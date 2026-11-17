// Reflection Trigger Service
// Per Section 16: Triggers reflection jobs based on various events
// This service wires up enqueueReflectionJob to appropriate call sites

import { enqueueReflectionJob } from '../infrastructure/cloud-tasks';
import { ReflectionEngineService } from './service';
import { ReflectionTriggerType } from './types';
import { logger } from '../infrastructure/logging';

export class ReflectionTriggerService {
  private reflectionService = new ReflectionEngineService();

  // Per Section 16: Reflection runs after repeated failures
  async onWorkflowFailed(
    agentId: string,
    tenantId: string,
    workflowId: string,
    failureCount: number
  ): Promise<void> {
    logger.info('Checking reflection trigger on workflow failure', {
      agent_id: agentId,
      tenant_id: tenantId,
      workflow_id: workflowId,
      failure_count: failureCount,
    });

    const shouldTrigger = await this.reflectionService.shouldTriggerReflection(
      agentId,
      tenantId,
      'repeated_failures'
    );

    if (shouldTrigger.shouldTrigger) {
      await this.enqueueWithQuotaManagement(agentId, tenantId, 'repeated_failures');
    } else {
      logger.info('Skipping reflection trigger', {
        agent_id: agentId,
        trigger_type: 'repeated_failures',
        reason: shouldTrigger.reason,
      });
    }
  }

  // Per Section 16: Reflection runs after repeated human corrections
  async onEscalationResolved(
    agentId: string,
    tenantId: string,
    escalationId: string
  ): Promise<void> {
    logger.info('Checking reflection trigger on escalation resolution', {
      agent_id: agentId,
      tenant_id: tenantId,
      escalation_id: escalationId,
    });

    const shouldTrigger = await this.reflectionService.shouldTriggerReflection(
      agentId,
      tenantId,
      'repeated_human_corrections'
    );

    if (shouldTrigger.shouldTrigger) {
      await this.enqueueWithQuotaManagement(agentId, tenantId, 'repeated_human_corrections');
    } else {
      logger.info('Skipping reflection trigger', {
        agent_id: agentId,
        trigger_type: 'repeated_human_corrections',
        reason: shouldTrigger.reason,
      });
    }
  }

  // Per Section 16: Reflection runs after N successful runs
  async onWorkflowCompleted(
    agentId: string,
    tenantId: string,
    workflowId: string
  ): Promise<void> {
    logger.info('Checking reflection trigger on workflow completion', {
      agent_id: agentId,
      tenant_id: tenantId,
      workflow_id: workflowId,
    });

    const shouldTrigger = await this.reflectionService.shouldTriggerReflection(
      agentId,
      tenantId,
      'n_successful_runs'
    );

    if (shouldTrigger.shouldTrigger) {
      await this.enqueueWithQuotaManagement(agentId, tenantId, 'n_successful_runs');
    } else {
      logger.info('Skipping reflection trigger', {
        agent_id: agentId,
        trigger_type: 'n_successful_runs',
        reason: shouldTrigger.reason,
      });
    }
  }

  // Phase 5: Triggered when a human submits late feedback with
  // decision === 'rejected' via /api/hitl-enforcement/late-feedback. Uses a
  // lower threshold (2+ flags in 7 days) than repeated_human_corrections —
  // each late rejection is a deliberate post-hoc human override of agent
  // output, so we need fewer signals to justify a reflection job.
  async onLateFeedbackFlagged(
    agentId: string,
    tenantId: string,
    feedbackId: string,
  ): Promise<void> {
    logger.info('Checking reflection trigger on flagged late feedback', {
      agent_id: agentId,
      tenant_id: tenantId,
      feedback_id: feedbackId,
    });

    const shouldTrigger = await this.reflectionService.shouldTriggerReflection(
      agentId,
      tenantId,
      'flagged_feedback',
    );

    if (shouldTrigger.shouldTrigger) {
      // Phase 5 gap fix: carry feedbackId through as job metadata so the
      // reflection run can hoist the specific triggering row into its
      // context and the LLM can anchor its analysis on that rejection
      // rather than guessing from the 50-row humanFeedback dump.
      await this.enqueueWithQuotaManagement(
        agentId,
        tenantId,
        'flagged_feedback',
        { feedbackId },
      );
    } else {
      logger.info('Skipping reflection trigger', {
        agent_id: agentId,
        trigger_type: 'flagged_feedback',
        feedback_id: feedbackId,
        reason: shouldTrigger.reason,
      });
    }
  }

  // Skills flywheel: task-level reflection trigger. Called from agent-execution
  // after a task completes when skills were injected. Carries injectedSkillIds
  // and taskId as metadata so the reflection service can evaluate skill quality.
  async onTaskCompleted(
    agentId: string,
    tenantId: string,
    taskId: string,
    injectedSkillIds: string[],
    success: boolean,
  ): Promise<void> {
    const triggerType: ReflectionTriggerType = success ? 'n_successful_runs' : 'repeated_failures';

    const shouldTrigger = await this.reflectionService.shouldTriggerReflection(
      agentId,
      tenantId,
      triggerType,
    );

    if (shouldTrigger.shouldTrigger) {
      await this.enqueueWithQuotaManagement(agentId, tenantId, triggerType, {
        taskId,
        injectedSkillIds,
      });
    }
  }

