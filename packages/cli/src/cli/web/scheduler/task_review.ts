import * as harness from '../../../harness/index.js';
import type { AgentConfig, ProviderConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';
import { CLAUDE_CODE_DEFAULT_RUN_SECONDS } from './task_roles.js';
import { dockerDevAllowlist } from '../../../lib/docker.js';

export const MAX_REVIEW_ROUNDS = 3;

export function reviewPrompt(objective: string, branch: string, round: number): string {
  return `You are an INDEPENDENT code reviewer. You did not write this code, and your job is to find real problems — not to be agreeable. Do not rubber-stamp.

The autonomous task you are reviewing had this objective:
"""
${objective}
"""

All of the task's work is committed to the git branch \`${branch}\`, checked out in your current working directory. Inspect it:
- \`git log --oneline\` to see the commits made for this task.
- Review the full change with \`git show\` / \`git diff\` across those commits.
- Read the changed files where it matters.

Review for:
- Correctness: real bugs, broken logic, unhandled cases.
- Completeness: does it ACTUALLY achieve the objective, or only part of it?
- Regressions: does it break existing behavior?
- Tests: is the new behavior covered, if the repo expects tests?
Verify claims against the code — do not trust comments or commit messages.

Be concrete: cite files and lines. If the work is genuinely complete and correct, say so plainly.

This is review round ${round} of at most ${MAX_REVIEW_ROUNDS}.

End your response with EXACTLY ONE of these two lines, and nothing after it:
REVIEW_RESULT: PASS
REVIEW_RESULT: CHANGES_REQUESTED`;
}

export function parseReviewVerdict(text: string): 'pass' | 'changes' {
  // Fail-safe: anything that is not an explicit trailing PASS counts as changes-requested.
  const matches = text.match(/REVIEW_RESULT:\s*(PASS|CHANGES_REQUESTED)/gi);
  if (!matches || matches.length === 0) return 'changes';
  const last = matches[matches.length - 1]!.toUpperCase();
  return /:\s*PASS/.test(last) ? 'pass' : 'changes';
}

export async function runDoneReview(opts: {
  agent: AgentConfig;
  provider: ProviderConfig;
  tools: Tool[];
  objective: string;
  branch: string;
  workingDir: string;
  round: number;
  signal?: AbortSignal;
  /** Wall-clock budget (seconds) for the review run. Defaults to the claude-code default. */
  maxRunSeconds?: number;
  /** When set, the review runs inside this docker container — aligned with the
   *  dev/planning cycles, so the reviewer can't execute the code under review on
   *  the host. best-effort git (see dockerHasGit). */
  dockerContainer?: string;
  /** Whether git is available inside the container; drives a prompt hint. */
  dockerHasGit?: boolean;
}): Promise<{ verdict: 'pass' | 'changes'; text: string }> {
  // Strip task-state tools: the reviewer must not mutate the task; the harness decides.
  const reviewTools = opts.tools.filter((t) => !t.name.startsWith('mcp__task__'));
  // claude-code reviewer: in a docker container it uses the same dontAsk +
  // workdir-scoped allowlist as the dev cycle (the Bash-rewrite hook is attached
  // by the runner via `docker`); otherwise bypassPermissions, no task bridge.
  const isClaudeCode = opts.provider.type === 'claude-code';
  const claudeCode = isClaudeCode
    ? opts.dockerContainer
      ? {
          permissionMode: 'dontAsk',
          allowedTools: dockerDevAllowlist(opts.workingDir),
          docker: { container: opts.dockerContainer, workdir: opts.workingDir },
        }
      : { permissionMode: 'bypassPermissions' as const }
    : undefined;
  // Wall-clock backstop for the review pass, enforced for every provider (the
  // Claude Code CLI has no --max-turns equivalent). Combined with any external
  // signal (a Pause landing mid-review) so either can abort the run.
  const budgetMs = (opts.maxRunSeconds ?? CLAUDE_CODE_DEFAULT_RUN_SECONDS) * 1000;
  const budgetController = new AbortController();
  const runTimer = setTimeout(() => budgetController.abort(), budgetMs);
  const signal: AbortSignal = opts.signal
    ? AbortSignal.any([opts.signal, budgetController.signal])
    : budgetController.signal;
  let prompt = reviewPrompt(opts.objective, opts.branch, opts.round);
  if (opts.dockerContainer) {
    prompt += `\n\n**Execution environment:** your shell commands run inside a Docker container mounted at \`${opts.workingDir}\`.`;
    if (opts.dockerHasGit === false) {
      prompt += ` Note: \`git\` is NOT available in this container — inspect the changes by reading the files directly instead of running git commands.`;
    }
  }
  try {
    const result = await harness.run(
      {
        agent: { ...opts.agent, permissionMode: 'bypassPermissions' }, // unattended: mirror the auto-approve confirm gate
        provider: opts.provider,
        tools: reviewTools,
        prompt,
        history: [],
        workingDir: opts.workingDir,
        signal,
        dockerContainer: opts.dockerContainer,
        ...(claudeCode ? { claudeCode } : {}),
      },
      {
        confirmTool: async () => 'once', // unattended
      },
    );
    return { verdict: parseReviewVerdict(result.text), text: result.text };
  } finally {
    clearTimeout(runTimer);
  }
}
