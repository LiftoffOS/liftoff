// Agent Lifecycle Service Implementation
// Per Section 8: Agent lifecycle and runtime status

import { Agent, AgentLifecycle, AgentRuntimeStatus, CreateAgentInput } from './types';
import { AgentRepository } from './repository';
import { InstructionRepository } from '../instruction-compiler/repository';
import { logger, logAudit } from '../infrastructure/logging';
import { getTenantRuntimeUrl, tenantRuntimeUrlState } from '../infrastructure/runtime-env';
import { createOrUnpauseJob, pauseJob, resumeJob, deleteJob } from '../scheduling/cloud-scheduler';
import { getCompanionCrons } from './trigger-config-helpers';
import { reactiveSubscriptionRepo } from '../reactive-subscriptions/repository';
import { registerEventAgent, deregisterEventAgent } from '../scheduling/event-trigger';

// Per Section 8: Valid lifecycle transitions
// Each state maps to the set of states it can transition to
const VALID_LIFECYCLE_TRANSITIONS: Record<AgentLifecycle, AgentLifecycle[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],      // Draft can be activated or archived
  ACTIVE: ['PAUSED', 'ARCHIVED'],     // Active can be paused or archived
  PAUSED: ['ACTIVE', 'ARCHIVED'],     // Paused can be reactivated or archived
  ARCHIVED: [],                        // Archived is terminal (no transitions allowed)
  DELETED: [],                         // Terminal tombstone (upstream internal agent deleted)
};

// Per Section 8: Valid runtime status transitions
const VALID_RUNTIME_TRANSITIONS: Record<AgentRuntimeStatus, AgentRuntimeStatus[]> = {
  IDLE: ['RUNNING', 'WAITING_FOR_EVENT'],
  RUNNING: ['IDLE', 'WAITING_FOR_EVENT', 'WAITING_FOR_HUMAN', 'STOPPING', 'FAILED'],
  WAITING_FOR_EVENT: ['RUNNING', 'IDLE', 'STOPPING', 'FAILED'],
  WAITING_FOR_HUMAN: ['RUNNING', 'IDLE', 'STOPPING', 'FAILED'],
  STOPPING: ['IDLE', 'FAILED'],
  FAILED: ['IDLE', 'RUNNING'],         // Can retry from failed state
};

export class AgentLifecycleService {
  private repository = new AgentRepository();
  private instructionRepository = new InstructionRepository();

  async create(input: CreateAgentInput): Promise<Agent> {
    // Per Section 8: Agents start in DRAFT lifecycle state
    return this.repository.create(input);
  }

  async getById(id: string): Promise<Agent | null> {
    return this.repository.findById(id);
  }

  // Alias for getById - used by agent execution service
  async getAgent(id: string): Promise<Agent | null> {
    return this.getById(id);
  }

  // Per Section 8: Validate that a lifecycle transition is allowed.
  // Returns false for idempotent same-state transitions (no-op) so callers
  // can skip redundant work instead of crashing.
  private validateLifecycleTransition(
    from: AgentLifecycle,
    to: AgentLifecycle,
    agentId: string
  ): boolean {
    // Same-state transition is a no-op, not an error.
    // This happens when an event is redelivered or the agent is already in
    // the target state (e.g., dashboard "resume" on an already-ACTIVE agent).
    if (from === to) {
      logger.info('Lifecycle transition is a no-op (already in target state)', {
        agentId, state: from,
      });
      return false;
    }

    // Defensive: an unmapped source state (a legacy/future lifecycle value
    // written outside this module) must not throw a TypeError here. Mirror
    // getValidLifecycleTransitions()'s `|| []`. Callers that must not hard-fail
    // on terminal states (archive) short-circuit before reaching this.
    const validTargets = VALID_LIFECYCLE_TRANSITIONS[from] ?? [];

    if (!validTargets.includes(to)) {
      logger.warn('Invalid lifecycle transition attempted', {
        agentId,
        from,
        to,
        validTransitions: validTargets,
      });
      throw new Error(
        `Invalid lifecycle transition: ${from} → ${to}. ` +
        `Valid transitions from ${from}: ${validTargets.join(', ') || 'none'}`
      );
    }

    return true;
  }

