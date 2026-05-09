import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editTool, applyEdit } from "./edit.js";

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

test("applyEdit: replaces a single occurrence", () => {
  assert.equal(applyEdit("hello world", "world", "there", false), "hello there");
});

test("applyEdit: replaceAll replaces every occurrence", () => {
  assert.equal(applyEdit("a a a", "a", "b", true), "b b b");
});

test("applyEdit: throws when oldString is not found", () => {
  assert.throws(() => applyEdit("foo", "bar", "x", false), /EOLDSTRING_NOT_FOUND/);
});

test("applyEdit: throws when oldString is non-unique without replaceAll", () => {
  assert.throws(() => applyEdit("a a", "a", "x", false), /EOLDSTRING_NOT_UNIQUE/);
});

test("applyEdit: oldString equal to newString is a no-op", () => {
  assert.equal(applyEdit("hello", "hello", "hello", false), "hello");
});

test("edit: applies a replacement and updates readPaths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-e-"));
  await writeFile(join(dir, "doc.txt"), "alpha beta gamma");
  const c = ctx(dir);
  const out = await editTool.execute(
    { path: "doc.txt", oldString: "beta", newString: "BETA" },
    c,
  );
  assert.match(out.content, /Applied edit/);
  assert.equal(await readFile(join(dir, "doc.txt"), "utf-8"), "alpha BETA gamma");
  assert.ok(c.readPaths.size > 0);
});

test("edit: sandbox rejects path traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-e-"));
  const out = await editTool.execute(
    { path: "../escape.txt", oldString: "x", newString: "y" },
    ctx(dir),
  );
  assert.match(out.content, /outside the working directory/);
});

test("edit: ENOENT on missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-e-"));
  const out = await editTool.execute(
    { path: "missing.txt", oldString: "x", newString: "y" },
    ctx(dir),
  );
  assert.match(out.content, /file not found/);
});
