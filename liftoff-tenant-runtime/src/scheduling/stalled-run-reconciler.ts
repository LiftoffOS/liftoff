// Stalled-run reconciler (plan §1 — Symphony "alive-but-silent" stall detection).
//
// A run that hangs past the 270s Cloud Task deadline or exhausts Cloud Tasks retries
// leaves invocations.outcome NULL, agent_run_states 'running', and NO terminal
// invocation — so ADR-030 "Run again" (which needs outcome='error') can't see it and
// the work is silently lost. This sweep completes such orphans as outcome='error' +
// failure_class='stalled', which (a) surfaces them on the Activity feed and (b) makes
// cron/event top-level runs re-runnable (rerun-router reads the invocation, not the
// audit row). Visible-only: no auto-retry; completing a genuinely-dead run's invocation
// is a data-pathology fix, not a lifecycle change (the agent stays ACTIVE).
//
// GRACE ≫ the 270s request deadline, so any non-paused, non-heartbeating run older than
// GRACE is definitionally dead. Legitimately-paused runs (HITL / clarification / delay /
// delegation / followup) are excluded: they always carry a pending
// agent_scheduled_invocations row keyed scheduled_by_invocation_id, and/or
// agent_run_states.status='interrupted'.
//
// Human-triggered runs are a second, separate sweep (closeStalledHumanRuns, below).
//
// Gated on STALLED_RUN_RECONCILER_ENABLED + isExecutionAllowed. Clones the
// idempotency-reconciler triad (module + internal-cron route + r5_scheduler_jobs entry).

import { getPoolForService } from '../infrastructure/database';
import { releaseLocksForInvocations } from '../interactive-chat/turn-lock-registry';
import { logger, logAudit } from '../infrastructure/logging';
import { isExecutionAllowed } from '../entitlements-client/service';
import { insertAuditLog } from '../audit';
import { invocation_failed_total } from '../observability/runtime-extensions-metrics';
import { resolveStartTriggeredBy } from '../agent-execution/trigger-attribution';

const GRACE = "INTERVAL '15 minutes'"; // ≫ 270s Cloud Task deadline; calibrate vs run-duration p99
const STALL = "INTERVAL '10 minutes'"; // agent_run_states heartbeat silence (appendItem bumps updated_at)

function isEnabled(): boolean {
  return process.env.STALLED_RUN_RECONCILER_ENABLED === '1';
}

/**
 * Whether this tenant has a run the sweeps above could still close without
 * anything else happening first: open, recent, of a kind they sweep, and not
 * paused. A paused run is excluded because its resume heartbeats, and that
 * heartbeat re-arms the watch; a missed completion (run-state terminal,
 * invocation open) is excluded because neither sweep ever closes it, and
 * counting it would keep the watch alive for seven days.
 */
export async function hasOpenSweepableRuns(tenantId: string): Promise<boolean> {
  if (!isEnabled()) return false;
  const res = await pool().query(
    `SELECT 1 FROM invocations i
      WHERE i.tenant_id = $1::uuid
        AND i.outcome IS NULL AND i.completed_at IS NULL
        AND i.started_at > NOW() - INTERVAL '7 days'
        AND ((i.triggered_by IN ('cron', 'event') AND i.parent_invocation_id IS NULL)
             OR i.triggered_by = 'human')
        AND NOT EXISTS (SELECT 1 FROM agent_scheduled_invocations asi
                        WHERE asi.scheduled_by_invocation_id = i.id::text AND asi.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM hitl_approval_requests h
                        WHERE h.tenant_id = i.tenant_id AND h.invocation_id = i.id AND h.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM agent_run_states ars
                        WHERE ars.invocation_id = i.id::text
                          AND ars.state->>'status' IN ('interrupted', 'complete', 'failed'))
      LIMIT 1`,
    [tenantId],
  );
  return (res.rowCount ?? 0) > 0;
}

function pool() {
  return getPoolForService('default');
}

export async function runStalledRunReconciliation(tenantId: string): Promise<{ reconciled: number }> {
  if (!isEnabled()) return { reconciled: 0 };
  if (!(await isExecutionAllowed(tenantId))) return { reconciled: 0 };
  const autonomous = await sweepAutonomousRuns(tenantId);
  const human = await closeStalledHumanRuns(tenantId);
  return { reconciled: autonomous + human.closed };
}

