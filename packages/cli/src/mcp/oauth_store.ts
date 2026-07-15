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
