import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  expandTemplate,
  parseSlashInvocation,
  tokenizeArgs,
} from "./loader.js";
import type { CommandSpec, PluginRecord } from "../types.js";

let testHome: string;

describe("tokenizeArgs", () => {
  it("splits bare words on whitespace", () => {
    assert.deepEqual(tokenizeArgs("a b c"), ["a", "b", "c"]);
  });
  it("keeps double-quoted spans as one arg", () => {
    assert.deepEqual(tokenizeArgs(`a "b c" d`), ["a", "b c", "d"]);
  });
  it("returns [] for empty input", () => {
    assert.deepEqual(tokenizeArgs(""), []);
    assert.deepEqual(tokenizeArgs("   "), []);
  });
});

describe("parseSlashInvocation", () => {
  it("returns null when input does not start with /", () => {
    assert.equal(parseSlashInvocation("hello"), null);
  });
  it("returns null on lone slash with no command name", () => {
    assert.equal(parseSlashInvocation("/"), null);
    assert.equal(parseSlashInvocation("/   "), null);
  });
  it("parses /name with no args", () => {
    assert.deepEqual(parseSlashInvocation("/foo"), { name: "foo", args: [], raw: "" });
  });
  it("parses /name with positional args and preserves raw tail", () => {
    assert.deepEqual(parseSlashInvocation("/foo a b"), {
      name: "foo",
      args: ["a", "b"],
      raw: "a b",
    });
  });
  it("preserves a quoted span as one positional", () => {
    assert.deepEqual(parseSlashInvocation(`/foo a "b c"`), {
      name: "foo",
      args: ["a", "b c"],
      raw: `a "b c"`,
    });
  });
});

describe("expandTemplate", () => {
  it("substitutes $1, $2, …", () => {
    assert.equal(expandTemplate("hi $1 from $2", ["alice", "rome"], ""), "hi alice from rome");
  });
  it("missing positionals collapse to empty", () => {
    assert.equal(expandTemplate("[$1][$2][$3]", ["a"], "a"), "[a][][]");
  });
  it("substitutes $ARGUMENTS with the raw tail", () => {
    assert.equal(expandTemplate("ran: $ARGUMENTS", [], "x y --flag"), "ran: x y --flag");
  });
  it("does NOT substitute $0 or $10+ (out of supported range)", () => {
    assert.equal(expandTemplate("$0 / $10", [], ""), "$0 / $10");
  });
});

describe("listActiveCommands / resolveCommand", () => {
  let loader: typeof import("./loader.js");
  let store: typeof import("../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-cmd-"));
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

  function pluginRecord(over: Partial<PluginRecord>): PluginRecord {
    return {
      id: randomUUID(),
      sourceId: randomUUID(),
      name: "p",
      description: null,
      manifestKind: "cc-plugin",
      relPath: ".",
      rawManifest: {},
      ...over,
    };
  }

  async function seed(plugins: PluginRecord[]): Promise<void> {
    await store.savePlugins({ sources: [], plugins });
  }

  it("lists commands from active plugins, in the agent's plugin order", async () => {
    const cmd = (body: string): CommandSpec => ({ body });
    await seed([
      pluginRecord({ name: "alpha", commands: { foo: cmd("alpha-foo"), bar: cmd("alpha-bar") } }),
      pluginRecord({ name: "beta", commands: { baz: cmd("beta-baz") } }),
      pluginRecord({ name: "gamma-inactive", commands: { quux: cmd("gamma-quux") } }),
    ]);

    const out = await loader.listActiveCommands(["alpha", "beta"]);
    const names = out.map((c) => c.name);
    assert.deepEqual(names, ["foo", "bar", "baz"]);
    // gamma-inactive's commands are not listed.
    assert.equal(out.find((c) => c.name === "quux"), undefined);
  });

  it("first-plugin-wins on collision", async () => {
    const cmd = (body: string): CommandSpec => ({ body });
    await seed([
      pluginRecord({ name: "alpha", commands: { foo: cmd("from-alpha") } }),
      pluginRecord({ name: "beta", commands: { foo: cmd("from-beta") } }),
    ]);

    // alpha first → /foo resolves to alpha's body
    const r1 = await loader.resolveCommand("foo", ["alpha", "beta"]);
    assert.equal(r1?.spec.body, "from-alpha");
    assert.equal(r1?.pluginName, "alpha");

    // beta first → /foo resolves to beta's body
    const r2 = await loader.resolveCommand("foo", ["beta", "alpha"]);
    assert.equal(r2?.spec.body, "from-beta");
  });

  it("returns null when the command exists only on a non-active plugin", async () => {
    await seed([
      pluginRecord({ name: "secret", commands: { hidden: { body: "x" } } }),
    ]);
    assert.equal(await loader.resolveCommand("hidden", []), null);
    assert.equal(await loader.resolveCommand("hidden", ["other-plugin"]), null);
    // But it resolves when activated.
    assert.ok(await loader.resolveCommand("hidden", ["secret"]));
  });

  it("returns null for empty/whitespace command names", async () => {
    await seed([pluginRecord({ name: "p", commands: { foo: { body: "x" } } })]);
    assert.equal(await loader.resolveCommand("", ["p"]), null);
    assert.equal(await loader.resolveCommand("   ", ["p"]), null);
  });
});
