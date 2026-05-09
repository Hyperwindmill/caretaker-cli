// Pure state helpers for the agent-form ToolPicker. The picker stores its
// selection as two parallel string sets (`allowed` and `confirm`) so the
// existing AgentConfig.allowedTools shape stays intact: `confirm` is just
// a subset of `allowed` carrying the "needs user confirmation" mark.

export type ToolState = "inactive" | "active" | "confirm";

export function getToolState(name: string, allowed: string[], confirm: string[]): ToolState {
  if (!allowed.includes(name)) return "inactive";
  return confirm.includes(name) ? "confirm" : "active";
}

export function cycleToolState(s: ToolState): ToolState {
  if (s === "inactive") return "active";
  if (s === "active") return "confirm";
  return "inactive";
}

export function applyToolState(
  name: string,
  next: ToolState,
  allowed: string[],
  confirm: string[],
): { allowed: string[]; confirm: string[] } {
  const a = new Set(allowed);
  const c = new Set(confirm);
  if (next === "inactive") {
    a.delete(name);
    c.delete(name);
  } else if (next === "active") {
    a.add(name);
    c.delete(name);
  } else {
    a.add(name);
    c.add(name);
  }
  return { allowed: [...a], confirm: [...c] };
}

export function formatToolsForDetail(allowed: string[], confirm: string[]): string {
  const set = new Set(confirm);
  return allowed.map((t) => (set.has(t) ? `${t}!` : t)).join(", ");
}