/** cron/event top-level runs. Unchanged by the human sweep below. */
async function sweepAutonomousRuns(tenantId: string): Promise<number> {
  // Atomic claim-and-complete: an orphan = incomplete + old, with NO pending scheduled
  // resume (HITL/clarification/delay/delegation/followup), whose run-state (if any) is
  // NOT terminal/paused (complete/failed/interrupted) and NOT freshly heartbeating — i.e.
  // only sweep runs whose run-state is absent or stuck 'running' past STALL. A run-state
  // that reached 'complete'/'failed'/'interrupted' is a missed-completion or pause, NOT a
  // stall, and must not be mislabeled 'stalled'.
  const res = await pool().query<{
    id: string;
    agent_id: string;
    triggered_by: string;
    thread_id: string | null;
    parent_invocation_id: string | null;
    last_rss_bytes: string | null;
    hard_bound: boolean;
  }>(
    `UPDATE invocations i SET
        outcome = 'error',
        failure_class = CASE
          WHEN i.active_deadline_at IS NOT NULL AND i.active_deadline_at < NOW()
          THEN 'routine_hard_bound' ELSE 'stalled' END,
        error_message = CASE
          WHEN i.active_deadline_at IS NOT NULL AND i.active_deadline_at < NOW()
          THEN 'routine_hard_bound: still active past its deadline (reconciler)'
          ELSE 'stalled: no run progress within grace window (reconciler)' END,
        reconciliation_status = 'pending',
        completed_at = NOW()
      WHERE i.tenant_id = $1::uuid
        -- Scope to autonomous top-level runs only. cron/event runs are the
        -- ones that lose work silently and are re-runnable; a chat (human) run has a live
        -- user (no silent loss, not re-runnable) and a delegated child (parent set) fails
        -- rerun-router's parent-null gate — sweeping either would mislabel it 'stalled' and
        -- pollute invocation_failed_total. The dev calibration dry-run confirmed the broad
        -- predicate would otherwise catch a dead human/chat run. Human runs are closed by
        -- closeStalledHumanRuns below, on thresholds derived from a person's run.
        AND i.triggered_by IN ('cron', 'event')
        AND i.parent_invocation_id IS NULL
        AND i.outcome IS NULL AND i.completed_at IS NULL
        AND (
          i.started_at < NOW() - ${GRACE}
          -- Or it blew its own deadline. A routine that is ACTIVE past the
          -- deadline is looping, not working — and unlike the grace-window
          -- case above it may still be heartbeating, which is exactly why the
          -- heartbeat check below cannot be the only bound. The pending-resume
          -- exclusion still applies, so a run paused for approval is untouched.
          OR (i.active_deadline_at IS NOT NULL AND i.active_deadline_at < NOW())
        )
        AND NOT EXISTS (SELECT 1 FROM agent_scheduled_invocations asi
                        WHERE asi.scheduled_by_invocation_id = i.id::text AND asi.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM agent_run_states ars
                        WHERE ars.invocation_id = i.id::text
                          AND (ars.state->>'status' IN ('interrupted', 'complete', 'failed')
                               -- A heartbeating run is normally healthy and must not be
                               -- swept. Past its own deadline it is the opposite: a live
                               -- loop is precisely what heartbeats.
                               OR (ars.state->>'status' = 'running'
                                   AND ars.updated_at >= NOW() - ${STALL}
                                   AND (i.active_deadline_at IS NULL OR i.active_deadline_at >= NOW()))))
      RETURNING i.id, i.agent_id, i.triggered_by, i.thread_id, i.parent_invocation_id,
                -- The last memory sample this run took before it went quiet.
                -- Present only when the run wrote a run-state heartbeat.
                (SELECT ars.last_rss_bytes FROM agent_run_states ars
                  WHERE ars.invocation_id = i.id::text) AS last_rss_bytes,
                (i.active_deadline_at IS NOT NULL AND i.active_deadline_at < NOW()) AS hard_bound`,
    [tenantId],
  );

  for (const r of res.rows) {
    await pool()
      .query(
        `UPDATE agent_run_states SET state = jsonb_set(state,'{status}','"failed"'), updated_at = NOW()
          WHERE invocation_id = $1 AND state->>'status' = 'running'`,
        [r.id],
      )
      .catch(() => {});
    // Surface + make re-runnable ONLY for top-level runs (children fail rerun-router's
    // parentInvocationId==null gate). Pass the COARSE triggered_by ('cron'|'event'):
    // conformTriggeredBy maps 'event'→'event:unknown' (passes ADR-030's startsWith('event:')).
    // insertAuditLog is the durable outbox path (resolves internalAgentId, conforms triggeredBy).
    if (r.parent_invocation_id == null) {
      await insertAuditLog(null, tenantId, {
        internalAgentId: r.agent_id, // runtime id; buildOutboxPayload resolves → platform internal id
        invocationId: r.id,
        threadId: r.thread_id ?? undefined,
        action: 'agent_execution',
        inputArgs: { reason: 'stalled_run_reconciled' },
        outcome: 'error',
        errorCode: 'run_stalled',
        triggeredBy: r.triggered_by, // coarse; conformed in buildOutboxPayload
      }).catch(() => {});
    }
  }

  if (res.rows.length) {
    invocation_failed_total.inc({ failure_class: 'stalled' }, res.rows.length);
    // Per-run line so a stall can be classified without a follow-up query. The
    // aggregate below stays for volume.
    for (const r of res.rows) {
      const rss = r.last_rss_bytes == null ? null : Number(r.last_rss_bytes);
      logger.warn(
        {
          event: r.hard_bound ? 'routine_hard_bound' : 'run_stalled',
          tenantId,
          invocationId: r.id,
          agentId: r.agent_id,
          triggeredBy: r.triggered_by,
          lastRssBytes: rss,
          lastRssMb: rss == null ? null : Math.round(rss / (1024 * 1024)),
        },
        r.hard_bound
          ? 'stalled-run-reconciler: routine stopped — still active past its deadline'
          : 'stalled-run-reconciler: run stopped heartbeating',
      );
    }
    logger.warn({ tenantId, reconciled: res.rows.length }, 'stalled-run-reconciler: completed orphaned runs as stalled');
  }
  return res.rows.length;
}

