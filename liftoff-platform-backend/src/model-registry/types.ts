// Model Registry Types
// Per Section 17: LLM management

import { normalizeTier } from '../llm/types';

// Tier names match the canonical LLMModelTier in src/llm/types.ts, and the
// `models.tier` CHECK constraint (migration 532). A tier read from outside
// this process goes through normalizeTier first.
export type ModelTier = 'small' | 'medium' | 'large';

export interface Model {
  id: string;
  name: string;
  // 'qwen' / 'deepseek' / 'kimi' / 'grok' are REGISTRY-side vendor keys (migrations
  // 322 and 380) for OpenRouter-hosted models — they keep each vendor out of the openrouter
  // tier-loader's DISTINCT-ON-tier map. Their runtime execution provider (and
  // pricing key prefix) remains 'openrouter'.
  provider: 'vertex-ai' | 'anthropic' | 'openai' | 'openrouter' | 'qwen' | 'deepseek' | 'kimi' | 'minimax' | 'grok' | 'xiaomi';
  modelId: string;
  tier?: ModelTier;
  status: 'approved' | 'deprecated' | 'disabled';
  capabilities: string[];
  /** Maximum context tokens this model accepts, or undefined when it has not
   *  been recorded. Undefined is meaningful and must not be defaulted: a
   *  consumer may only make a destructive decision on a recorded window, never
   *  on a provider-family floor, because the floor understates every
   *  long-window model. */
  contextWindow?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelConfig {
  id: string;
  tenantId: string;
  modelId: string;
  version: number;
  routingPolicy: RoutingPolicy;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutingPolicy {
  // Tier-based intent (human-readable governance). The service always
  // populates defaultModel/taskOverrides as the resolved form for consumers.
  defaultTier?: ModelTier;
  taskTierOverrides?: Record<string, ModelTier>;
  // Provider selection
  defaultProvider?: string;
  providerOverrides?: Record<string, string>;
  // Resolved model IDs — populated by the service from tier resolution.
  // These are what tenant-runtime consumes from the cache.
  defaultModel?: string;
  taskOverrides?: Record<string, string>;
  // Workspace AI selection marker (see workspace-ai-vendors.ts). Distinguishes
  // "explicitly chose Anthropic" from "never touched the dropdown" — both
  // produce an anthropic-shaped policy, so the read path needs this to show the
  // right value. Absent → 'default' (Liftoff Managed). Tenant-runtime treats
  // unknown policy keys as passthrough; nothing there reads it.
  selectedVendor?: string;
}

/** A routing policy READ from outside this process (a stored row, a request
 *  body), with its tier fields under their current names: `defaultTier` and
 *  every `taskTierOverrides` value go through normalizeTier. Returns the same
 *  object when there is nothing to change. */
export function normalizePolicyTiers(policy: RoutingPolicy): RoutingPolicy {
  const overrides = policy.taskTierOverrides;
  const overridesChange = !!overrides && Object.values(overrides).some((t) => normalizeTier(t) !== t);
  if (normalizeTier(policy.defaultTier) === policy.defaultTier && !overridesChange) return policy;
  return {
    ...policy,
    ...(policy.defaultTier !== undefined ? { defaultTier: normalizeTier(policy.defaultTier) } : {}),
    ...(overrides && overridesChange
      ? { taskTierOverrides: Object.fromEntries(Object.entries(overrides).map(([k, t]) => [k, normalizeTier(t)])) }
      : {}),
  };
}

export interface RegisterModelInput {
  name: string;
  provider: 'vertex-ai' | 'anthropic' | 'openai' | 'openrouter' | 'qwen' | 'deepseek' | 'kimi' | 'minimax' | 'grok' | 'xiaomi';
  modelId: string;
  tier?: ModelTier;
  capabilities: string[];
  /** Maximum context tokens. Omit when it is not known — a wrong number here is
   *  worse than none, because the runtime treats a recorded window as
   *  authoritative enough to act on. */
  contextWindow?: number;
}

// Per Section 17: Rollout approvals

export type RolloutStatus = 'pending' | 'approved' | 'rejected' | 'in_progress' | 'completed' | 'rolled_back';

export type RolloutStrategy = 'immediate' | 'canary' | 'gradual' | 'blue_green';

export interface ModelRollout {
  id: string;
  tenantId: string;
  modelId: string;
  previousModelId: string | null;
  version: number;
  status: RolloutStatus;
  strategy: RolloutStrategy;
  config: RolloutConfig;

  // Approval tracking
  requestedBy: string;
  requestedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;

  // Rollout progress
  startedAt: Date | null;
  completedAt: Date | null;
  rollbackedAt: Date | null;
  rollbackReason: string | null;

  // Metrics
  metrics: RolloutMetrics;

  createdAt: Date;
  updatedAt: Date;
}

export interface RolloutConfig {
  // Canary settings
  canaryPercentage?: number;      // e.g., 10 = 10% of traffic
  canaryDurationMinutes?: number; // How long to run canary

  // Gradual rollout settings
  gradualSteps?: number[];        // e.g., [10, 25, 50, 100]
  stepDurationMinutes?: number;   // Duration per step

  // Health check settings
  healthCheckEnabled: boolean;
  errorThresholdPercent?: number; // Auto-rollback if errors exceed
  latencyThresholdMs?: number;    // Auto-rollback if latency exceeds

  // Notification settings
  notifyOnApproval: string[];     // Email addresses
  notifyOnFailure: string[];
}

export interface RolloutMetrics {
  requestsTotal: number;
  requestsSuccess: number;
  requestsFailed: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  errorRate: number;
}

export interface CreateRolloutInput {
  tenantId: string;
  modelId: string;
  strategy: RolloutStrategy;
  config: RolloutConfig;
  requestedBy: string;
}

export interface ApproveRolloutInput {
  approvedBy: string;
  comment?: string;
}

export interface RejectRolloutInput {
  rejectedBy: string;
  reason: string;
}
