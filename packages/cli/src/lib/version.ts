import { readFileSync } from 'node:fs';

/** The running CLI's version, read from package.json at runtime (relative to
 *  this module, not the CWD) so it tracks the single Changesets-managed
 *  version without a static JSON import that would break tsc's rootDir
 *  constraint. src/lib and dist/lib are both two levels below the package. */
export function cliVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
  } catch {
    // ponytail: placeholder when package.json isn't bundled next to dist/ —
    // an unreadable file must only degrade the reported version.
    return '0.0.0';
  }
}
