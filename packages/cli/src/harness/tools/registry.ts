import type { Tool } from './types.js';

/**
 * In-process tool registry. Tools are registered once at startup
 * (registerBuiltins + future registerMcpServers) and filtered per-run by
 * the agent's allowedTools list.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool. Throws if a tool with the same name is already
   *  registered — registration is meant to be deterministic, and silent
   *  overwrites would mask bugs. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Filter the registry by an explicit allowlist of tool names. Names
   *  not present in the registry are silently dropped — the agent may
   *  reference tools that are unmounted on this install. */
  filtered(allowed: string[]): Tool[] {
    const set = new Set(allowed);
    return this.list().filter((t) => set.has(t.name));
  }
}
