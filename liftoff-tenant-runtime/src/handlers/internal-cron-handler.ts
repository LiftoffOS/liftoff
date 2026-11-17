// Internal maintenance endpoints.
//
// None of these runs on a clock of its own any more. Work with a deadline arms
// a Cloud Task for its endpoint when the work is created (see
// infrastructure/maintenance-tasks.ts), a sweep that finds work still open
// re-arms itself, and POST /housekeeping/daily (one Cloud Scheduler job) runs
// every endpoint once a day as the backstop. The Cloud Tasks deliveries carry
// the scheduler SA's OIDC token, so Cloud Run IAM gates them exactly as it
// gated the scheduler.

import { Router, type Request, type Response } from 'express';
import { getPool, getPoolForService } from '../infrastructure/database';
import { forEachTenant } from '../infrastructure/tenant-registry';
import { runComputedMetricPollingCycle } from '../reactive-subscriptions/computed-metric-poller';
import { logger } from '../infrastructure/logging';
import { createEscalation } from '../agent-execution/engine/escalation-helper';
import { AgentLifecycleService } from '../agent-lifecycle/service';
import type { ExecutionContext } from '../agent-execution/types';
import { armWatch, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';
import { armStallWatch } from '../scheduling/stall-watch';
import { armNextComputedMetricPoll } from '../reactive-subscriptions/poll-schedule';
import { enqueueDailyHousekeeping } from './housekeeping';

const lifecycle = new AgentLifecycleService();

const router = Router();

router.post('/computed-metric-poller', async (_req: Request, res: Response) => {
  const result = await runComputedMetricPollingCycle();
  // Next poll: the earliest subscription's own next_poll_at, hourly at most.
  await armNextComputedMetricPoll();
  return res.json(result);
});

router.post('/reactive-window-pruner', async (_req: Request, res: Response) => {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM reactive_subscription_windows WHERE expires_at < NOW() - INTERVAL '1 hour'`
  );
  return res.json({ deleted: rowCount });
});

router.post('/connector-entity-state-pruner', async (_req: Request, res: Response) => {
  const pool = getPool();
  let totalDeleted = 0;
  for (let i = 0; i < 100; i++) {  // hard cap 100 batches per run
    const { rowCount } = await pool.query(
      `DELETE FROM connector_entity_state
       WHERE (tenant_id, connector_id, entity_type, entity_id) IN (
         SELECT tenant_id, connector_id, entity_type, entity_id FROM connector_entity_state
         WHERE last_seen_at < NOW() - INTERVAL '90 days'
         LIMIT 1000
       )`
    );
    if (!rowCount) break;
    totalDeleted += rowCount;
  }
  logger.info('connector-entity-state-pruner finished', { deleted: totalDeleted });
  return res.json({ deleted: totalDeleted });
});

// ── Hybrid execution engine sweepers (plan §"Maintenance crons") ─────────
//
// hybrid-stuck-pause-sweep — every 30 minutes. Finds clarification /
// hitl pause rows whose expiry Cloud Task should have fired but didn't
// (rare; protects against Cloud Tasks delivery failures). Marks each
// row 'fired' and creates a kind='system_internal' escalation.
router.post('/hybrid-loop/sweep-stuck', async (_req: Request, res: Response) => {
  const pool = getPoolForService('scheduled-execution');
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    agent_id: string;
    objective: string;
    workflow_resume_payload: Record<string, unknown> | null;
  }>(
    // Oldest first, and the batch is capped: without the ordering a backlog
    // larger than one batch could hand back the same recent rows every cycle
    // while the oldest lapse waited indefinitely. The queue's actionability
    // predicate already hides a lapsed approval from readers, so a starved row
    // is invisible rather than wrong — but it also never resumes the run it is
    // holding, and that is what starvation costs here.
    `SELECT id, tenant_id, agent_id, objective, workflow_resume_payload
       FROM agent_scheduled_invocations
      WHERE status = 'pending'
        AND fires_at < NOW() - INTERVAL '1 minute'
        AND objective IN ('clarification-expiry', 'hitl-expiry')
      ORDER BY fires_at ASC
      LIMIT 100`,
  );

  let swept = 0;
  // Close approvals whose run has already finished.
  //
  // Runs before the expiry pass below, deliberately. Both touch pending
  // approvals, and the expiry pass files "Pause expired without resolution" —
  // a false record about a person for a question that stopped mattering hours
  // earlier. Withdrawing first means the honest disposition wins the race.
  try {
    const { withdrawOrphanedApprovals } = await import('../hitl-enforcement/withdraw-orphaned-approvals');
    const withdrawn = await withdrawOrphanedApprovals();
    if (withdrawn.length > 0) {
      logger.info({ count: withdrawn.length }, 'withdrew approvals whose run had already ended');
    }
  } catch (e) {
    // Never blocks the sweeper. A withdrawal that does not happen leaves today's
    // behaviour; a sweeper that dies leaves every stale pause behind it.
    logger.warn({ err: (e as Error).message }, 'withdraw-orphaned-approvals pass failed; sweeper continues');
  }

  for (const row of rows) {
    try {
      await pool.query(
        `UPDATE agent_scheduled_invocations
            SET status = 'fired', fired_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [row.id],
      );
      // For HITL pauses, also expire the approval row. The 24h Cloud Task
      // (finalizeHitlExpired) is what normally flips it; when that delivery
      // failed and the sweeper is the one catching the row, the approval
      // would otherwise stay status='pending' forever — surfacing in the
      // "awaiting decision" count even though the decision window has passed.
      // decision stays NULL: expiry is a timeout, not an auto-rejection
      // (preserves operator late-feedback for agent learning).
      if (row.objective === 'hitl-expiry') {
        const approvalId = (row.workflow_resume_payload as {
          hitlContext?: { approvalId?: string };
        } | null)?.hitlContext?.approvalId;
        if (approvalId) {
          await pool.query(
            `UPDATE hitl_approval_requests
                SET status = 'expired', updated_at = NOW()
              WHERE id = $1 AND status = 'pending'`,
            [approvalId],
          );
        }
      }
      // A stranded pause has no workflow of its own: the ids are absent, and
      // createEscalation resolves the identity its rows require at its boundary.
      const ctx = {
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        instructionVersion: 0,
        instruction: { allowedConnectors: [], systemPrompt: '', userInstructions: '' } as unknown as ExecutionContext['instruction'],
        traceId: `hybrid-sweeper-${row.id}`,
        agentType: 'agent' as const,
        hitlLevel: 3,
        modelConfig: {},
        execConfig: {},
        memoryScope: {},
      } as ExecutionContext;
      await createEscalation(
        ctx,
        'Pause expired without resolution (sweeper)',
        { kind: 'system_internal' },
      );
      await lifecycle.updateRuntimeStatus(row.agent_id, 'IDLE');
      swept++;
    } catch (err) {
      logger.warn({ err, rowId: row.id }, 'Non-fatal: hybrid-loop sweep-stuck failed for row');
    }
  }
  logger.info({ swept, candidates: rows.length }, 'hybrid-loop sweep-stuck cycle complete');
  return res.json({ swept, candidates: rows.length });
});

