import { randomUUID } from 'node:crypto';
import * as harness from '../../../harness/index.js';
import { loadAgents, loadConfig } from '../../../store/json.js';
import { getDb, Task, Project, TaskMessage, getTaskById, saveTask, addTaskMessage, updateTaskMessageContent, runQuery } from '../../../store/db.js';
import { runningTasks, runningTaskControllers } from './locks.js';
import { isGitRepo, ensureWorktree, agentDirIn, commitWip, finalizeDone, runBootstrap } from '../../../lib/task_git.js';
import { runDoneReview, MAX_REVIEW_ROUNDS } from './task_review.js';
import type { AgentConfig, ProviderConfig, ProjectConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';
import type { RunOptions } from '../../../harness/index.js';
import { claudeCodeTaskExtras } from '../../../harness/claude_code_runner.js';
import { issueBridgeToken, revokeBridgeToken, getTaskBridgeUrl } from '../mcp_bridge.js';
import {
  resolveRoleAgent,
  resolveReviewEnabled,
  resolveSddEnabled,
  resolveMaxRunSeconds,
  filterPlannerTools,
  TaskRole,
} from './task_roles.js';

function buildPrompt(
  systemPrompt: string,
  taskId: number,
  taskTitle: string,
  maxRunSeconds: number,
  maxTurns: number,
  workingDir?: string,
): string {
  const workspaceLine = workingDir
    ? `\n**Your workspace is: \`${workingDir}\`** — operate exclusively inside this directory. Do NOT reference or modify any other path on the filesystem.\n`
    : '';

  return `${systemPrompt}
${workspaceLine}
---

You are running in **autonomous task mode**. Your job is to advance one step toward the objective.

You have no memory of previous invocations. Your only memory is in the task messages.
It is therefore **mandatory** that you always leave a detailed record of what you did,
so the next invocation can pick up exactly where you left off.

You have **${maxRunSeconds} seconds** for this invocation. Plan accordingly — do not start
work you cannot finish and document within that time.

Your agent runtime allows a maximum of **${maxTurns} turns** per invocation. Use them wisely.

On each invocation:
1. Read the current state with \`task_get_state\` (objective, checklist, recent messages)
2. From the recent messages, understand what has already been done and what remains
3. Identify the next step in the checklist
4. Do the necessary work using the other tools available to you
5. Update the checklist with \`task_update_checklist_item\`
6. **Mandatory:** call \`task_add_message\` with a detailed summary of:
   - what you did in this session
   - which tools you used and what the results were
   - what the recommended next step is
   - any issues encountered or decisions made
7. If the objective is complete, close with \`task_complete\`
8. If you need human input to proceed, call \`task_block\` with a clear explanation
9. Otherwise, stop — you will continue in the next cycle

Do NOT try to complete everything in one invocation.
Do ONE meaningful step, then stop and document.

TASK ID: ${taskId}
TITLE: ${taskTitle}`;
}

function buildPlanningPrompt(
  systemPrompt: string,
  taskId: number,
  taskTitle: string,
  maxRunSeconds: number,
  maxTurns: number,
  workingDir: string | undefined,
  sdd: boolean,
): string {
  const workspaceLine = workingDir
    ? `\n**Your workspace is: \`${workingDir}\`** — operate exclusively inside this directory.\n`
    : '';

  const accessBlock = sdd
    ? `You are in **SDD mode**: you may create and edit **markdown (.md) documents only** — specs, plans, ADRs — and you MUST follow this project's own documentation conventions (see the project context / AGENTS.md). Everything else stays read-only: explore with \`read_file\`, \`glob\`, and \`grep\`; non-markdown files and \`bash\` are not available. Reference the documents you created in the plan you submit.`
    : `You have read-only access to the workspace: explore it with \`read_file\`, \`glob\`, and
\`grep\`. Write tools and \`bash\` are not available in this phase.`;

  return `${systemPrompt}
${workspaceLine}
---

You are running in **autonomous task mode**, in the **PLANNING phase**. Your only job
is to produce an implementation plan for this task — you must NOT ${sdd ? 'implement anything; markdown documents are the only files you may touch' : 'modify anything'}.

${accessBlock}

You have no memory of previous invocations. Your only memory is in the task messages.
You have **${maxRunSeconds} seconds** and at most **${maxTurns} turns** for this invocation.

On each invocation:
1. Read the current state with \`task_get_state\` (objective, checklist, recent messages)
2. Explore the workspace as needed to understand how to achieve the objective
3. When the plan is ready:
   - Replace the checklist with concrete execution steps via \`task_update_checklist\`
   - Call \`task_submit_plan\` with the full plan (markdown). This ends the planning
     phase and starts execution — the executing agent will read your plan from the
     task thread, so make it self-contained.
4. If you cannot finish the plan in this invocation, call \`task_add_message\` with your
   findings so far, then stop — you will continue planning in the next cycle.

Do NOT call \`task_complete\` in this phase.

TASK ID: ${taskId}
TITLE: ${taskTitle}`;
}


export async function runTaskHeartbeatTick(now: Date): Promise<void> {
  // 1. Pick one active, unlocked task (oldest updatedAt first). Archived tasks
  //    are excluded from the heartbeat — they are deliberately parked.
  const taskRows = (await runQuery(`SELECT * FROM tasks WHERE (status = 'active' OR status = 'reviewing' OR status = 'planning') AND lockedAt IS NULL`)) as Task[];
  const eligible = taskRows.filter((t) => !t.archived);
  if (eligible.length === 0) {
    return;
  }

  // Sort by updatedAt asc to find the oldest
  eligible.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  const task = eligible[0]!;

  const lockKey = `task_db_${task.id}`;
  if (runningTasks.has(lockKey)) {
    return;
  }

  runningTasks.add(lockKey);
  // Register an abort handle so Pause/block can kill this run mid-cycle.
  const abortController = new AbortController();
  runningTaskControllers.set(task.id, abortController);
  console.log(`[task_heartbeat] Claimed task #${task.id}: "${task.title}"`);

  // Update lockedAt in DB
  task.lockedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  await saveTask(task);

  let liveMsgId: number | null = null;

  try {
    // 2. Load Config & Project
    const config = await loadConfig();
    const project = (config.projects || []).find((p) => p.id === task.projectId);
    if (!project) {
      throw new Error(`Project with ID ${task.projectId} not found for task #${task.id}`);
    }

    // 3. Load Agent — resolved per role: the task's phase decides who runs.
    //    planner/reviewer overrides degrade onto the developer chain
    //    (task.agentId -> project.agentId -> agents[0]).
    const agents = await loadAgents();
    const role: TaskRole =
      task.status === 'reviewing' ? 'reviewer' : task.status === 'planning' ? 'planner' : 'developer';
    const agent = resolveRoleAgent(role, task, project, agents);
    if (!agent) {
      throw new Error(`No agent configured in agents.json for project "${project.name}"`);
    }

    // 4. Load Provider
    const provider = config.providers.find((p) => p.name === agent.provider);
    if (!provider) {
      throw new Error(`Provider "${agent.provider}" not found for agent "${agent.name}"`);
    }

    const baseWorkingDir = project.workingDir || agent.workingDir || process.cwd();
    let workingDir = baseWorkingDir;

    // Worktree isolation for git projects: lazily create a dedicated branch + worktree.
    if (task.worktreePath) {
      workingDir = await agentDirIn(task.worktreePath, baseWorkingDir);
    } else if (await isGitRepo(baseWorkingDir)) {
      const wt = await ensureWorktree(baseWorkingDir, task.projectId, task.id, task.title);
      task.branch = wt.branch;
      task.worktreePath = wt.worktreePath;
      await saveTask(task);
      workingDir = wt.agentWorkingDir;
      console.log(`[task_heartbeat] Task #${task.id} worktree ${wt.worktreePath} (branch ${wt.branch})`);

      // Project bootstrap: run once in the fresh worktree before the agent's first
      // cycle (e.g. `pnpm install`). A failing command blocks the task so the user
      // sees why setup broke instead of the agent flailing in an unbuilt tree.
      const bootstrap = (project.bootstrapCommands || []).filter((c) => c.trim());
      if (bootstrap.length > 0) {
        try {
          console.log(`[task_heartbeat] Task #${task.id} running ${bootstrap.length} bootstrap command(s)`);
          await runBootstrap(workingDir, bootstrap);
        } catch (bootErr) {
          const reason = bootErr instanceof Error ? bootErr.message : String(bootErr);
          task.status = 'blocked';
          task.blockedReason = reason;
          task.updatedAt = new Date().toISOString();
          await saveTask(task);
          await addTaskMessage({
            taskId: task.id,
            role: 'assistant',
            messageType: 'block',
            content: `Bootstrap failed — task blocked.\n\n${reason}`,
          });
          console.error(`[task_heartbeat] Task #${task.id} bootstrap failed, blocked:`, reason);
          return;
        }
      }
    }
    // Non-git projects fall through: workingDir stays baseWorkingDir (run in place).

    // Ensure mcp__task__* is in agent.allowedTools
    const baseTools = [...agent.allowedTools];
    if (!baseTools.includes('mcp__task__*')) {
      baseTools.push('mcp__task__*');
    }
    const effectiveAgent = {
      ...agent,
      allowedTools: baseTools,
      permissionMode: 'bypassPermissions', // unattended: mirror the auto-approve confirm gate
    };

    // Resolve tools
    let tools = await harness.resolveAgentTools(effectiveAgent, harness.tools);

    // Reviewing tasks run one independent review pass on their branch as their
    // own heartbeat cycle (not the agent's task loop), then transition. The
    // review gate flag is read at decision time: disabling it while a task sits
    // in reviewing finalizes the task directly on the next tick.
    if (task.status === 'reviewing') {
      await runReviewCycle({ task, project, agent: effectiveAgent, provider, tools, workingDir, signal: abortController.signal });
      return; // the finally{} block still runs and releases the lock
    }

    const planning = task.status === 'planning';
    const sdd = planning && resolveSddEnabled(task, project);
    if (planning) {
      // Read-only phase: strip workspace-mutating tools (same post-filter
      // mechanism the review uses to strip mcp__task__*). In SDD mode the
      // file writers survive, wrapped to markdown-only targets.
      tools = filterPlannerTools(tools, sdd);
    }

    // Max turns: standard sonnet settings or maxTurns
    const maxTurns = agent.maxTurns || 30;
    const isClaudeCode = provider.type === 'claude-code';
    // Per-invocation wall-clock budget (task → project → provider default),
    // enforced below via the abort timer for every provider.
    const maxRunSeconds = resolveMaxRunSeconds(task, project, isClaudeCode);

    // 5. Construct prompt
    const prompt = planning
      ? buildPlanningPrompt(agent.systemPrompt, task.id, task.title, maxRunSeconds, maxTurns, workingDir, sdd)
      : buildPrompt(agent.systemPrompt, task.id, task.title, maxRunSeconds, maxTurns, workingDir);

    const checklistBefore = (task.checklist || []).filter((item) => item.status !== 'pending').length;

    // Create a live assistant message in DB
    const liveMsg = await addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'heartbeat_live',
      content: '',
    });
    liveMsgId = liveMsg.id;

    let buffer = '';
    let lastWrite = 0;

    const updateLiveContent = async (force = false) => {
      if (liveMsgId === null) return;
      const nowMs = Date.now();
      if (force || nowMs - lastWrite > 2500) {
        lastWrite = nowMs;
        await updateTaskMessageContent(liveMsgId, buffer);
      }
    };

    // Load full history for replay
    const historyMessages = (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`)) as TaskMessage[];
    historyMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Map history to loop-compatible message records
    const historyRecords = historyMessages
      .filter((m) => m.messageType === 'chat' || m.messageType === 'heartbeat' || m.messageType === 'tool_call' || m.messageType === 'review' || m.messageType === 'plan')
      .map((m) => ({
        id: randomUUID(),
        v: 1 as const,
        type: 'message' as const,
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId || undefined,
        createdAt: m.createdAt,
      }));

    console.log(`[task_heartbeat] Running agent "${agent.name}" on task #${task.id}...`);

    // claude-code agents get role-scoped permission/tool extras and, when a
    // task bridge is running, an injected mcp__task server so the CLI can
    // still call task_get_state/task_submit_plan/etc despite --strict-mcp-config.
    let bridgeToken: string | undefined;
    let claudeCode: RunOptions['claudeCode'];
    // Same handle Pause aborts; the wall-clock budget (resolved above) also
    // aborts it. Enforced for every provider — native runs stay additionally
    // turn-bounded by maxTurns.
    const signal: AbortSignal = abortController.signal;
    const runTimer: NodeJS.Timeout = setTimeout(() => abortController.abort(), maxRunSeconds * 1000);
    if (isClaudeCode) {
      const bridgeUrl = getTaskBridgeUrl();
      bridgeToken = bridgeUrl ? issueBridgeToken() : undefined;
      claudeCode = claudeCodeTaskExtras({
        planning,
        sdd,
        bridge: bridgeUrl && bridgeToken ? { url: bridgeUrl, token: bridgeToken } : undefined,
      });
      if (!bridgeUrl) {
        console.warn('[tasks] claude-code agent without task bridge URL — task tools unavailable this run');
      }
    }

    try {
      await harness.run(
        {
          agent: effectiveAgent,
          provider,
          tools,
          prompt,
          history: historyRecords,
          workingDir,
          claudeCode,
          signal,
        },
        {
          onChunk: (chunk) => {
            buffer += chunk;
            void updateLiveContent();
          },
          onToolCall: (id, name, args) => {
            void addTaskMessage({
              taskId: task.id,
              role: 'assistant',
              messageType: 'tool_call',
              content: `${name} ${JSON.stringify(args)}`,
              toolCallId: id,
            });
          },
          confirmTool: async () => 'once', // Autonomous execution auto-approves tools
        },
      );
    } finally {
      if (bridgeToken) revokeBridgeToken(bridgeToken);
      clearTimeout(runTimer);
    }

    // Finalize live message
    if (liveMsgId !== null) {
      await updateTaskMessageContent(liveMsgId, buffer, 'heartbeat');
      liveMsgId = null;
    }

    // 6. Reload task to evaluate checklist progress
    const refreshedTask = await getTaskById(task.id);
    if (refreshedTask && (refreshedTask.status === 'active' || refreshedTask.status === 'planning')) {
      const checklistAfter = (refreshedTask.checklist || []).filter((item) => item.status !== 'pending').length;
      let noProgressCount = refreshedTask.noProgressCount;

      if (checklistAfter > checklistBefore) {
        noProgressCount = 0;
        console.log(`[task_heartbeat] Task #${task.id} made checklist progress: ${checklistBefore} -> ${checklistAfter}`);
      } else {
        noProgressCount++;
        console.log(`[task_heartbeat] Task #${task.id} made no progress (${noProgressCount}/${refreshedTask.maxNoProgress})`);
      }

      refreshedTask.noProgressCount = noProgressCount;
      refreshedTask.updatedAt = new Date().toISOString();

      if (noProgressCount >= refreshedTask.maxNoProgress) {
        refreshedTask.status = 'paused';
        await addTaskMessage({
          taskId: task.id,
          role: 'assistant',
          messageType: 'system',
          content: `Auto-paused: no checklist progress after ${noProgressCount} iterations.`,
        });
        console.log(`[task_heartbeat] Task #${task.id} auto-paused due to no progress.`);
      }

      await saveTask(refreshedTask);
    }

    // Git lifecycle: commit progress every cycle. When the agent has just
    // completed the task it is now 'reviewing' (review runs next tick as its
    // own cycle) — or already 'done' when the review gate is disabled, in
    // which case the worktree is finalized here, after the run has ended.
    const gitTask = await getTaskById(task.id);
    if (gitTask && gitTask.worktreePath) {
      try {
        if (await commitWip(gitTask.worktreePath, gitTask.title)) {
          console.log(`[task_heartbeat] Task #${task.id} committed WIP to ${gitTask.branch}`);
        }
        if (gitTask.status === 'done') {
          await finalizeDone(gitTask.worktreePath);
          gitTask.worktreePath = null;
          gitTask.updatedAt = new Date().toISOString();
          await saveTask(gitTask);
          console.log(`[task_heartbeat] Task #${task.id} done (review gate off): worktree removed, branch ${gitTask.branch} kept`);
        }
      } catch (gitErr) {
        console.error(`[task_heartbeat] Task #${task.id} git step failed:`, gitErr);
      }
    }

  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[task_heartbeat] Task #${task.id} run failed:`, errorMsg);

    if (liveMsgId !== null) {
      await updateTaskMessageContent(liveMsgId, `⚠️ Heartbeat cycle failed: ${errorMsg}`, 'heartbeat');
    }

    await addTaskMessage({
      taskId: task.id,
      role: 'assistant',
      messageType: 'system',
      content: `Heartbeat error: ${errorMsg}`,
    });
  } finally {
    // 7. Ensure task is unlocked
    const finalCheck = await getTaskById(task.id);
    if (finalCheck) {
      finalCheck.lockedAt = null;
      finalCheck.updatedAt = new Date().toISOString();
      await saveTask(finalCheck);
    }
    runningTasks.delete(lockKey);
    runningTaskControllers.delete(task.id);
    console.log(`[task_heartbeat] Lock released for task #${task.id}`);
  }
}