// ── Runs a person started (triggered_by = 'human') ────────────────────────────
//
// Chat turns, chat continuations, HITL/clarification resumes and test-harness runs.
// Nothing else ever closes one that hangs: the turn's own abort (hard timeout or Stop)
// is an agent_invocation_signals row the engine reads only at a step boundary, so a run
// blocked in one unbounded await never reads it, and its invocation, run state and the
// agent's runtime_status stay open forever.
//
// Stalled = no run-state heartbeat for HUMAN_STALL (appendItem bumps updated_at on every
// tool call, tool result and assistant message) AND started more than HUMAN_GRACE ago.
// A live human run cannot meet both:
//   - the longest step that writes no heartbeat is ~15 min: code_session at its 600s
//     default + clone/diff/transport margin; a model call is capped at 10 min
//     (SDK_TIMEOUT_MS). The run state is written at the start, so pre-engine setup
//     (memory retrieval / HyDE, ~10 min at worst) counts as silence and fits too;
//   - a chat turn ends by ~29 min end to end: its 14-min hard timeout writes an abort
//     the engine reads at the next boundary, at most one ~15-min step later (agent-service
//     and PB cut the request itself at 900s / 870s).
// 30 min is 2x the longest silent step and past the chat turn's whole lifetime. A run
// with no run-state row has no heartbeat to read, so it needs HUMAN_NO_HEARTBEAT_GRACE.
//
// A run waiting on a person is never open: a pause completes its invocation (outcome
// 'gated' / 'parked', completed_at set) and its resume reuses that completed row. The
// pending-resume, pending-approval and interrupted run-state exclusions are kept anyway.

const HUMAN_GRACE = "INTERVAL '30 minutes'";
const HUMAN_STALL = "INTERVAL '30 minutes'";
const HUMAN_NO_HEARTBEAT_GRACE = "INTERVAL '2 hours'";

