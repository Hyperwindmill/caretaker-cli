// Managed install of binary-distributed ACP agents (spec:
// 2026-08-25-acp-registry-presets). Download → sha256 verify → extract →
// chmod, all into a tmp sibling renamed into place on success, so a failed
// install leaves nothing behind. Idempotent per <id>/<version>: the saved
// provider just points at the resulting absolute path — nothing else in
// caretaker knows the binary is "managed".

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { dataDir } from '../store/json.js';
import type { AcpAgentPreset } from '../types.js';

const exec = promisify(execFile);

type FetchLike = (url: string) => Promise<Response>;
let fetchImpl: FetchLike = (url) => fetch(url);
export function __setFetch(f: FetchLike): void {
  fetchImpl = f;
}
export function __resetFetch(): void {
  fetchImpl = (url) => fetch(url);
}

export type InstalledAcp = { command: string; args: string[]; env?: Record<string, string> };

function isExtractable(name: string): boolean {
  return /\.(tar\.(gz|bz2|xz)|tgz|tbz2|tar|zip)$/i.test(name);
}

async function extract(archive: string, dest: string): Promise<void> {
  if (/\.zip$/i.test(archive) && process.platform === 'linux') {
    // GNU tar has no zip support; macOS and Windows ship bsdtar (which does).
    try {
      await exec('unzip', ['-o', archive, '-d', dest]);
      return;
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error(
          'unzip is required to extract .zip archives on Linux — install it (e.g. apt install unzip)',
        );
      }
      throw err;
    }
  }
  await exec('tar', ['-xf', archive, '-C', dest]);
}

export async function installAcpAgent(
  preset: AcpAgentPreset,
  onProgress: (line: string) => void = () => {},
): Promise<InstalledAcp> {
  const d = preset.dist;
  if (!d || d.kind !== 'binary') {
    throw new Error(`"${preset.id}" has no binary distribution for this platform`);
  }
  const dir = join(dataDir(), 'acp', preset.id, preset.version || 'latest');
  const command = resolve(dir, d.cmd);
  const result: InstalledAcp = { command, args: d.args ?? [], ...(d.env ? { env: d.env } : {}) };

  if (await stat(command).then(() => true).catch(() => false)) {
    onProgress('already installed');
    return result;
  }

  const tmp = `${dir}.tmp-${process.pid}`;
  try {
    await mkdir(tmp, { recursive: true });
    onProgress(`downloading ${d.archive}`);
    const res = await fetchImpl(d.archive);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    const archiveName = basename(new URL(d.archive).pathname);
    const archivePath = join(tmp, archiveName);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(archivePath));

    if (d.sha256) {
      onProgress('verifying checksum');
      const hash = createHash('sha256').update(await readFile(archivePath)).digest('hex');
      if (hash !== d.sha256) throw new Error(`sha256 mismatch: expected ${d.sha256}, got ${hash}`);
    }

    if (isExtractable(archiveName)) {
      onProgress('extracting');
      await extract(archivePath, tmp);
      await rm(archivePath, { force: true });
    } else {
      // Raw executable download (no archive): move it to the cmd path.
      const target = resolve(tmp, d.cmd);
      await mkdir(join(target, '..'), { recursive: true });
      await rename(archivePath, target);
    }

    const cmdInTmp = resolve(tmp, d.cmd);
    if (!(await stat(cmdInTmp).then(() => true).catch(() => false))) {
      throw new Error(`archive did not contain the expected command "${d.cmd}"`);
    }
    await chmod(cmdInTmp, 0o755).catch(() => {}); // no-op semantics on Windows

    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    onProgress('installed');
    return result;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    // Remove the (possibly just-created, empty) id dir if this was the first version.
    await rmdir(join(dataDir(), 'acp', preset.id)).catch(() => {});
    throw err instanceof Error ? err : new Error(String(err));
  }
}
