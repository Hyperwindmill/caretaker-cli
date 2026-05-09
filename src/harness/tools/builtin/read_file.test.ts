import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFileTool } from "./read_file.js";

function ctx(workingDir: string) {
  return {
    signal: new AbortController().signal,
    workingDir,
    readPaths: new Set<string>(),
  };
}

test("read_file: relative path emits cat -n line-numbered output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  await writeFile(join(dir, "hello.txt"), "ciao\nmondo");
  const out = await readFileTool.execute({ path: "hello.txt" }, ctx(dir));
  assert.equal(out.content, "     1\tciao\n     2\tmondo");
});

test("read_file: populates ctx.readPaths on success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  await writeFile(join(dir, "x.txt"), "x");
  const c = ctx(dir);
  await readFileTool.execute({ path: "x.txt" }, c);
  assert.ok(c.readPaths.has(resolve(dir, "x.txt")));
});

test("read_file: absolute path outside workingDir is rejected by sandbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "ct-rf-other-"));
  await writeFile(join(elsewhere, "secret.txt"), "secret");
  const out = await readFileTool.execute({ path: join(elsewhere, "secret.txt") }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test("read_file: '..' traversal is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  const out = await readFileTool.execute({ path: "../escape.txt" }, ctx(dir));
  assert.match(out.content, /outside the working directory/);
});

test("read_file: missing path argument returns error", async () => {
  const out = await readFileTool.execute({}, ctx(tmpdir()));
  assert.match(out.content, /Error: path must be/);
});

test("read_file: ENOENT surfaces a file-not-found error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  const out = await readFileTool.execute({ path: "missing.txt" }, ctx(dir));
  assert.match(out.content, /Error: file not found/);
});

test("read_file: directory path returns directory error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  const out = await readFileTool.execute({ path: "." }, ctx(dir));
  assert.match(out.content, /Error: path is a directory/);
});

test("read_file: binary file is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  const path = join(dir, "bin.dat");
  // Buffer of mostly NUL bytes — definitively binary by the sampling heuristic.
  await writeFile(path, Buffer.from([0, 0, 0, 0xff, 0, 0, 0, 0, 0]));
  const out = await readFileTool.execute({ path: "bin.dat" }, ctx(dir));
  assert.match(out.content, /appears to be binary/);
});

test("read_file: offset and limit paginate the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ct-rf-"));
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
  await writeFile(join(dir, "many.txt"), lines);
  const out = await readFileTool.execute({ path: "many.txt", offset: 3, limit: 2 }, ctx(dir));
  assert.match(out.content, /^     3\tline3\n     4\tline4/);
  assert.match(out.content, /Showing lines 3-4 of 10/);
});
