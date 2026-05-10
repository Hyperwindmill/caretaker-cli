import { createElement } from "react";
import { render } from "ink";
import App from "./tui/app.js";
import { loadAgents, loadConfig } from "./store/json.js";
import { run } from "./harness/loop.js";
import { tools as toolRegistry } from "./harness/tools/instance.js";
import { resolveAgentTools } from "./harness/tools/index.js";
import { refreshSourcesOnStart } from "./plugins/refresh_on_start.js";

const promptArg = process.argv.slice(2).join(" ").trim();

// Fire refresh-on-start in the background — startup must not block on a
// slow git fetch. The next agent run reads plugins.json fresh so it picks
// up newly-discovered plugins automatically.
void refreshSourcesOnStart().catch((err) => {
  console.error("[boot] refresh-on-start failed:", err);
});

if (!promptArg) {
  render(createElement(App));
} else {
  const config = await loadConfig();
  const agents = await loadAgents();
  const agent = agents[0];
  if (!agent) {
    console.error("no agents configured. run without args to open the TUI.");
    process.exit(1);
  }
  const provider = config.providers.find((p) => p.name === agent.provider);
  if (!provider) {
    console.error(`agent "${agent.name}" references provider "${agent.provider}" which is not in caretaker.json`);
    process.exit(1);
  }

  console.log(`→ running "${agent.name}" (${agent.model} via ${provider.name})\n`);

  const result = await run(
    { agent, provider, tools: resolveAgentTools(agent, toolRegistry), prompt: promptArg, workingDir: agent.workingDir },
    {
      onChunk: (s) => process.stdout.write(s),
      onToolCall: (_id, name, args) => process.stdout.write(`\n  → tool ${name}(${JSON.stringify(args)})`),
      onToolResult: (_id, content) => process.stdout.write(`\n  ← ${content.slice(0, 200)}\n`),
    },
  );
  process.stdout.write(`\n\n[stop=${result.stop} tool_calls=${result.toolCalls} usage=${JSON.stringify(result.usage)}]\n`);
}
