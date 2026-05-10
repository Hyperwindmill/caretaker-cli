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
    description?: string | null;
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
          description: opts.description ?? null,
          manifestKind: opts.manifestKind ?? "skill-glob",
          relPath: opts.relPath,
          rawManifest: {},
        },
      ],
    });
  }

  describe("listActiveSkills", () => {
    it("returns empty when activeNames is empty", async () => {
      assert.deepEqual(await loader.listActiveSkills([]), []);
    });

    it("returns empty when no plugin matches", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      try {
        await seed({ sourceUrl: dir, pluginName: "real", relPath: "real" });
        assert.deepEqual(await loader.listActiveSkills(["nonexistent"]), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns name + description for each active plugin", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      try {
        await seed({
          sourceUrl: dir,
          pluginName: "alpha",
          relPath: "a",
          description: "do alpha things",
        });
        const out = await loader.listActiveSkills(["alpha"]);
        assert.deepEqual(out, [{ name: "alpha", description: "do alpha things" }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("description defaults to empty string when null", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      try {
        await seed({ sourceUrl: dir, pluginName: "bare", relPath: "b" });
        const out = await loader.listActiveSkills(["bare"]);
        assert.deepEqual(out, [{ name: "bare", description: "" }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("readActiveSkill", () => {
    it("returns content for an active skill-glob plugin", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      const skillDir = path.join(dir, "skills", "my-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "Do the thing.\n");
      try {
        await seed({ sourceUrl: dir, pluginName: "my-skill", relPath: "skills/my-skill" });
        const out = await loader.readActiveSkill("my-skill", ["my-skill"]);
        assert.equal(out, "Do the thing.\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns null when name is not in active list", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      const skillDir = path.join(dir, "x");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "x");
      try {
        await seed({ sourceUrl: dir, pluginName: "x", relPath: "x" });
        // Plugin exists in plugins.json but the agent did not activate it.
        assert.equal(await loader.readActiveSkill("x", []), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns null when SKILL.md is missing", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      const skillDir = path.join(dir, "absent");
      mkdirSync(skillDir, { recursive: true });
      try {
        await seed({ sourceUrl: dir, pluginName: "absent", relPath: "absent" });
        assert.equal(await loader.readActiveSkill("absent", ["absent"]), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects relPath that escapes the source root", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      try {
        await seed({ sourceUrl: dir, pluginName: "evil", relPath: "../../outside" });
        assert.equal(await loader.readActiveSkill("evil", ["evil"]), null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("concatenates SKILL.md files for cc-plugin sources", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      mkdirSync(path.join(dir, "skills", "one"), { recursive: true });
      mkdirSync(path.join(dir, "skills", "two"), { recursive: true });
      writeFileSync(path.join(dir, "skills", "one", "SKILL.md"), "Skill one.\n");
      writeFileSync(path.join(dir, "skills", "two", "SKILL.md"), "Skill two.\n");
      try {
        await seed({
          sourceUrl: dir,
          pluginName: "bundle",
          relPath: ".",
          manifestKind: "cc-plugin",
        });
        const out = await loader.readActiveSkill("bundle", ["bundle"]);
        assert.ok(out !== null);
        assert.ok(out.includes("Skill one."));
        assert.ok(out.includes("Skill two."));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns null when SKILL.md exceeds the size cap", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "plug-loader-"));
      const skillDir = path.join(dir, "huge");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "x".repeat(100_001));
      try {
        await seed({ sourceUrl: dir, pluginName: "huge", relPath: "huge" });
        const origWarn = console.warn;
        console.warn = () => {};
        try {
          assert.equal(await loader.readActiveSkill("huge", ["huge"]), null);
        } finally {
          console.warn = origWarn;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
