import * as harness from '../../../harness/index.js';
import type { AgentConfig, ProviderConfig } from '../../../types.js';
import type { Tool } from '../../../harness/tools/types.js';

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
}): Promise<{ verdict: 'pass' | 'changes'; text: string }> {
  // Strip task-state tools: the reviewer must not mutate the task; the harness decides.
  const reviewTools = opts.tools.filter((t) => !t.name.startsWith('mcp__task__'));
  const result = await harness.run(
    {
      agent: opts.agent,
      provider: opts.provider,
      tools: reviewTools,
      prompt: reviewPrompt(opts.objective, opts.branch, opts.round),
      history: [],
      workingDir: opts.workingDir,
    },
    {
      confirmTool: async () => 'once', // unattended
    },
  );
  return { verdict: parseReviewVerdict(result.text), text: result.text };
}
