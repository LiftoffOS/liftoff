// Stuck Plan Resumer
//
// Under the Cloud Tasks fan-out model, HRBP provisioning happens via one
// task per spec → /api/tasks/hrbp-provision-spec → runPlatformAgent. The
// approve handler enqueues each spec; Cloud Tasks handles retries with
// exponential backoff (queue retry_config: 5 attempts, 5s-300s backoff).
//
// A "stuck" plan is one that landed in `provisioning` status but has not
// completed all specs after STUCK_AFTER_MS. Causes can include:
//   - The approve handler crashed AFTER the status transition but BEFORE
//     enqueueing all per-spec tasks (no Cloud Task ever fired).
//   - All retries on a spec's task exhausted without that spec converging.
//   - Tasks fired but failed silently (extremely rare; surfaces in logs).
//
// On startup, this module re-scans for stuck plans and re-enqueues each
// non-completed spec. Cloud Tasks' deterministic task names (hrbp-{planId}-
// {specId}) provide natural idempotency: if a task with the same name is
// still in the queue or recently completed, the enqueue is a no-op.

import { log } from '../infrastructure/logging.js';
import { getPool } from '../infrastructure/database.js';
import { findStuckProvisioningPlans } from './repository.js';
import { workforcePlanService } from './service.js';
import { enqueueHrbpSpec } from '../infrastructure/cloud-tasks.js';
import { WorkforcePlanNotFoundError } from './types.js';

/**
 * A plan is considered "stuck" if it has been in `provisioning` status
 * for longer than this. 10 minutes covers the normal HRBP run for a
 * 20-spec plan (each task has a 270s dispatch deadline) with headroom.
 */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

type EnqueueFn = typeof enqueueHrbpSpec;

export interface ResumeOptions {
  staleAfterMs?: number;
  limit?: number;
  findStuck?: typeof findStuckProvisioningPlans;
  /** Override the enqueue function (tests). */
  enqueue?: EnqueueFn;
}

export async function resumeStuckProvisioningPlans(
  options: ResumeOptions = {},
): Promise<number> {
  const staleAfterMs = options.staleAfterMs ?? STUCK_AFTER_MS;
  const limit = options.limit ?? 100;
  const findStuck = options.findStuck ?? findStuckProvisioningPlans;
  const enqueue: EnqueueFn = options.enqueue ?? enqueueHrbpSpec;

  let stuck: Array<{ planId: string; tenantId: string }>;
  try {
    stuck = await findStuck(staleAfterMs, limit);
  } catch (err) {
    log.error(
      { error: (err as Error).message },
      'Stuck-plan resumer: lookup failed - skipping',
    );
    return 0;
  }
  if (stuck.length === 0) return 0;

  log.info(
    { count: stuck.length, staleAfterMs },
    'Stuck-plan resumer: found plans to re-enqueue',
  );

  const pool = getPool();
  let resumedCount = 0;
  for (const { planId, tenantId } of stuck) {
    try {
      const plan = await workforcePlanService.getPlan(planId, tenantId);
      if (!plan.approvedBy) {
        // approvedBy is set by service.approve() in the same transaction that
        // moves the plan to provisioning. A plan in provisioning with no
        // approver is a data-integrity bug — skip noisily instead of
        // silently attributing the resume to plan.accountId.
        log.error(
          { planId, tenantId },
          'Stuck-plan resumer: plan in provisioning has no approvedBy — skipping',
        );
        continue;
      }
      // A resume is a new attempt, so it opens a new run rather than joining
      // the old one. Task names are scoped to the run, so reusing the previous
      // run's id would rebuild the previous attempt's names and Cloud Tasks
      // would dedup the retry away.
      //
      // Any run still open for this plan is closed as failed first: it never
      // reached a terminal plan state, which is why the plan is being resumed.
      await pool.query(
        `UPDATE hrbp_provisioning_runs SET status = 'failed', updated_at = NOW()
          WHERE plan_id = $1 AND tenant_id = $2 AND status = 'running'`,
        [planId, tenantId],
      );
      const fresh = await pool.query<{ id: string }>(
        `INSERT INTO hrbp_provisioning_runs (plan_id, tenant_id, status, spec_count)
         VALUES ($1, $2, 'running', $3) RETURNING id`,
        [planId, tenantId, plan.agents.length],
      );
      const runId = fresh.rows[0].id;

      // Re-enqueue specs that aren't fully completed. `enqueued` counts tasks
      // this pass actually created; a dedup hit is counted separately, because
      // reporting one as work done hides the fact that nothing was retried.
      let enqueued = 0;
      let alreadyQueued = 0;
      for (const spec of plan.agents) {
        if (spec.provisioningStatus === 'completed') continue;
        try {
          const result = await enqueue({
            tenantId,
            planId,
            runId,
            spec,
            approverAccountId: plan.approvedBy,
          });
          if (result.enqueued) enqueued++;
          else alreadyQueued++;
        } catch (enqErr) {
          log.error(
            { planId, specId: spec.specId, error: (enqErr as Error).message },
            'Stuck-plan resumer: re-enqueue failed for spec; continuing',
          );
        }
      }
      log.info({ planId, runId, enqueued, alreadyQueued }, 'Stuck-plan resumer: re-enqueued specs');
      resumedCount++;
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        log.warn({ planId, tenantId }, 'Stuck-plan resumer: plan vanished — skipping');
        continue;
      }
      log.error(
        { planId, tenantId, error: (err as Error).message },
        'Stuck-plan resumer: load/re-enqueue threw - continuing',
      );
    }
  }

  log.info(
    { resumedCount, totalFound: stuck.length },
    'Stuck-plan resumer: finished',
  );
  return resumedCount;
}

export function startStuckPlanResumer(): void {
  void resumeStuckProvisioningPlans().catch(err => {
    log.error({ error: (err as Error).message }, 'Stuck-plan resumer: unexpected error');
  });
}
