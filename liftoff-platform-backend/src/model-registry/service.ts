// Model Registry Service Implementation
// Per Section 17: Approved model list, routing policy, rollout approvals

import {
  Model,
  ModelConfig,
  RegisterModelInput,
  RoutingPolicy,
  normalizePolicyTiers,
  ModelRollout,
  CreateRolloutInput,
  ApproveRolloutInput,
  RejectRolloutInput,
  RolloutMetrics,
} from './types';
import { ModelRepository, ModelConfigRepository, ModelRolloutRepository } from './repository';
import { publishEvent } from '../events/publisher';
import { normalizeTier } from '../llm/types';
import { logger } from '../infrastructure/logging';
import {
  buildWorkspaceAiPolicy,
  type WorkspaceAiSelection,
} from './workspace-ai-vendors';
import { hasStaticRate } from '../llm/pricing';

export class ModelRegistryService {
  private modelRepository = new ModelRepository();
  private configRepository = new ModelConfigRepository();
  private rolloutRepository = new ModelRolloutRepository();

  // Per Section 17: Use Anthropic Claude Opus on Vertex AI for:
  // - instruction compilation
  // - complex planning
  // - reflection
  // - high-risk human-facing summaries

  // List all models
  async listAll(): Promise<Model[]> {
    return this.modelRepository.findAll();
  }

  // Per Section 17: Approved model list
  async listApproved(): Promise<Model[]> {
    return this.modelRepository.findApproved();
  }

  // Get model by ID
  async getById(id: string): Promise<Model | null> {
    return this.modelRepository.findById(id);
  }

  // Register a new model
  async register(input: RegisterModelInput): Promise<Model> {
    return this.modelRepository.create({ ...input, tier: normalizeTier(input.tier) });
  }

  /** Approve a model for use.
   *
   *  REFUSES a model that has no published rate, and that refusal is the point.
   *  Approval is not a label: `findByTierAndProvider` picks the newest approved
   *  row, so an approved model is immediately tier-resolvable and can be
   *  serving traffic seconds later. `computeRowCost` never bills $0 — it falls
   *  back to the conservative default — so an unpriced model does not fail, it
   *  is charged at ANOTHER model's price on every row, indefinitely, while
   *  every surface looks healthy. The tenant runtime is worse: it books no cost
   *  at all.
   *
   *  The code path was already fenced (pricing-coverage.test.ts gates every
   *  model reachable from a tier map, with an empty debt list). This is the
   *  half that was not: an operator adding a model through the admin API
   *  touched no code and passed no ratchet. Migrations that insert
   *  `status='approved'` directly still bypass this by design — they are
   *  covered by review and by that same ratchet.
   *
   *  Both rate sources are consulted in `computeRowCost`'s own resolution
   *  order, via the shared `pricingKeysFor`: a second copy of that order is how
   *  the gate and the biller start disagreeing about what counts as priced. */
  async approve(id: string): Promise<Model> {
    const existing = await this.modelRepository.findById(id);
    if (!existing) throw new Error(`Model ${id} not found`);

    const priced =
      hasStaticRate(existing.provider, existing.modelId)
      || await this.modelRepository.hasSyncedRate(existing.provider, existing.modelId);

    if (!priced) {
      throw new Error(
        `Cannot approve ${existing.provider}/${existing.modelId}: no published rate. `
        + `An approved model is immediately tier-resolvable, and an unpriced one is billed `
        + `at another model's rate on every row. Add it to MODEL_PRICING in `
        + `src/llm/pricing.ts (from the vendor's own price list, never an estimate), or let `
        + `the model-pricing sync job write a model_pricing row for it, then approve again.`,
      );
    }

    const model = await this.modelRepository.updateStatus(id, 'approved');

    // Per Section 4: Publish model status change event
    await publishEvent({
      eventType: 'model.approved',
      entityType: 'model',
      entityId: model.id,
      entityVersion: 1,
      eventVersion: 1,
      payload: { name: model.name, provider: model.provider },
    });

    return model;
  }

