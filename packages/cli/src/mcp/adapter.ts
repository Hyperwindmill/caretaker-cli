// Adapter: bridges MCP servers into the in-process Tool registry shape used
// by the harness loop. For each requested server id, connects via the pool,
// calls tools/list, and returns one Tool per remote tool with name
// `mcp__<id>__<toolName>`.
//
// Failure semantics: a server that cannot be connected to surfaces as zero
// tools plus a one-line warn — we don't want a single broken MCP server to
// abort the whole agent run. The error is already persisted on the server
// row by getClient().

import type { Tool } from '../harness/tools/types.js';
import { getClient } from './client.js';

const NAME_PREFIX = 'mcp__';

function joinedToolName(serverId: string, toolName: string): string {
  return `${NAME_PREFIX}${serverId}__${toolName}`;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function buildTool(serverId: string, remote: RemoteTool): Tool {
  return {
    name: joinedToolName(serverId, remote.name),
    description: remote.description ?? `MCP tool ${remote.name}`,
    parameters: (remote.inputSchema as Record<string, unknown> | undefined) ?? {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    async execute(args, ctx) {
      const client = await getClient(serverId);
      const res = await client.callTool(
        { name: remote.name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal: ctx.signal },
      );
      const parts: string[] = [];
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      for (const c of content) {
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        // Non-text content (image/audio/resource) is dropped for now — the
        // loop's ToolResult contract is text-only. A future iteration can
        // surface attachments through ToolResult.attachments.
      }
      const text = parts.join('\n');
      if (res.isError === true) {
        return { content: text || 'Error: MCP tool reported a failure' };
      }
      return { content: text };
    },
  };
}

/**
 * Build the Tool[] exposed by a list of MCP server ids. Servers that are
 * unknown, disabled, or unreachable contribute zero tools; the agent run
 * continues with whatever connected. Order follows the input ids and the
 * remote tools/list order.
 */
export async function mcpToolsForServers(serverIds: string[]): Promise<Tool[]> {
  const out: Tool[] = [];
  for (const id of serverIds) {
    let client;
    try {
      client = await getClient(id);
    } catch (err) {
      console.warn(
        `[mcp adapter] skipping server ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    let listed;
    try {
      listed = await client.listTools();
    } catch (err) {
      console.warn(
        `[mcp adapter] tools/list failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    for (const t of listed.tools ?? []) {
      out.push(buildTool(id, t as RemoteTool));
    }
  }
  return out;
}
