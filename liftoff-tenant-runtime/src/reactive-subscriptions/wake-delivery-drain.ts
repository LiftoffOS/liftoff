// Self-wake outbox drain worker + reconcilers.
//
// - drainWakeEventDeliveries: claim <=N staged deliveries/tick, enqueue the wake-event resume Cloud
//   Task, then consume the one-shot subscription. Herd spreading = the per-tick limit.
// - reconcileWake: reclaim stale delivery leases (crash between claim and enqueue) AND stale ASI wake
//   leases (crash between claim and fired/settled), re-enqueuing resume/settlement tasks.
//
// Registered on the runtime's periodic scheduler (see index.ts). Idempotent + fail-open.

import { logger } from '../infrastructure/logging';
import { wakeEventDeliveryRepo } from './wake-event-delivery-repo';
import { reactiveSubscriptionRepo } from './repository';
import { agentScheduledInvocationsRepo } from '../scheduling/agent-scheduled-invocations-repo';

const DRAIN_LIMIT = Number(process.env.WAKE_DELIVERY_DRAIN_LIMIT ?? 20);
const DRAIN_INTERVAL_MS = Number(process.env.WAKE_DELIVERY_DRAIN_INTERVAL_MS ?? 15_000);
const RECONCILE_INTERVAL_MS = Number(process.env.WAKE_RECONCILE_INTERVAL_MS ?? 60_000);

let drainTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

/** Start the in-process drain + reconcile loops (gated on SELF_WAKE_ENABLED). Both .unref() so they
 *  never keep the process alive during shutdown. Mirrors the deep-research drainer registration. */
export function startWakeDrainer(): void {
  if (process.env.SELF_WAKE_ENABLED !== 'true' || drainTimer) return;
  drainTimer = setInterval(() => {
    void drainWakeEventDeliveries().catch((e) => logger.warn('wake drain tick failed', { error: (e as Error).message }));
  }, DRAIN_INTERVAL_MS);
  reconcileTimer = setInterval(() => {
    void reconcileWake().catch(() => {});
  }, RECONCILE_INTERVAL_MS);
  drainTimer.unref?.();
  reconcileTimer.unref?.();
  logger.info('Self-wake drain + reconcile loops started', { drainMs: DRAIN_INTERVAL_MS, reconcileMs: RECONCILE_INTERVAL_MS });
}

