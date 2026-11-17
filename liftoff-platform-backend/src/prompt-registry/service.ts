// Prompt Registry Service Implementation
// Per Section 17: Prompt template versions, validator hook versions

import {
  PromptBundle,
  PromptTemplate,
  CreateBundleInput,
  CreateTemplateInput,
  PromptRollout,
  CreatePromptRolloutInput,
  ApprovePromptRolloutInput,
  RejectPromptRolloutInput,
  PromptRolloutMetrics,
} from './types';
import { PromptBundleRepository, PromptTemplateRepository, PromptRolloutRepository } from './repository';
import { publishEvent } from '../events/publisher';
import { logger } from '../infrastructure/logging';

export class PromptRegistryService {
  private bundleRepo = new PromptBundleRepository();
  private templateRepo = new PromptTemplateRepository();
  private rolloutRepo = new PromptRolloutRepository();

  async listBundles(): Promise<PromptBundle[]> {
    return this.bundleRepo.findAll();
  }

  async listApprovedBundles(): Promise<PromptBundle[]> {
    return this.bundleRepo.findApproved();
  }

  async getBundleById(id: string): Promise<PromptBundle | null> {
    return this.bundleRepo.findById(id);
  }

  async createBundle(input: CreateBundleInput): Promise<PromptBundle> {
    const bundle = await this.bundleRepo.create(input);

    await publishEvent({
      entityType: 'prompt_bundle',
      entityId: bundle.id,
      eventType: 'tenant.prompt_bundle.created',
      entityVersion: bundle.version,
      eventVersion: 1,
      tenantId: bundle.tenantId,
      payload: {
        name: bundle.name,
        version: bundle.version,
        templates: bundle.templates,
      },
    });

    return bundle;
  }

  async approveBundle(id: string): Promise<PromptBundle> {
    const bundle = await this.bundleRepo.updateStatus(id, 'approved');

    // Per Section 4: Publish tenant.prompt_bundle.approved event
    await publishEvent({
      entityType: 'prompt_bundle',
      entityId: bundle.id,
      eventType: 'tenant.prompt_bundle.approved',
      entityVersion: bundle.version,
      eventVersion: 1,
      tenantId: bundle.tenantId,
      payload: {
        name: bundle.name,
        version: bundle.version,
        approvedAt: bundle.approvedAt,
      },
    });

    return bundle;
  }

  async deprecateBundle(id: string): Promise<PromptBundle> {
    const bundle = await this.bundleRepo.updateStatus(id, 'deprecated');

    await publishEvent({
      entityType: 'prompt_bundle',
      entityId: bundle.id,
      eventType: 'tenant.prompt_bundle.deprecated',
      entityVersion: bundle.version,
      eventVersion: 1,
      tenantId: bundle.tenantId,
      payload: {
        name: bundle.name,
        version: bundle.version,
      },
    });

    return bundle;
  }

  async updateBundle(id: string, templates: string[]): Promise<PromptBundle> {
    const bundle = await this.bundleRepo.updateTemplates(id, templates);

    // Per Section 4: Publish tenant.prompt_bundle.updated event
    await publishEvent({
      entityType: 'prompt_bundle',
      entityId: bundle.id,
      eventType: 'tenant.prompt_bundle.updated',
      entityVersion: bundle.version,
      eventVersion: 1,
      tenantId: bundle.tenantId,
      payload: {
        name: bundle.name,
        version: bundle.version,
        templates: bundle.templates,
      },
    });

    return bundle;
  }

  async listTemplates(): Promise<PromptTemplate[]> {
    return this.templateRepo.findAll();
  }

  async getTemplateById(id: string): Promise<PromptTemplate | null> {
    return this.templateRepo.findById(id);
  }

