// Developer Proxy domain types — bundled with billing-types because ReportUsage is
// the coupling point between developer-proxy and billing. Ships in this
// package rather than a standalone @liftoffos/developer-proxy-types per Phase 0b.

export type DeveloperProxyVendor = 'anthropic' | 'openai';

export type CredentialStatus =
  | 'pending'
  | 'active'
  | 'revoked'
  | 'expired';

export type UsageStreamStatus =
  | 'pending'
  | 'final'
  | 'disconnected'
  | 'error';

export interface DeveloperProxyCredential {
  id: string;
  tenantId: string;
  userId: string;
  vendor: DeveloperProxyVendor;
  /**
   * Secret Manager path of the form
   * `developer-proxy/{tenantId}/{userId}/{vendor}/{version}`. Never a raw key.
   */
  encryptedApiKeyRef: string;
  label: string;
  status: CredentialStatus;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface DeveloperProxyUsageLogEntry {
  id: string;
  tenantId: string;
  userId: string;
  vendor: DeveloperProxyVendor;
  model: string;
  /** Vendor-assigned request identifier — idempotency key for billing.ReportUsage. */
  requestId: string;
  inputTokens: bigint;
  outputTokens: bigint;
  cachedInputTokens: bigint;
  cacheCreationInputTokens: bigint;
  costMicros: bigint;
  status: UsageStreamStatus;
  startedAt: Date;
  finalizedAt: Date | null;
}

export interface DeveloperProxyVendorConfig {
  vendor: DeveloperProxyVendor;
  baseUrl: string;
  allowedModels: string[];
  /** Cost per 1 input token, in micros (10^-6 USD). */
  microsPerTokenIn: Record<string, bigint>;
  microsPerTokenOut: Record<string, bigint>;
  /** Cached input tokens charged at this rate. */
  microsPerCachedTokenIn: Record<string, bigint>;
}

export interface PkceSession {
  id: string;
  tenantId: string;
  userId: string;
  vendor: DeveloperProxyVendor;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  expiresAt: Date;
}
