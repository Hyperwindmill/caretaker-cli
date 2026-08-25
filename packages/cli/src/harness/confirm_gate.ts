// Shared confirm-gate state for interactive chat surfaces (web, VSCode, TUI).
//
// Native and claude-code agents gate by the user's [!] picker selection
// (agent.confirmTools): only listed names prompt, and "always" un-lists the
// name for the rest of the controller's lifetime.
//
// ACP agents invert the rule: agent.confirmTools is always empty (the picker
// does not apply to external runners), and a session/request_permission means
// the agent's OWN permission model already decided this call was worth asking
// about — so every request surfaces a card, and "always" is remembered
// per tool name in-memory.

import type { ConfirmDecision } from './tools/index.js';

export class ConfirmGateState {
  private readonly isAcp: boolean;
  /** Native mode: names that still prompt ("always" removes). */
  private readonly confirmSet: Set<string>;
  /** ACP mode: names the user already granted "always" (adds). */
  private readonly acpAllowed = new Set<string>();

  constructor(providerType: string | undefined, confirmTools: string[] | undefined) {
    this.isAcp = providerType === 'acp';
    this.confirmSet = new Set(confirmTools ?? []);
  }

  needsAsk(name: string): boolean {
    return this.isAcp ? !this.acpAllowed.has(name) : this.confirmSet.has(name);
  }

  remember(name: string, decision: ConfirmDecision): void {
    if (decision !== 'always') return;
    if (this.isAcp) this.acpAllowed.add(name);
    else this.confirmSet.delete(name);
  }
}