  async createTemplate(input: CreateTemplateInput): Promise<PromptTemplate> {
    const template = await this.templateRepo.create(input);

    await publishEvent({
      entityType: 'prompt_template',
      entityId: template.id,
      eventType: 'tenant.prompt_template.created',
      entityVersion: template.version,
      eventVersion: 1,
      tenantId: template.tenantId,
      payload: {
        name: template.name,
        version: template.version,
        variables: template.variables,
      },
    });

    return template;
  }

  async updateTemplate(id: string, content: string, variables: string[]): Promise<PromptTemplate> {
    const template = await this.templateRepo.update(id, content, variables);

    await publishEvent({
      entityType: 'prompt_template',
      entityId: template.id,
      eventType: 'tenant.prompt_template.updated',
      entityVersion: template.version,
      eventVersion: 1,
      tenantId: template.tenantId,
      payload: {
        name: template.name,
        version: template.version,
        variables: template.variables,
      },
    });

    return template;
  }

  // ==========================================
  // Per Section 15: Prompt Rollout Approval Workflow
  // ==========================================

  async listRollouts(tenantId?: string): Promise<PromptRollout[]> {
    return this.rolloutRepo.findAll(tenantId);
  }

  async listPendingRollouts(tenantId?: string): Promise<PromptRollout[]> {
    return this.rolloutRepo.findPending(tenantId);
  }

  async listInProgressRollouts(tenantId?: string): Promise<PromptRollout[]> {
    return this.rolloutRepo.findInProgress(tenantId);
  }

  async getRolloutById(id: string): Promise<PromptRollout | null> {
    return this.rolloutRepo.findById(id);
  }

  async createRollout(input: CreatePromptRolloutInput): Promise<PromptRollout> {
    // Validate bundle exists
    const bundle = await this.bundleRepo.findById(input.bundleId);
    if (!bundle) {
      throw new Error(`Bundle ${input.bundleId} not found`);
    }

    // Check for existing pending rollout
    const pendingRollouts = await this.rolloutRepo.findPending(input.tenantId);
    if (pendingRollouts.length > 0) {
      throw new Error('There is already a pending prompt rollout for this tenant');
    }

    // Check for in-progress rollout
    const inProgressRollouts = await this.rolloutRepo.findInProgress(input.tenantId);
    if (inProgressRollouts.length > 0) {
      throw new Error('There is already an in-progress prompt rollout for this tenant');
    }

    const rollout = await this.rolloutRepo.create(input);

    logger.info('Created prompt rollout request', {
      rolloutId: rollout.id,
      tenantId: input.tenantId,
      bundleId: input.bundleId,
      strategy: input.strategy,
      requestedBy: input.requestedBy,
    });

    await publishEvent({
      eventType: 'tenant.prompt_rollout.requested',
      tenantId: input.tenantId,
      entityType: 'prompt_rollout',
      entityId: rollout.id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        bundleId: input.bundleId,
        strategy: input.strategy,
        requestedBy: input.requestedBy,
      },
    });