// §4.8 — idempotency reconciler. Dedicated route (NOT folded into sweep-stuck,
// whose Cloud Scheduler job is defined only in an orphaned terraform module and
// is not actually deployed). Needs its own r5_scheduler_jobs entry in
// tenant-runtime-template to fire. Gated internally by
// IDEMPOTENCY_RECONCILER_ENABLED; abandons stuck at_most_once side-effect claims
// so a redelivery is no longer blocked forever, and prunes expired replay
// payloads.
//
// Runs for every tenant this runtime serves. Tenant ids come from the `tenants`
// table, never process.env.TENANT_ID: that is the slug and would fail the
// reconciler's tenant_id::uuid cast.
router.post('/idempotency-reconcile', async (_req: Request, res: Response) => {
  try {
    const { runIdempotencyReconciliation, hasInFlightAtMostOnceClaims } = await import('../scheduling/idempotency-reconciler');
    let inFlight = false;
    const fanout = await forEachTenant('idempotency-reconcile', async (tenantId) => {
      const result = await runIdempotencyReconciliation(tenantId);
      if (await hasInFlightAtMostOnceClaims(tenantId)) inFlight = true;
      return result;
    });
    // A claim still in flight may yet get stuck: look again one window later.
    if (inFlight) armWatch('idempotency', MAINTENANCE_PATHS.idempotencyReconcile, { delayMs: 11 * 60 * 1000 });
    return res.json(fanout);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'idempotency reconciliation cycle failed');
    return res.status(500).json({ error: 'idempotency reconciliation failed' });
  }
});

