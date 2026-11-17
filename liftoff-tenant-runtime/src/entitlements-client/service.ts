// Entitlements Client Service
// Per Section 4: Pull contract - Tenant runtime may call control-plane APIs

import {
  TenantEntitlement,
  TenantQuotas,
  ApprovedDeployment,
  ModelConfig,
  PromptBundle,
  TenantMigrationState,
  CacheConfig,
  DEFAULT_CACHE_CONFIG,
} from './types';
import { providerForStoredName } from '../agent-execution/provider-resolution';
import type { ModelTier, RoutingPolicy } from './types';
import { EntitlementsRepository } from './repository';
import { logger } from '../infrastructure/logging';
import { modelForTierOrUndefined } from '../llm/tiers';
import { entitlement_cache_age_ms } from '../observability/runtime-extensions-metrics';
import { getManagedSecret } from '../infrastructure/secret-store';
import { withDeadline } from '../infrastructure/deadline';

/**
 * How long a control-plane read may take, body included. These sit on the run's
 * admission path (a cache miss here is a fetch), and a pooled connection left
 * dead by a network reset held them until the caller's own timer — or forever,
 * where there was none. 5s is what the entitlement fetch already used for its
 * headers; it now covers the body too, and the other two reads get the same.
 * Each already answers null on failure, so a timeout degrades exactly as an
 * unreachable control plane always has.
 */
const CONTROL_PLANE_READ_DEADLINE_MS = 5_000;

/** GET a control-plane JSON document under CONTROL_PLANE_READ_DEADLINE_MS.
 *  Null on 404; throws on any other non-2xx, on a timeout, and on a bad body. */
async function readControlPlaneJson(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<unknown | null> {
  return withDeadline(label, CONTROL_PLANE_READ_DEADLINE_MS, async (signal) => {
    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`${label} failed: ${response.status}`);
    }
    return response.json();
  });
}

// A cache older than this many TTLs is not "a bit stale" — it means the write
// back into the cache is not happening at all. One TTL of slack is normal
// (nothing touched this tenant); ten is a broken refresh.
const STALE_CACHE_ALARM_MULTIPLE = 10;

/** The model+provider pair a routing policy pins for ONE task, or null when it
 *  pins nothing for that task.
 *
 *  Shared verbatim by `getModelForTask` (which falls through to the policy
 *  default when this returns null) and `getTaskModelOverride` (which does not).
 *  One copy on purpose: the two must agree about what counts as a task-specific
 *  pin, or a caller asking "did anyone choose a model here" gets a different
 *  answer from the caller asking "what model runs here".
 *
 *    1.  A COMPLETE pair — model + provider written together for this task.
 *    1b. A model override under a policy naming NO provider anywhere. Nothing
 *        can be crossed, so the override stands as written.
 *    2.  An incomplete override against a policy that DOES name a provider
 *        (legacy rows carry a model with no provider half). Keep the tier
 *        intent, drop the possibly-foreign model id. */
function taskSpecificPair(
  policy: RoutingPolicy,
  taskType: string,
): { model: string; provider?: string } | null {
  const taskModel = policy.taskOverrides?.[taskType];
  const taskProvider = policy.providerOverrides?.[taskType];

  if (taskModel && taskProvider) {
    return { model: taskModel, provider: providerForStoredName(taskProvider, taskModel) };
  }

  // Each half is translated against ITS OWN model, which is the only id that
  // can say which family a stored gateway name meant. Reading the task's model
  // against the policy's default provider would answer for the wrong one: a
  // Qwen workspace with a legacy Claude-only task override would resolve GLM,
  // because a Claude id names no gateway publisher and the fallback is GLM.
  const provider = taskProvider
    ? providerForStoredName(taskProvider, taskModel)
    : providerForStoredName(policy.defaultProvider, policy.defaultModel);

  if (taskModel && !provider) return { model: taskModel, provider: undefined };

  if (taskModel && provider) {
    const tier = policy.taskTierOverrides?.[taskType] ?? policy.defaultTier;
    if (tier) {
      const tierModel = modelForTierOrUndefined(provider, tier);
      if (tierModel) return { model: tierModel, provider };
    }
  }

  return null;
}

