/**
 * Shell environment probe for Linux.
 *
 * On Linux, .bashrc typically exits early for non-interactive shells due to:
 *   [ -z "$PS1" ] && return
 * or similar guards. This means NVM, volta, fnm et al. are NOT available
 * even when spawning with `bash -l -c`.
 *
 * Solution: probe the environment once using an interactive shell
 * (`bash -i -c 'env'`) which DOES source .bashrc, then merge relevant
 * variables (PATH, NVM_DIR, VOLTA_HOME, FNM_DIR, etc.) into the
 * subprocess env when running commands.
 */

import { spawn } from "node:child_process";

/**
 * Key environment variables to extract from the interactive shell.
 * These are commonly set by version managers and user shell configs.
 */
const RELEVANT_VARS = [
  // PATH is always needed
  "PATH",
  // Node version managers
  "NVM_DIR",
  "NVM_BIN",
  "NVM_INC",
  "VOLTA_HOME",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  // Other common dev tools
  "GOPATH",
  "GOBIN",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  // Custom common dev tools
  "JAVA_HOME",
  "ANDROID_HOME",
  "DOTNET_ROOT",
  // Custom paths users may set
  "NODE_PATH",
];

/**
 * Resolved shell environment from probing.
 */
export interface ShellEnvResult {
  /** Environment variables extracted from interactive shell */
  env: Record<string, string>;
  /** Whether the probe was successful */
  success: boolean;
  /** Error message if probe failed */
  error?: string;
}

let cachedResult: ShellEnvResult | null = null;
let probePromise: Promise<ShellEnvResult> | null = null;

/**
 * Probe the interactive shell environment.
 *
 * This runs `bash -i -c 'env'` to get the full
 * environment including user's .bashrc customizations.
 *
 * On Windows and macOS, this returns early with an empty result since
 * those platforms handle PATH differently (login shells work correctly).
 *
 * @param force - Force re-probe even if cached result exists
 * @returns Shell environment result
 */
export async function probeShellEnv(force = false): Promise<ShellEnvResult> {
  // Windows doesn't need this - handled differently
  if (process.platform === "win32") {
    return { env: {}, success: true };
  }

  // macOS doesn't need this - shells are typically login shells
  // and .bash_profile/.zprofile are sourced properly
  if (process.platform === "darwin") {
    return { env: {}, success: true };
  }

  // Return cached result if available
  if (cachedResult && !force) {
    return cachedResult;
  }

  // If a probe is already in progress, wait for it
  if (probePromise) {
    return probePromise;
  }

  probePromise = doProbe();
  cachedResult = await probePromise;
  probePromise = null;
  return cachedResult;
}

/**
 * Perform the actual environment probe.
 */
async function doProbe(): Promise<ShellEnvResult> {
  const shell = process.env.SHELL || "/bin/bash";
  const shellName = shell.split("/").pop() || "bash";

  return new Promise((resolve) => {
    const timeout = 10_000; // 10 second timeout
    let stdout = "";
    let stderr = "";

    const proc = spawn(shell, ["-i", "-c", "env"], {
      timeout,
      // Don't inherit stdio - we want to capture output
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && stdout === "") {
        console.warn(`[shell-env] Probe exited with code ${code}: ${stderr}`);
        resolve({
          env: {},
          success: false,
          error: `Shell probe failed with code ${code}`,
        });
        return;
      }

      const env: Record<string, string> = {};

      // Parse env output (format: KEY=value per line)
      for (const line of stdout.split("\n")) {
        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx);
        const value = line.slice(eqIdx + 1);

        if (RELEVANT_VARS.includes(key)) {
          env[key] = value;
        }
      }

      console.log(
        `[shell-env] Probed ${shellName} environment, found ${Object.keys(env).length} relevant vars: ${Object.keys(env).join(", ") || "(none)"}`,
      );

      resolve({ env, success: true });
    });

    proc.on("error", (err) => {
      console.warn(`[shell-env] Probe error:`, err.message);
      resolve({
        env: {},
        success: false,
        error: err.message,
      });
    });
  });
}

/**
 * Get the cached shell environment, or probe if not yet done.
 *
 * This is a synchronous getter for use in tools where we don't want
 * to await anything. Must call probeShellEnv() at startup.
 */
export function getShellEnv(): Record<string, string> {
  if (!cachedResult) {
    // Not yet probed - return empty, caller will use default env
    console.warn("[shell-env] getShellEnv() called before probe completed");
    return {};
  }
  return cachedResult.env;
}

/**
 * Merge the probed shell environment into the given env object.
 *
 * This is used by bash tool to inject PATH and other variables
 * from the user's interactive shell environment.
 *
 * PATH is prepended (so user tools take precedence), while other
 * variables are set only if not already present in the env.
 */
export function mergeShellEnv(
  existingEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const shellEnv = getShellEnv();
  const merged: NodeJS.ProcessEnv = { ...existingEnv };

  // Prepend shell PATH to existing PATH
  if (shellEnv.PATH) {
    merged.PATH = shellEnv.PATH + ":" + (existingEnv.PATH || "");
  }

  // Set other variables only if not already present
  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === "PATH") continue; // Already handled above
    if (!(key in merged)) {
      merged[key] = value;
    }
  }

  return merged;
}
