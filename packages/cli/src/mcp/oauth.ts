// OAuthClientProvider backed by an mcp.json row's encrypted `oauthState`.
// The interactive authenticateMcpServer flow lives in the same module
// (added in Task 6). Client-info + tokens persist; the PKCE verifier is
// in-memory only.

import { openUrl } from '../lib/open_url.js';
import { loadMcpServers, saveMcpServers } from '../store/json.js';
import { readOAuthBlob, writeOAuthBlob, type OAuthBlob } from './oauth_store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { startCallbackListener } from './oauth_callback.js';
import { closeClient } from './client.js';

export class StoredOAuthProvider implements OAuthClientProvider {
  private verifier?: string;

  constructor(
    private readonly serverId: string,
    private readonly _redirectUrl: string,
  ) {}

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'caretaker-cli',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private async readBlob(): Promise<OAuthBlob> {
    const file = await loadMcpServers();
    const row = file.servers.find((s) => s.id === this.serverId);
    return row ? readOAuthBlob(row) : {};
  }

  // Merge one field into the row's blob and persist atomically. Best-effort:
  // a failed write must not throw mid-flow.
  private async mergeBlob(patch: Partial<OAuthBlob>): Promise<void> {
    try {
      const file = await loadMcpServers();
      const row = file.servers.find((s) => s.id === this.serverId);
      if (!row) return;
      row.oauthState = writeOAuthBlob({ ...readOAuthBlob(row), ...patch });
      await saveMcpServers(file);
    } catch (err) {
      console.error(`[mcp oauth] failed to persist state for ${this.serverId}:`, err);
    }
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    return (await this.readBlob()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.mergeBlob({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readBlob()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.mergeBlob({ tokens });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no PKCE code verifier in memory');
    return this.verifier;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    openUrl(authorizationUrl.toString());
  }
}

export function buildAuthProvider(server: { id: string }): StoredOAuthProvider {
  // Passive/pool path never redirects; a placeholder redirectUrl satisfies
  // the interface. The interactive flow (Task 6) builds its own provider with
  // the live loopback redirectUrl.
  return new StoredOAuthProvider(server.id, 'http://127.0.0.1/callback');
}

/** Interactive OAuth: open the browser, capture the code on a loopback
 *  listener, exchange it, and persist tokens. Explicit user action only —
 *  never called from the passive pool. */
export async function authenticateMcpServer(id: string): Promise<void> {
  const file = await loadMcpServers();
  const server = file.servers.find((s) => s.id === id);
  if (!server) throw new Error(`MCP server ${id} not found`);
  if (server.transport !== 'http' || !server.url) {
    throw new Error(`MCP server "${server.name}" is not an http server`);
  }

  const listener = await startCallbackListener();
  const provider = new StoredOAuthProvider(id, listener.redirectUrl);
  const client = new Client({ name: 'caretaker-cli', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    authProvider: provider,
  });

  try {
    try {
      await client.connect(transport);
      return; // already authorized (saved tokens still valid)
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      // redirectToAuthorization already opened the browser via the provider.
    }
    const code = await listener.waitForCode();
    await transport.finishAuth(code);
    // Drop any stale pooled connection so the next getClient picks up tokens.
    await closeClient(id);
  } finally {
    listener.close();
    await client.close().catch(() => {});
  }
}

/** Clear stored OAuth state (logout) and drop any pooled connection. */
export async function revokeMcpAuth(id: string): Promise<void> {
  const file = await loadMcpServers();
  const server = file.servers.find((s) => s.id === id);
  if (!server || !server.oauthState) return;
  delete server.oauthState;
  await saveMcpServers(file);
  await closeClient(id);
}

