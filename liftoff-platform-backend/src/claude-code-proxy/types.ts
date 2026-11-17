// Claude Code Proxy Types
// Zod schemas + TypeScript interfaces for developer proxy key management

import { z } from 'zod';

// --- Database Row Type ---

export type ClaudeCodePlanType = 'free' | 'pro' | 'max_5x' | 'max_20x' | 'team_standard' | 'team_premium' | 'enterprise' | 'api';

export interface ClaudeCodeProxyKey {
  id: string;
  tenantId: string;
  accountId: string;
  keyHash: string;
  keyPrefix: string;
  keyHint: string;
  anthropicSecretName: string;
  name: string;
  description: string | null;
  planType: ClaudeCodePlanType | null;
  costPerMonth: number | null;
  costPerMillionInputTokens: number | null;
  costPerMillionOutputTokens: number | null;
  status: 'active' | 'revoked';
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  /** FK to internal_agents — present when this key was created for a specific Agent */
  internalAgentId: string | null;
}

// --- API Response (never includes hash or secret name) ---

export interface ProxyKeyResponse {
  id: string;
  tenantId: string;
  accountId: string;
  keyPrefix: string;
  keyHint: string;
  name: string;
  description: string | null;
  planType: ClaudeCodePlanType | null;
  costPerMonth: number | null;
  costPerMillionInputTokens: number | null;
  costPerMillionOutputTokens: number | null;
  status: 'active' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Create Key Response (includes full key ONCE) ---

export interface CreateProxyKeyResponse extends ProxyKeyResponse {
  key: string;
  setupToken: string;
  setupInstructions: {
    baseUrl: string;
    envCommand: string;
  };
}

// --- Zod Schemas ---

// Vendor-neutral credential creation: `vendor` + generic
// `apiKey`, with `anthropicApiKey` preserved for backward compatibility.
export const createProxyKeySchema = z.object({
  tenantId: z.string().uuid(),
  vendor: z.enum(['anthropic', 'openai']).optional(),
  apiKey: z.string().min(20).max(200).optional(),
  /** @deprecated use `apiKey` + `vendor` */
  anthropicApiKey: z.string().min(20).max(200).optional(),
  label: z.string().max(120).optional(),
}).refine((v) => Boolean(v.apiKey ?? v.anthropicApiKey), {
  message: 'apiKey is required',
});

export const listProxyKeysSchema = z.object({
  tenantId: z.string().uuid(),
});

export const revokeProxyKeySchema = z.object({
  tenantId: z.string().uuid(),
});

// The two fields a person can write on a connection (migration 478). null
// clears a field back to its derived value; absent leaves it as it is.
export const updateProxyKeySchema = z.object({
  tenantId: z.string().uuid(),
  name: z.string().trim().min(1).max(255).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

export const selfRevokeSchema = z.object({
  confirm: z.literal(true),
});

// --- Resolved proxy auth context (attached to req by proxy-auth middleware) ---

export interface ProxyAuthContext {
  keyId: string;
  tenantId: string;
  accountId: string;
  anthropicSecretName: string;
  /** FK to internal_agents — present when the proxy key was created for a specific Agent */
  internalAgentId?: string;
}

// --- Usage Stats ---

export interface ProxyUsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  estimatedCostUsd: number;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    requests: number;
    estimatedCostUsd: number;
  }>;
}
