// Workforce Plans Service
//
// Wraps the repository with lifecycle state-machine validation. Every status
// transition goes through here so we can throw a typed lifecycle error that
// the router maps to HTTP 409.
//
// Lifecycle (see migration 085 for the CHECK constraint):
//
//   draft <-> pending_approval -> approved -> provisioning -> completed
//                                                                 |
//                                                                 +-> failed
//                                                                 |
//                                                                 v
//                                                              draft (reopen)
//
//   - Direct draft -> approved is allowed (owner is also approver).
//   - Reject sends pending_approval back to draft (no separate rejected state).
//   - Reopen sends completed back to draft and bumps the revision counter.
//   - failed plans can also be reopened.

import * as repository from './repository.js';
import { publishWorkforcePlanEvent } from './events.js';
import { getPool } from '../infrastructure/database.js';
import { enqueueHrbpSpec } from '../infrastructure/cloud-tasks.js';
import { log } from '../infrastructure/logging.js';
// Provisioning is now driven by per-spec Cloud Tasks fan-out enqueued from
// the workforce-plans/router approve handler. The old in-process HRBP path
// (provisionWorkforcePlan) was deleted with hrbp-agent.ts.
import type {
  CreateWorkforcePlanInput,
  ListWorkforcePlansOptions,
  PaginatedWorkforcePlans,
  UpdateWorkforcePlanInput,
  WorkforcePlan,
  WorkforcePlanAgentSpec,
  WorkforcePlanStatus,
} from './types.js';
import {
  WorkforcePlanLifecycleError,
  WorkforcePlanNotFoundError,
} from './types.js';

export class WorkforcePlanService {
  // ── Reads ────────────────────────────────────────────────────────────

  async getPlan(planId: string, tenantId: string): Promise<WorkforcePlan> {
    const plan = await repository.getPlan(planId, tenantId);
    if (!plan) throw new WorkforcePlanNotFoundError(planId);
    return plan;
  }

  async listPlans(
    tenantId: string,
    options: ListWorkforcePlansOptions = {},
  ): Promise<PaginatedWorkforcePlans> {
    return repository.listPlans(tenantId, options);
  }

  // ── Create ───────────────────────────────────────────────────────────

  async createDraft(input: CreateWorkforcePlanInput): Promise<WorkforcePlan> {
    const plan = await repository.createPlan(input);
    void publishWorkforcePlanEvent('workforce_plan.created', plan.id, plan.tenantId, plan.revision, {
      accountId: plan.accountId,
      title: plan.title,
      agentCount: plan.agents.length,
    });
    return plan;
  }

  // ── Update (draft only) ──────────────────────────────────────────────

  /**
   * Update a draft plan's mutable fields. Throws if the plan is not in
   * `draft` status. The CAIO's workforce_plan__draft tool calls this when
   * iterating on a plan during conversation.
   */
  async updateDraft(
    planId: string,
    tenantId: string,
    patch: UpdateWorkforcePlanInput,
  ): Promise<WorkforcePlan> {
    const existing = await this.getPlan(planId, tenantId);
    if (existing.status !== 'draft') {
      throw new WorkforcePlanLifecycleError(existing.status, 'update');
    }
    const updated = await repository.updatePlanFields(planId, tenantId, patch);
    if (!updated) throw new WorkforcePlanNotFoundError(planId);
    return updated;
  }

  // ── Lifecycle transitions ────────────────────────────────────────────

  /**
   * Transition a draft to pending_approval. Called by the CAIO's
   * workforce_plan__commit tool when the plan is ready for human review.
   * Validates that the plan has at least one agent spec.
   */
  async submitForApproval(planId: string, tenantId: string): Promise<WorkforcePlan> {
    const existing = await this.getPlan(planId, tenantId);
    if (existing.status !== 'draft') {
      throw new WorkforcePlanLifecycleError(existing.status, 'submit');
    }
    if (existing.agents.length === 0) {
      throw new WorkforcePlanLifecycleError(
        existing.status,
        'submit',
        'Cannot submit a plan with no agents',
      );
    }
    const updated = await repository.transitionStatus(
      planId,
      tenantId,
      'draft',
      'pending_approval',
    );
    if (!updated) throw new WorkforcePlanNotFoundError(planId);
    void publishWorkforcePlanEvent(
      'workforce_plan.submitted',
      updated.id,
      updated.tenantId,
      updated.revision,
      { agentCount: updated.agents.length },
    );
    return updated;
  }

