import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "../types.js";

let testHome: string;

function ctx(activePlugins: string[]): ToolContext {
  return {
    signal: new AbortController().signal,
    workingDir: process.cwd(),
    readPaths: new Set(),
    activePlugins,
  };
}

async function seedPlugin(
  store: typeof import("../../../store/json.js"),
  pluginName: string,
  commands: Record<string, { description?: string; argumentHint?: string; body: string }>,
) {
  await store.savePlugins({
    sources: [],
    plugins: [
      {
        id: randomUUID(),
        sourceId: randomUUID(),
        name: pluginName,
        description: null,
        manifestKind: "cc-plugin",
        relPath: ".",
        rawManifest: {},
        commands,
      },
    ],
  });
}

describe("invoke_command tool", () => {
  let invokeCommand: typeof import("./invoke_command.js").invokeCommandTool;
  let store: typeof import("../../../store/json.js");

  before(async () => {
    testHome = mkdtempSync(path.join(tmpdir(), "caretaker-invokecmd-"));
    process.env.CARETAKER_HOME = testHome;
    invokeCommand = (await import("./invoke_command.js")).invokeCommandTool;
    store = await import("../../../store/json.js");
  });

  after(async () => {
    await rm(testHome, { recursive: true, force: true });
    delete process.env.CARETAKER_HOME;
  });

  beforeEach(async () => {
    await rm(store.pluginsPath(), { force: true });
  });

  it("rejects empty/missing name", async () => {
    const out = await invokeCommand.execute({ name: "" }, ctx(["x"]));
    assert.match(out.content, /^Error:/);
  });

  it("returns Error when the command is not in any active plugin", async () => {
    await seedPlugin(store, "alpha", { foo: { body: "bar" } });
    // Plugin not active for this agent.
    const out = await invokeCommand.execute({ name: "foo" }, ctx([]));
    assert.match(out.content, /not available/);
  });

  it("expands $N positionals + $ARGUMENTS from the args string", async () => {
    await seedPlugin(store, "alpha", {
      assess: { body: "Run on $1 with target $2 — full: $ARGUMENTS" },
    });
    const out = await invokeCommand.execute(
      { name: "assess", args: "my-app target-vision" },
      ctx(["alpha"]),
    );
    assert.equal(out.content, "Run on my-app with target target-vision — full: my-app target-vision");
  });

  it("preserves double-quoted spans as one positional", async () => {
    await seedPlugin(store, "alpha", { greet: { body: "hi $1, from $2" } });
    const out = await invokeCommand.execute(
      { name: "greet", args: `"Daniele Traverso" Italy` },
      ctx(["alpha"]),
    );
    assert.equal(out.content, "hi Daniele Traverso, from Italy");
  });

  it("handles missing args field (empty expansion)", async () => {
    await seedPlugin(store, "alpha", { ping: { body: "$1/$ARGUMENTS/done" } });
    const out = await invokeCommand.execute({ name: "ping" }, ctx(["alpha"]));
    assert.equal(out.content, "//done");
  });
});
