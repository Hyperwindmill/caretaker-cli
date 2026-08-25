// Agent-facing memory tools. Named `mcp__memory__*` so the shared builtin MCP
// server (mcp/builtin_server.ts) picks them up by prefix and serves them over
// both the stdio subcommand and the per-task HTTP bridge, exactly like the
// `mcp__task__*` set. Native agents opt in via allowedTools (the
// `mcp__<ns>__*` wildcard is generic in resolveAgentTools and the pickers).
//
// memory_read is THE recall event of the memory subsystem: every delivered id
// bumps the memory's acquired strength (recallCount / lastRecalledAt) — the
// signal the future consolidation/decay feeds on. That is why the prelude
// injects titles only: a system that always injects bodies never learns what
// mattered. Read-only w.r.t. content — no planner deny needed.
// See docs/superpowers/specs/2026-08-25-memory-daemon-step3-recall-design.md

import type { Tool, ToolResult } from '../types.js';
import { listMemories, bumpMemoryRecall } from '../../../store/db.js';

export const memoryReadTool: Tool = {
  name: 'mcp__memory__memory_read',
  description:
    'Read the full content of stored memories by id. Ids come from the <memories> block in the system prompt. Reading a memory reinforces it (recall statistics are updated), so read the ones actually relevant, not all of them.',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory ids to read.',
      },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  execute: async (args, _ctx): Promise<ToolResult> => {
    const ids = Array.isArray(args.ids)
      ? (args.ids as unknown[]).filter(
          (v): v is string => typeof v === 'string' && v.trim() !== ''
        )
      : [];
    if (ids.length === 0) throw new Error('memory_read requires a non-empty `ids` array');
    const byId = new Map((await listMemories()).map((m) => [m.id, m]));
    const memories: object[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m) {
        missing.push(id);
        continue;
      }
      await bumpMemoryRecall(id);
      memories.push({
        id: m.id,
        title: m.title,
        body: m.body,
        kind: m.kind,
        importance: m.importance,
        projectId: m.projectId,
        createdAt: m.createdAt,
      });
    }
    return { content: JSON.stringify({ memories, missing }) };
  },
};
