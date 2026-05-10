import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { discoverPlugins } from "./manifest.js";
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

test("discoverPlugins extracts mcpServers from plugin.json (stdio + http shapes)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/plugin.json",
      JSON.stringify({
        name: "pack",
        mcpServers: {
          local: { command: "node", args: ["server.js"], env: { DEBUG: "1" } },
          remote: { url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } },
          missing: { foo: "bar" }, // dropped — neither command nor url
        },
      }),
    );
    const [found] = await discoverPlugins(dir);
    assert.ok(found.mcpServers);
    assert.deepEqual(Object.keys(found.mcpServers!).sort(), ["local", "remote"]);
    const local = found.mcpServers!.local as { command: string; args?: string[]; env?: Record<string, string> };
    assert.equal(local.command, "node");
    assert.deepEqual(local.args, ["server.js"]);
    assert.deepEqual(local.env, { DEBUG: "1" });
    const remote = found.mcpServers!.remote as { url: string; headers?: Record<string, string> };
    assert.equal(remote.url, "https://mcp.example.com");
    assert.deepEqual(remote.headers, { Authorization: "Bearer x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPlugins propagates mcpServers from marketplace entries", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "plug-"));
  try {
    mk(
      dir,
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [
          {
            name: "alpha",
            source: "./alpha",
            mcpServers: { gh: { command: "npx", args: ["-y", "@x/gh"] } },
          },
          { name: "beta", source: "./beta" },
        ],
      }),
    );
    const found = await discoverPlugins(dir);
    const alpha = found.find((p) => p.name === "alpha")!;
    const beta = found.find((p) => p.name === "beta")!;
    assert.ok(alpha.mcpServers);
    assert.equal(Object.keys(alpha.mcpServers!).length, 1);
    assert.equal(beta.mcpServers, undefined);
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
