import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeTool } from "./write.js";

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

test("write: creates a new file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-w-"));
  const out = await writeTool.execute({ path: "new.txt", content: "hello" }, ctx(dir));
  assert.match(out.content, /^Wrote 5 bytes to new\.txt$/);
  assert.equal(await readFile(join(dir, "new.txt"), "utf-8"), "hello");
});

test("write: refuses to overwrite an unread existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-w-"));
  await writeFile(join(dir, "exists.txt"), "old");
  const out = await writeTool.execute({ path: "exists.txt", content: "new" }, ctx(dir));
  assert.match(out.content, /was not read in this run/);
  assert.equal(await readFile(join(dir, "exists.txt"), "utf-8"), "old");
});

test("write: allows overwrite when the path was added to readPaths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-w-"));
  const path = join(dir, "exists.txt");
  await writeFile(path, "old");
  const c = ctx(dir);
  c.readPaths.add(resolve(path));
  const out = await writeTool.execute({ path: "exists.txt", content: "new" }, c);
  assert.match(out.content, /Wrote 3 bytes/);
  assert.equal(await readFile(path, "utf-8"), "new");
});

test("write: creates parent directories as needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-w-"));
  const out = await writeTool.execute(
    { path: "a/b/c/leaf.txt", content: "deep" },
    ctx(dir),
  );
  assert.match(out.content, /Wrote/);
  assert.equal(await readFile(join(dir, "a", "b", "c", "leaf.txt"), "utf-8"), "deep");
});

test("write: sandbox rejects paths outside workingDir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-w-"));
  const out = await writeTool.execute({ path: "../escape.txt", content: "x" }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});
