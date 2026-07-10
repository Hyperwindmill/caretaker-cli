// Git source fetcher for plugin sources. Each source has its own cache dir
// at ~/.caretaker/plugin-cache/<sourceId> (UUID, no collision with the
// caretaker server's numeric ids if both run on the same host).
//
// Auth tokens stored in the source row are decrypted on demand via
// lib/encryption.ts; for legacy / unencrypted entries the value is used as-is.

import * as fs from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { decrypt, isEncrypted } from '../../lib/encryption.js';
import type { FetchResult } from '../types.js';

export interface GitFetchInput {
  url: string;
  ref: string | null;
  authToken: string | null;
}

type OnAuth = () => { username: string; password: string };

export interface GitClient {
  clone(args: {
    fs: unknown;
    http: unknown;
    dir: string;
    url: string;
    ref?: string;
    singleBranch: boolean;
    depth: number;
    onAuth?: OnAuth;
  }): Promise<void>;
  fetch(args: {
    fs: unknown;
    http: unknown;
    dir: string;
    url: string;
    ref?: string;
    singleBranch: boolean;
    depth: number;
    onAuth?: OnAuth;
  }): Promise<unknown>;
  checkout(args: { fs: unknown; dir: string; ref: string; force: boolean }): Promise<void>;
  resolveRef(args: { fs: unknown; dir: string; ref: string }): Promise<string>;
  currentBranch(args: { fs: unknown; dir: string }): Promise<string | undefined | void>;
}

const realIsomorphicGitClient: GitClient = {
  clone: (args) => git.clone(args as Parameters<typeof git.clone>[0]),
  fetch: (args) => git.fetch(args as Parameters<typeof git.fetch>[0]),
  checkout: (args) => git.checkout(args as Parameters<typeof git.checkout>[0]),
  resolveRef: (args) => git.resolveRef(args as Parameters<typeof git.resolveRef>[0]),
  currentBranch: (args) => git.currentBranch(args as Parameters<typeof git.currentBranch>[0]),
};

let gitImpl: GitClient = realIsomorphicGitClient;

/** Testing seam: inject a mock GitClient. Pass `null` to restore the real isomorphic-git client. */
export function __setGitClient(impl: GitClient | null): void {
  gitImpl = impl ?? realIsomorphicGitClient;
}

function plainToken(authToken: string): string {
  return isEncrypted(authToken) ? decrypt(authToken) : authToken;
}

function buildOnAuth(authToken: string | null): OnAuth | undefined {
  if (!authToken) return undefined;
  const password = plainToken(authToken);
  return () => ({ username: 'x-access-token', password });
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function fetchGit(input: GitFetchInput, cacheDir: string): Promise<FetchResult> {
  const onAuth = buildOnAuth(input.authToken);
  const gitDir = path.join(cacheDir, '.git');
  const alreadyCloned = await dirExists(gitDir);

  if (!alreadyCloned) {
    await mkdir(cacheDir, { recursive: true });
    await gitImpl.clone({
      fs,
      http,
      dir: cacheDir,
      url: input.url,
      ref: input.ref ?? undefined,
      singleBranch: true,
      depth: 1,
      onAuth,
    });
  } else {
    try {
      // Pass URL explicitly so cache moves between hosts (e.g. URL change in
      // plugins.json) work without us editing the repo's stored remote config.
      await gitImpl.fetch({
        fs,
        http,
        dir: cacheDir,
        url: input.url,
        ref: input.ref ?? undefined,
        singleBranch: true,
        depth: 1,
        onAuth,
      });
      const target =
        input.ref ??
        ((await gitImpl.currentBranch({ fs, dir: cacheDir })) as string | undefined) ??
        'HEAD';
      await gitImpl.checkout({ fs, dir: cacheDir, ref: target, force: true });
    } catch {
      // ponytail: iso-git's in-place update is unreliable on Windows — it reports
      // the working tree as dirty (filemode/stat mismatch, or locked files) and
      // throws CheckoutConflictError even with force:true, where Linux succeeds.
      // Don't fight the dirty-detection: nuke the cache and reclone (shallow, so
      // cheap). Platform-agnostic, self-heals corrupted caches too. The reclone
      // path has no catch, so a genuine clone/network failure still propagates.
      await rm(cacheDir, { recursive: true, force: true });
      return fetchGit(input, cacheDir);
    }
  }

  const sha = await gitImpl.resolveRef({ fs, dir: cacheDir, ref: 'HEAD' });
  return { root: cacheDir, sha };
}