// API Response interfaces
interface _EntitlementApiResponse {
  tenantOperationalStatus: string;
  agentExecutionAllowed: boolean;
  /** Control plane's billing_controls.suspended. Optional: the control plane
   *  deploys ahead of the runtime, so a snapshot without it is expected during
   *  the rollout window and reads as `false`. */
  billingSuspended?: boolean;
  remainingIncludedCredits: number;
  overageAllowed: boolean;
  includedMonthlyCredits?: number;
  overageCeiling?: number;
  /**
   * The control plane serves the entitlement row's optimistic-lock counter as
   * `version`. `entityVersion` is the name it carries on the EVENT envelope.
   * Both are declared because this response was read for the event-envelope
   * name only — a field the control plane has never sent on this endpoint — so
   * `data.entityVersion || 1` evaluated to 1 on every fetch for every tenant.
   * That is what made the (then version-guarded) cache write a permanent no-op.
   */
  version?: number;
  entityVersion?: number;
}

interface _DeploymentApiResponse {
  id: string;
  artifactRef: string;
  version: number;
  status: string;
  approvedAt: string;
  entityVersion?: number;
}

const CONTROL_PLANE_API = process.env.CONTROL_PLANE_API_URL || 'http://localhost:3000';

// Default quotas when no entitlement is cached
const DEFAULT_TENANT_QUOTAS: TenantQuotas = {
  tenantId: '',
  operationalStatus: 'pending',
  agentExecutionAllowed: false,
  billingSuspended: false,
  remainingIncludedCredits: 0,
  overageAllowed: false,
  includedMonthlyCredits: 1000,
  overageCeiling: 0,
  entityVersion: 0,
  updatedAt: new Date(),
};

export class EntitlementsClient {
  private repository = new EntitlementsRepository();
  private cacheConfig: CacheConfig;

