// Update notice routes (web server only). See
// docs/superpowers/specs/2026-11-25-update-notice-design.md.
// Deliberately undocumented in openapi.ts: GUI internals, like voice and ui-state.

import type { Hono } from 'hono';
import { loadConfig, loadUiState, saveUiState } from '../../store/json.js';
import { probeShellEnv } from '../../harness/tools/builtin/shell-env.js';
import { cliVersion } from '../../lib/version.js';
import {
  findInstalledCli,
  getLatestRelease,
  isNewer,
  runCliUpdate,
  updateCommand,
  type InstalledCli,
  type LatestRelease,
  type PackageManager,
} from '../../lib/update_check.js';

export interface UpdateStatus {
  current: string;
  /** Absent when the check is disabled or failed. */
  latest?: string;
  url?: string;
  appOutdated: boolean;
  /** The `caretaker-cli` on PATH, when found. */
  cliVersion?: string;
  cliOutdated: boolean;
  /** Update command for that CLI's package manager (npm or pnpm), when found. */
  cliCommand?: string;
  dismissedVersion?: string;
}

export interface CliUpdateResult {
  ok: boolean;
  output: string;
  cliVersion?: string;
  cliOutdated: boolean;
  cliCommand?: string;
}

export interface UpdateDeps {
  current: () => string;
  getLatest: () => Promise<LatestRelease | null>;
  findCli: () => Promise<InstalledCli | null>;
  runUpdate: (manager: PackageManager) => Promise<{ ok: boolean; output: string }>;
}

const defaultDeps: UpdateDeps = {
  current: cliVersion,
  getLatest: () => getLatestRelease(),
  findCli: () => findInstalledCli(),
  // The probe puts the version manager's npm/pnpm on PATH (same reason as findCli).
  runUpdate: async (manager) => {
    await probeShellEnv().catch(() => {});
    return runCliUpdate({ manager });
  },
};

export function registerUpdate(app: Hono, over: Partial<UpdateDeps> = {}): void {
  const deps: UpdateDeps = { ...defaultDeps, ...over };
  let updating = false;

  const cliStatus = async (latest: LatestRelease | null) => {
    const cli = await deps.findCli();
    return {
      ...(cli ? { cliVersion: cli.version, cliCommand: updateCommand(cli.manager) } : {}),
      cliOutdated: !!(cli && latest && isNewer(latest.version, cli.version)),
    };
  };

  app.get('/api/update', async (c) => {
    const current = deps.current();
    const { dismissedUpdateVersion } = await loadUiState();
    const base = { current, ...(dismissedUpdateVersion ? { dismissedVersion: dismissedUpdateVersion } : {}) };
    if ((await loadConfig()).updateCheck === false) {
      return c.json<UpdateStatus>({ ...base, appOutdated: false, cliOutdated: false });
    }
    const latest = await deps.getLatest();
    return c.json<UpdateStatus>({
      ...base,
      ...(latest ? { latest: latest.version, url: latest.url } : {}),
      appOutdated: !!latest && isNewer(latest.version, current),
      ...(await cliStatus(latest)),
    });
  });

  app.post('/api/update/dismiss', async (c) => {
    const body = await c.req.json().catch(() => null);
    const version = body?.version;
    if (typeof version !== 'string' || !version) {
      return c.json({ error: 'version must be a non-empty string' }, 400);
    }
    const state = await loadUiState();
    state.dismissedUpdateVersion = version;
    await saveUiState(state);
    return c.body(null, 204);
  });

  app.post('/api/update/cli', async (c) => {
    if (updating) return c.json({ error: 'update already running' }, 409);
    updating = true;
    try {
      // Same manager that installed the CLI on PATH; npm when none is found.
      const run = await deps.runUpdate((await deps.findCli())?.manager ?? 'npm');
      return c.json<CliUpdateResult>({ ...run, ...(await cliStatus(await deps.getLatest())) });
    } finally {
      updating = false;
    }
  });
}