  // Per Section 8: Validate that a runtime status transition is allowed
  private validateRuntimeTransition(
    from: AgentRuntimeStatus,
    to: AgentRuntimeStatus,
    agentId: string
  ): void {
    const validTargets = VALID_RUNTIME_TRANSITIONS[from];

    if (!validTargets.includes(to)) {
      logger.warn('Invalid runtime status transition attempted', {
        agentId,
        from,
        to,
        validTransitions: validTargets,
      });
      throw new Error(
        `Invalid runtime status transition: ${from} → ${to}. ` +
        `Valid transitions from ${from}: ${validTargets.join(', ') || 'none'}`
      );
    }
  }

  // Per Section 8: Only ACTIVE agents may execute
  // Per Section 9: Agent activation requires an active instruction
  async activate(id: string): Promise<void> {
    const agent = await this.repository.findById(id);
    if (!agent) throw new Error('Agent not found');

    // Per Section 8: Validate lifecycle transition
    const shouldProceed = this.validateLifecycleTransition(agent.lifecycle, 'ACTIVE', id);
    if (!shouldProceed) return; // Already ACTIVE — no-op

    // Per Section 9: Check for active instruction before agent activation
    const activeInstruction = await this.instructionRepository.findActiveByAgentId(
      agent.tenantId,
      id
    );

    if (!activeInstruction) {
      throw new Error(
        'Cannot activate agent without an active instruction. ' +
        'Ensure an instruction has been approved and activated first.'
      );
    }

    const previousLifecycle = agent.lifecycle;

    // Per Section 8: Every transition is audit-logged
    await this.repository.updateLifecycle(id, 'ACTIVE');

    logger.info('Agent lifecycle transition', {
      agentId: id,
      tenantId: agent.tenantId,
      from: previousLifecycle,
      to: 'ACTIVE',
      instructionId: activeInstruction.id,
      instructionVersion: activeInstruction.version,
    });

    // Per Section 8: Audit log for lifecycle change
    logAudit('agent.lifecycle_changed', {
      tenantId: agent.tenantId,
      agentId: id,
      resourceType: 'agent',
      resourceId: id,
    }, {
      action: 'activated',
      previousState: { lifecycle: previousLifecycle },
      newState: { lifecycle: 'ACTIVE' },
      metadata: {
        instructionId: activeInstruction.id,
        instructionVersion: activeInstruction.version,
      },
    });

    // Scheduler management is now a separate step (ensureSchedulerJob)
    // handled by the EventProcessor. No rollback — if scheduler fails,
    // the step is retried on Pub/Sub redelivery.

    // Re-activate reactive subscriptions when the agent moves back to ACTIVE.
    await reactiveSubscriptionRepo.setAgentStatus(agent.tenantId, id, 'active');
  }

