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

describe("refreshSourcesOnStart", () => {
  let mod: typeof import("./refresh_on_start.js");
  let mgr: typeof import("./source_manager.js");
  let store: typeof import("../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-refresh-start-home-"));
    testCache = mkdtempSync(path.join(tmpdir(), "caretaker-refresh-start-cache-"));
    process.env.CARETAKER_HOME = testHome;
    process.env.PLUGIN_CACHE_DIR = testCache;
    mod = await import("./refresh_on_start.js");
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

  function makePathSource(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-ros-"));
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin/plugin.json"),
      JSON.stringify({ name }),
    );
    return dir;
  }

  it("returns [] when no source is flagged refreshOnStart", async () => {
    const dir = makePathSource("nope");
    try {
      await mgr.createSource({ kind: "path", url: dir, refreshOnStart: false });
      const results = await mod.refreshSourcesOnStart();
      assert.deepEqual(results, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes only sources with refreshOnStart=true", async () => {
    const a = makePathSource("alpha");
    const b = makePathSource("beta");
    try {
      const sa = await mgr.createSource({ kind: "path", url: a, refreshOnStart: true });
      const sb = await mgr.createSource({ kind: "path", url: b, refreshOnStart: false });
      const results = await mod.refreshSourcesOnStart();
      assert.equal(results.length, 1);
      assert.equal(results[0].sourceId, sa.id);
      assert.equal(results[0].outcome.pluginsFound, 1);
      assert.equal(results[0].outcome.error, null);
      // Source A has fetch metadata, source B does not.
      const refreshed = await mgr.getSource(sa.id);
      const untouched = await mgr.getSource(sb.id);
      assert.ok(refreshed?.lastFetchedAt);
      assert.equal(untouched?.lastFetchedAt, null);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("captures failures per-source and keeps going", async () => {
    const ok = makePathSource("ok");
    const broken = mkdtempSync(path.join(tmpdir(), "plug-ros-broken-"));
    // No manifest in `broken` → discoverPlugins throws NoPluginsFoundError.
    try {
      const sok = await mgr.createSource({ kind: "path", url: ok, refreshOnStart: true });
      const sbr = await mgr.createSource({ kind: "path", url: broken, refreshOnStart: true });

      const origErr = console.error;
      console.error = () => {};
      let results;
      try {
        results = await mod.refreshSourcesOnStart();
      } finally {
        console.error = origErr;
      }
      assert.equal(results.length, 2);
      const okResult = results.find((r) => r.sourceId === sok.id);
      const brResult = results.find((r) => r.sourceId === sbr.id);
      assert.ok(okResult && okResult.outcome.error === null);
      assert.ok(brResult && brResult.outcome.error);
    } finally {
      rmSync(ok, { recursive: true, force: true });
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
