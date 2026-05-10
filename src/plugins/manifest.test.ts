import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { discoverPlugins, discoverPluginMcpServers } from "./manifest.js";
import { NoPluginsFoundError } from "./types.js";

function mk(root: string, rel: string, content: string) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

test("discoverPlugins reads .claude-plugin/marketplace.json", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          { name: "alpha", source: "./alpha", description: "First" },
          { name: "beta", source: "./beta" },
        ],
      }),
    );
    const found = await discoverPlugins(dir);
    assert.equal(found.length, 2);
    assert.equal(found[0].name, "alpha");
    assert.equal(found[0].manifestKind, "cc-marketplace");
    assert.equal(found[0].relPath, "./alpha");
    assert.equal(found[0].description, "First");
    assert.equal(found[1].description, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins reads .claude-plugin/plugin.json as a marketplace of one", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/plugin.json",
      JSON.stringify({ name: "solo", description: "Only" }),
    );
    const found = await discoverPlugins(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "solo");
    assert.equal(found[0].manifestKind, "cc-plugin");
    assert.equal(found[0].relPath, ".");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPluginMcpServers reads .mcp.json with the official wrappered shape", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-mcp-"));
  try {
    mk(
      dir,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          youtrack: {
            type: "stdio",
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/scripts/proxy.cjs"],
          },
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          greptile: {
            type: "http",
            url: "https://api.greptile.com/mcp",
            headers: { Authorization: "Bearer ${GREPTILE_API_KEY}" },
          },
          missing: { foo: "bar" }, // dropped — neither command nor url
        },
      }),
    );
    const out = await discoverPluginMcpServers(dir);
    assert.ok(out);
    assert.deepEqual(Object.keys(out!).sort(), ["greptile", "linear", "youtrack"]);
    const yt = out!.youtrack as { command: string; args: string[] };
    assert.equal(yt.command, "node");
    assert.deepEqual(yt.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/proxy.cjs"]);
    const greptile = out!.greptile as { url: string; headers: Record<string, string> };
    assert.equal(greptile.headers.Authorization, "Bearer ${GREPTILE_API_KEY}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPluginMcpServers reads .mcp.json with the bare-map shape", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-mcp-"));
  try {
    mk(
      dir,
      ".mcp.json",
      JSON.stringify({
        playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
      }),
    );
    const out = await discoverPluginMcpServers(dir);
    assert.ok(out);
    const pw = out!.playwright as { command: string; args: string[] };
    assert.equal(pw.command, "npx");
    assert.deepEqual(pw.args, ["@playwright/mcp@latest"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPluginMcpServers returns undefined when .mcp.json is absent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-mcp-"));
  try {
    assert.equal(await discoverPluginMcpServers(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPluginMcpServers tolerates malformed JSON without throwing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-mcp-"));
  try {
    mk(dir, ".mcp.json", "{ this is not json }");
    assert.equal(await discoverPluginMcpServers(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins falls back to SKILL.md glob when no manifest is present", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(dir, "skills/foo/SKILL.md", "---\nname: foo\ndescription: Foo skill\n---\nbody");
    mk(dir, "skills/bar/SKILL.md", "no-frontmatter content");
    const found = await discoverPlugins(dir);
    assert.equal(found.length, 2);
    const byName = Object.fromEntries(found.map((p) => [p.name, p]));
    assert.ok(byName.foo);
    assert.equal(byName.foo.manifestKind, "skill-glob");
    assert.equal(byName.foo.description, "Foo skill");
    assert.equal(byName.foo.relPath, "skills/foo");
    assert.ok(byName.bar);
    assert.equal(byName.bar.description, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins throws NoPluginsFoundError on an empty directory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    await assert.rejects(discoverPlugins(dir), NoPluginsFoundError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins rejects entries that escape the source root", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          { name: "good", source: "./inside" },
          { name: "evil", source: "../outside" },
        ],
      }),
    );
    const found = await discoverPlugins(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "good");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins keeps the first of duplicate names within a single source", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          { name: "dup", source: "./a" },
          { name: "dup", source: "./b" },
        ],
      }),
    );
    const found = await discoverPlugins(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].relPath, "./a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins falls through when marketplace.json contains only invalid entries", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          { source: "./no-name-here" },
          { name: "evil", source: "../../etc" },
        ],
      }),
    );
    mk(
      dir,
      ".claude-plugin/plugin.json",
      JSON.stringify({ name: "fallback-target" }),
    );
    const found = await discoverPlugins(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "fallback-target");
    assert.equal(found[0].manifestKind, "cc-plugin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
