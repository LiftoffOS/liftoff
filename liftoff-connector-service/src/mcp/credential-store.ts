// CredentialStore interface + adapter that wraps this service's
// credentialService. MCP clients call `getCredentials(tenantId, connectorType)`
// on every request so they always see a non-expired token (refresh is
// handled inside credentialService.getCredentials).
//
// Adaptation from tenant-runtime:
//   - The tenant-runtime adapter looked up connectors by type (selecting
//     the most recent active connector). Here, executors are dispatched
//     with the CONCRETE connectorId, and the MCP clients are constructed
//     with that connectorId baked in. Construction of an MCP client is
//     scoped to one call — we do NOT cache across calls — so there is no
//     risk of id/type drift. That lets us drop the SQL "resolve type→id"
//     round-trip entirely and just forward the id the executor received.
//   - `refreshOAuthToken` doesn't need to do anything special — the
//     credential service refreshes internally when tokens are near expiry.
//     We expose the same shape for call-site compatibility.

import { credentialService } from '../credentials/service.js';

export interface CredentialStore {
  getCredentials(
    tenantId: string,
    connectorType: string,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;

  refreshOAuthToken(
    tenantId: string,
    connectorType: string,
    refreshToken: string,
  ): Promise<{
    accessToken: string;
    expiresInMs: number;
  }>;
}

/**
 * Per-connectorId adapter. Unlike the tenant-runtime version this takes the
 * resolved connectorId in the constructor and ignores the connectorType
 * argument — executors always have the id in hand when they build this.
 */
export class PerConnectorIdCredentialStore implements CredentialStore {
  constructor(
    private readonly tenantId: string,
    private readonly connectorId: string,
  ) {}

  async getCredentials(
    _tenantId: string,
    _connectorType: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: Date }> {
    const creds = await credentialService.getCredentials(this.tenantId, this.connectorId);
    return {
      accessToken: creds.accessToken ?? creds.apiKey ?? '',
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };
  }

  async refreshOAuthToken(
    _tenantId: string,
    _connectorType: string,
    _refreshToken: string,
  ): Promise<{ accessToken: string; expiresInMs: number }> {
    // Refresh is applied inside credentialService.getCredentials when tokens
    // are within 5 minutes of expiry. Callers that reach here just want a
    // fresh token; getCredentials gives them one.
    const creds = await credentialService.getCredentials(this.tenantId, this.connectorId);
    const expiresInMs = creds.expiresAt
      ? Math.max(0, creds.expiresAt.getTime() - Date.now())
      : 3600 * 1000;
    return {
      accessToken: creds.accessToken ?? creds.apiKey ?? '',
      expiresInMs,
    };
  }
}