  // Deprecate a model
  async deprecate(id: string): Promise<Model> {
    const model = await this.modelRepository.updateStatus(id, 'deprecated');

    // Per Section 4: Publish model status change event
    await publishEvent({
      eventType: 'model.deprecated',
      entityType: 'model',
      entityId: model.id,
      entityVersion: 1,
      eventVersion: 1,
      payload: { name: model.name, provider: model.provider },
    });

    return model;
  }

  // Disable a model
  async disable(id: string): Promise<Model> {
    const model = await this.modelRepository.updateStatus(id, 'disabled');

    // Per Section 4: Publish model status change event
    await publishEvent({
      eventType: 'model.disabled',
      entityType: 'model',
      entityId: model.id,
      entityVersion: 1,
      eventVersion: 1,
      payload: { name: model.name, provider: model.provider },
    });

    return model;
  }

  /** Record a model's context window, in tokens.
   *
   *  `null` clears it back to unrecorded, which is a real state and not the same
   *  as zero: the runtime treats an absent window as "fall back to the provider
   *  family floor and never retire a session on it". Anything that is not a
   *  positive integer is rejected rather than coerced, because a coerced window
   *  is a number the runtime would trust as exact.
   *
   *  Returns null when no such model exists, so the caller can 404 rather than
   *  report a write that touched nothing. */
  async setContextWindow(id: string, contextWindow: number | null): Promise<Model | null> {
    if (contextWindow !== null) {
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        throw new Error('contextWindow must be a positive integer, or null to clear it');
      }
    }
    return this.modelRepository.updateContextWindow(id, contextWindow);
  }

  // Per Section 17: Get routing policy for a tenant
  async getConfigsForTenant(tenantId: string): Promise<ModelConfig[]> {
    return this.configRepository.findByTenantId(tenantId);
  }

  // A stored policy carries DECISIONS — a provider and a tier — and no resolved
  // model id. This used to resolve every tier to a concrete id before persisting,
  // "so tenant-runtime can consume it directly from its cache", and that sentence
  // is the whole defect: what the runtime consumed directly was a value frozen at
  // write time, preferred over the tier, and stale from the next registry change
  // onward. The runtime now resolves (provider, tier) against the registry
  // snapshot on every call, which is the same answer without the staleness.
  //
  // Kept as a named no-op rather than deleted at every call site, because the
  // three writers that call it are where a future reader would otherwise think
  // resolution belongs. A policy passed through is returned unchanged; an id a
  // CALLER supplied is preserved, because this was never the place that decided
  // whether a caller may pin one.
  private async resolveTiersInPolicy(policy: RoutingPolicy): Promise<RoutingPolicy> {
    return policy;
  }

  // Per Section 17: Update routing policy (direct, for non-rollout scenarios)
  async updateConfig(
    tenantId: string,
    modelId: string,
    routingPolicy: RoutingPolicy
  ): Promise<ModelConfig> {
    const resolved = await this.resolveTiersInPolicy(normalizePolicyTiers(routingPolicy));
    const config = await this.configRepository.upsert(tenantId, modelId, resolved);

    // Per Section 4: Publish tenant.model_config.updated event
    await publishEvent({
      eventType: 'tenant.model_config.updated',
      tenantId,
      entityType: 'model_config',
      entityId: config.id,
      entityVersion: config.version,
      eventVersion: 1,
    });

    return config;
  }

  // Delete a model config for a tenant
  async deleteConfig(tenantId: string, modelId: string): Promise<void> {
    await this.configRepository.delete(tenantId, modelId);
  }

  // ==========================================
  // Workspace AI vendor selection (settings dropdown)
  // ==========================================

  /** Apply a Workspace AI vendor selection: rebuild the tenant's routing
   *  policy via buildWorkspaceAiPolicy and write it onto the tenant's EXISTING
   *  model_configs row.
   *
   *  Single-row invariant: the upsert conflicts on (tenant_id, model_id), so
   *  writing with a different models.id would INSERT A SECOND config row and
   *  make getModelForTask order-dependent. We therefore reuse the existing
   *  row's model_id (the FK is vestigial for execution — the policy carries
   *  resolved model ids); only a tenant with zero rows gets a fresh row,
   *  anchored on the anthropic medium registry model. */
  async setWorkspaceVendor(tenantId: string, selection: WorkspaceAiSelection): Promise<ModelConfig> {
    const configs = await this.configRepository.findByTenantId(tenantId);
    const existing = configs[0];

    let anchorModelId = existing?.modelId;
    if (!anchorModelId) {
      const anchor = await this.modelRepository.findByTierAndProvider('medium', 'anthropic');
      if (!anchor) {
        throw new Error('No anthropic medium model registered to anchor a new model_config row');
      }
      anchorModelId = anchor.id;
    }

    const policy = buildWorkspaceAiPolicy(selection, existing?.routingPolicy);
    const config = await this.configRepository.upsert(tenantId, anchorModelId, policy);

    logger.info('Workspace AI vendor applied', {
      tenantId,
      selection,
      defaultProvider: policy.defaultProvider,
      defaultModel: policy.defaultModel,
    });

    // Same event every routing-policy write fires — drives the TR
    // cached_model_configs sync (outbox trigger covers the row too; the
    // explicit publish matches updateConfig's behavior).
    await publishEvent({
      eventType: 'tenant.model_config.updated',
      tenantId,
      entityType: 'model_config',
      entityId: config.id,
      entityVersion: config.version,
      eventVersion: 1,
    });

    return config;
  }

  /** Read the tenant's Workspace AI selection ('default' when the tenant never
   *  chose a vendor — indistinguishable-from-anthropic policies are exactly why
   *  the selectedVendor marker exists). */
  async getWorkspaceVendor(tenantId: string): Promise<WorkspaceAiSelection> {
    const configs = await this.configRepository.findByTenantId(tenantId);
    const marker = configs[0]?.routingPolicy?.selectedVendor;
    return (marker as WorkspaceAiSelection | undefined) ?? 'default';
  }

  // Get the effective model for a task type
  async getModelForTask(tenantId: string, taskType: string): Promise<Model | null> {
    const configs = await this.configRepository.findByTenantId(tenantId);

    for (const config of configs) {
      if (config.routingPolicy.taskOverrides?.[taskType]) {
        const modelId = config.routingPolicy.taskOverrides[taskType];
        return this.modelRepository.findById(modelId);
      }
      if (config.routingPolicy.defaultModel) {
        return this.modelRepository.findById(config.routingPolicy.defaultModel);
      }
    }

    // Fall back to first approved model
    const approved = await this.modelRepository.findApproved();
    return approved[0] || null;
  }

  // ==========================================
  // Per Section 17: Rollout Approval Workflow
  // ==========================================

  // List all rollouts
  async listRollouts(tenantId?: string): Promise<ModelRollout[]> {
    return this.rolloutRepository.findAll(tenantId);
  }

  // List pending rollouts (awaiting approval)
  async listPendingRollouts(tenantId?: string): Promise<ModelRollout[]> {
    return this.rolloutRepository.findPending(tenantId);
  }

  // List in-progress rollouts
  async listInProgressRollouts(tenantId?: string): Promise<ModelRollout[]> {
    return this.rolloutRepository.findInProgress(tenantId);
  }

  // Get rollout by ID
  async getRolloutById(id: string): Promise<ModelRollout | null> {
    return this.rolloutRepository.findById(id);
  }

  // Create a new rollout request
  async createRollout(input: CreateRolloutInput): Promise<ModelRollout> {
    // Validate model exists and is approved
    const model = await this.modelRepository.findById(input.modelId);
    if (!model) {
      throw new Error(`Model ${input.modelId} not found`);
    }
    if (model.status !== 'approved') {
      throw new Error(`Model ${input.modelId} is not approved for use`);
    }

    // Check for existing pending rollout
    const pendingRollouts = await this.rolloutRepository.findPending(input.tenantId);
    if (pendingRollouts.length > 0) {
      throw new Error('There is already a pending rollout for this tenant. Approve or reject it first.');
    }

    // Check for in-progress rollout
    const inProgressRollouts = await this.rolloutRepository.findInProgress(input.tenantId);
    if (inProgressRollouts.length > 0) {
      throw new Error('There is already an in-progress rollout for this tenant.');
    }

    const rollout = await this.rolloutRepository.create(input);

    logger.info('Created model rollout request', {
      rolloutId: rollout.id,
      tenantId: input.tenantId,
      modelId: input.modelId,
      strategy: input.strategy,
      requestedBy: input.requestedBy,
    });

    await publishEvent({
      eventType: 'tenant.model_rollout.requested',
      tenantId: input.tenantId,
      entityType: 'model_rollout',
      entityId: rollout.id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: input.modelId,
        strategy: input.strategy,
        requestedBy: input.requestedBy,
      },
    });

    return rollout;
  }

  // Approve a rollout request
  async approveRollout(id: string, input: ApproveRolloutInput): Promise<ModelRollout> {
    const rollout = await this.rolloutRepository.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'pending') {
      throw new Error(`Rollout ${id} is not pending approval (status: ${rollout.status})`);
    }

    const approved = await this.rolloutRepository.approve(id, input.approvedBy);

    logger.info('Approved model rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      approvedBy: input.approvedBy,
    });

    await publishEvent({
      eventType: 'tenant.model_rollout.approved',
      tenantId: rollout.tenantId,
      entityType: 'model_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        approvedBy: input.approvedBy,
        comment: input.comment,
      },
    });

    return approved;
  }

  // Reject a rollout request
  async rejectRollout(id: string, input: RejectRolloutInput): Promise<ModelRollout> {
    const rollout = await this.rolloutRepository.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'pending') {
      throw new Error(`Rollout ${id} is not pending approval (status: ${rollout.status})`);
    }

    const rejected = await this.rolloutRepository.reject(id, input.rejectedBy, input.reason);

    logger.info('Rejected model rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      rejectedBy: input.rejectedBy,
      reason: input.reason,
    });

    await publishEvent({
      eventType: 'tenant.model_rollout.rejected',
      tenantId: rollout.tenantId,
      entityType: 'model_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        rejectedBy: input.rejectedBy,
        reason: input.reason,
      },
    });

    return rejected;
  }

  // Start executing an approved rollout
  async startRollout(id: string): Promise<ModelRollout> {
    const rollout = await this.rolloutRepository.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'approved') {
      throw new Error(`Rollout ${id} is not approved (status: ${rollout.status})`);
    }

    const started = await this.rolloutRepository.startRollout(id);

    logger.info('Started model rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      strategy: rollout.strategy,
    });

    // For immediate strategy, complete right away
    if (rollout.strategy === 'immediate') {
      return this.completeRollout(id);
    }

    await publishEvent({
      eventType: 'tenant.model_rollout.started',
      tenantId: rollout.tenantId,
      entityType: 'model_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        strategy: rollout.strategy,
      },
    });

    return started;
  }

  // Complete a rollout (switches traffic fully to new model)
  async completeRollout(id: string): Promise<ModelRollout> {
    const rollout = await this.rolloutRepository.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'in_progress' && rollout.status !== 'approved') {
      throw new Error(`Cannot complete rollout with status: ${rollout.status}`);
    }

    // Update the model config for the tenant
    const model = await this.modelRepository.findById(rollout.modelId);
    if (!model) {
      throw new Error(`Model ${rollout.modelId} not found`);
    }

    // A rollout is the ONE legitimate writer of a model id into a policy: it is
    // a deliberate platform decision to put this tenant on THIS model, which is
    // a pin and not a workspace choosing from a menu. Everything else records a
    // provider and a tier and resolves the model at call time.
    //
    // `rollout.modelId` is a `models.id` — a UUID. It is the right value for the
    // config's own foreign key (the second argument) and the WRONG value for
    // `defaultModel`, which every reader treats as a vendor model slug. Writing
    // the UUID there produced a policy naming a model no provider publishes, so
    // the runtime resolved nothing from it and the rollout silently did not take.
    // `model` is the row already loaded above for exactly this purpose.
    await this.configRepository.upsert(rollout.tenantId, rollout.modelId, {
      defaultModel: model.modelId,
      taskOverrides: {},
    });

    const completed = await this.rolloutRepository.completeRollout(id);

    logger.info('Completed model rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
    });

    // Publish config update event
    await publishEvent({
      eventType: 'tenant.model_config.updated',
      tenantId: rollout.tenantId,
      entityType: 'model_config',
      entityId: rollout.modelId,
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        previousModelId: rollout.previousModelId,
        rolloutId: id,
      },
    });

    await publishEvent({
      eventType: 'tenant.model_rollout.completed',
      tenantId: rollout.tenantId,
      entityType: 'model_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        previousModelId: rollout.previousModelId,
      },
    });

    return completed;
  }

  // Rollback a rollout (reverts to previous model)
  async rollbackRollout(id: string, reason: string): Promise<ModelRollout> {
    const rollout = await this.rolloutRepository.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'in_progress' && rollout.status !== 'completed') {
      throw new Error(`Cannot rollback rollout with status: ${rollout.status}`);
    }

    // Revert to previous model if available. Same distinction as completeRollout:
    // the UUID identifies the config row, the SLUG is what a policy can be read
    // against. A rollback that wrote the UUID reverted nothing a runtime could
    // resolve — the worse half of the pair, because a rollback is what someone
    // reaches for when a model is already misbehaving.
    if (rollout.previousModelId) {
      const previous = await this.modelRepository.findById(rollout.previousModelId);
      if (!previous) {
        throw new Error(`Previous model ${rollout.previousModelId} not found`);
      }
      await this.configRepository.upsert(rollout.tenantId, rollout.previousModelId, {
        defaultModel: previous.modelId,
        taskOverrides: {},
      });
    } else {
      // Delete the config if there was no previous model
      await this.configRepository.delete(rollout.tenantId, rollout.modelId);
    }

    const rolledBack = await this.rolloutRepository.rollback(id, reason);

    logger.info('Rolled back model rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      previousModelId: rollout.previousModelId,
      reason,
    });

    await publishEvent({
      eventType: 'tenant.model_rollout.rolled_back',
      tenantId: rollout.tenantId,
      entityType: 'model_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        previousModelId: rollout.previousModelId,
        reason,
      },
    });

    return rolledBack;
  }

  // Update rollout metrics (for monitoring)
  async updateRolloutMetrics(id: string, metrics: RolloutMetrics): Promise<void> {
    const rollout = await this.rolloutRepository.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }

    await this.rolloutRepository.updateMetrics(id, metrics);

    // Check if auto-rollback thresholds are exceeded
    if (rollout.config.healthCheckEnabled) {
      const errorThreshold = rollout.config.errorThresholdPercent || 5;
      const latencyThreshold = rollout.config.latencyThresholdMs || 5000;

      if (metrics.errorRate > errorThreshold / 100) {
        logger.warn('Error rate threshold exceeded, triggering auto-rollback', {
          rolloutId: id,
          errorRate: metrics.errorRate,
          threshold: errorThreshold,
        });
        await this.rollbackRollout(id, `Auto-rollback: Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeded threshold ${errorThreshold}%`);
      } else if (metrics.p99LatencyMs > latencyThreshold) {
        logger.warn('Latency threshold exceeded, triggering auto-rollback', {
          rolloutId: id,
          p99LatencyMs: metrics.p99LatencyMs,
          threshold: latencyThreshold,
        });
        await this.rollbackRollout(id, `Auto-rollback: P99 latency ${metrics.p99LatencyMs}ms exceeded threshold ${latencyThreshold}ms`);
      }
    }
  }
}
