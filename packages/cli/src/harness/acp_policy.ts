// Permission policy for ACP runs: one pure function replaces the per-runner
// tangle (claude-code CLI flags, native tool filtering). Every ACP
// session/request_permission goes through decidePermission; 'ask' is resolved
// by the caller via the ordinary confirm gate.

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { ConfirmDecision } from './tools/index.js';

export type AcpPolicyMode = 'interactive' | 'unattended' | 'planner' | 'deny-all';

export type AcpRunExtras = {
  /** Permission policy. Default 'interactive' (route to the confirm gate). */
  mode?: AcpPolicyMode;
  /** Planner SDD mode: edits allowed on markdown-only locations. */
  sdd?: boolean;
  /** Extra per-run MCP servers (the task bridge), same shape as claude-code's. */
  extraMcpServers?: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }>;
  /** Docker confinement: 'execute' tool calls are denied (the bridge-injected
   *  run_command tool is the only shell path). */
  docker?: { container: string; workdir: string };
};

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** Kinds a planner must never perform. 'other' stays allowed on purpose:
 *  MCP tool calls (task_submit_plan, task_get_state) surface as 'other'. */
const PLANNER_DENIED_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

export function decidePermission(
  req: RequestPermissionRequest,
  extras: AcpRunExtras,
): PermissionDecision {
  const mode = extras.mode ?? 'interactive';
  const kind = req.toolCall.kind ?? 'other';
  // Docker confinement outranks every mode: shell goes through run_command or dies.
  if (extras.docker && kind === 'execute') return 'deny';
  switch (mode) {
    case 'deny-all':
      return 'deny';
    case 'unattended':
      return 'allow';
    case 'planner': {
      if (!PLANNER_DENIED_KINDS.has(kind)) return 'allow';
      if (extras.sdd && kind === 'edit') {
        const locations = req.toolCall.locations ?? [];
        if (locations.length > 0 && locations.every((l) => l.path.endsWith('.md'))) return 'allow';
      }
      return 'deny';
    }
    case 'interactive':
      return 'ask';
  }
}

/** Map a gate decision onto the agent-provided options. Fail-safe: when no
 *  matching option exists, respond 'cancelled' (never invent an optionId). */
export function buildPermissionResponse(
  options: PermissionOption[],
  decision: ConfirmDecision | 'deny',
): RequestPermissionResponse {
  const pick = (kinds: string[]) =>
    kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
  const opt =
    decision === 'reject' || decision === 'deny'
      ? pick(['reject_once', 'reject_always'])
      : decision === 'always'
        ? pick(['allow_always', 'allow_once'])
        : pick(['allow_once', 'allow_always']);
  return opt
    ? { outcome: { outcome: 'selected', optionId: opt.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** Role restrictions + task-bridge wiring for autonomous task runs — the ACP
 *  mirror of claudeCodeTaskExtras. */
export function acpTaskExtras(p: {
  planning: boolean;
  sdd: boolean;
  bridge?: { url: string; token: string };
  docker?: { container: string; workdir: string };
}): AcpRunExtras {
  const extraMcpServers = p.bridge
    ? {
        task: {
          type: 'http' as const,
          url: p.bridge.url,
          headers: { Authorization: `Bearer ${p.bridge.token}` },
        },
      }
    : undefined;
  return { mode: p.planning ? 'planner' : 'unattended', sdd: p.sdd, extraMcpServers, docker: p.docker };
}