async function runReviewCycle(opts: {
  task: Task;
  project?: ProjectConfig | null;
  agent: AgentConfig;
  provider: ProviderConfig;
  tools: Tool[];
  workingDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { task, project, agent, provider, tools, workingDir, signal } = opts;
  const maxRunSeconds = resolveMaxRunSeconds(task, project, provider.type === 'claude-code');
  if (!task.worktreePath) return; // reviewing implies a worktree; nothing to review otherwise

  // Review gate disabled (task or project level): finalize directly, no review.
  if (!resolveReviewEnabled(task, project)) {
    await commitWip(task.worktreePath, task.title);
    const current = await getTaskById(task.id);
    if (!current || current.status !== 'reviewing') return;
    await finalizeDone(current.worktreePath!);
    current.status = 'done';
    current.worktreePath = null;
    current.updatedAt = new Date().toISOString();
    await saveTask(current);
    console.log(`[task_heartbeat] Task #${task.id} review gate disabled: finalized as done, branch ${current.branch} kept`);
    return;
  }

  // Finalize the agent's last work so the branch is complete before review.
  await commitWip(task.worktreePath, task.title);

  // Round is derived from the review-message stream, never a stored counter.
  const priorReviews = (
    (await runQuery(`SELECT * FROM task_messages WHERE taskId = ${task.id}`)) as TaskMessage[]
  ).filter((m) => m.messageType === 'review').length;
  const round = priorReviews + 1;

  let verdict: 'pass' | 'changes' = 'pass';
  let reviewText = '';
  try {
    const review = await runDoneReview({
      agent,
      provider,
      tools,
      objective: task.objective,
      branch: task.branch || '(unknown)',
      workingDir,
      round,
      signal,
      maxRunSeconds,
    });
    verdict = review.verdict;
    reviewText = review.text;
  } catch (reviewErr) {
    // A broken review must not trap the task in reviewing — finalize as pass.
    console.error(`[task_heartbeat] Task #${task.id} review failed, finalizing:`, reviewErr);
    verdict = 'pass';
  }

  // Respect a Pause that arrived mid-review: only transition if still reviewing.
  const current = await getTaskById(task.id);
  if (!current || current.status !== 'reviewing') {
    console.log(`[task_heartbeat] Task #${task.id} left reviewing mid-review (now ${current?.status}); skipping transition.`);
    return;
  }

  if (reviewText) {
    await addTaskMessage({
      taskId: task.id,
      role: 'user',
      messageType: 'review',
      content: `[CODE REVIEW round ${round}/${MAX_REVIEW_ROUNDS}] verdict=${verdict}\n\n${reviewText}`,
    });
  }
  console.log(`[task_heartbeat] Task #${task.id} review round ${round}: ${verdict}`);

  if (verdict === 'changes' && round < MAX_REVIEW_ROUNDS) {
    // Reopen: keep the worktree; the review message is replayed to the agent next cycle.
    current.status = 'active';
    current.noProgressCount = 0;
    current.updatedAt = new Date().toISOString();
    await saveTask(current);
    console.log(`[task_heartbeat] Task #${task.id} reopened by review (round ${round}).`);
  } else {
    if (verdict === 'changes') {
      await addTaskMessage({
        taskId: task.id,
        role: 'assistant',
        messageType: 'system',
        content: `Finished as done despite outstanding review findings after ${MAX_REVIEW_ROUNDS} rounds.`,
      });
    }
    await finalizeDone(current.worktreePath!);
    current.status = 'done';
    current.worktreePath = null;
    current.updatedAt = new Date().toISOString();
    await saveTask(current);
    console.log(`[task_heartbeat] Task #${task.id} done: worktree removed, branch ${current.branch} kept`);
  }
}