// The sweep only closes runs started within the last 7 days. Older stuck runs are
// closed quietly by migration 435 (no Activity entry, no webhook, not billed):
// closing them here would replay that history as fresh failures and bill it today.
// Migration 435 uses the same 7 days; the two must agree so no run falls between them.
const HUMAN_WINDOW = "INTERVAL '7 days'";
const RECENT = `i.started_at > NOW() - ${HUMAN_WINDOW}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ClosedHumanRun {
  id: string;
  agent_id: string;
  thread_id: string | null;
  parent_invocation_id: string | null;
  triggered_by_user_id: string | null;
  last_rss_bytes: string | null;
  last_progress_at: Date | null;
  /** Older than HUMAN_WINDOW, so closed without an audit row or billing (Stop only). */
  quiet: boolean;
}

const QUIET_STOP_MESSAGE =
  'stalled: stale run older than 7 days closed on Stop; not billed, no Activity entry';

/**
 * Close the tenant's stalled human-triggered runs, or with `invocationId`, only that one
 * (the Stop fallback). Writes the stall close the autonomous sweep writes, then consumes
 * pending aborts, frees the chat thread's turn lock, posts the terminal audit and moves
 * each affected agent RUNNING -> IDLE when it has no other open run.
 *
 * Billing: reconciliation_status='pending' hands the run's spend to the stalled-billing
 * reconciler, which publishes it once from llm_usage_log; the spend subscriber dedups by
 * invocation id, so a run that later finishes on its own does not bill twice.
 *
 * The sweep only sees runs inside HUMAN_WINDOW. Stop still closes an older stuck run,
 * because a person asked and otherwise the thread and the agent stay stuck, but it
 * closes it the way migration 435 did: no audit row (so no Activity entry and no
 * run.failed webhook) and nothing for billing to pick up. Same reason as the
 * migration: a failure dated today for a run from weeks ago, billed today, is wrong.
 */
export async function closeStalledHumanRuns(
  tenantId: string,
  opts: { invocationId?: string } = {},
): Promise<{ closed: number; idled: number }> {
  if (!isEnabled()) return { closed: 0, idled: 0 };

  const res = await pool().query<ClosedHumanRun>(
    `UPDATE invocations i SET
        outcome = 'error',
        failure_class = 'stalled',
        error_message = CASE WHEN ${RECENT}
          THEN 'stalled: no run progress within grace window (reconciler)'
          ELSE '${QUIET_STOP_MESSAGE}' END,
        -- An old run closed on Stop settles like migration 435's: 'unrecoverable' is
        -- never selected by the stalled-billing reconciler (it reads only 'pending'),
        -- and 'expired' is never replayed by billing-queued-reconciliation (it reads
        -- only 'pending'), which would otherwise pick up the new completed_at.
        reconciliation_status = CASE WHEN ${RECENT} THEN 'pending' ELSE 'unrecoverable' END,
        billing_queued = CASE WHEN ${RECENT} THEN i.billing_queued ELSE 'expired' END,
        completed_at = NOW()
      WHERE i.tenant_id = $1::uuid
        AND i.triggered_by = 'human'
        AND ($2::uuid IS NULL OR i.id = $2::uuid)
        -- The sweep: the last HUMAN_WINDOW only. Stop: any age (see above).
        AND ($2::uuid IS NOT NULL OR ${RECENT})
        AND i.outcome IS NULL AND i.completed_at IS NULL
        AND i.started_at < NOW() - ${HUMAN_GRACE}
        AND NOT EXISTS (SELECT 1 FROM agent_scheduled_invocations asi
                        WHERE asi.scheduled_by_invocation_id = i.id::text AND asi.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM hitl_approval_requests h
                        WHERE h.tenant_id = i.tenant_id AND h.invocation_id = i.id AND h.status = 'pending')
        AND (
          -- Heartbeat stopped: still 'running' and silent past HUMAN_STALL. Any other
          -- run-state (complete / failed / interrupted) is a missed completion or a
          -- pause, not a stall.
          EXISTS (SELECT 1 FROM agent_run_states ars
                  WHERE ars.invocation_id = i.id::text
                    AND ars.state->>'status' = 'running'
                    AND ars.updated_at < NOW() - ${HUMAN_STALL})
          OR (NOT EXISTS (SELECT 1 FROM agent_run_states ars WHERE ars.invocation_id = i.id::text)
              AND i.started_at < NOW() - ${HUMAN_NO_HEARTBEAT_GRACE})
        )
      RETURNING i.id, i.agent_id, i.thread_id, i.parent_invocation_id, i.triggered_by_user_id,
                (SELECT ars.last_rss_bytes FROM agent_run_states ars
                  WHERE ars.invocation_id = i.id::text) AS last_rss_bytes,
                (SELECT ars.updated_at FROM agent_run_states ars
                  WHERE ars.invocation_id = i.id::text) AS last_progress_at,
                NOT (${RECENT}) AS quiet`,
    [tenantId, opts.invocationId ?? null],
  );
  if (res.rows.length === 0) return { closed: 0, idled: 0 };

  const ids = res.rows.map((r) => r.id);
  const bestEffort = (what: string) => (err: Error) =>
    logger.warn({ tenantId, invocationIds: ids, err: err.message }, `stalled-run-reconciler: ${what} failed (non-fatal)`);

  await pool()
    .query(
      `UPDATE agent_run_states SET state = jsonb_set(state,'{status}','"failed"'), updated_at = NOW()
        WHERE invocation_id = ANY($1::text[]) AND state->>'status' = 'running'`,
      [ids],
    )
    .catch(bestEffort('run-state close'));
  // A Stop that never reached the run is answered by this close.
  await pool()
    .query(
      `UPDATE agent_invocation_signals SET consumed_at = NOW()
        WHERE invocation_id = ANY($1::uuid[]) AND signal_kind = 'abort' AND consumed_at IS NULL`,
      [ids],
    )
    .catch(bestEffort('abort-signal consume'));
  // Frees the thread for the person's next message. A process still holding the lock
  // sees rowCount 0 on its next heartbeat and aborts its own (already dead) turn.
  // The statement is the turn registry's: one module owns every query against
  // chat_turn_locks, so a reader cannot decide liveness for itself (INV-PB-018).
  await releaseLocksForInvocations(pool(), tenantId, ids)
    .catch(bestEffort('chat turn lock release'));

  // The terminal row a failed run posts (executeTask's error path): Activity shows the
  // run ended, and the control plane fires its run.failed webhook. Same attribution as
  // the run's own start row.
  for (const r of res.rows) {
    if (r.parent_invocation_id != null || r.quiet) continue;
    await insertAuditLog(null, tenantId, {
      internalAgentId: r.agent_id,
      userId: r.triggered_by_user_id && UUID_RE.test(r.triggered_by_user_id) ? r.triggered_by_user_id : undefined,
      invocationId: r.id,
      threadId: r.thread_id ?? undefined,
      action: 'agent_execution',
      inputArgs: { reason: 'stalled_run_reconciled' },
      outcome: 'error',
      errorCode: 'run_stalled',
      triggeredBy: resolveStartTriggeredBy({
        triggeredBy: 'human',
        agentId: r.agent_id,
        triggeredByUserId: r.triggered_by_user_id ?? undefined,
      }),
    }).catch(() => {});
  }

  // RUNNING -> IDLE only when nothing else of the agent's is open. One statement, so a
  // run that opens meanwhile is seen. Only from RUNNING: WAITING_FOR_HUMAN / FAILED /
  // STOPPING belong to some other run.
  let idled = 0;
  for (const agentId of new Set(res.rows.map((r) => r.agent_id))) {
    const idle = await pool()
      .query<{ id: string }>(
        `UPDATE agents a SET runtime_status = 'IDLE', updated_at = NOW()
          WHERE a.id = $1::uuid AND a.tenant_id = $2::uuid AND a.runtime_status = 'RUNNING'
            AND NOT EXISTS (SELECT 1 FROM invocations o
                            WHERE o.tenant_id = $2::uuid AND o.agent_id = $1::uuid AND o.completed_at IS NULL)
          RETURNING a.id`,
        [agentId, tenantId],
      )
      .catch((err: Error) => {
        logger.warn({ tenantId, agentId, err: err.message }, 'stalled-run-reconciler: runtime status reset failed (non-fatal)');
        return { rows: [] as { id: string }[] };
      });
    if (idle.rows.length) {
      idled++;
      logAudit('agent.runtime_status_changed', {
        tenantId, agentId, resourceType: 'agent', resourceId: agentId,
      }, {
        action: 'runtime_status_changed',
        previousState: { runtimeStatus: 'RUNNING' },
        newState: { runtimeStatus: 'IDLE' },
        metadata: { reason: 'stalled_run_reconciled' },
      });
    }
  }

  invocation_failed_total.inc({ failure_class: 'stalled' }, res.rows.length);
  for (const r of res.rows) {
    const rss = r.last_rss_bytes == null ? null : Number(r.last_rss_bytes);
    logger.warn(
      {
        event: 'run_stalled',
        tenantId,
        invocationId: r.id,
        agentId: r.agent_id,
        triggeredBy: 'human',
        lastProgressAt: r.last_progress_at,
        lastRssBytes: rss,
        lastRssMb: rss == null ? null : Math.round(rss / (1024 * 1024)),
        viaStop: opts.invocationId != null,
        quiet: r.quiet,
      },
      'stalled-run-reconciler: closed a human-triggered run that stopped heartbeating',
    );
  }
  return { closed: res.rows.length, idled };
}
