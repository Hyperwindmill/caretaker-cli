// Path sandbox for fs tools. Ported from caretaker server's
// src/mcp/fs_sandbox.ts. Symlinks are intentionally NOT followed for the
// check — this is a "soft jail" that protects against accidental escapes
// (`..` traversal, absolute paths outside the working dir), not a security
// boundary against an adversarial filesystem.

import * as path from 'node:path';

export class OutsideRootError extends Error {
  code = 'EOUTSIDE_ROOT';
  constructor(root: string, candidate: string) {
    super(`Path "${candidate}" is outside the working directory "${root}"`);
  }
}

export function assertWithinRoot(root: string, candidate: string): string {
  const absRoot = path.resolve(root);
  const absCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(absRoot, candidate);
  const rel = path.relative(absRoot, absCandidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new OutsideRootError(absRoot, candidate);
  }
  return absCandidate;
}
