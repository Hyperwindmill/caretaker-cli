import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { McpServerConfig } from "../types.js";

let testHome: string;

async function makeLinkedClientPair(register: (s: McpServer) => void): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  register(server);
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

function pingTool(s: McpServer): void {
  s.registerTool(
    "ping",
    { description: "Replies pong", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );
}

describe("mcp client pool", () => {
  let pool: typeof import("./client.js");
  let store: typeof import("../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-pool-"));
    process.env.CARETAKER_HOME = testHome;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
    pool = await import("./client.js");
    store = await import("../store/json.js");
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    await rm(store.mcpServersPath(), { force: true });
    pool.__resetPool();
  });

  afterEach(() => {
    pool.__setConnectOverride(undefined);
  });

  function dummyServer(over: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
      id: randomUUID(),
      name: "fake",
      transport: "stdio",
      enabled: true,
      command: "node",
      args: [],
      lastConnectedAt: null,
      lastConnectError: null,
      ...over,
    };
  }

  it("getClient: caches the connected client across calls", async () => {
    const cfg = dummyServer();
    await store.saveMcpServers({ servers: [cfg] });

    let connectCalls = 0;
    pool.__setConnectOverride(async () => {
      connectCalls++;
      return makeLinkedClientPair(pingTool);
    });

    const a = await pool.getClient(cfg.id);
    const b = await pool.getClient(cfg.id);
    assert.equal(a, b, "second call must reuse the pooled client");
    assert.equal(connectCalls, 1);

    await pool.closeAll();
  });

  it("getClient: dedupes concurrent connects via the inflight map", async () => {
    const cfg = dummyServer();
    await store.saveMcpServers({ servers: [cfg] });

    let connectCalls = 0;
    pool.__setConnectOverride(async () => {
      connectCalls++;
      // Simulate a slow connect so both concurrent callers latch onto the
      // same inflight promise.
      await new Promise((r) => setTimeout(r, 10));
      return makeLinkedClientPair(pingTool);
    });

    const [a, b] = await Promise.all([pool.getClient(cfg.id), pool.getClient(cfg.id)]);
    assert.equal(a, b);
    assert.equal(connectCalls, 1, "concurrent calls must share one connect");

    await pool.closeAll();
  });

  it("getClient: persists the error on the server row when connect fails", async () => {
    const cfg = dummyServer();
    await store.saveMcpServers({ servers: [cfg] });

    pool.__setConnectOverride(async () => {
      throw new Error("boom");
    });

    await assert.rejects(() => pool.getClient(cfg.id), /boom/);
    const file = await store.loadMcpServers();
    const row = file.servers.find((s) => s.id === cfg.id)!;
    assert.equal(row.lastConnectError, "boom");
    assert.ok(row.lastConnectedAt, "lastConnectedAt should record the attempt");
  });

  it("getClient: does not memoize failures (next call retries)", async () => {
    const cfg = dummyServer();
    await store.saveMcpServers({ servers: [cfg] });

    let attempts = 0;
    pool.__setConnectOverride(async () => {
      attempts++;
      if (attempts === 1) throw new Error("first-failure");
      return makeLinkedClientPair(pingTool);
    });

    await assert.rejects(() => pool.getClient(cfg.id));
    const client = await pool.getClient(cfg.id);
    assert.ok(client);
    assert.equal(attempts, 2);

    await pool.closeAll();
  });

  it("getClient: rejects unknown ids and disabled servers", async () => {
    await store.saveMcpServers({ servers: [] });
    await assert.rejects(() => pool.getClient("unknown-id"), /not found/);

    const disabled = dummyServer({ enabled: false });
    await store.saveMcpServers({ servers: [disabled] });
    await assert.rejects(() => pool.getClient(disabled.id), /disabled/);
  });

  it("closeClient: drops one entry without affecting others", async () => {
    const a = dummyServer();
    const b = dummyServer();
    await store.saveMcpServers({ servers: [a, b] });

    let aClosed = 0;
    let bClosed = 0;
    pool.__setConnectOverride(async (s) => {
      const pair = await makeLinkedClientPair(pingTool);
      const orig = pair.close;
      return {
        client: pair.client,
        close: async () => {
          if (s.id === a.id) aClosed++;
          else bClosed++;
          await orig();
        },
      };
    });

    const ca = await pool.getClient(a.id);
    const cb = await pool.getClient(b.id);
    assert.ok(ca && cb);

    await pool.closeClient(a.id);
    assert.equal(aClosed, 1);
    assert.equal(bClosed, 0);

    // a is now gone — re-getting should reconnect.
    const ca2 = await pool.getClient(a.id);
    assert.notEqual(ca2, ca);

    await pool.closeAll();
  });

  it("closeAll: closes every pooled connection", async () => {
    const a = dummyServer();
    const b = dummyServer();
    await store.saveMcpServers({ servers: [a, b] });

    let closes = 0;
    pool.__setConnectOverride(async () => {
      const pair = await makeLinkedClientPair(pingTool);
      const orig = pair.close;
      return {
        client: pair.client,
        close: async () => {
          closes++;
          await orig();
        },
      };
    });

    await pool.getClient(a.id);
    await pool.getClient(b.id);
    await pool.closeAll();
    assert.equal(closes, 2);

    // Pool is empty now — getClient must reconnect.
    pool.__setConnectOverride(async () => makeLinkedClientPair(pingTool));
    const fresh = await pool.getClient(a.id);
    assert.ok(fresh);
    await pool.closeAll();
  });
});

