// Codec for the per-server OAuth blob persisted in McpServerConfig.oauthState.
// The blob holds the DCR client registration and the OAuth tokens; it is a
// single AES-256-GCM encrypted JSON string so the client_secret and
// refresh_token never touch disk in cleartext.

import { decrypt, encrypt, isEncrypted } from '../lib/encryption.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServerConfig } from '../types.js';

export type OAuthBlob = {
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
};

export function readOAuthBlob(server: McpServerConfig): OAuthBlob {
  const raw = server.oauthState;
  if (!raw) return {};
  const json = isEncrypted(raw) ? decrypt(raw) : raw;
  return JSON.parse(json) as OAuthBlob;
}

export function readOAuthBlobSafe(server: McpServerConfig): OAuthBlob {
  try {
    return readOAuthBlob(server);
  } catch {
    return {};
  }
}

export function writeOAuthBlob(blob: OAuthBlob): string {
  return encrypt(JSON.stringify(blob));
}

/**
 * Decide whether a stored DCR registration is stale for the current loopback
 * redirect. The ephemeral callback port changes on every interactive attempt
 * (`listen(0)`), so once the registered `redirect_uris` no longer include the
 * current redirect, the client registration is unusable — and so are the
 * tokens, which are bound to that same `client_id`. Returns the cleared blob
 * to persist, or `null` when nothing is stale (no registration, or the current
 * redirect still matches). Clearing tokens alongside clientInformation is what
 * lets the next interactive connect reach the browser flow instead of failing
 * a refresh against a freshly re-registered client_id.
 */
export function staleRegistrationReset(blob: OAuthBlob, currentRedirectUrl: string): OAuthBlob | null {
  const uris = blob.clientInformation?.redirect_uris;
  if (!uris || uris.includes(currentRedirectUrl)) return null;
  return { ...blob, clientInformation: undefined, tokens: undefined };
}