  /**
   * Approve a plan. Allowed from either `draft` (owner approves their own
   * plan directly) or `pending_approval`. The plan transitions to
   * `provisioning` immediately - the HRBP Agent picks it up from there.
   */
  async approve(
    planId: string,
    tenantId: string,
    approvedBy: string,
    options: {
      /** The approver's answer to the builder's question. Undefined leaves
       *  the plan's recorded answer as it is (false for a plan never asked). */
      launchOnCompletion?: boolean;
    } = {},
  ): Promise<WorkforcePlan> {
    const existing = await this.getPlan(planId, tenantId);
    if (existing.status !== 'draft' && existing.status !== 'pending_approval') {
      throw new WorkforcePlanLifecycleError(existing.status, 'approve');
    }
    if (existing.agents.length === 0) {
      throw new WorkforcePlanLifecycleError(
        existing.status,
        'approve',
        'Cannot approve a plan with no agents',
      );
    }
    // Two-step transition. First mark as approved (records who/when), then
    // immediately move to provisioning so the HRBP Agent picks it up.
    const approved = await repository.transitionStatus(
      planId,
      tenantId,
      ['draft', 'pending_approval'],
      'approved',
      {
        approvedBy,
        ...(options.launchOnCompletion !== undefined ? { launchOnCompletion: options.launchOnCompletion } : {}),
      },
    );
    if (!approved) throw new WorkforcePlanNotFoundError(planId);

    const provisioning = await repository.transitionStatus(
      planId,
      tenantId,
      'approved',
      'provisioning',
    );
    if (!provisioning) {
      // Should not happen given we just transitioned to `approved`, but if a
      // concurrent reader did something weird, surface it as a lifecycle
      // error rather than silently leaving the plan in `approved`.
      throw new WorkforcePlanLifecycleError('approved', 'start_provisioning');
    }

    // Publish the approval event FIRST so external observers see the state
    // change, then the provisioning_started event so the dashboard can
    // update its progress UI.
    void publishWorkforcePlanEvent(
      'workforce_plan.approved',
      provisioning.id,
      provisioning.tenantId,
      provisioning.revision,
      {
        approvedBy,
        agents: provisioning.agents,
        agentCount: provisioning.agents.length,
      },
    );
    void publishWorkforcePlanEvent(
      'workforce_plan.provisioning_started',
      provisioning.id,
      provisioning.tenantId,
      provisioning.revision,
      { agentCount: provisioning.agents.length },
    );

    // HRBP fan-out lives HERE, not in the router.
    //
    // A plan can be approved from the HTTP route or from the CAIO's
    // workforce_plan__approve tool, which calls this method directly. The
    // service layer is the only thing both paths share, so anything that must
    // happen on every approval belongs to it — put it in the route and a chat
    // approval transitions the plan and provisions nothing.
    await this.startHrbpProvisioning(provisioning, approvedBy);

    return provisioning;
  }

