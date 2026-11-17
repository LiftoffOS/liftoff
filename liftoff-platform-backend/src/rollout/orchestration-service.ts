// Rollout Orchestration Service
// Per Section 17: Progressive rollout execution and monitoring

import { ModelRollout, RolloutConfig, RolloutMetrics } from '../model-registry/types';
import { ModelRolloutRepository } from '../model-registry/repository';
import { ModelRegistryService } from '../model-registry/service';
import { ValidatorHookService } from '../validator-hooks/service';
import { publishEvent } from '../events/publisher';
import { logger } from '../infrastructure/logging';
import { getPool, withTenantScope, withAdminScope } from '../infrastructure/database';

export interface RolloutProgress {
  rolloutId: string;
  status: string;
  strategy: string;
  currentStep: number;
  totalSteps: number;
  currentPercentage: number;
  targetPercentage: number;
  nextStepAt: Date | null;
  metrics: RolloutMetrics;
}

export interface TrafficSplit {
  rolloutId: string;
  percentage: number;
  isActive: boolean;
}

export class RolloutOrchestrationService {
  private rolloutRepository = new ModelRolloutRepository();
  private modelRegistryService = new ModelRegistryService();
  private validatorHookService = new ValidatorHookService();

  // Get current traffic split for a tenant's rollout
  async getTrafficSplit(tenantId: string): Promise<TrafficSplit | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT ts.rollout_id, ts.percentage, ts.is_active
       FROM rollout_traffic_splits ts
       JOIN model_rollouts r ON ts.rollout_id = r.id
       WHERE r.tenant_id = $1 AND r.status = 'in_progress' AND ts.is_active = true
       ORDER BY ts.created_at DESC
       LIMIT 1`,
      [tenantId]
    ));

    if (result.rows.length === 0) {
      return null;
    }

    return {
      rolloutId: result.rows[0].rollout_id,
      percentage: result.rows[0].percentage,
      isActive: result.rows[0].is_active,
    };
  }

  // Determine which model to use based on traffic split
  async shouldUseNewModel(tenantId: string): Promise<boolean> {
    const split = await this.getTrafficSplit(tenantId);
    if (!split) {
      return false; // No active rollout, use current model
    }

    // Simple percentage-based routing
    const random = Math.random() * 100;
    return random < split.percentage;
  }

  // Start progressive rollout (called after approval)
  // Per Section 17: Invoke validator hooks before starting
  async startProgressiveRollout(rolloutId: string): Promise<void> {
    const rollout = await this.rolloutRepository.findById(rolloutId);
    if (!rollout) {
      throw new Error(`Rollout ${rolloutId} not found`);
    }

    if (rollout.status !== 'approved') {
      throw new Error(`Rollout ${rolloutId} is not approved`);
    }

    // Per Section 17: Invoke pre-start validator hooks
    const validationResult = await this.validatorHookService.validateRolloutStart(
      rollout.tenantId,
      {
        rolloutId,
        modelId: rollout.modelId,
        strategy: rollout.strategy,
      }
    );

    if (!validationResult.passed) {
      const errors = validationResult.blockers
        .flatMap((b) => b.errors.map((e) => `${b.hookName}: ${e}`))
        .join('; ');

      logger.warn('Rollout start blocked by validator hooks', {
        rolloutId,
        blockers: validationResult.blockers,
      });

      throw new Error(`Rollout blocked by validator hooks: ${errors}`);
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      logger.warn('Rollout start has warnings from validator hooks', {
        rolloutId,
        warnings: validationResult.warnings,
      });
    }

    const pool = getPool();

    // Determine initial percentage based on strategy
    let initialPercentage = 100;
    let nextStepAt: Date | null = null;
    const steps = this.getStepsForStrategy(rollout);

    if (rollout.strategy === 'canary') {
      initialPercentage = rollout.config.canaryPercentage || 10;
      const durationMinutes = rollout.config.canaryDurationMinutes || 30;
      nextStepAt = new Date(Date.now() + durationMinutes * 60 * 1000);
    } else if (rollout.strategy === 'gradual' && steps.length > 0) {
      initialPercentage = steps[0];
      const stepDuration = rollout.config.stepDurationMinutes || 60;
      nextStepAt = new Date(Date.now() + stepDuration * 60 * 1000);
    }

    // Create traffic split record
    await pool.query(
      `INSERT INTO rollout_traffic_splits (rollout_id, percentage)
       VALUES ($1, $2)`,
      [rolloutId, initialPercentage]
    );

    // Update rollout with progress tracking
    await withTenantScope(rollout.tenantId, (client) => client.query(
      `UPDATE model_rollouts SET
         status = 'in_progress',
         started_at = NOW(),
         current_step = 0,
         current_percentage = $2,
         next_step_at = $3,
         updated_at = NOW()
       WHERE id = $1`,
      [rolloutId, initialPercentage, nextStepAt]
    ));

    // Log audit entry
    await this.logAudit(rolloutId, 'rollout_started', 'system', {
      strategy: rollout.strategy,
      initialPercentage,
      steps,
    });

    logger.info('Started progressive rollout', {
      rolloutId,
      strategy: rollout.strategy,
      initialPercentage,
      nextStepAt,
    });

    await publishEvent({
      eventType: 'tenant.model_rollout.started',
      tenantId: rollout.tenantId,
      entityType: 'model_rollout',
      entityId: rolloutId,
      entityVersion: rollout.version,
      eventVersion: 1,
      payload: {
        modelId: rollout.modelId,
        strategy: rollout.strategy,
        initialPercentage,
      },
    });
  }

  // Advance rollout to next step (called by scheduled job)
  // Per Section 17: Invoke validator hooks before advancing
  async advanceRollout(rolloutId: string): Promise<boolean> {
    const rollout = await this.rolloutRepository.findById(rolloutId);

    if (!rollout || rollout.status !== 'in_progress') {
      return false;
    }

    const steps = this.getStepsForStrategy(rollout);
    const currentStep = await this.getCurrentStep(rolloutId);
    const nextStep = currentStep + 1;

    // Per Section 17: Invoke pre-advance validator hooks
    const currentPercentage = steps[currentStep] || 0;
    const nextPercentage = steps[nextStep] || 100;

    const validationResult = await this.validatorHookService.validateRolloutAdvance(
      rollout.tenantId,
      {
        rolloutId,
        modelId: rollout.modelId,
        strategy: rollout.strategy,
        currentStep,
        currentPercentage,
        nextPercentage,
        metrics: rollout.metrics,
      }
    );

    if (!validationResult.passed) {
      logger.warn('Rollout advance blocked by validator hooks', {
        rolloutId,
        currentStep,
        nextStep,
        blockers: validationResult.blockers,
      });

      await this.logAudit(rolloutId, 'advance_blocked', 'system', {
        reason: 'validator_hooks_failed',
        blockers: validationResult.blockers,
      });

      // Don't throw - just return false and let the rollout stay at current step
      return false;
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      logger.warn('Rollout advance has warnings from validator hooks', {
        rolloutId,
        warnings: validationResult.warnings,
      });

      await this.logAudit(rolloutId, 'advance_warnings', 'system', {
        warnings: validationResult.warnings,
      });
    }

    // Check if we've reached 100%
    if (rollout.strategy === 'canary') {
      // Canary complete - go to 100%
      await this.setTrafficPercentage(rolloutId, 100);
      await this.completeRollout(rolloutId);
      return true;
    }

    if (rollout.strategy === 'gradual') {
      if (nextStep >= steps.length) {
        // All steps complete
        await this.completeRollout(rolloutId);
        return true;
      }

      const nextPercentage = steps[nextStep];
      const stepDuration = rollout.config.stepDurationMinutes || 60;
      const nextStepAt = new Date(Date.now() + stepDuration * 60 * 1000);

      // Update traffic split
      await this.setTrafficPercentage(rolloutId, nextPercentage);

      // Update rollout progress
      await withTenantScope(rollout.tenantId, (client) => client.query(
        `UPDATE model_rollouts SET
           current_step = $2,
           current_percentage = $3,
           next_step_at = $4,
           updated_at = NOW()
         WHERE id = $1`,
        [rolloutId, nextStep, nextPercentage, nextStepAt]
      ));

      await this.logAudit(rolloutId, 'step_advanced', 'system', {
        previousStep: currentStep,
        newStep: nextStep,
        percentage: nextPercentage,
      });

      logger.info('Advanced rollout to next step', {
        rolloutId,
        step: nextStep,
        percentage: nextPercentage,
        nextStepAt,
      });

      await publishEvent({
        eventType: 'tenant.model_rollout.step_advanced',
        tenantId: rollout.tenantId,
        entityType: 'model_rollout',
        entityId: rolloutId,
        entityVersion: rollout.version,
        eventVersion: 1,
        payload: {
          step: nextStep,
          percentage: nextPercentage,
        },
      });

      return true;
    }

    return false;
  }

  // Complete rollout (go to 100%)
  private async completeRollout(rolloutId: string): Promise<void> {
    const rollout = await this.rolloutRepository.findById(rolloutId);
    if (!rollout) return;

    // Set to 100% traffic
    await this.setTrafficPercentage(rolloutId, 100);

    // Update model config
    await this.modelRegistryService.completeRollout(rolloutId);

    await this.logAudit(rolloutId, 'rollout_completed', 'system', {
      finalPercentage: 100,
    });

    // Send completion notification
    await this.sendNotification(rollout, 'completed');
  }

  // Set traffic percentage for rollout
  private async setTrafficPercentage(rolloutId: string, percentage: number): Promise<void> {
    const pool = getPool();

    // Deactivate previous splits
    await pool.query(
      `UPDATE rollout_traffic_splits SET is_active = false, end_time = NOW()
       WHERE rollout_id = $1 AND is_active = true`,
      [rolloutId]
    );

    // Create new split
    await pool.query(
      `INSERT INTO rollout_traffic_splits (rollout_id, percentage)
       VALUES ($1, $2)`,
      [rolloutId, percentage]
    );
  }

  // Get current step for rollout
  private async getCurrentStep(rolloutId: string): Promise<number> {
    const result = await withAdminScope(
      { caller: 'rollout.orchestration.getCurrentStep', reason: 'by-id model_rollouts read (no tenant context in this private helper)' },
      (client) => client.query(
        `SELECT current_step FROM model_rollouts WHERE id = $1`,
        [rolloutId]
      ),
    );
    return result.rows[0]?.current_step || 0;
  }

  // Get steps array for strategy
  private getStepsForStrategy(rollout: ModelRollout): number[] {
    if (rollout.strategy === 'gradual') {
      return rollout.config.gradualSteps || [10, 25, 50, 100];
    }
    if (rollout.strategy === 'canary') {
      const canaryPct = rollout.config.canaryPercentage || 10;
      return [canaryPct, 100];
    }
    return [100]; // immediate
  }

  // Get rollout progress
  async getRolloutProgress(rolloutId: string): Promise<RolloutProgress | null> {
    const rollout = await this.rolloutRepository.findById(rolloutId);
    if (!rollout) return null;

    const progressResult = await withTenantScope(rollout.tenantId, (client) => client.query(
      `SELECT current_step, current_percentage, next_step_at
       FROM model_rollouts WHERE id = $1`,
      [rolloutId]
    ));

    const progress = progressResult.rows[0];
    const steps = this.getStepsForStrategy(rollout);

    return {
      rolloutId,
      status: rollout.status,
      strategy: rollout.strategy,
      currentStep: progress?.current_step || 0,
      totalSteps: steps.length,
      currentPercentage: progress?.current_percentage || 0,
      targetPercentage: steps[steps.length - 1] || 100,
      nextStepAt: progress?.next_step_at || null,
      metrics: rollout.metrics,
    };
  }

  // Process rollouts that are ready to advance
  async processScheduledAdvancements(): Promise<number> {
    const result = await withAdminScope(
      { caller: 'rollout.orchestration.processScheduledAdvancements', reason: 'cross-tenant scan of scheduled in-progress model_rollouts (no tenant filter)' },
      (client) => client.query(
        `SELECT id FROM model_rollouts
         WHERE status = 'in_progress'
           AND next_step_at IS NOT NULL
           AND next_step_at <= NOW()`
      ),
    );

    let processed = 0;
    for (const row of result.rows) {
      try {
        const advanced = await this.advanceRollout(row.id);
        if (advanced) processed++;
      } catch (error) {
        logger.error('Failed to advance rollout', { rolloutId: row.id, error });
      }
    }

    if (processed > 0) {
      logger.info('Processed scheduled rollout advancements', { count: processed });
    }

    return processed;
  }

  // Check metrics and trigger auto-rollback if needed
  async checkMetricsAndRollback(rolloutId: string, metrics: RolloutMetrics): Promise<boolean> {
    const rollout = await this.rolloutRepository.findById(rolloutId);
    if (!rollout || rollout.status !== 'in_progress') {
      return false;
    }

    if (!rollout.config.healthCheckEnabled) {
      return false;
    }

    const errorThreshold = rollout.config.errorThresholdPercent || 5;
    const latencyThreshold = rollout.config.latencyThresholdMs || 5000;

    let rollbackReason: string | null = null;

    if (metrics.errorRate > errorThreshold / 100) {
      rollbackReason = `Auto-rollback: Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeded threshold ${errorThreshold}%`;
    } else if (metrics.p99LatencyMs > latencyThreshold) {
      rollbackReason = `Auto-rollback: P99 latency ${metrics.p99LatencyMs}ms exceeded threshold ${latencyThreshold}ms`;
    }

    if (rollbackReason) {
      logger.warn('Triggering auto-rollback due to metrics threshold breach', {
        rolloutId,
        metrics,
        errorThreshold,
        latencyThreshold,
      });

      await this.rollbackRollout(rolloutId, rollbackReason);
      return true;
    }

    return false;
  }

  // Rollback rollout
  async rollbackRollout(rolloutId: string, reason: string): Promise<void> {
    const rollout = await this.rolloutRepository.findById(rolloutId);
    if (!rollout) return;

    const pool = getPool();

    // Deactivate traffic splits
    await pool.query(
      `UPDATE rollout_traffic_splits SET is_active = false, end_time = NOW()
       WHERE rollout_id = $1`,
      [rolloutId]
    );

    // Perform the rollback
    await this.modelRegistryService.rollbackRollout(rolloutId, reason);

    await this.logAudit(rolloutId, 'rollout_rolled_back', 'system', { reason });

    // Send rollback notification
    await this.sendNotification(rollout, 'rolled_back', { reason });
  }

  // Log audit entry
  private async logAudit(
    rolloutId: string,
    action: string,
    actor: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const pool = getPool();
    const rollout = await this.rolloutRepository.findById(rolloutId);

    await pool.query(
      `INSERT INTO rollout_audit_log (rollout_id, action, actor, new_status, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [rolloutId, action, actor, rollout?.status, JSON.stringify(details)]
    );
  }

  // Send notification
  private async sendNotification(
    rollout: ModelRollout,
    notificationType: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const pool = getPool();
    const recipients = this.getNotificationRecipients(rollout, notificationType);

    for (const recipient of recipients) {
      // Record notification
      await pool.query(
        `INSERT INTO rollout_notifications (rollout_id, notification_type, recipient, details)
         VALUES ($1, $2, $3, $4)`,
        [rollout.id, notificationType, recipient, JSON.stringify(details)]
      );

      // Publish notification event for external handlers
      await publishEvent({
        eventType: 'notification.rollout',
        entityType: 'model_rollout',
        entityId: rollout.id,
        entityVersion: rollout.version,
        eventVersion: 1,
        tenantId: rollout.tenantId,
        payload: {
          notificationType,
          recipient,
          modelId: rollout.modelId,
          strategy: rollout.strategy,
          ...details,
        },
      });
    }

    logger.info('Sent rollout notifications', {
      rolloutId: rollout.id,
      notificationType,
      recipientCount: recipients.length,
    });
  }

  // Get notification recipients based on event type
  private getNotificationRecipients(rollout: ModelRollout, notificationType: string): string[] {
    switch (notificationType) {
      case 'approved':
      case 'started':
      case 'completed':
        return rollout.config.notifyOnApproval || [];
      case 'rolled_back':
      case 'failed':
        return rollout.config.notifyOnFailure || [];
      default:
        return [];
    }
  }

  // Get rollout history for a tenant
  async getRolloutHistory(tenantId: string, limit: number = 10): Promise<ModelRollout[]> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM model_rollouts
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [tenantId, limit]
    ));

    return result.rows.map(this.mapRolloutRow);
  }

  // Get audit log for a rollout
  async getRolloutAuditLog(rolloutId: string): Promise<Array<{
    action: string;
    actor: string;
    previousStatus: string | null;
    newStatus: string | null;
    details: Record<string, unknown>;
    createdAt: Date;
  }>> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT action, actor, previous_status, new_status, details, created_at
       FROM rollout_audit_log
       WHERE rollout_id = $1
       ORDER BY created_at ASC`,
      [rolloutId]
    );

    return result.rows.map(row => ({
      action: row.action,
      actor: row.actor,
      previousStatus: row.previous_status,
      newStatus: row.new_status,
      details: row.details,
      createdAt: row.created_at,
    }));
  }

  private mapRolloutRow(row: Record<string, unknown>): ModelRollout {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      modelId: row.model_id as string,
      previousModelId: row.previous_model_id as string | null,
      version: row.version as number,
      status: row.status as ModelRollout['status'],
      strategy: row.strategy as ModelRollout['strategy'],
      config: (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as RolloutConfig,
      requestedBy: row.requested_by as string,
      requestedAt: row.requested_at as Date,
      approvedBy: row.approved_by as string | null,
      approvedAt: row.approved_at as Date | null,
      rejectedBy: row.rejected_by as string | null,
      rejectedAt: row.rejected_at as Date | null,
      rejectionReason: row.rejection_reason as string | null,
      startedAt: row.started_at as Date | null,
      completedAt: row.completed_at as Date | null,
      rollbackedAt: row.rollbacked_at as Date | null,
      rollbackReason: row.rollback_reason as string | null,
      metrics: (typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics) as RolloutMetrics,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  }
}

// Singleton instance
export const rolloutOrchestrationService = new RolloutOrchestrationService();