// ─── Adapter tests (use the same seam) ───────────────────────────────────

describe("mcp adapter", () => {
  let pool: typeof import("./client.js");
  let adapter: typeof import("./adapter.js");
  let store: typeof import("../store/json.js");

  before(async () => {
    pool = await import("./client.js");
    adapter = await import("./adapter.js");
    store = await import("../store/json.js");
  });

  beforeEach(async () => {
    await rm(store.mcpServersPath(), { force: true });
    pool.__resetPool();
  });

  afterEach(() => {
    pool.__setConnectOverride(undefined);
  });

  it("namespaces remote tool names as mcp__<id>__<toolName>", async () => {
    const cfg: McpServerConfig = {
      id: "srv1",
      name: "fake",
      transport: "stdio",
      enabled: true,
      command: "node",
      lastConnectedAt: null,
      lastConnectError: null,
    };
    await store.saveMcpServers({ servers: [cfg] });

    pool.__setConnectOverride(async () =>
      makeLinkedClientPair((s) => {
        s.registerTool(
          "echo",
          { description: "Echoes input", inputSchema: { msg: z.string() } },
          async ({ msg }) => ({ content: [{ type: "text", text: msg as string }] }),
        );
        s.registerTool(
          "ping",
          { description: "pong", inputSchema: {} },
          async () => ({ content: [{ type: "text", text: "pong" }] }),
        );
      }),
    );

    const tools = await adapter.mcpToolsForServers([cfg.id]);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["mcp__srv1__echo", "mcp__srv1__ping"]);

    const echo = tools.find((t) => t.name === "mcp__srv1__echo")!;
    const result = await echo.execute(
      { msg: "hello" },
      { signal: new AbortController().signal, workingDir: "/", readPaths: new Set() },
    );
    assert.equal(result.content, "hello");

    await pool.closeAll();
  });

  it("surfaces remote errors as Tool result strings (not throws)", async () => {
    const cfg: McpServerConfig = {
      id: "srv2",
      name: "fake",
      transport: "stdio",
      enabled: true,
      command: "node",
      lastConnectedAt: null,
      lastConnectError: null,
    };
    await store.saveMcpServers({ servers: [cfg] });

    pool.__setConnectOverride(async () =>
      makeLinkedClientPair((s) => {
        s.registerTool(
          "boom",
          { description: "fails", inputSchema: {} },
          async () => ({
            isError: true,
            content: [{ type: "text", text: "things went wrong" }],
          }),
        );
      }),
    );

    const [tool] = await adapter.mcpToolsForServers([cfg.id]);
    const out = await tool.execute(
      {},
      { signal: new AbortController().signal, workingDir: "/", readPaths: new Set() },
    );
    assert.match(out.content, /things went wrong/);

    await pool.closeAll();
  });

  it("skips servers that fail to connect (warn + empty contribution)", async () => {
    const ok: McpServerConfig = {
      id: "ok",
      name: "ok",
      transport: "stdio",
      enabled: true,
      command: "node",
      lastConnectedAt: null,
      lastConnectError: null,
    };
    const bad: McpServerConfig = { ...ok, id: "bad", name: "bad" };
    await store.saveMcpServers({ servers: [ok, bad] });

    pool.__setConnectOverride(async (s) => {
      if (s.id === "bad") throw new Error("unreachable");
      return makeLinkedClientPair(pingTool);
    });

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const tools = await adapter.mcpToolsForServers([ok.id, bad.id]);
      const names = tools.map((t) => t.name);
      assert.deepEqual(names, ["mcp__ok__ping"]);
    } finally {
      console.warn = origWarn;
    }

    await pool.closeAll();
  });
});