  /**
   * Skills flywheel for INTERACTIVE CHAT (P1.5).
   *
   * Chat injects skills like any other run but never scored them, so a skill
   * that only ever gets used in conversation could never improve — the whole
   * flywheel was autonomous-only.
   *
   * Deliberately NOT fired on every turn. A conversation is many small turns,
   * and reflecting on each one would be both expensive and misleading (a
   * one-line answer is not evidence about a skill). The caller gates on the
   * thread having gone quiet, so this sees a finished exchange. Quota handling
   * is the same as every other trigger.
   */
  async onChatTurnCompleted(
    agentId: string,
    tenantId: string,
    threadId: string,
    injectedSkillIds: string[],
    success: boolean,
  ): Promise<void> {
    if (injectedSkillIds.length === 0) return;

    const triggerType: ReflectionTriggerType = success ? 'n_successful_runs' : 'repeated_failures';

    const shouldTrigger = await this.reflectionService.shouldTriggerReflection(
      agentId,
      tenantId,
      triggerType,
    );

    if (shouldTrigger.shouldTrigger) {
      await this.enqueueWithQuotaManagement(agentId, tenantId, triggerType, {
        threadId,
        injectedSkillIds,
      });
    }
  }

  // Per Section 16: Scheduled cadence reflection
  /** True when a task was actually enqueued, false when quota declined it. */
  async onScheduledReflection(agentId: string, tenantId: string): Promise<boolean> {
    logger.info('Processing scheduled reflection', {
      agent_id: agentId,
      tenant_id: tenantId,
    });

    return this.enqueueWithQuotaManagement(agentId, tenantId, 'scheduled');
  }

  // Helper to enqueue with quota management.
  //
  // Phase 5 gap fix: accepts optional metadata that is forwarded to the
  // Cloud Tasks payload. For flagged_feedback we pass { feedbackId } so the
  // reflection run can hoist the exact triggering human_feedback row into
  // its context.
  /** True when a task was actually enqueued.
   *
   *  It used to return void, so a caller could not tell an enqueue from a
   *  quota skip — both are a plain return. The scheduled sweep counted every
   *  non-throwing call as an enqueue and reported work that never happened,
   *  which is the fabricated-success shape INV-TR-004 forbids. */
  private async enqueueWithQuotaManagement(
    agentId: string,
    tenantId: string,
    triggerType: ReflectionTriggerType,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      // Check quotas before enqueueing
      // Named agent, because the weekly allowance is per agent. Reading it
      // tenant-only returns zero-used and lets the enqueue through, so the
      // decline would land after the Cloud Task was already created and
      // charged — spending a slot to discover it had none.
      const quota = await this.reflectionService.getQuotaStatus(tenantId, agentId);

      if (quota.dailyRunsRemaining <= 0) {
        logger.warn('Daily reflection quota exceeded, skipping enqueue', {
          agent_id: agentId,
          tenant_id: tenantId,
          trigger_type: triggerType,
        });
        return false;
      }

      if (quota.concurrentJobsRemaining <= 0) {
        logger.warn('Concurrent reflection jobs limit reached, skipping enqueue', {
          agent_id: agentId,
          tenant_id: tenantId,
          trigger_type: triggerType,
        });
        return false;
      }

      // Enqueue FIRST, then charge the quota.
      //
      // The increment used to run before the enqueue and was never rolled back
      // when the enqueue threw, so a failing enqueue permanently consumed the
      // tenant's daily run AND a concurrency slot — and only a completed job
      // decrements concurrency, which a task that was never created can never
      // do. A few failed attempts pin current_concurrent_jobs at its maximum
      // and wedge the tenant: every later enqueue then short-circuited on the
      // concurrency check and returned silently.
      //
      // Charging after success can briefly under-count against a concurrent
      // sweep, which is a bound being generous for a moment. The old order
      // could make the bound permanently unsatisfiable, which is not
      // recoverable without a manual write.
      const taskName = await enqueueReflectionJob(agentId, tenantId, triggerType, metadata);
      await this.reflectionService.incrementQuotaOnEnqueue(tenantId, agentId);

      logger.info('Reflection job enqueued successfully', {
        agent_id: agentId,
        tenant_id: tenantId,
        trigger_type: triggerType,
        task_name: taskName,
      });
      return true;
    } catch (error) {
      logger.error('Failed to enqueue reflection job', {
        agent_id: agentId,
        tenant_id: tenantId,
        trigger_type: triggerType,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  // Called when a reflection job completes (success or failure)
  async onReflectionJobCompleted(tenantId: string): Promise<void> {
    await this.reflectionService.decrementQuotaOnCompletion(tenantId);
    logger.info('Reflection job completed, quota decremented', {
      tenant_id: tenantId,
    });
  }
}

// Singleton instance for use across the application
export const reflectionTriggerService = new ReflectionTriggerService();