  constructor(cacheConfig: Partial<CacheConfig> = {}) {
    this.cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...cacheConfig };
  }

  // Per Section 4: Current entitlement snapshot
  async getEntitlement(tenantId: string): Promise<TenantEntitlement> {
    // Try cache first
    let entitlement = await this.repository.getEntitlement(tenantId);

    // Check if cache is stale or missing
    if (!entitlement || await this.repository.isCacheStale(tenantId, this.cacheConfig.entitlementTtlMs)) {
      if (this.cacheConfig.refreshOnMiss) {
        // How old the row we are about to replace actually was. The fetch path
        // silently wrote nothing for months while reporting success, and the
        // only evidence was a cached row nobody looked at. Measuring the age at
        // the moment of refresh turns that into a signal: if this stays in the
        // days-to-months range, the write is not landing.
        if (entitlement?.updatedAt) {
          const ageMs = Date.now() - new Date(entitlement.updatedAt).getTime();
          entitlement_cache_age_ms.observe(ageMs, { tenant_id: tenantId });
          if (ageMs > this.cacheConfig.entitlementTtlMs * STALE_CACHE_ALARM_MULTIPLE) {
            logger.warn('Entitlement cache far past TTL before refresh', {
              tenantId,
              entitlementCacheAgeMs: ageMs,
              ttlMs: this.cacheConfig.entitlementTtlMs,
              entityVersion: entitlement.entityVersion,
            });
          }
        }
        entitlement = await this.fetchEntitlementFromControlPlane(tenantId);
      }
    }

    if (!entitlement) {
      logger.warn('No entitlement found for tenant, using defaults', { tenantId });
      return { ...DEFAULT_TENANT_QUOTAS, tenantId };
    }

    return entitlement;
  }

  // Get full quotas for admission control
  async getQuotas(tenantId: string): Promise<TenantQuotas> {
    const quotas = await this.repository.getQuotas(tenantId);

    if (!quotas) {
      logger.warn('No quotas found for tenant, using defaults', { tenantId });
      return { ...DEFAULT_TENANT_QUOTAS, tenantId };
    }

    return quotas;
  }

  // Per Section 4: Tenant operational status
  async getOperationalStatus(tenantId: string): Promise<string> {
    const entitlement = await this.getEntitlement(tenantId);
    return entitlement.operationalStatus;
  }

  // Quick check if execution is allowed
  async isExecutionAllowed(tenantId: string): Promise<boolean> {
    const entitlement = await this.getEntitlement(tenantId);
    return (
      entitlement.operationalStatus === 'active' &&
      entitlement.agentExecutionAllowed
    );
  }

  // Per Section 4: Approved deployment revision
  async getApprovedDeployment(tenantId: string): Promise<ApprovedDeployment | null> {
    let deployment = await this.repository.getApprovedDeployment(tenantId);

    if (!deployment && this.cacheConfig.refreshOnMiss) {
      deployment = await this.fetchDeploymentFromControlPlane(tenantId);
    }

    return deployment;
  }

  // Per Section 4: Approved model configuration
  async getModelConfigs(tenantId: string): Promise<ModelConfig[]> {
    return this.repository.getModelConfigs(tenantId);
  }

  /** The model and provider to use for a specific task type.
   *
   *  A model id only means anything to the provider that publishes it, so the
   *  two halves are resolved as ONE pair and never mixed across sources.
   *  Resolving them independently — `taskOverrides[task] || defaultModel` for
   *  the model, `providerOverrides[task] || defaultProvider` for the provider —
   *  is what sent `claude-sonnet-4-6` to OpenRouter on a Qwen workspace: the
   *  task carried a model override written while the default provider was
   *  Anthropic, and the provider half then inherited today's vendor.
   *
   *  Precedence, each step yielding a coherent pair:
   *    1. A COMPLETE task override (model + provider written together).
   *    2. The task's tier, resolved against the effective provider's own
   *       catalogue. This preserves the intent of a model-only override — a
   *       task pinned to the cheap tier stays on the cheap tier — while using
   *       the model id that provider actually publishes.
   *    2b. The CALLER's own tier intent, when it carries one that differs from
   *       the policy default (see `tierHint`).
   *    3. The policy default pair.
   *
   *  @param tierHint The caller's own tier intent — in practice an agent's
   *    `model_config.tier`. Without it, step 3 hands back the workspace
   *    `defaultModel` for every caller, so an agent configured for 'large'
   *    silently ran the medium model: the policy default was consulted before
   *    the tier table ever was. With it, the workspace still chooses the
   *    provider and the model family while the agent chooses the size, and the
   *    pair stays coherent — the invariant this whole method is built around.
   *    A hint equal to the policy's own `defaultTier` changes nothing.
   */
  async getModelForTask(
    tenantId: string,
    taskType: string,
    tierHint?: ModelTier,
  ): Promise<{ model: string; provider?: string } | null> {
    const configs = await this.getModelConfigs(tenantId);

    for (const config of configs) {
      const policy = config.routingPolicy;

      const taskPair = taskSpecificPair(policy, taskType);
      if (taskPair) return taskPair;

      // 1b. The task's own DECISION, with no stored model id.
      //
      //     `taskSpecificPair` is gated on the task's MODEL at every branch,
      //     because its other caller uses it to answer "did the workspace choose
      //     a model for this task" and that must stay a question about a pin.
      //     But a task can now carry a tier and a provider and no model at all —
      //     that is what the control plane writes since it stopped materialising
      //     ids — and without this branch such a task would fall through to the
      //     workspace default and silently change tier. The five background tasks
      //     are assigned `small`; the default is `medium`, so the failure would be
      //     every one of them quietly running a tier up, at a tier up's price.
      const taskTier = policy.taskTierOverrides?.[taskType];
      const taskProviderName = policy.providerOverrides?.[taskType];
      if (taskTier || taskProviderName) {
        const taskProvider = providerForStoredName(
          taskProviderName ?? policy.defaultProvider,
          undefined,
        );
        const tier = taskTier ?? policy.defaultTier;
        if (taskProvider && tier) {
          const tierModel = modelForTierOrUndefined(taskProvider, tier);
          if (tierModel) return { model: tierModel, provider: taskProvider };
        }
      }

      // The policy is a CACHE of the control plane's, so it can still name the
      // gateway after the control plane has moved off it — for as long as the
      // cache takes to refresh. Translated on read for the same reason a stored
      // config is: 'openrouter' resolves to no tier map, so an untranslated one
      // silently loses the tier intent here and falls through to the default
      // model.
      const defaultProvider = providerForStoredName(policy.defaultProvider, policy.defaultModel);

      // 2b. The caller's tier intent, resolved against the policy's provider.
      if (tierHint && tierHint !== policy.defaultTier && defaultProvider) {
        const tierModel = modelForTierOrUndefined(defaultProvider, tierHint);
        if (tierModel) return { model: tierModel, provider: defaultProvider };
      }

      // 3. The default pair, resolved from the POLICY'S DECISION rather than
      //    from a model id it used to carry.
      //
      //    A policy states a provider and a tier. The model is whatever the
      //    registry currently publishes for that pair, which is why the control
      //    plane stopped materialising one: a stored id is a cache of this
      //    lookup with no invalidation, and it left workspaces a generation
      //    behind between deploys.
      //
      //    `defaultModel` is still read FIRST when present, and that ordering is
      //    deliberate rather than leftover. A stored id can still arrive — from
      //    a policy written before the change, from a cache that has not
      //    refreshed, or from an operator who deliberately pinned one — and
      //    honouring it is what makes the two planes safe to deploy in either
      //    order. Once nothing writes it, this branch simply stops being taken.
      if (policy.defaultModel) {
        return { model: policy.defaultModel, provider: defaultProvider };
      }

      if (defaultProvider) {
        const tierModel = modelForTierOrUndefined(defaultProvider, policy.defaultTier ?? 'medium');
        if (tierModel) return { model: tierModel, provider: defaultProvider };
      }
    }

    return null;
  }

  /** A model+provider pair pinned for THIS task specifically, or null.
   *
   *  Deliberately never falls back to the policy default the way
   *  `getModelForTask` does. Callers that must distinguish "the workspace chose
   *  a model for this task" from "resolution landed somewhere" need that
   *  distinction to be real: the nested coding agents keep their own vendor
   *  default model unless an operator actually pinned one, and a lookup that
   *  answers `defaultModel` for every tenant would silently take that away. */
  async getTaskModelOverride(
    tenantId: string,
    taskType: string,
  ): Promise<{ model: string; provider?: string } | null> {
    const configs = await this.getModelConfigs(tenantId);
    for (const config of configs) {
      const pair = taskSpecificPair(config.routingPolicy, taskType);
      if (pair) return pair;
    }
    return null;
  }

  // Per Section 4: Approved prompt bundle
  async getPromptBundle(tenantId: string, bundleId: string): Promise<PromptBundle | null> {
    return this.repository.getPromptBundle(tenantId, bundleId);
  }

  // Get all approved prompt bundles
  async getApprovedPromptBundles(tenantId: string): Promise<PromptBundle[]> {
    return this.repository.getApprovedPromptBundles(tenantId);
  }

  // Per Section 4: Feature flags
  async getFeatureFlags(tenantId: string): Promise<Record<string, boolean | string | number>> {
    const flags = await this.repository.getFeatureFlags(tenantId);
    return flags?.flags ?? {};
  }

  // Check a specific feature flag
  async isFeatureEnabled(tenantId: string, flagName: string): Promise<boolean> {
    const flags = await this.getFeatureFlags(tenantId);
    return !!flags[flagName];
  }

  // Get feature flag value (for non-boolean flags)
  async getFeatureFlagValue<T>(tenantId: string, flagName: string, defaultValue: T): Promise<T> {
    const flags = await this.getFeatureFlags(tenantId);
    return (flags[flagName] as T) ?? defaultValue;
  }

  // Per Section 4: Tenant migration state
  async getMigrationState(tenantId: string): Promise<TenantMigrationState | null> {
    try {
      return await readControlPlaneJson(
        'fetch migration state',
        `${CONTROL_PLANE_API}/api/tenants/${tenantId}/migration`,
        {},
      ) as TenantMigrationState | null;
    } catch (error) {
      logger.error('Failed to fetch migration state', { tenantId, error });
      return null;
    }
  }

  // getRemainingCredits() and hasSufficientCredits() are gone (INV-TR-012).
  // They were the last money arithmetic on this side: a balance read and an
  // overage-ceiling comparison over `remaining_credits` / `overage_allowed` /
  // `overage_ceiling` — columns nothing has maintained since metering moved to
  // the control plane. Neither had a production caller, which is the only
  // reason they never denied anything themselves. Spend authority is
  // `billing_controls` + the OU buckets; permission arrives as
  // operationalStatus / agentExecutionAllowed / billingSuspended.

  // Per Section 4: Runtime stale-event rule - check if event version is newer
  async isEventNewer(
    tenantId: string,
    entityType: string,
    entityId: string,
    eventVersion: number
  ): Promise<boolean> {
    const storedVersion = await this.repository.getStoredVersion(tenantId, entityType, entityId);

    if (storedVersion === null) {
      return true; // First event for this entity
    }

    return eventVersion > storedVersion;
  }

  // Fetch and cache entitlement from control plane
  private async fetchEntitlementFromControlPlane(tenantId: string): Promise<TenantEntitlement | null> {
    try {
      const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
      const headers: Record<string, string> = {};
      if (serviceToken) {
        headers['X-Service-Auth'] = serviceToken;
      }
      // The timer used to be cleared before `response.json()`, so a body that
      // never arrived was waited for forever. The deadline now covers it.
      const data = await readControlPlaneJson(
        'fetch entitlement',
        `${CONTROL_PLANE_API}/api/internal/entitlements/tenant/${tenantId}`,
        headers,
      ) as any;
      if (data === null) return null;

      // Map control plane response to runtime entitlement. Defaults match
      // DEFAULT_TENANT_QUOTAS so a partial response (control-plane row missing
      // fields) doesn't NULL-poison the cached row's NOT NULL columns.
      const entitlement: TenantEntitlement = {
        tenantId,
        operationalStatus: data.tenantOperationalStatus,
        agentExecutionAllowed: data.agentExecutionAllowed,
        // Absent until the control plane ships the field (it deploys first);
        // absent must mean "not suspended", never "suspended".
        billingSuspended: data.billingSuspended ?? false,
        remainingIncludedCredits: data.remainingIncludedCredits,
        overageAllowed: data.overageAllowed,
        includedMonthlyCredits: data.includedMonthlyCredits ?? DEFAULT_TENANT_QUOTAS.includedMonthlyCredits,
        overageCeiling: data.overageCeiling ?? DEFAULT_TENANT_QUOTAS.overageCeiling,
        // `version` is what the control plane actually sends on this endpoint;
        // `entityVersion` is the event-envelope spelling, accepted so the two
        // shapes stay interchangeable. Reading only the latter is what pinned
        // every cached row at version 1 forever.
        entityVersion: data.entityVersion ?? data.version ?? 1,
        updatedAt: new Date(),
      };

      // Cache it. The fetch variant writes unconditionally — a control-plane
      // read is the current truth and has no version to be ordered against.
      await this.repository.upsertEntitlementFromFetch(entitlement);

      logger.info('Fetched and cached entitlement from control plane', { tenantId });

      return entitlement;
    } catch (error) {
      logger.error('Failed to fetch entitlement from control plane', { tenantId, error });
      return null;
    }
  }

  // Fetch and cache deployment from control plane
  private async fetchDeploymentFromControlPlane(tenantId: string): Promise<ApprovedDeployment | null> {
    try {
      // X-Service-Auth, like every other control-plane call. Without it this
      // hit the Firebase gate and 401'd; the catch below turned that into
      // `null`, which reads as "this tenant has no approved deployment" — a
      // plausible answer, which is why it went unnoticed. The endpoint itself
      // did not exist either until the matching service route was added.
      const serviceToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
      const data = await readControlPlaneJson(
        'fetch deployment',
        `${CONTROL_PLANE_API}/api/internal/deployments/tenant/${tenantId}/approved`,
        serviceToken ? { 'X-Service-Auth': serviceToken } : {},
      ) as any;
      if (data === null) return null;

      const deployment: ApprovedDeployment = {
        deploymentId: data.id,
        tenantId,
        artifactRef: data.artifactRef,
        version: data.version,
        status: data.status,
        approvedAt: new Date(data.approvedAt),
        entityVersion: data.entityVersion || 1,
      };

      // Cache the deployment for future lookups
      await this.repository.upsertDeployment(deployment);
      logger.info('Fetched and cached deployment from control plane', { tenantId, deploymentId: deployment.deploymentId });

      return deployment;
    } catch (error) {
      logger.error('Failed to fetch deployment from control plane', { tenantId, error });
      return null;
    }
  }
}

// Singleton instance for convenience
let defaultClient: EntitlementsClient | null = null;

export function getEntitlementsClient(): EntitlementsClient {
  if (!defaultClient) {
    defaultClient = new EntitlementsClient();
  }
  return defaultClient;
}

// Convenience functions using the default client
export async function isExecutionAllowed(tenantId: string): Promise<boolean> {
  return getEntitlementsClient().isExecutionAllowed(tenantId);
}

export async function getOperationalStatus(tenantId: string): Promise<string> {
  return getEntitlementsClient().getOperationalStatus(tenantId);
}

export async function isFeatureEnabled(tenantId: string, flagName: string): Promise<boolean> {
  return getEntitlementsClient().isFeatureEnabled(tenantId, flagName);
}