  // Ensure the Cloud Scheduler job or event trigger is configured for an agent.
  // Idempotent: createOrUnpauseJob checks for existing jobs, registerEventAgent is safe to re-call.
  // No rollback on failure — the EventProcessor retries this step independently.
  async ensureSchedulerJob(id: string): Promise<void> {
    const agent = await this.repository.findById(id);
    if (!agent) throw new Error('Agent not found');

    // Guard: only resume/create scheduler jobs for ACTIVE agents. A stale or
    // redelivered activation event can call this method after the agent has
    // been paused, which would resume the Cloud Scheduler job and re-register
    // event triggers for a PAUSED agent.
    if (agent.lifecycle !== 'ACTIVE') {
      logger.info('ensureSchedulerJob skipped: agent not ACTIVE', {
        agentId: id,
        lifecycle: agent.lifecycle,
      });
      return;
    }

    const cronExpression = agent.triggerConfig?.cronExpr || agent.triggerConfig?.cron_expression;
    logger.info('Evaluating scheduler for agent', {
      agentId: id,
      hasTriggerConfig: !!agent.triggerConfig,
      triggerType: agent.triggerConfig?.type ?? 'none',
      cronExpression: cronExpression ?? 'none',
      tenantRuntimeUrl: tenantRuntimeUrlState(),
    });

    if (agent.triggerConfig?.type === 'cron' && cronExpression) {
      // Fast path: single resume API call (~1s) for previously created jobs.
      // Falls back to full create-or-update only on NOT_FOUND (first activation).
      // The old createOrUnpauseJob() did 3 API calls (get + resume + update)
      // taking 30-60s, which caused activation timeouts and Pub/Sub redelivery.
      try {
        await resumeJob(agent.tenantId, id);
      } catch (error: any) {
        if (error.code === 5) {
          // NOT_FOUND — first activation, job doesn't exist yet
          await createOrUnpauseJob({
            tenantId: agent.tenantId,
            agentId: id,
            cronExpr: cronExpression,
            apiBaseUrl: getTenantRuntimeUrl(),
            timezone: agent.triggerConfig.timezone,
            description: `Scheduled execution for agent: ${agent.name}`,
          });
        } else {
          throw error;
        }
      }
      logger.info('Cloud Scheduler job ensured for agent', {
        agentId: id,
        cronExpr: cronExpression,
      });
    } else if (agent.triggerConfig?.type === 'event') {
      // Trigger flipped away from cron — pause any lingering cron job so
      // the agent doesn't fire from BOTH the cron tick AND the event push.
      // pauseJob is idempotent: a NOT_FOUND (no prior cron) is swallowed
      // inside the helper. Without this, agents that flip cron→event keep
      // double-invoking until the reconciler's 5-min tick pauses the cron.
      try {
        await pauseJob(agent.tenantId, id);
        logger.info('Paused stale cron job after trigger flipped to event', { agentId: id });
      } catch (err) {
        logger.warn(
          { agentId: id, err: (err as Error).message },
          'pauseJob after cron→event flip failed (reconciler will catch up)',
        );
      }
    }

    // Companion crons. Each runs as an independent Cloud Scheduler job
    // with suffix `-companion-{label}`. Body uses triggeredBy='cron' (CHECK-constraint
    // compliant) + triggeredByLabel='companion:{label}' for granular attribution.
    // No-op for agents that declare no companions.
    for (const c of getCompanionCrons(agent.triggerConfig)) {
      const suffix = `-companion-${c.label}`;
      const triggeredByLabel = `companion:${c.label}`;
      try {
        await resumeJob(agent.tenantId, id, suffix, { triggeredByLabel });
      } catch (error: any) {
        if (error.code === 5) {
          await createOrUnpauseJob({
            tenantId: agent.tenantId,
            agentId: id,
            cronExpr: c.cronExpr,
            apiBaseUrl: getTenantRuntimeUrl(),
            timezone: c.timezone,
            description: `Companion (${c.label}) for agent: ${agent.name}`,
            jobSuffix: suffix,
            triggeredByLabel,
          });
        } else throw error;
      }
      logger.info('Companion Cloud Scheduler job ensured for agent', {
        agentId: id, label: c.label, cronExpr: c.cronExpr,
      });
    }

    // Reactive subscriptions. Upsert + delete-not-in to converge DB state.
    // No-op for agents that declare no subscriptions.
    if (agent.triggerConfig?.reactiveSubscriptions?.length) {
      await reactiveSubscriptionRepo.upsertForAgent(
        agent.tenantId, id, agent.triggerConfig.reactiveSubscriptions,
      );
      await reactiveSubscriptionRepo.deleteNotIn(
        agent.tenantId, id, agent.triggerConfig.reactiveSubscriptions.map(s => s.label),
      );
    }

    // (Re)open event-trigger registration after companions are ensured. The original
    // code structure ran event registration in an else-branch of the cron path —
    // preserved here verbatim so existing event agents keep behaving the same.
    if (agent.triggerConfig?.type === 'event') {
      const eventTopic = agent.triggerConfig.eventTopic || agent.triggerConfig.event_topics?.[0];
      if (eventTopic) {
        registerEventAgent(id, agent.tenantId, eventTopic);
        logger.info('Registered agent for event trigger', {
          agentId: id,
          eventTopic,
        });
      } else {
        logger.warn('Event-triggered agent has no eventTopic configured', {
          agentId: id,
          triggerConfig: agent.triggerConfig,
        });
      }
    }
  }

