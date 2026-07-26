// Detect / start / stop the managed local Speaches container backing voice
// mode. The configured endpoint is the source of truth (see the design doc);
// this module never rewrites `voice.endpoint` and never invents a port — it
// only parses the one the user already configured and makes a container match
// it. `lib/docker.ts` is deliberately task-agnostic, so we reuse its
// `containerState` primitive but build our own run argv here (Speaches needs a
// published port + a named cache volume, not a worktree bind-mount + a
// `sleep infinity` keep-alive).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { VoiceConfig } from 'caretaker-types';
import { commandEnv } from '../../harness/tools/builtin/shell-env.js';
import { containerState } from '../../lib/docker.js';
import { voiceAuthHeaders } from './voice_proxy.js';

const exec = promisify(execFile);

const CONTAINER_NAME = 'caretaker-speaches';
const IMAGE = 'ghcr.io/speaches-ai/speaches:latest-cpu';
// A named volume, deliberately not the `caretaker-cli_hf-hub-cache` that
// docker-compose.voice.yml creates — a container already running under that
// name (compose-started or hand-started) is adopted as-is and keeps its own
// volume; only a fresh create uses ours.
const VOLUME = 'caretaker-hf-hub-cache:/home/ubuntu/.cache/huggingface/hub';

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 2_000;

export type BackendStatus = {
  /** Why the affordance may be unavailable, distinguished because the fixes differ. */
  docker: 'ok' | 'absent' | 'denied' | 'down';
  container: 'running' | 'stopped' | 'absent';
  imagePresent: boolean;
  /** Port parsed out of the endpoint, or null when it is not loopback. */
  port: number | null;
  /** True when /v1/models answers — running is not the same as ready. */
  responding: boolean;
};

export type StartProgress = {
  step: 'image' | 'run' | 'ready' | 'models' | 'done' | 'error';
  message: string;
  /** Present only on the terminal line ('done' | 'error'). */
  status?: BackendStatus;
};

// --- Docker layer, injectable so tests never need a real daemon --------

interface BackendDeps {
  containerState: (name: string) => Promise<'running' | 'stopped' | 'absent'>;
  dockerInfo: () => Promise<{ ok: true } | { ok: false; code?: string; stderr: string }>;
  imagePresent: (image: string) => Promise<boolean>;
  /** Streams docker's own pull output line by line — not parsed into a
   *  percentage, just passed through as progress. */
  pullImage: (image: string) => AsyncGenerator<string>;
  runContainer: (args: string[]) => Promise<void>;
  startContainer: (name: string) => Promise<void>;
  stopContainer: (name: string) => Promise<void>;
}

async function dockerExec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('docker', args, { env: commandEnv(), maxBuffer: 8 * 1024 * 1024 });
}

/** Bridges a child process's stdout+stderr into an async generator of lines.
 *  Used only for `docker pull`, whose progress bars use `\r` rather than `\n`. */
async function* streamLines(proc: ChildProcess): AsyncGenerator<string> {
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };
  const push = (chunk: Buffer | string) => {
    for (const line of chunk.toString('utf8').split(/\r\n|\r|\n/)) {
      if (line.trim().length > 0) queue.push(line);
    }
    wake();
  };

  proc.stdout?.on('data', push);
  proc.stderr?.on('data', push);
  proc.on('error', (err) => {
    failure = err;
    done = true;
    wake();
  });
  proc.on('close', (code) => {
    done = true;
    if (code !== 0 && !failure) failure = new Error(`docker pull exited with code ${code}`);
    wake();
  });

  for (;;) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) {
      if (failure) throw failure;
      return;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
}

const defaultDeps: BackendDeps = {
  containerState,
  async dockerInfo() {
    try {
      await dockerExec(['info']);
      return { ok: true };
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string };
      return { ok: false, code: e.code, stderr: e.stderr ?? e.message ?? '' };
    }
  },
  async imagePresent(image) {
    try {
      await dockerExec(['image', 'inspect', image]);
      return true;
    } catch {
      return false;
    }
  },
  pullImage(image) {
    const proc = spawn('docker', ['pull', image], { env: commandEnv() });
    return streamLines(proc);
  },
  async runContainer(args) {
    await dockerExec(args);
  },
  async startContainer(name) {
    await dockerExec(['start', name]);
  },
  async stopContainer(name) {
    await dockerExec(['stop', name]);
  },
};

let deps: BackendDeps = defaultDeps;

/** @internal Test-only seam: swap the docker layer so tests never need a real
 *  Docker daemon. Pass null to restore the real implementation. */