// Stalled-run reconciler (plan §1). Completes orphaned/stalled autonomous runs as
// outcome='error' + failure_class='stalled' so they surface on Activity and cron/event
// top-level runs become re-runnable (ADR-030). Gated app-side by
// STALLED_RUN_RECONCILER_ENABLED; needs its own r5_scheduler_jobs entry to fire.
router.post('/stalled-run-reconcile', async (_req: Request, res: Response) => {
  try {
    const { runStalledRunReconciliation } = await import('../scheduling/stalled-run-reconciler');
    // Fast-follow (ADR-031): drain the LLM cost of runs this (and prior) cycles
    // swept, so stalled consumption reaches the OU boundary. Runs over the full
    // reconciliation_status='pending' backlog, so it also settles historical orphans.
    //
    // Both halves run per tenant. Scoping this sweep to one tenant does not just
    // leave the others' runs open — their stalled LLM cost never reaches the OU
    // boundary at all, so the backlog is unbilled as well as unswept.
    const { reconcileStalledBilling } = await import('../scheduling/stalled-run-billing-reconciler');
    const { hasOpenSweepableRuns } = await import('../scheduling/stalled-run-reconciler');
    let open = false;
    const fanout = await forEachTenant('stalled-run-reconcile', async (tenantId) => {
      const swept = await runStalledRunReconciliation(tenantId);
      const billing = await reconcileStalledBilling(tenantId);
      if (await hasOpenSweepableRuns(tenantId)) open = true;
      return { ...swept, billing };
    });
    // A run this sweep could still close is open: look again.
    if (open) armStallWatch();
    return res.json(fanout);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'stalled-run reconciliation cycle failed');
    return res.status(500).json({ error: 'stalled-run reconciliation failed' });
  }
});

// agent-invocation-signals-cleanup — daily.
router.post('/hybrid-loop/sweep-signals', async (_req: Request, res: Response) => {
  const pool = getPoolForService('scheduled-execution');
  const { rowCount } = await pool.query(
    `DELETE FROM agent_invocation_signals WHERE created_at < NOW() - INTERVAL '7 days'`,
  );
  // C10 — quarantined session artifacts age out on the same daily tick rather
  // than earning their own Cloud Scheduler job. Thirty days is long enough that
  // a corruption reported by a customer is still on disk when someone goes
  // looking, and short enough that transcript bytes do not accumulate forever.
  const quarantine = await pool.query(
    `DELETE FROM quarantined_session_artifacts WHERE quarantined_at < NOW() - INTERVAL '30 days'`,
  ).catch((e) => {
    // A sweep failure must not fail the signals cycle it rides on.
    logger.warn({ err: (e as Error).message }, 'quarantined-session-artifacts sweep failed');
    return { rowCount: 0 };
  });
  logger.info(
    { deleted: rowCount, quarantineSwept: quarantine.rowCount ?? 0 },
    'hybrid-loop sweep-signals cycle complete',
  );
  return res.json({ deleted: rowCount, quarantineSwept: quarantine.rowCount ?? 0 });
});

