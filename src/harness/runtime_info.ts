// Per-run static identity block appended to the system prompt. Same idea
// as the sister repo's <runtime-info> tag: tells the model who it is,
// which model + provider it runs against, and where its working directory
// is. Live values (token usage, context window) live in the
// `get_agent_context` builtin so the prompt stays cache-friendly across
// turns.

export function formatRuntimeInfoBlock(input: {
  agentName: string;
  model: string;
  provider: string;
  workingDir: string;
}): string {
  const lines = [
    `agent_name: ${input.agentName || "(unnamed)"}`,
    `model: ${input.model || "(unset)"}`,
    `provider: ${input.provider || "(unset)"}`,
    `working_dir: ${input.workingDir}`,
  ];
  return `<runtime-info>\n${lines.join("\n")}\n</runtime-info>`;
}
