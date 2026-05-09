import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

let testHome: string;

describe("plugin skill loader", () => {
  let loader: typeof import("./loader.js");
  let store: typeof import("../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-loader-"));
    process.env.CARETAKER_HOME = testHome;
    loader = await import("./loader.js");
    store = await import("../store/json.js");
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  async function seed(opts: {
    sourceUrl: string;
    pluginName: string;
    relPath: string;
    manifestKind?: "skill-glob" | "cc-plugin" | "cc-marketplace";
  }) {
    const sourceId = randomUUID();
    await store.savePlugins({
      sources: [
        {
          id: sourceId,
          kind: "path",
          url: opts.sourceUrl,
          refreshOnStart: false,
        },
      ],
      plugins: [
        {
          id: randomUUID(),
          sourceId,
          name: opts.pluginName,
          description: null,
          manifestKind: opts.manifestKind ?? "skill-glob",
          relPath: opts.relPath,
          rawManifest: {},
        },
      ],
    });
  }

  it("returns empty string when activeNames is empty", async () => {
    assert.equal(await loader.loadPluginSkills([]), "");
  });

  it("returns empty string when no plugin matches by name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    try {
      await seed({ sourceUrl: dir, pluginName: "real", relPath: "real" });
      assert.equal(await loader.loadPluginSkills(["nonexistent"]), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a skill-glob plugin with its SKILL.md content", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    const skillDir = path.join(dir, "skills", "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "Do the thing.\n");
    try {
      await seed({ sourceUrl: dir, pluginName: "my-skill", relPath: "skills/my-skill" });
      const out = await loader.loadPluginSkills(["my-skill"]);
      assert.ok(out.includes('<skill name="my-skill">'));
      assert.ok(out.includes("Do the thing."));
      assert.ok(out.includes("</skill>"));
      assert.ok(out.startsWith("The following skills"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips silently when SKILL.md is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    const skillDir = path.join(dir, "skills", "absent");
    mkdirSync(skillDir, { recursive: true });
    try {
      await seed({ sourceUrl: dir, pluginName: "absent", relPath: "skills/absent" });
      assert.equal(await loader.loadPluginSkills(["absent"]), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders multiple plugins concatenated", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    const a = path.join(dir, "alpha");
    const b = path.join(dir, "beta");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(path.join(a, "SKILL.md"), "Alpha skill.\n");
    writeFileSync(path.join(b, "SKILL.md"), "Beta skill.\n");
    const sourceId = randomUUID();
    await store.savePlugins({
      sources: [{ id: sourceId, kind: "path", url: dir, refreshOnStart: false }],
      plugins: [
        { id: randomUUID(), sourceId, name: "alpha", description: null, manifestKind: "skill-glob", relPath: "alpha", rawManifest: {} },
        { id: randomUUID(), sourceId, name: "beta", description: null, manifestKind: "skill-glob", relPath: "beta", rawManifest: {} },
      ],
    });
    try {
      const out = await loader.loadPluginSkills(["alpha", "beta"]);
      assert.ok(out.includes('<skill name="alpha">'));
      assert.ok(out.includes("Alpha skill."));
      assert.ok(out.includes('<skill name="beta">'));
      assert.ok(out.includes("Beta skill."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects relPath that escapes the source root", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    try {
      await seed({ sourceUrl: dir, pluginName: "evil", relPath: "../../outside" });
      assert.equal(await loader.loadPluginSkills(["evil"]), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes XML-special characters in plugin names", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    mkdirSync(path.join(dir, "x"), { recursive: true });
    writeFileSync(path.join(dir, "x", "SKILL.md"), "x");
    try {
      await seed({ sourceUrl: dir, pluginName: 'foo<bar"&baz', relPath: "x" });
      const out = await loader.loadPluginSkills(['foo<bar"&baz']);
      assert.ok(out.includes("foo&lt;bar&quot;&amp;baz"));
      assert.ok(!out.includes('foo<bar"&baz">'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders cc-plugin via recursive SKILL.md glob under the plugin root", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    // The plugin is the entire source root (relPath="."), with multiple SKILL.md files inside.
    mkdirSync(path.join(dir, "skills", "one"), { recursive: true });
    mkdirSync(path.join(dir, "skills", "two"), { recursive: true });
    writeFileSync(path.join(dir, "skills", "one", "SKILL.md"), "Skill one.\n");
    writeFileSync(path.join(dir, "skills", "two", "SKILL.md"), "Skill two.\n");
    try {
      await seed({ sourceUrl: dir, pluginName: "bundle", relPath: ".", manifestKind: "cc-plugin" });
      const out = await loader.loadPluginSkills(["bundle"]);
      assert.ok(out.includes("Skill one."));
      assert.ok(out.includes("Skill two."));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a SKILL.md exceeding the size cap", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
    const skillDir = path.join(dir, "huge");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "x".repeat(100_001));
    try {
      await seed({ sourceUrl: dir, pluginName: "huge", relPath: "huge" });
      // Silence the warn during the test
      const origWarn = console.warn;
      console.warn = () => {};
      try {
        assert.equal(await loader.loadPluginSkills(["huge"]), "");
      } finally {
        console.warn = origWarn;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