export function setVoiceBackendDepsForTest(overrides: Partial<BackendDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

// --- Port / endpoint parsing --------------------------------------------

// Node's WHATWG URL keeps the brackets in `.hostname` for a bracketed IPv6
// authority (verified: `new URL('http://[::1]:1/').hostname === '[::1]'`,
// not `'::1'`), so the literal bracketed form is what we must match here.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Port when the endpoint is loopback, else null. Exported for tests. */
export function loopbackPort(endpoint: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

function joinUrl(endpoint: string, suffix: string): string {
  return `${endpoint.replace(/\/+$/, '')}${suffix}`;
}

/** Short-timeout GET, independent of Docker — a remote or hand-run backend
 *  still reports `responding: true`. */
async function probeResponding(
  endpoint: string,
  headers: Record<string, string> = {},
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(joinUrl(endpoint, '/models'), { headers, signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function classifyDocker(): Promise<BackendStatus['docker']> {
  const info = await deps.dockerInfo();
  if (info.ok) return 'ok';
  if (info.code === 'ENOENT') return 'absent';
  if (/permission denied/i.test(info.stderr)) return 'denied';
  return 'down';
}

export async function probeBackend(endpoint: string): Promise<BackendStatus> {
  const port = loopbackPort(endpoint);
  const docker = await classifyDocker();
  // Coherent status without throwing: don't even ask Docker for container /
  // image state when it isn't there to ask.
  const container = docker === 'ok' ? await deps.containerState(CONTAINER_NAME) : 'absent';
  const imagePresent = docker === 'ok' ? await deps.imagePresent(IMAGE) : false;
  const responding = await probeResponding(endpoint);
  return { docker, container, imagePresent, port, responding };
}

function runArgs(port: number): string[] {
  return [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-p',
    `127.0.0.1:${port}:8000`,
    '-v',
    VOLUME,
    IMAGE,
  ];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollReady(voice: VoiceConfig): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const headers = voiceAuthHeaders(voice);
  for (;;) {
    if (await probeResponding(voice.endpoint, headers)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

/** POST <endpoint>/models/<id> — not optional: Speaches does not fetch models
 *  on demand, so skipping this leaves the backend reporting healthy and then
 *  404ing on the first real request. An already-installed model commonly
 *  answers 409 rather than 2xx; that is success, not failure.
 *
 *  Model ids are typically `org/name` (e.g. `Systran/faster-whisper-small`)
 *  and Speaches' route captures the id verbatim including the slash — so the
 *  id goes in the path unencoded, not through encodeURIComponent (which would
 *  turn it into `%2F` and very likely 404 against a path-style route match). */
async function installModel(voice: VoiceConfig, modelId: string): Promise<void> {
  const res = await fetch(joinUrl(voice.endpoint, `/models/${modelId}`), {
    method: 'POST',
    headers: voiceAuthHeaders(voice),
  });
  if (res.ok || res.status === 409) return;
  const body = await res.text().catch(() => '');
  throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
}

export async function* startBackend(voice: VoiceConfig): AsyncGenerator<StartProgress> {
  const endpoint = voice.endpoint;
  const port = loopbackPort(endpoint);
  if (port == null) {
    yield {
      step: 'error',
      message: `Cannot manage a local backend for a non-loopback endpoint (${endpoint}).`,
      status: await probeBackend(endpoint),
    };
    return;
  }

  // 1. Image
  try {
    if (await deps.imagePresent(IMAGE)) {
      yield { step: 'image', message: `Image ${IMAGE} already present.` };
    } else {
      yield { step: 'image', message: `Pulling ${IMAGE} — first run downloads about 2 GB.` };
      for await (const line of deps.pullImage(IMAGE)) {
        yield { step: 'image', message: line };
      }
    }
  } catch (err) {
    yield { step: 'error', message: errMsg(err), status: await probeBackend(endpoint) };
    return;
  }

  // 2. Run — idempotent, so two caretaker instances or a hand/compose-started
  // container are all fine.
  try {
    const state = await deps.containerState(CONTAINER_NAME);
    if (state === 'running') {
      yield { step: 'run', message: 'Container already running.' };
    } else if (state === 'stopped') {
      yield { step: 'run', message: 'Starting the existing container.' };
      await deps.startContainer(CONTAINER_NAME);
    } else {
      yield { step: 'run', message: `Creating the container on port ${port}.` };
      await deps.runContainer(runArgs(port));
    }
  } catch (err) {
    yield { step: 'error', message: errMsg(err), status: await probeBackend(endpoint) };
    return;
  }

  // 3. Readiness — running is not the same as ready.
  yield { step: 'ready', message: 'Waiting for the backend to respond…' };
  if (!(await pollReady(voice))) {
    yield {
      step: 'error',
      message: `Timed out after ${READY_TIMEOUT_MS / 1000}s waiting for ${endpoint}/models to respond.`,
      status: await probeBackend(endpoint),
    };
    return;
  }
  yield { step: 'ready', message: 'Backend is responding.' };

  // 4. Models — required, see installModel's comment.
  const modelIds = [voice.sttModel, voice.ttsModel].filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0,
  );
  for (const id of modelIds) {
    try {
      await installModel(voice, id);
      yield { step: 'models', message: `Model ${id} ready.` };
    } catch (err) {
      yield {
        step: 'error',
        message: `Failed to install model ${id}: ${errMsg(err)}`,
        status: await probeBackend(endpoint),
      };
      return;
    }
  }

  yield { step: 'done', message: 'Backend started.', status: await probeBackend(endpoint) };
}

/** `docker stop` only — never `rm`, never touches the volume. Stopping must
 *  not cost a multi-gigabyte re-download; removing the container or its cache
 *  is not offered, `docker` in a terminal remains the way to do that. */
export async function stopBackend(): Promise<void> {
  await deps.stopContainer(CONTAINER_NAME);
}