  /**
   * Open the run row and fan one Cloud Task out per spec.
   *
   * The run row anchors the per-spec event log (it is the FK target for
   * hrbp_provisioning_events.run_id), so it has to exist before any task runs.
   * Task names are deterministic, which gives natural idempotency; an enqueue
   * failure on one spec must not block the others.
   *
   * hrbp_provisioning_runs is a non-RLS service table (INV-WF-002), so the
   * direct pool is correct here.
   */
  private async startHrbpProvisioning(
    plan: WorkforcePlan,
    approverAccountId: string,
  ): Promise<void> {
    const pool = getPool();
    const runInsert = await pool.query<{ id: string }>(
      `INSERT INTO hrbp_provisioning_runs (plan_id, tenant_id, status, spec_count)
       VALUES ($1, $2, 'running', $3)
       RETURNING id`,
      [plan.id, plan.tenantId, plan.agents.length],
    );
    const runId = runInsert.rows[0].id;

    for (const spec of plan.agents) {
      try {
        const result = await enqueueHrbpSpec({
          tenantId: plan.tenantId,
          planId: plan.id,
          runId,
          spec,
          approverAccountId,
        });
        // The run row was created moments ago, so its task names are new and
        // nothing should collide. If one does, something re-approved this plan
        // concurrently and this call is not the one provisioning the spec —
        // worth saying out loud rather than assuming it was queued.
        if (!result.enqueued) {
          log.warn(
            { planId: plan.id, runId, specId: spec.specId, taskName: result.taskName },
            'HRBP: task name already existed on a fresh run — spec not enqueued by this approval',
          );
        }
      } catch (enqueueErr) {
        log.error(
          { err: (enqueueErr as Error).message, planId: plan.id, specId: spec.specId },
          'HRBP enqueue failed for spec; remaining specs continue',
        );
      }
    }
  }

  /**
   * Reject a pending_approval plan and send it back to draft for re-editing.
   * No separate rejected state - matches colab-prototype's pattern.
   */
  async reject(
    planId: string,
    tenantId: string,
    reason: string,
  ): Promise<WorkforcePlan> {
    const existing = await this.getPlan(planId, tenantId);
    if (existing.status !== 'pending_approval') {
      throw new WorkforcePlanLifecycleError(existing.status, 'reject');
    }
    const updated = await repository.transitionStatus(
      planId,
      tenantId,
      'pending_approval',
      'draft',
      { rejectedReason: reason },
    );
    if (!updated) throw new WorkforcePlanNotFoundError(planId);
    void publishWorkforcePlanEvent(
      'workforce_plan.rejected',
      updated.id,
      updated.tenantId,
      updated.revision,
      { reason },
    );
    return updated;
  }

  /**
   * Reopen a completed (or failed) plan for amendment. Bumps the revision
   * counter so we can audit amendment history. The CAIO then modifies the
   * agents array via updateDraft and the user re-approves.
   *
   * Re-provisioning diffs against existing internalAgentId values: already-
   * provisioned specs are skipped, new specs go through distill + create,
   * removed specs are flagged for user attention (no auto-delete).
   */
  async reopen(planId: string, tenantId: string): Promise<WorkforcePlan> {
    const existing = await this.getPlan(planId, tenantId);
    if (existing.status !== 'completed' && existing.status !== 'failed') {
      throw new WorkforcePlanLifecycleError(existing.status, 'reopen');
    }
    const updated = await repository.transitionStatus(
      planId,
      tenantId,
      ['completed', 'failed'],
      'draft',
      { bumpRevision: true },
    );
    if (!updated) throw new WorkforcePlanNotFoundError(planId);

    // Reset every spec's `provisioningStatus` and clear any stale
    // `errorMessage` so the HRBP Agent will re-evaluate each one on the
    // next approve(). We deliberately keep `internalAgentId` set - that
    // linkage is the key signal the HRBP uses to decide skip vs update
    // vs re-distill.
    const resetSpecs = updated.agents.map(spec => ({
      ...spec,
      provisioningStatus: undefined,
      errorMessage: undefined,
    }));
    if (updated.agents.length > 0) {
      const withResetSpecs = await repository.updatePlanAgents(
        planId,
        tenantId,
        resetSpecs,
      );
      if (withResetSpecs) {
        // Keep the revision number from the transition (not re-read by
        // updatePlanAgents - it preserves whatever was there).
        withResetSpecs.revision = updated.revision;
        void publishWorkforcePlanEvent(
          'workforce_plan.reopened',
          withResetSpecs.id,
          withResetSpecs.tenantId,
          withResetSpecs.revision,
          { previousStatus: existing.status },
        );
        return withResetSpecs;
      }
    }

    void publishWorkforcePlanEvent(
      'workforce_plan.reopened',
      updated.id,
      updated.tenantId,
      updated.revision,
      { previousStatus: existing.status },
    );
    return updated;
  }

