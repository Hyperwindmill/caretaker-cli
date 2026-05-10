#!/usr/bin/env node
// Process entrypoint: boot side-effects (plugin refresh, model-limits
// fetch, MCP shutdown hooks) + dispatch to the CLI layer in src/cli/.
// Subcommand routing lives in src/cli/index.ts; this file stays thin.

import { refreshSourcesOnStart } from './plugins/refresh_on_start.js';
import { closeAll as closeAllMcp } from './mcp/client.js';
import { initModelLimits } from './harness/model_limits.js';
import { runCli } from './cli/index.js';

// Fire refresh-on-start in the background — startup must not block on a
// slow git fetch. The next agent run reads plugins.json fresh so it picks
// up newly-discovered plugins automatically.
void refreshSourcesOnStart().catch((err) => {
  console.error('[boot] refresh-on-start failed:', err);
});

// Populate the model-context registry from models.dev in the background.
// Degrades gracefully (percent stays null) until the first fetch lands.
initModelLimits();

// Tear pooled MCP connections down on shutdown so child stdio processes are
// not orphaned and HTTP sessions get a chance to send DELETE. Best-effort:
// SIGINT/SIGTERM may not yield enough time for the close handshake.
const shutdownMcp = async (): Promise<void> => {
  try {
    await closeAllMcp();
  } catch {
    /* swallow — we are exiting regardless */
  }
};
process.on('exit', () => {
  // exit is sync — fire-and-forget; close handlers may not complete.
  void shutdownMcp();
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await shutdownMcp();
    process.exit(0);
  });
}

await runCli(process.argv);