  // Per Section 8: PAUSED agents stop new work
  async pause(id: string): Promise<void> {
    const agent = await this.repository.findById(id);
    if (!agent) throw new Error('Agent not found');

    // Per Section 8: Validate lifecycle transition
    const shouldProceed = this.validateLifecycleTransition(agent.lifecycle, 'PAUSED', id);

    if (shouldProceed) {
      const previousLifecycle = agent.lifecycle;
      await this.repository.updateLifecycle(id, 'PAUSED');

      logger.info('Agent lifecycle transition', {
        agentId: id,
        tenantId: agent.tenantId,
        from: previousLifecycle,
        to: 'PAUSED',
      });

      // Per Section 8: Audit log for lifecycle change
      logAudit('agent.lifecycle_changed', {
        tenantId: agent.tenantId,
        agentId: id,
        resourceType: 'agent',
        resourceId: id,
      }, {
        action: 'paused',
        previousState: { lifecycle: previousLifecycle },
        newState: { lifecycle: 'PAUSED' },
      });
    }

    // Infrastructure reconciliation: ALWAYS pause the scheduler / deregister
    // event triggers, even on same-state no-ops. On Pub/Sub redelivery after a
    // partial failure (DB committed PAUSED but pauseJob() threw), the lifecycle
    // check above returns shouldProceed=false, but the scheduler job is still
    // ENABLED. Skipping here would leave the scheduler running indefinitely.
    if (agent.triggerConfig?.type === 'cron') {
      await pauseJob(agent.tenantId, id);
      logger.info('Cloud Scheduler job paused for agent', { agentId: id });
    } else if (agent.triggerConfig?.type === 'event') {
      const eventTopic = agent.triggerConfig.eventTopic || agent.triggerConfig.event_topics?.[0];
      if (eventTopic) {
        deregisterEventAgent(id, agent.tenantId, eventTopic);
        logger.info('Deregistered agent from event trigger', { agentId: id, eventTopic });
      }
    }

    // Pause companion crons (no-op if none declared).
    for (const c of getCompanionCrons(agent.triggerConfig)) {
      try {
        await pauseJob(agent.tenantId, id, `-companion-${c.label}`);
      } catch (e: any) {
        if (e.code !== 5) throw e;
      }
    }

    // Pause reactive subscriptions.
    await reactiveSubscriptionRepo.setAgentStatus(agent.tenantId, id, 'paused');
  }