    return rollout;
  }

  async approveRollout(id: string, input: ApprovePromptRolloutInput): Promise<PromptRollout> {
    const rollout = await this.rolloutRepo.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'pending') {
      throw new Error(`Rollout ${id} is not pending approval (status: ${rollout.status})`);
    }

    const approved = await this.rolloutRepo.approve(id, input.approvedBy);

    logger.info('Approved prompt rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      bundleId: rollout.bundleId,
      approvedBy: input.approvedBy,
    });

    await publishEvent({
      eventType: 'tenant.prompt_rollout.approved',
      tenantId: rollout.tenantId,
      entityType: 'prompt_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        bundleId: rollout.bundleId,
        approvedBy: input.approvedBy,
        comment: input.comment,
      },
    });

    return approved;
  }

  async rejectRollout(id: string, input: RejectPromptRolloutInput): Promise<PromptRollout> {
    const rollout = await this.rolloutRepo.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'pending') {
      throw new Error(`Rollout ${id} is not pending approval (status: ${rollout.status})`);
    }

    const rejected = await this.rolloutRepo.reject(id, input.rejectedBy, input.reason);

    logger.info('Rejected prompt rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      bundleId: rollout.bundleId,
      rejectedBy: input.rejectedBy,
      reason: input.reason,
    });

    await publishEvent({
      eventType: 'tenant.prompt_rollout.rejected',
      tenantId: rollout.tenantId,
      entityType: 'prompt_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        bundleId: rollout.bundleId,
        rejectedBy: input.rejectedBy,
        reason: input.reason,
      },
    });

    return rejected;
  }

  async startRollout(id: string): Promise<PromptRollout> {
    const rollout = await this.rolloutRepo.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'approved') {
      throw new Error(`Rollout ${id} is not approved (status: ${rollout.status})`);
    }

    const started = await this.rolloutRepo.startRollout(id);

    logger.info('Started prompt rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      bundleId: rollout.bundleId,
      strategy: rollout.strategy,
    });

    // For immediate strategy, complete right away
    if (rollout.strategy === 'immediate') {
      return this.completeRollout(id);
    }

    await publishEvent({
      eventType: 'tenant.prompt_rollout.started',
      tenantId: rollout.tenantId,
      entityType: 'prompt_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        bundleId: rollout.bundleId,
        strategy: rollout.strategy,
      },
    });

    return started;
  }

  async completeRollout(id: string): Promise<PromptRollout> {
    const rollout = await this.rolloutRepo.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'in_progress' && rollout.status !== 'approved') {
      throw new Error(`Cannot complete rollout with status: ${rollout.status}`);
    }

    // Approve the new bundle
    await this.bundleRepo.updateStatus(rollout.bundleId, 'approved');

    // Deprecate previous bundle if exists
    if (rollout.previousBundleId) {
      await this.bundleRepo.updateStatus(rollout.previousBundleId, 'deprecated');
    }

    const completed = await this.rolloutRepo.completeRollout(id);

    logger.info('Completed prompt rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      bundleId: rollout.bundleId,
    });

    await publishEvent({
      eventType: 'tenant.prompt_bundle.updated',
      tenantId: rollout.tenantId,
      entityType: 'prompt_bundle',
      entityId: rollout.bundleId,
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        bundleId: rollout.bundleId,
        previousBundleId: rollout.previousBundleId,
        rolloutId: id,
      },
    });

    await publishEvent({
      eventType: 'tenant.prompt_rollout.completed',
      tenantId: rollout.tenantId,
      entityType: 'prompt_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        bundleId: rollout.bundleId,
        previousBundleId: rollout.previousBundleId,
      },
    });

    return completed;
  }

  async rollbackRollout(id: string, reason: string): Promise<PromptRollout> {
    const rollout = await this.rolloutRepo.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }
    if (rollout.status !== 'in_progress' && rollout.status !== 'completed') {
      throw new Error(`Cannot rollback rollout with status: ${rollout.status}`);
    }

    // Revert to previous bundle if available
    if (rollout.previousBundleId) {
      await this.bundleRepo.updateStatus(rollout.previousBundleId, 'approved');
      await this.bundleRepo.updateStatus(rollout.bundleId, 'deprecated');
    }

    const rolledBack = await this.rolloutRepo.rollback(id, reason);

    logger.info('Rolled back prompt rollout', {
      rolloutId: id,
      tenantId: rollout.tenantId,
      bundleId: rollout.bundleId,
      previousBundleId: rollout.previousBundleId,
      reason,
    });

    await publishEvent({
      eventType: 'tenant.prompt_rollout.rolled_back',
      tenantId: rollout.tenantId,
      entityType: 'prompt_rollout',
      entityId: id,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        bundleId: rollout.bundleId,
        previousBundleId: rollout.previousBundleId,
        reason,
      },
    });

    return rolledBack;
  }

  // ==========================================
  // GAP-017 FIX: Tenant-scoped bundle methods
  // ==========================================

  async getBundlesForTenant(
    tenantId: string,
    options?: { includeApprovedOnly?: boolean }
  ): Promise<PromptBundle[]> {
    // Get base bundles (global bundles available to all tenants)
    let bundles: PromptBundle[];
    if (options?.includeApprovedOnly) {
      bundles = await this.bundleRepo.findApproved();
    } else {
      bundles = await this.bundleRepo.findAll();
    }

    // Filter to bundles that are either:
    // 1. Global (no tenantId or tenantId matches)
    // 2. Specifically assigned to this tenant
    const tenantBundles = bundles.filter(
      bundle => !bundle.tenantId || bundle.tenantId === tenantId
    );

    // Apply any tenant-specific overrides
    const overrides = await this.bundleRepo.getTenantOverrides(tenantId);
    return tenantBundles.map(bundle => {
      const override = overrides.find(o => o.bundleId === bundle.id);
      if (override) {
        return { ...bundle, ...override.settings };
      }
      return bundle;
    });
  }

  async getApprovedBundlesForTenant(tenantId: string): Promise<PromptBundle[]> {
    return this.getBundlesForTenant(tenantId, { includeApprovedOnly: true });
  }

  async getLatestApprovedBundleForTenant(
    tenantId: string,
    bundleName: string
  ): Promise<PromptBundle | null> {
    const bundles = await this.getApprovedBundlesForTenant(tenantId);

    // Filter by name and sort by version descending (version is numeric)
    const matchingBundles = bundles
      .filter(b => b.name === bundleName)
      .sort((a, b) => b.version - a.version);

    return matchingBundles[0] || null;
  }

  async checkTenantBundleAccess(
    tenantId: string,
    bundleId: string
  ): Promise<{ hasAccess: boolean; reason?: string }> {
    const bundle = await this.bundleRepo.findById(bundleId);
    if (!bundle) {
      return { hasAccess: false, reason: 'Bundle not found' };
    }

    // Check if bundle is tenant-specific
    if (bundle.tenantId && bundle.tenantId !== tenantId) {
      return { hasAccess: false, reason: 'Bundle belongs to another tenant' };
    }

    // Check if bundle is approved
    if (bundle.status !== 'approved') {
      return { hasAccess: false, reason: `Bundle status is ${bundle.status}` };
    }

    // Check for explicit access restrictions
    const restrictions = await this.bundleRepo.getTenantRestrictions(bundleId);
    if (restrictions.length > 0 && !restrictions.includes(tenantId)) {
      return { hasAccess: false, reason: 'Tenant not in allowed list' };
    }

    return { hasAccess: true };
  }

  async setTenantBundleOverride(
    tenantId: string,
    bundleId: string,
    overrideData: {
      type: 'config' | 'variables' | 'disable';
      settings?: Record<string, unknown>;
      enabled?: boolean;
    }
  ): Promise<{ id: string; tenantId: string; bundleId: string; override: typeof overrideData }> {
    // Verify bundle exists and tenant has access
    const access = await this.checkTenantBundleAccess(tenantId, bundleId);
    if (!access.hasAccess) {
      throw new Error(`Cannot override bundle: ${access.reason}`);
    }

    const override = await this.bundleRepo.setTenantOverride(tenantId, bundleId, overrideData);

    await publishEvent({
      entityType: 'prompt_bundle_override',
      entityId: override.id,
      eventType: 'tenant.prompt_bundle.override_set',
      entityVersion: 1,
      eventVersion: 1,
      tenantId,
      payload: {
        bundleId,
        overrideType: overrideData.type,
      },
    });

    return override;
  }

  async updateRolloutMetrics(id: string, metrics: PromptRolloutMetrics): Promise<void> {
    const rollout = await this.rolloutRepo.findById(id);
    if (!rollout) {
      throw new Error(`Rollout ${id} not found`);
    }

    await this.rolloutRepo.updateMetrics(id, metrics);

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