  /**
   * Mark a plan as completed. Called by the HRBP Agent when all specs in
   * the plan have provisioning_status = completed.
   */
  async markCompleted(planId: string, tenantId: string): Promise<WorkforcePlan> {
    const updated = await repository.transitionStatus(
      planId,
      tenantId,
      'provisioning',
      'completed',
    );
    if (!updated) throw new WorkforcePlanNotFoundError(planId);
    void publishWorkforcePlanEvent(
      'workforce_plan.completed',
      updated.id,
      updated.tenantId,
      updated.revision,
      { agentCount: updated.agents.length },
    );
    return updated;
  }

  /**
   * Mark a plan as failed. Called by the HRBP Agent when one or more specs
   * failed to provision. Already-completed agents stay live - this only
   * marks the overall plan status.
   */
  async markFailed(planId: string, tenantId: string): Promise<WorkforcePlan> {
    const updated = await repository.transitionStatus(
      planId,
      tenantId,
      'provisioning',
      'failed',
    );
    if (!updated) throw new WorkforcePlanNotFoundError(planId);
    const failedSpecs = updated.agents.filter(a => a.provisioningStatus === 'failed');
    void publishWorkforcePlanEvent(
      'workforce_plan.failed',
      updated.id,
      updated.tenantId,
      updated.revision,
      {
        failedCount: failedSpecs.length,
        totalCount: updated.agents.length,
      },
    );
    return updated;
  }

  // ── HRBP Agent helpers ───────────────────────────────────────────────

  /**
   * Persist agent spec changes from the HRBP Agent during provisioning.
   * Called repeatedly as each spec moves through pending -> provisioning ->
   * completed/failed. Does NOT enforce a status check - the HRBP Agent is
   * trusted to only call this while the plan is in `provisioning`.
   */
  async updateAgentSpecs(
    planId: string,
    tenantId: string,
    agents: WorkforcePlanAgentSpec[],
  ): Promise<WorkforcePlan> {
    const updated = await repository.updatePlanAgents(planId, tenantId, agents);
    if (!updated) throw new WorkforcePlanNotFoundError(planId);
    const completed = updated.agents.filter(a => a.provisioningStatus === 'completed').length;
    const failed = updated.agents.filter(a => a.provisioningStatus === 'failed').length;
    const total = updated.agents.length;
    void publishWorkforcePlanEvent(
      'workforce_plan.provisioning_progress',
      updated.id,
      updated.tenantId,
      updated.revision,
      { completed, failed, total },
    );
    return updated;
  }

  // ── Soft delete ──────────────────────────────────────────────────────

  async softDelete(planId: string, tenantId: string): Promise<void> {
    const deleted = await repository.softDeletePlan(planId, tenantId);
    if (!deleted) throw new WorkforcePlanNotFoundError(planId);
  }

  // ── State machine introspection (used by tests) ──────────────────────

  /**
   * Returns true if the given source -> target transition is allowed.
   * Pure function over the static state machine - safe to call from tests.
   */
  static canTransition(from: WorkforcePlanStatus, to: WorkforcePlanStatus): boolean {
    const allowed: Record<WorkforcePlanStatus, WorkforcePlanStatus[]> = {
      draft: ['pending_approval', 'approved'],
      pending_approval: ['approved', 'draft'],
      approved: ['provisioning'],
      provisioning: ['completed', 'failed'],
      completed: ['draft'],
      failed: ['draft'],
    };
    return allowed[from]?.includes(to) ?? false;
  }
}

export const workforcePlanService = new WorkforcePlanService();
