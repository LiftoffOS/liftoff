export type DeveloperProxyVendor = 'anthropic' | 'openai';

export interface ByokCredential {
  id: string;
  tenantId: string;
  userId: string;
  vendor: string;
  keyPrefix: string;
  keyHint: string;
  secretName: string;
  label: string;
  status: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Vendor-neutral credential creation contract. `apiKey` is the
// generic raw provider key; `anthropicApiKey` is preserved for backward
// compatibility with existing Anthropic callers during migration.
export interface CreateCredentialParams {
  tenantId: string;
  userId: string;
  vendor?: DeveloperProxyVendor;
  apiKey?: string;
  /** @deprecated legacy Anthropic-only field; use `apiKey` + `vendor`. */
  anthropicApiKey?: string;
  label?: string;
}

export interface CreateCredentialResult {
  credential: CredentialResponse;
  fullKey: string;       // liftoff_sk_* — returned ONCE, not stored
  setupToken: string;    // one-time token for CLI exchange
  proxyBaseUrl: string;
}

export type CredentialResponse = Omit<ByokCredential, 'secretName'>;
