// Pure helpers for resolving extension-level configuration. Kept free of
// `vscode` imports so they're unit-testable with the Node test runner.

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HomeResolverInputs {
  envValue: string | undefined;
  settingValue: string | undefined;
}

/**
 * Resolve CARETAKER_HOME with precedence: env var > VSCode setting > default
 * (`~/.caretaker`). Empty strings are treated as unset on both inputs.
 */
export function resolveCaretakerHome(inputs: HomeResolverInputs): string {
  const fromEnv = inputs.envValue?.trim();
  if (fromEnv) return fromEnv;

  const fromSetting = inputs.settingValue?.trim();
  if (fromSetting) return fromSetting;

  return join(homedir(), '.caretaker');
}
