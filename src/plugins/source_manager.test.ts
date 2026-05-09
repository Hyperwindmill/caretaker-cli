import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

let testHome: string;
let testCache: string;

describe("source_manager", () => {
  let mgr: typeof import("./source_manager.js");
  let store: typeof import("../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-srcmgr-home-"));
    testCache = mkdtempSync(path.join(tmpdir(), "caretaker-srcmgr-cache-"));
    process.env.CARETAKER_HOME = testHome;
    process.env.PLUGIN_CACHE_DIR = testCache;
    mgr = await import("./source_manager.js");
    store = await import("../store/json.js");
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    await rm(testCache, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
    delete process.env.PLUGIN_CACHE_DIR;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  function makePathSource(name: string, description?: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-src-"));
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin/plugin.json"),
      JSON.stringify({ name, description }),
    );
    return dir;
  }

  it("createSource persists a path source", async () => {
    const dir = makePathSource("x", "desc");
    try {
      const created = await mgr.createSource({ kind: "path", url: dir });
      assert.equal(created.kind, "path");
      assert.equal(created.url, dir);
      assert.equal(created.lastFetchedAt, null);
      const list = await mgr.listSources();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, created.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshSource against a path source populates plugins and metadata", async () => {
    const dir = makePathSource("alpha", "Alpha plugin");
    try {
      const created = await mgr.createSource({ kind: "path", url: dir });
      const result = await mgr.refreshSource(created.id);
      assert.equal(result.pluginsFound, 1);
      assert.equal(result.sha, null);
      assert.equal(result.error, null);

      const plugins = (await mgr.listPlugins()).filter((p) => p.sourceId === created.id);
      assert.equal(plugins.length, 1);
      assert.equal(plugins[0].name, "alpha");
      assert.equal(plugins[0].manifestKind, "cc-plugin");

      const src = await mgr.getSource(created.id);
      assert.ok(src);
      assert.ok(src.lastFetchedAt);
      assert.equal(src.lastFetchError, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshSource: failure on a previously-OK source preserves prior plugins, writes the error", async () => {
    const dir = makePathSource("tmp");
    try {
      const created = await mgr.createSource({ kind: "path", url: dir });
      await mgr.refreshSource(created.id);
      // Break the source.
      rmSync(path.join(dir, ".claude-plugin"), { recursive: true, force: true });
      const second = await mgr.refreshSource(created.id);
      assert.equal(second.pluginsFound, 0);
      assert.ok(second.error && /no manifest|no plugins/i.test(second.error));

      const src = await mgr.getSource(created.id);
      assert.ok(src);
      assert.ok(src.lastFetchError && /no manifest|no plugins/i.test(src.lastFetchError));
      // Plugins from the prior successful refresh stay until the next success.
      const plugins = (await mgr.listPlugins()).filter((p) => p.sourceId === created.id);
      assert.equal(plugins.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshSource serialises concurrent calls for the same source id", async () => {
    const dir = makePathSource("ser");
    try {
      const created = await mgr.createSource({ kind: "path", url: dir });
      const [a, b] = await Promise.all([
        mgr.refreshSource(created.id),
        mgr.refreshSource(created.id),
      ]);
      assert.deepEqual(a, b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deleteSource cascades the source's plugins", async () => {
    const dir = makePathSource("to-delete");
    try {
      const created = await mgr.createSource({ kind: "path", url: dir });
      await mgr.refreshSource(created.id);
      const ok = await mgr.deleteSource(created.id);
      assert.equal(ok, true);
      const sources = await mgr.listSources();
      assert.equal(sources.find((s) => s.id === created.id), undefined);
      const plugins = (await mgr.listPlugins()).filter((p) => p.sourceId === created.id);
      assert.equal(plugins.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deleteSource returns false on unknown id", async () => {
    const ok = await mgr.deleteSource("does-not-exist");
    assert.equal(ok, false);
  });

  it("patchSource updates ref and refreshOnStart but not the kind", async () => {
    const dir = makePathSource("p");
    try {
      const created = await mgr.createSource({ kind: "path", url: dir });
      const patched = await mgr.patchSource(created.id, { refreshOnStart: true });
      assert.ok(patched);
      assert.equal(patched.refreshOnStart, true);
      assert.equal(patched.kind, "path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
