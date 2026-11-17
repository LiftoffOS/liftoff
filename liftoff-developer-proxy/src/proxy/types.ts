export interface DevProxyAuthContext {
  keyId: string;
  tenantId: string;
  userId: string;
  secretName: string; // Secret Manager ID for the Anthropic API key
  vendor: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface UsageRecord {
  tenantId: string;
  userId: string;
  credentialId: string;
  vendor: string;
  model: string;
  requestId: string;
  usage: TokenUsage;
  costMicros: bigint;
  status: 'final' | 'disconnected' | 'error';
  errorMessage?: string;
}
