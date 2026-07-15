// OAuthClientProvider backed by an mcp.json row's encrypted `oauthState`.
// The interactive authenticateMcpServer flow lives in the same module
// (added in Task 6). Client-info + tokens persist; the PKCE verifier is
// in-memory only.

import { openUrl } from '../lib/open_url.js';
import { loadMcpServers, saveMcpServers } from '../store/json.js';
import { readOAuthBlob, writeOAuthBlob, type OAuthBlob } from './oauth_store.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

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
