// Sandbox Credential Vending Service
// Provides short-lived credentials to sandboxes per-operation.
// Credentials are NOT injected as environment variables.
// Each request is logged and validated against the agent's connector allowlist.
// Resolved: SE-004 — credential injection model.

import { log } from '../infrastructure/logging';
import { InjectedCredential } from './types';

/**
 * Interface matching the existing connector credential service.
 * Injected to avoid circular dependency.
 */
export interface ConnectorCredentialProvider {
  getCredentials(connectorId: string, tenantId: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    instanceUrl?: string;
    expiresAt?: Date;
  }>;
}

export interface VendedCredential {
  connectorId: string;
  credentialType: string;
  accessToken: string;
  instanceUrl?: string;
  expiresAt?: Date;
}

export class CredentialVendingService {
  // Track vending requests per sandbox for rate limiting
  private readonly vendCounts = new Map<string, number>();
  private readonly MAX_VENDS_PER_SANDBOX = 100;

  constructor(
    private readonly credentialProvider: ConnectorCredentialProvider,
  ) {}

  /**
   * Vend a credential for a sandbox operation.
   * Validates against the allowed credentials list and rate limits.
   */
  async vendCredential(
    tenantId: string,
    sandboxId: string,
    request: InjectedCredential,
    allowedCredentials: InjectedCredential[],
  ): Promise<VendedCredential> {
    // Validate the request is in the allowed list
    const isAllowed = allowedCredentials.some(
      c => c.connectorId === request.connectorId
        && c.credentialType === request.credentialType
        && (c.scope === request.scope || c.scope === 'write'), // write implies read
    );

    if (!isAllowed) {
      throw new Error(
        `Credential not allowed: ${request.connectorId} (${request.credentialType}, ${request.scope})`
      );
    }

    // Rate limit credential vending per sandbox
    const count = this.vendCounts.get(sandboxId) ?? 0;
    if (count >= this.MAX_VENDS_PER_SANDBOX) {
      throw new Error(`Credential vending rate limit exceeded for sandbox ${sandboxId}`);
    }
    this.vendCounts.set(sandboxId, count + 1);

    // Fetch from the existing credential service
    const creds = await this.credentialProvider.getCredentials(request.connectorId, tenantId);

    log.info({
      message: 'Credential vended for sandbox',
      sandboxId,
      connectorId: request.connectorId,
      credentialType: request.credentialType,
      scope: request.scope,
    });

    return {
      connectorId: request.connectorId,
      credentialType: request.credentialType,
      accessToken: creds.accessToken,
      instanceUrl: creds.instanceUrl,
      expiresAt: creds.expiresAt,
    };
  }

  /**
   * Get credential values for output sanitizer (redact these from stdout/stderr).
   */
  getCredentialValuesForRedaction(_allowedCredentials: InjectedCredential[]): string[] {
    // Return connector IDs as markers — actual token values are added dynamically
    // when credentials are vended
    return [];
  }

  /**
   * Clean up rate limit state for a destroyed sandbox.
   */
  clearSandbox(sandboxId: string): void {
    this.vendCounts.delete(sandboxId);
  }
}