  // Per Section 8: ARCHIVED agents are hidden from default UI and do not run
  async archive(id: string): Promise<void> {
    const agent = await this.repository.findById(id);
    if (!agent) throw new Error('Agent not found');

    // Idempotent teardown: if the agent is already in a terminal state, there
    // is no lifecycle transition to make — but we still run the infra cleanup
    // below. 'DELETED' is written by the canonical-reconciler when the upstream
    // internal agent is gone; the event-driven handleInternalAgentDeleted then
    // archives the same agent. Treating 'DELETED'/'ARCHIVED' as a no-op here is
    // what stops archive-on-internal_agent.deleted from crash-looping: a
    // 'DELETED' source previously had no entry in VALID_LIFECYCLE_TRANSITIONS,
    // so the validator did undefined.includes(...) and threw, 500ing the shared
    // control-plane-events push subscription into an endless nack→DLQ→replay
    // loop. ('ARCHIVED' already no-op'd here via the from===to check.)
    const isTerminal = agent.lifecycle === 'ARCHIVED' || agent.lifecycle === 'DELETED';
    const shouldProceed = isTerminal
      ? false
      : this.validateLifecycleTransition(agent.lifecycle, 'ARCHIVED', id);

    if (shouldProceed) {
      // Additional check: ensure agent is not running
      if (agent.runtimeStatus === 'RUNNING' || agent.runtimeStatus === 'STOPPING') {
        throw new Error(
          `Cannot archive agent while it is ${agent.runtimeStatus}. ` +
          'Stop all running workflows first.'
        );
      }

      const previousLifecycle = agent.lifecycle;
      await this.repository.updateLifecycle(id, 'ARCHIVED');

      logger.info('Agent lifecycle transition', {
        agentId: id,
        tenantId: agent.tenantId,
        from: previousLifecycle,
        to: 'ARCHIVED',
      });

      // Per Section 8: Audit log for lifecycle change
      logAudit('agent.lifecycle_changed', {
        tenantId: agent.tenantId,
        agentId: id,
        resourceType: 'agent',
        resourceId: id,
      }, {
        action: 'archived',
        previousState: { lifecycle: previousLifecycle },
        newState: { lifecycle: 'ARCHIVED' },
      });
    }

    // Infrastructure cleanup: ALWAYS attempt to remove scheduler / event
    // triggers, even on same-state no-ops. Same reasoning as pause() above.
    if (agent.triggerConfig?.type === 'cron') {
      try {
        await deleteJob(agent.tenantId, id);
        logger.info('Cloud Scheduler job deleted for agent', { agentId: id });
      } catch (error) {
        logger.error('Failed to delete Cloud Scheduler job', {
          agentId: id,
          error: (error as Error).message,
        });
      }
    } else if (agent.triggerConfig?.type === 'event') {
      const eventTopic = agent.triggerConfig.eventTopic || agent.triggerConfig.event_topics?.[0];
      if (eventTopic) {
        deregisterEventAgent(id, agent.tenantId, eventTopic);
        logger.info('Deregistered agent from event trigger on archive', { agentId: id, eventTopic });
      }
    }

    // Delete companion crons (no-op if none declared).
    for (const c of getCompanionCrons(agent.triggerConfig)) {
      try {
        await deleteJob(agent.tenantId, id, `-companion-${c.label}`);
      } catch (e: any) {
        if (e.code !== 5) throw e;
      }
    }

    // Delete reactive subscriptions (cascades to windows table).
    await reactiveSubscriptionRepo.deleteAgent(agent.tenantId, id);
  }

  // Per Section 8: Update runtime status with transition validation
  async updateRuntimeStatus(id: string, status: AgentRuntimeStatus): Promise<void> {
    const agent = await this.repository.findById(id);
    if (!agent) throw new Error('Agent not found');

    // Per Section 8: Only ACTIVE agents can have runtime status changes
    if (agent.lifecycle !== 'ACTIVE' && status !== 'IDLE') {
      throw new Error(
        `Cannot set runtime status to ${status} for agent in ${agent.lifecycle} state. ` +
        'Only ACTIVE agents can execute.'
      );
    }

    // Allow idempotent transitions (e.g., RUNNING → RUNNING from concurrent scheduler invocations)
    if (agent.runtimeStatus === status) {
      logger.info('Agent runtime status unchanged (idempotent)', { agentId: id, status });
      return;
    }

    // Per Section 8: Validate runtime status transition
    this.validateRuntimeTransition(agent.runtimeStatus, status, id);

    const previousStatus = agent.runtimeStatus;
    await this.repository.updateRuntimeStatus(id, status);

    logger.info('Agent runtime status transition', {
      agentId: id,
      tenantId: agent.tenantId,
      from: previousStatus,
      to: status,
      lifecycle: agent.lifecycle,
    });

    // Per Section 8: Audit log for runtime status change
    logAudit('agent.runtime_status_changed', {
      tenantId: agent.tenantId,
      agentId: id,
      resourceType: 'agent',
      resourceId: id,
    }, {
      action: 'runtime_status_changed',
      previousState: { runtimeStatus: previousStatus },
      newState: { runtimeStatus: status },
      metadata: { lifecycle: agent.lifecycle },
    });
  }

  // Get valid transitions for current state (useful for UI)
  getValidLifecycleTransitions(currentState: AgentLifecycle): AgentLifecycle[] {
    return VALID_LIFECYCLE_TRANSITIONS[currentState] || [];
  }

  getValidRuntimeTransitions(currentState: AgentRuntimeStatus): AgentRuntimeStatus[] {
    return VALID_RUNTIME_TRANSITIONS[currentState] || [];
  }
}
