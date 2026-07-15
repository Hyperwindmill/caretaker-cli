// OAuthClientProvider backed by an mcp.json row's encrypted `oauthState`.
// The interactive authenticateMcpServer flow lives in the same module.
// Client-info + tokens persist; the PKCE verifier is in-memory only.

import { openUrl } from '../lib/open_url.js';
import { loadMcpServers, saveMcpServers, withMcpServersLock } from '../store/json.js';
import { readOAuthBlob, writeOAuthBlob, staleRegistrationReset, type OAuthBlob } from './oauth_store.js';
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
    private readonly interactive: boolean = false,
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

  // Merge one field into the row's blob and persist atomically.
  // Uses withMcpServersLock to prevent race conditions during RMW.
  private async mergeBlob(patch: Partial<OAuthBlob>): Promise<void> {
    await withMcpServersLock(async () => {
      try {
        const file = await loadMcpServers();
        const row = file.servers.find((s) => s.id === this.serverId);
        if (!row) return;
        row.oauthState = writeOAuthBlob({ ...readOAuthBlob(row), ...patch });
        await saveMcpServers(file);
      } catch (err) {
        console.error(`[mcp oauth] failed to persist state for ${this.serverId}:`, err);
      }
    });
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    try {
      return (await this.readBlob()).clientInformation;
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await this.mergeBlob({ clientInformation: info });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      return (await this.readBlob()).tokens;
    } catch {
      return undefined;
    }
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
    if (!this.interactive) {
      throw new Error("Interactive OAuth authentication is not allowed on passive connections");
    }
    openUrl(authorizationUrl.toString());
  }
}

export function buildAuthProvider(server: { id: string }): StoredOAuthProvider {
  // Passive/pool path never redirects; a placeholder redirectUrl satisfies the SDK interface.
  // Passing interactive = false will prevent DCR/Browser spawn and raise UnauthorizedError.
  return new StoredOAuthProvider(server.id, 'http://127.0.0.1/callback', false);
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

  // M1 fix: If clientInformation redirect_uris do not contain the current port,
  // clear clientInformation to force a DCR fresh registration.
  await withMcpServersLock(async () => {
    const freshFile = await loadMcpServers();
    const freshServer = freshFile.servers.find((s) => s.id === id);
    if (freshServer) {
      try {
        // R1: when the ephemeral redirect port no longer matches the stored
        // DCR registration, clear BOTH clientInformation and tokens — the
        // tokens are bound to the old client_id and, if kept, would send the
        // next connect down a refresh-with-wrong-client path (invalid_grant)
        // instead of opening the browser.
        const reset = staleRegistrationReset(readOAuthBlob(freshServer), listener.redirectUrl);
        if (reset) {
          freshServer.oauthState = writeOAuthBlob(reset);
          await saveMcpServers(freshFile);
        }
      } catch {
        // If decryption fails, clear all oauthState to heal
        delete freshServer.oauthState;
        await saveMcpServers(freshFile);
      }
    }
  });

  const provider = new StoredOAuthProvider(id, listener.redirectUrl, true);
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
  await closeClient(id);
  await withMcpServersLock(async () => {
    const file = await loadMcpServers();
    const server = file.servers.find((s) => s.id === id);
    if (!server || !server.oauthState) return;
    delete server.oauthState;
    await saveMcpServers(file);
  });
}