// WS-3.4 — hourly notification-dedup TTL sweeper.
router.post('/notification-dedup-sweep', async (_req: Request, res: Response) => {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM notification_dedup WHERE created_at < NOW() - INTERVAL '24 hours'`,
  );
  return res.json({ swept: rowCount });
});

// WS-9.6 — mirror-locks reaper. Two Cloud Scheduler jobs already exist but
// the endpoints disappeared in a prior refactor; locks accumulate until an
// agent ends up waiting on an expired-but-undeleted row. CI scheduler-target
// validator (WS-9.6) prevents this class from recurring.
router.post('/reap-mirror-locks', async (_req: Request, res: Response) => {
  const pool = getPool();
  const r = await pool.query(
    `DELETE FROM mirror_locks WHERE expires_at < NOW() RETURNING tenant_id, owner, repo`,
  );
  logger.info({ reaped: r.rowCount }, 'mirror-locks reaper cycle complete');
  return res.json({ reaped: r.rowCount ?? 0 });
});

// The BACKSTOP, and only that. It stops rows accumulating for threads nothing
// ever returns to; it is not the liveness signal and it is deliberately still
// keyed on the LEASE rather than the 75-second heartbeat window (INV-PB-018).
// Narrowing it would make a cron tick race live turns, which is the opposite of
// what a backstop is for — a thread whose owner died is already reclaimed by the
// next message on it, without waiting for this.
router.post('/reap-chat-turn-locks', async (_req: Request, res: Response) => {
  const { sweepExpiredLocks } = await import('../interactive-chat/turn-lock-registry');
  const reaped = await sweepExpiredLocks(getPool());
  logger.info({ reaped: reaped.length }, 'chat-turn-locks reaper cycle complete');
  return res.json({ reaped: reaped.length });
});

// WS-8.2 — Layer-2 deep-scan worker tick. Claims a batch of pending memories,
// scans each via the LLM provider abstraction, quarantines on hit.
router.post('/memory-deep-scan-tick', async (_req: Request, res: Response) => {
  const { runDeepScanTick } = await import('../memory/deep-scan-worker');
  const stats = await runDeepScanTick();
  return res.json(stats);
});

// Weekly per-agent performance snapshot. Cloud Scheduler tick (weekly). Iterates every
// tenant's ACTIVE agents and upserts a snapshot for the previous ISO week. Idempotent — the
// snapshot upsert keys on (tenant_id, agent_id, period_start), so reruns overwrite.
router.post('/performance-snapshot-tick', async (_req: Request, res: Response) => {
  const { computePerformanceSnapshot, savePerformanceSnapshot } = await import('../learning/performance-tracker');
  // One week boundary for the whole tick, computed before the fan-out: deriving
  // it per tenant would put tenants swept either side of midnight UTC into
  // different weeks on the same run.
  const now = new Date();
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const thisWeekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  const periodEnd = thisWeekStart;
  const periodStart = new Date(thisWeekStart.getTime() - 7 * 24 * 3600 * 1000);

  const fanout = await forEachTenant('performance-snapshot-tick', async (tenantId) => {
    const agents = await getPool().query<{ id: string }>(
      `SELECT id FROM agents WHERE tenant_id = $1 AND lifecycle = 'ACTIVE'`,
      [tenantId],
    );
    let saved = 0;
    for (const a of agents.rows) {
      try {
        const snapshot = await computePerformanceSnapshot(tenantId, a.id, periodStart, periodEnd);
        await savePerformanceSnapshot(tenantId, snapshot);
        saved++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, agentId: a.id }, 'performance-snapshot-tick: agent failed');
      }
    }
    return { agents: agents.rows.length, saved };
  });

  return res.json({
    ...fanout,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });
});

// WS-5.4 — daily connector binding probe.
router.post('/connector-binding-probe', async (_req: Request, res: Response) => {
  try {
    const { probeAllBindings } = await import('../connectors/binding-probe');
    const stats = await probeAllBindings();
    return res.json(stats);
  } catch (err) {
    // A rejection nobody catches leaves the response unsent, and the scheduler
    // reads a request timeout instead of the failure.
    logger.error({ err: (err as Error).message }, 'connector binding probe run failed');
    return res.status(500).json({ error: 'connector binding probe failed' });
  }
});

// C.2 — hourly per-tenant connector-tool smoke. Hash-sharded into 6 buckets
// so each binding gets probed every 6 hours, not every hour. Picks a
// read-only function per connector and dispatches it via the tool-gateway.
// Kill switch: CONNECTOR_TOOL_SMOKE_DISABLED=1.
router.post('/connector-tool-smoke', async (req: Request, res: Response) => {
  const { runConnectorToolSmoke } = await import('../connectors/tool-smoke');
  const { toolGatewayService } = await import('../tool-gateway/router');
  const stats = await runConnectorToolSmoke(
    toolGatewayService as unknown as Parameters<typeof runConnectorToolSmoke>[0],
    { allBuckets: req.body?.allBuckets === true },
  );
  return res.json(stats);
});

// WS-9.2 — Gmail users.watch re-arm. Watches expire after 7 days; this
// refreshes any binding whose watch_expires_at is within 36 hours, and is armed
// for the earliest one (armNextGmailRearm).
router.post('/gmail-watch-rearm', async (_req: Request, res: Response) => {
  const { rearmExpiringGmailWatches } = await import('../connectors/gmail-watch');
  const stats = await rearmExpiringGmailWatches();
  return res.json(stats);
});

// Skill-embedding sweeper. Armed when an embedding comes back empty. Picks up
// agent_skills rows with status='active' and embedding IS NULL (caused by
// either a write-time embedding-generation failure after retries exhausted,
// or pre-embedding-column historical rows) and regenerates each embedding.
//
// Why this exists: skill retrieval (src/skills/retrieval.ts:43) requires
// embedding IS NOT NULL. NULL rows are invisible to retrieval → never
// injected → skill-feedback callback to platform-backend never fires →
// reflection-engine evidence never accumulates → whole learning loop silent.
// This sweeper guarantees self-healing across all tenants.
//
// Cap of 100 rows/tick bounds cost (~$0.001 per row at Google embed pricing).
router.post('/skill-embedding-sweeper', async (_req: Request, res: Response) => {
  const { sweepNullSkillEmbeddings } = await import('../skills/embedding-sweeper');
  const stats = await sweepNullSkillEmbeddings(100);
  logger.info({ ...stats }, 'skill-embedding-sweeper cycle complete');
  return res.json(stats);
});

// Closes expired vendor browser sessions. The same sweep as
// POST /api/jobs/web-sessions-reap, here because this router is the one a
// Cloud Task reaches with the scheduler's OIDC token (that one wants a shared
// secret). Armed for the earliest open session's expiry, and re-armed after
// each sweep.
router.post('/web-sessions-reap', async (_req: Request, res: Response) => {
  try {
    const { SessionReaper } = await import('../integrations/web-fetch/session-reaper');
    const { anchorClient, browserbaseClient, browserUseClient } = await import('../tools/standard-tool-handler');
    const result = await new SessionReaper(anchorClient, browserbaseClient, browserUseClient).sweep();
    const { armNextWebSessionReap } = await import('../browser-sessions/reap-schedule');
    await armNextWebSessionReap();
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'web-sessions-reap failed');
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// The one Cloud Scheduler job. Enqueues every maintenance endpoint once (see
// handlers/housekeeping.ts); each runs as its own Cloud Task, so one slow or
// failing sweep neither times out nor hides the others.
router.post('/housekeeping/daily', async (_req: Request, res: Response) => {
  try {
    return res.json(await enqueueDailyHousekeeping());
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'daily housekeeping enqueue failed');
    return res.status(500).json({ error: 'daily housekeeping enqueue failed' });
  }
});

// Periodic reconciler for cached_model_configs. Hourly Cloud Scheduler
// tick. Walks every tenant in the cache, fetches PB's authoritative
// configs, and replaces the cached row. Defense-in-depth against
// migrations or operator SQL that bypassed the Pub/Sub event path.
router.post('/model-config-reconciler', async (_req: Request, res: Response) => {
  const { reconcileModelConfigs } = await import('../scheduling/model-config-reconciler');
  const result = await reconcileModelConfigs();
  return res.json(result);
});

// Retention for workflow_escalations (B1 to B3). Daily Cloud Scheduler tick.
// Sweeps operator records left unresolved beyond the window and deletes rows
// resolved longer ago than it. Batched and ordered oldest-first, so a backlog
// drains over successive passes instead of starving.
router.post('/escalation-retention', async (_req: Request, res: Response) => {
  const { runEscalationRetention } = await import('../agent-execution/escalation-retention');
  const result = await runEscalationRetention();
  return res.json(result);
});

// Retention for dlq_messages and failed_events. Daily Cloud Scheduler tick.
// Deletes rows whose handling already finished (resolved/discarded, and
// successfully republished) past 30 days, and reports the rows nobody has
// dealt with instead of deleting them. The report is what backs the
// dlq_backlog_pending alert; see src/infrastructure/dlq-retention.ts for why
// unresolved rows are never swept.
router.post('/dlq-retention', async (_req: Request, res: Response) => {
  const { runDlqRetention } = await import('../infrastructure/dlq-retention');
  const result = await runDlqRetention();
  return res.json(result);
});

// Trims superseded agent_skills rows to the newest few per skill and rebuilds
// the HNSW embedding index once the tail has drained. Superseding is an UPDATE,
// so a rewrite leaves its predecessor behind; where the control plane sends no
// stable id the runtime inserts under a generated one every publish and the old
// rows accumulate. Idempotent — returns deleted: 0 once there is nothing left.
router.post('/agent-skills-retention', async (_req: Request, res: Response) => {
  const { runAgentSkillsRetention } = await import('../jobs/agent-skills-retention');
  const result = await runAgentSkillsRetention();
  return res.json(result);
});

// Republishes invocations whose invocation.completed publish failed silently,
// and closes out the ones the Stripe meter can no longer accept.
//
// On this router rather than jobs/router.ts for the reason recorded above: that
// router is not reachable by a scheduler, so a job mounted there never runs.
// That matters more here than for its neighbours — the replay emits billing
// events and drains prepaid balance, so a job that cannot run can hide an
// unbounded replay that is safe only for as long as it never runs.
router.post('/billing-queued-reconciliation', async (_req: Request, res: Response) => {
  const { runBillingQueuedReconciliation } = await import('../jobs/billing-queued-reconciliation');
  await runBillingQueuedReconciliation();
  return res.json({ ok: true });
});

// Closes the loop on applied reflection suggestions: compares an agent's
// failure rate over the runs before and after a suggestion landed, and records
// improved / no_change / degraded against the outcome the reflection predicted.
//
// This is the caller `recordSuggestionOutcome` never had. It and its columns
// have existed since migration 063 and nothing has ever invoked them, so "did
// this refinement help?" was unanswerable. An endpoint alone would not have
// changed that — it would only have moved the orphan up a level — so the
// scheduler entry in r5_scheduler_jobs.tf is part of the same change.
//
// Lives here rather than beside the other jobs in jobs/router.ts because this
// is the router Cloud Scheduler actually reaches: the r5 scheduler jobs send an
// OIDC token and no shared secret, and the /api/jobs/* routes that check for
// one are scheduled from a module that is not deployed in any environment.
// Every sibling below is IAM-gated the same way — agent-service grants
// run.invoker to six named service accounts and nothing else.
//
// Safe to run more often than the settle window: the query that feeds it
// selects only suggestions whose outcome is still unrecorded.
router.post('/reflection-outcome-closure', async (_req: Request, res: Response) => {
  const { runReflectionOutcomeClosure } = await import('../jobs/reflection-outcome-closure');
  const result = await runReflectionOutcomeClosure();
  return res.json(result);
});

// The cadence half of the reflection engine.
//
// `onScheduledReflection` is the only trigger whose gate returns true
// unconditionally, so this route reaches the baseline / drift / revert /
// closure machinery on a fixed cadence, independent of the evidence counters.
//
// Deliberately on THIS router, for the reason the sibling above records: the r5
// scheduler jobs authenticate with an OIDC token and send no shared secret, so
// the same handler behind `requireServiceAuth()` would 401 on every fire while
// the job kept reporting ENABLED. Its scheduler entry belongs in
// `r5_scheduler_jobs.tf` beside the closure job, and is covered by the existing
// attempt_count alert that watches for a non-200.
router.post('/scheduled-reflection', async (_req: Request, res: Response) => {
  const { runScheduledReflection } = await import('../jobs/scheduled-reflection');
  const result = await runScheduledReflection();
  return res.json(result);
});

// Can a REAL recorded conversation still be rebuilt for another engine?
//
// Certification asks that of FIXTURES, which are written by hand and therefore
// always contain the turns somebody remembered to include. This asks it of what
// was actually recorded — the half certification structurally cannot reach. A
// canonical record that silently dropped one side of the conversation would
// pass every count-based check.
//
// Read-only. It sends no turns, mutates no agent, and calls no model.
router.post('/canonical-rebuild-canary', async (_req: Request, res: Response) => {
  const { runCanonicalRebuildCanary } = await import('../jobs/canonical-rebuild-canary');
  const result = await runCanonicalRebuildCanary();
  // 200 either way: the finding is in the body and on the log line the alert
  // watches. A non-2xx here would be read by the scheduler health alert as the
  // JOB being broken, which is a different fact from the job correctly
  // reporting that a record cannot be rebuilt.
  return res.json(result);
});

// Would each agent's stored workflow run?
//
// Read-only: builds each agent's real tool catalog and validates its stored
// steps against it. Executes no step, sends no turn, calls no model, writes
// nothing.
//
// With WORKFLOW_STEPS_ENABLED=1 this is not a pre-enablement check — it is the
// only way to find a broken graph without waiting for its next fire, and
// `validateWorkflowGraph` fails the whole run rather than the offending step.
router.post('/workflow-steps-audit', async (_req: Request, res: Response) => {
  const { auditWorkflowSteps } = await import('../jobs/workflow-steps-audit');
  const result = await auditWorkflowSteps();
  // 200 either way. A finding is a fact about stored data, not a failure of
  // this job, and a non-2xx would be read by the scheduler-health alert as the
  // job being broken.
  return res.json(result);
});

export default router;
