// OAuth token provider used by MCPClient to fetch a valid bearer token
// before each MCP request. Ported from
// tenant-runtime/src/infrastructure/token-provider.ts with the
// connector-service credential store adapter substituted.

import { MCPError, MCPErrorCode } from './mcp-errors.js';
import type { CredentialStore } from './credential-store.js';

export { type CredentialStore } from './credential-store.js';

export interface TokenProvider {
  getToken(): Promise<string>;
  refreshToken(): Promise<string>;
  isTokenExpired(): boolean;
}

export interface TokenProviderConfig {
  tenantId: string;
  connectorType: string;
  /** Buffer before expiry to trigger refresh (default: 5 minutes). */
  refreshBufferMs?: number;
}

export class OAuthTokenProvider implements TokenProvider {
  private cachedToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private refreshPromise: Promise<string> | null = null;
  private readonly refreshBufferMs: number;

  constructor(
    private readonly config: TokenProviderConfig,
    private readonly credentialStore: CredentialStore,
  ) {
    this.refreshBufferMs = config.refreshBufferMs ?? 5 * 60 * 1000;
  }

  async getToken(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    if (this.cachedToken && !this.isTokenExpired()) {
      return this.cachedToken;
    }
    return this.refreshToken();
  }

  async refreshToken(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<string> {
    const credentials = await this.credentialStore.getCredentials(
      this.config.tenantId,
      this.config.connectorType,
    );

    if (!credentials.refreshToken && !credentials.accessToken) {
      throw new MCPError(
        MCPErrorCode.TOKEN_REFRESH_FAILED,
        'No access or refresh token available',
      );
    }

    // credentialService.getCredentials handles refresh internally when a
    // token is within 5 min of expiry, so the returned accessToken is fresh.
    this.cachedToken = credentials.accessToken;
    this.tokenExpiry = credentials.expiresAt ?? new Date(Date.now() + 3600 * 1000);

    return this.cachedToken;
  }

  isTokenExpired(): boolean {
    if (!this.tokenExpiry) return true;
    return Date.now() >= this.tokenExpiry.getTime() - this.refreshBufferMs;
  }
}
