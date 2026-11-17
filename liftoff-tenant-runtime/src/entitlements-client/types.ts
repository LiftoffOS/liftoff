// Entitlements Client Types
// Per Section 4: Pull contract - Tenant runtime may call control-plane APIs for current entitlement snapshot

// Per Section 12: Runtime-facing entitlement fields. This is the single
// source of truth for what the runtime knows about a tenant's plan after
// migration 060 collapsed the legacy `data` JSON blob into typed columns.
// All quota fields the admission controller and dynamic-quota service need
// live here directly — no more COALESCE-on-JSON fallback.
export interface TenantEntitlement {
  tenantId: string;
  operationalStatus: TenantOperationalStatus;
  agentExecutionAllowed: boolean;
  /**
   * The control plane's `billing_controls.suspended` for this tenant's account,
   * folded into the served snapshot so the runtime's admission gate and the
   * control plane's execution-guard read the same hard stop.
   *
   * Defaults to FALSE everywhere it is absent — an old cached row, or a
   * snapshot served by a control plane that has not shipped the field yet
   * (PB deploys before TR). FALSE means "no billing suspension known", which is
   * the pre-change behaviour: the field can only tighten admission once real
   * values flow, never loosen it.
   */
  billingSuspended: boolean;
  /** @deprecated Legacy "Section 13" credit field. Retired from every runtime
   *  decision — spend authority is the control plane's billing_controls + OU
   *  buckets. Carried on the wire and in the cache for one release; read it for
   *  nothing new. */
  remainingIncludedCredits: number;
  /** @deprecated See remainingIncludedCredits. */
  overageAllowed: boolean;
  /** @deprecated See remainingIncludedCredits. */
  includedMonthlyCredits: number;
  /** @deprecated See remainingIncludedCredits. This is the ceiling that denied
   *  a tenant at 0.008% of its real allowance. */
  overageCeiling: number;
  entityVersion: number;
  updatedAt: Date;
}

export type TenantOperationalStatus = 'pending' | 'active' | 'suspended' | 'churned';

// TenantQuotas is now an alias for TenantEntitlement — the historical split
// no longer reflects the schema. Kept as a named alias so existing call sites
// (admission controller) don't all need updating.
export type TenantQuotas = TenantEntitlement;

// Per Section 4: Pull contract items
export interface ApprovedDeployment {
  deploymentId: string;
  tenantId: string;
  artifactRef: string;
  version: string;
  status: string;
  approvedAt: Date;
  entityVersion: number;
}

export interface ModelConfig {
  id: string;
  tenantId: string;
  modelId: string;
  routingPolicy: RoutingPolicy;
  version: number;
  entityVersion: number;
}

/** Tier names, matching the canonical `LLMModelTier` in src/llm/types.ts and
 *  platform-backend's `ModelTier`.
 *
 *  A mirror that drifts from the canonical union fails silently:
 *  `modelForTierOrUndefined` falls back to `medium` for any tier it does not
 *  recognise, so a large request arriving under another name is quietly served
 *  the medium model with no error anywhere. That is why the top tier's retired
 *  name is translated at every read boundary by `normalizeTier`, and why this
 *  union must change in the same commit as `LLMModelTier`. */
export type ModelTier = 'small' | 'medium' | 'large';

export interface RoutingPolicy {
  // Resolved model IDs — populated by the control plane from tier resolution.
  defaultModel?: string;
  taskOverrides?: Record<string, string>;
  // Provider selection
  defaultProvider?: string;
  providerOverrides?: Record<string, string>;
  // Tier intent fields (informational; resolution happens in the control plane)
  defaultTier?: ModelTier;
  taskTierOverrides?: Record<string, ModelTier>;
}

export interface PromptBundle {
  bundleId: string;
  tenantId: string;
  name: string;
  version: number;
  status: 'draft' | 'approved' | 'deprecated';
  templates: Record<string, string>;
  approvedAt?: Date;
  entityVersion: number;
}

export interface FeatureFlags {
  tenantId: string;
  flags: Record<string, boolean | string | number>;
  entityVersion: number;
}

export interface TenantMigrationState {
  tenantId: string;
  migrationId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  sourceInstance: string;
  targetInstance: string;
  startedAt?: Date;
  completedAt?: Date;
}

// Cache configuration
export interface CacheConfig {
  entitlementTtlMs: number;
  deploymentTtlMs: number;
  modelConfigTtlMs: number;
  featureFlagTtlMs: number;
  refreshOnMiss: boolean;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  entitlementTtlMs: 60000, // 1 minute
  deploymentTtlMs: 300000, // 5 minutes
  modelConfigTtlMs: 300000, // 5 minutes
  featureFlagTtlMs: 60000, // 1 minute
  refreshOnMiss: true,
};