export function stopWakeDrainer(): void {
  if (drainTimer) clearInterval(drainTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  drainTimer = null;
  reconcileTimer = null;
}

/** Drain staged wake-event deliveries into resume Cloud Tasks. Returns how many were enqueued. */
export async function drainWakeEventDeliveries(limit = DRAIN_LIMIT): Promise<{ enqueued: number }> {
  const claimed = await wakeEventDeliveryRepo.claimStaged(limit);
  if (claimed.length === 0) return { enqueued: 0 };
  const { enqueueAgentExecution } = await import('../infrastructure/cloud-tasks');
  let enqueued = 0;
  for (const d of claimed) {
    try {
      const wakeRow = await agentScheduledInvocationsRepo.getById(d.wakeScheduledInvocationId);
      if (!wakeRow || wakeRow.status === 'cancelled' || wakeRow.status === 'fired' || wakeRow.status === 'errored') {
        // The wake is gone/terminal — drop the delivery and clean the subscription.
        await wakeEventDeliveryRepo.markDone(d.id);
        await reactiveSubscriptionRepo.deleteOneShotByBoundInvocation(d.wakeScheduledInvocationId).catch(() => {});
        continue;
      }
      const res = await enqueueAgentExecution(d.tenantId, wakeRow.agentId, {
        objective: 'wake-event',
        threadId: wakeRow.threadId ?? '', triggeredBy: 'event',
        triggeredByLabel: `wake-event:${d.wakeScheduledInvocationId}`,
        scheduleKey: new Date().toISOString().slice(0, 16),
        contextRef: `wake-event:${d.wakeScheduledInvocationId}`,
        receiverPath: '/api/tasks/resume-execution',
        receiverBody: {
          tenantId: d.tenantId, agentId: wakeRow.agentId,
          invocationId: wakeRow.scheduledByInvocationId ?? '',
          workflowResume: {
            scheduledInvocationId: d.wakeScheduledInvocationId,
            kind: 'wake-event',
            wakePayload: { event: d.payloadRef },
          },
        },
      } as Parameters<typeof enqueueAgentExecution>[2]);
      // Consume the one-shot subscription AFTER the resume is durably enqueued, then done.
      await reactiveSubscriptionRepo.markConsumedByBoundInvocation(d.wakeScheduledInvocationId);
      await wakeEventDeliveryRepo.markEnqueued(d.id, d.leaseToken ?? '', res?.taskName ?? null);
      await wakeEventDeliveryRepo.markDone(d.id);
      enqueued++;
    } catch (err) {
      // Enqueue failed → leave the lease to expire; the reconciler re-stages. Never lost.
      logger.warn('drainWakeEventDeliveries: enqueue failed; reconciler will retry', {
        delivery: d.id, error: (err as Error).message,
      });
    }
  }
  return { enqueued };
}

/** Reconcile stale wake leases: delivery outbox + ASI wake rows. Re-enqueues the appropriate task. */
export async function reconcileWake(): Promise<void> {
  // C2 — park wakes that keep killing the process that resumes them.
  //
  // Runs FIRST, deliberately. The reclaim blocks below hand rows back to be
  // retried; this takes out the ones that have proven they will not succeed.
  // Running it here also keeps it clear of the `return` in the ASI block below
  // (which exits the whole function when there is nothing stale), so parking
  // happens on every tick regardless of what else the reconciler finds.
  try {
    const parked = await agentScheduledInvocationsRepo.parkExhaustedWakes();
    const { wakeWaitSetRepo: waitSetRepo } = await import('../scheduling/wake-wait-set-repo');
    const parkedSets = await waitSetRepo.parkExhaustedWaitSets();
    if (parked.length > 0 || parkedSets.length > 0) {
      // ERROR, not warn: a parked wake is work the tenant asked for that will
      // now never happen until a person intervenes. It should page someone.
      logger.error('Wake parked after exhausting resume attempts', {
        event: 'wake_parked_exhausted',
        scheduledInvocations: parked.length,
        waitSets: parkedSets.length,
        ids: [...parked, ...parkedSets].slice(0, 20).map((r) => r.id),
      });
    }
  } catch (err) {
    logger.warn('reconcileWake: park sweep failed', { error: (err as Error).message });
  }

  try {
    const { retried, dead } = await wakeEventDeliveryRepo.reclaimStale();
    if (retried || dead) logger.info('Wake delivery reconcile', { retried, dead });
  } catch (err) {
    logger.warn('reconcileWake: delivery reclaim failed', { error: (err as Error).message });
  }
  try {
    const stale = await agentScheduledInvocationsRepo.reclaimStaleWakeLeases();
    if (stale.length === 0) return;
    const { enqueueAgentExecution } = await import('../infrastructure/cloud-tasks');
    for (const row of stale) {
      // Re-enqueue through resumeFromWake, keyed by the ORIGINAL wake_kind so it re-runs the correct
      // path (a reclaimed poll re-checks; event/job re-compose). The stable triggerKey (wake:<id>)
      // makes the continuation replay via event_processing_ledger rather than rerun, so a reclaim of a
      // resume_inflight/settlement_pending row is idempotent (never a double model run).
      //
      // A HITL approval's pause row takes the same lease, so it can be reclaimed here too. It is
      // routed back to the HITL resume: that primitive reads the decision off the approval row, so one
      // kind serves approved and rejected alike. Sent as a wake it would be validated as one and refused.
      const payload = row.workflow_resume_payload as { pauseReason?: string } | null;
      const wk = row.wake_kind as string | null;
      const kind = payload?.pauseReason === 'hitl_approval' ? 'hitl-approved'
        : wk === 'poll' ? 'wake-poll'
        : wk === 'event' ? 'wake-event'
        : wk === 'job' ? 'wake-job'
        : 'wake-timer';
      await enqueueAgentExecution(row.tenant_id as string, row.agent_id as string, {
        objective: 'wake-reconcile',
        threadId: (row.thread_id as string) ?? '', triggeredBy: 'system',
        triggeredByLabel: `wake-reconcile:${row.id}`,
        scheduleKey: new Date().toISOString().slice(0, 16),
        contextRef: `wake-reconcile:${row.id}`,
        receiverPath: '/api/tasks/resume-execution',
        receiverBody: {
          tenantId: row.tenant_id, agentId: row.agent_id,
          // The HITL resume rebuilds its context from the run's invocation id; a wake recovers its own.
          ...(row.scheduled_by_invocation_id ? { invocationId: row.scheduled_by_invocation_id } : {}),
          workflowResume: { scheduledInvocationId: row.id, kind },
        },
      } as Parameters<typeof enqueueAgentExecution>[2]).catch((err) => {
        logger.warn('reconcileWake: re-enqueue failed', { row: row.id, error: (err as Error).message });
      });
    }
    logger.info('Wake ASI lease reconcile', { reclaimed: stale.length });
  } catch (err) {
    logger.warn('reconcileWake: ASI reclaim failed', { error: (err as Error).message });
  }

  // Wait-set parent leases: a crash during resumeWaitSet leaves the parent resume_inflight/
  // settlement_pending past its lease. Reset to pending + re-enqueue a wake-waitset resume (the stable
  // triggerKey replays the continuation via the ledger rather than rerunning).
  try {
    const { wakeWaitSetRepo } = await import('../scheduling/wake-wait-set-repo');
    const staleSets = await wakeWaitSetRepo.reclaimStaleLeases();
    if (staleSets.length === 0) return;
    const { enqueueAgentExecution } = await import('../infrastructure/cloud-tasks');
    for (const ws of staleSets) {
      await enqueueAgentExecution(ws.tenant_id as string, ws.agent_id as string, {
        objective: 'wake-waitset',
        threadId: (ws.thread_id as string) ?? '', triggeredBy: 'system',
        triggeredByLabel: `wake-waitset-reconcile:${ws.id}`,
        scheduleKey: new Date().toISOString().slice(0, 16),
        contextRef: `waitset-reconcile:${ws.id}`,
        receiverPath: '/api/tasks/resume-execution',
        receiverBody: { tenantId: ws.tenant_id, agentId: ws.agent_id,
          workflowResume: { waitSetId: ws.id, kind: 'wake-waitset' } },
      } as Parameters<typeof enqueueAgentExecution>[2]).catch((err) => {
        logger.warn('reconcileWake: wait-set re-enqueue failed', { waitSet: ws.id, error: (err as Error).message });
      });
    }
    logger.info('Wake wait-set lease reconcile', { reclaimed: staleSets.length });
  } catch (err) {
    logger.warn('reconcileWake: wait-set reclaim failed', { error: (err as Error).message });
  }

  // Re-arm wakes stranded 'pending' with no trigger (crash between row insert and armWakeTrigger).
  // The lease reconcilers above only touch resume_inflight/settlement_pending, so this closes the
  // insert->arm crash window. Idempotent (Cloud Tasks name dedup).
  try {
    const { agentExecutionService } = await import('../agent-execution/service');
    await agentExecutionService.sweepStrandedWakes();
  } catch (err) {
    logger.warn('reconcileWake: stranded-wake sweep failed', { error: (err as Error).message });
  }
}
