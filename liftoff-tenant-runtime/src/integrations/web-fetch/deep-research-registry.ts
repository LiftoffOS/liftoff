// Persistent record of every deep_research submission. The reconciler
// (deep-research-reconciler.ts) drives off this table; each vendor client
// (perplexity, openai, google) writes/finalizes via the helpers exported here.

import { getPool } from '../../infrastructure/database';

/** Subset of WebVendor that emits deep_research submissions. Other web-tool
 *  vendors don't have a long-running submit/poll lifecycle to recover. */
export type DeepResearchVendor = 'perplexity' | 'openai' | 'google';

export interface DeepResearchSubmissionRow {
  deepResearchId:     string;
  submissionId:       string;
  tenantId:           string;
  agentId:            string | null;
  vendor:             DeepResearchVendor;
  reasoningEffort:    'low' | 'medium' | 'high';
  estimateCostMicros: number;
  submittedAt:        Date;
  lastPolledAt:       Date | null;
  polledCount:        number;
  finalStatus:        'completed' | 'failed' | 'abandoned' | null;
  finalCostMicros:    number | null;
  finalizedAt:        Date | null;
}

export interface InsertSubmissionInput {
  deepResearchId:     string;
  submissionId:       string;
  tenantId:           string;
  agentId:            string | null;
  vendor:             DeepResearchVendor;
  reasoningEffort:    'low' | 'medium' | 'high';
  estimateCostMicros: number;
}

/**
 * Idempotent insert. Second submit with the same deep_research_id is a no-op
 * (defensive — UUID collisions are effectively impossible but the registry
 * write is in a `.catch()` block so a retry under load is harmless).
 */
export async function insertSubmission(input: InsertSubmissionInput): Promise<void> {
  await getPool().query(
    `INSERT INTO deep_research_submissions
       (deep_research_id, submission_id, tenant_id, agent_id,
        vendor, reasoning_effort, estimate_cost_micros)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (deep_research_id) DO NOTHING`,
    [
      input.deepResearchId, input.submissionId, input.tenantId, input.agentId,
      input.vendor, input.reasoningEffort, input.estimateCostMicros,
    ],
  );
}

export interface FinalizeSubmissionInput {
  deepResearchId:  string;
  finalStatus:     'completed' | 'failed' | 'abandoned';
  finalCostMicros: number;
}

/**
 * Idempotent finalize. The WHERE clause prevents the reconciler from
 * over-writing a hook-driven completion (or vice versa).
 */
export async function finalizeSubmission(input: FinalizeSubmissionInput): Promise<void> {
  await getPool().query(
    `UPDATE deep_research_submissions
        SET final_status      = $2,
            final_cost_micros = $3,
            finalized_at      = NOW()
      WHERE deep_research_id  = $1
        AND final_status IS NULL`,
    [input.deepResearchId, input.finalStatus, input.finalCostMicros],
  );
}

/** Bump last_polled_at + polled_count. Called from the reconciler and the
 *  408 branch of perplexity-client. */
export async function markPolled(deepResearchId: string): Promise<void> {
  await getPool().query(
    `UPDATE deep_research_submissions
        SET last_polled_at = NOW(),
            polled_count   = polled_count + 1
      WHERE deep_research_id = $1`,
    [deepResearchId],
  );
}

/**
 * Hook heartbeat. The hook's poll loop in perplexity-client calls this on
 * EVERY Perplexity poll iteration (5s cadence per DEEP_RESEARCH_POLL_INTERVAL_MS).
 * The reconciler's selection predicate skips rows where hook_active_until > NOW(),
 * so an actively-polling hook owns the submission and the reconciler stays out
 * of the way.
 *
 * Failure mode: if the hook stops calling this (process crash, 408 ceiling,
 * graceful exit on COMPLETED/FAILED), hook_active_until goes stale within
 * ttlSeconds and the reconciler picks up the submission on the next pass.
 *
 * ttlSeconds defaults to 30 — comfortably > the 5s poll cadence so the
 * heartbeat doesn't expire mid-poll, comfortably < the reconciler's 60s
 * cadence so recovery latency is sub-minute on crash.
 */
export async function markHookActive(deepResearchId: string, ttlSeconds = 30): Promise<void> {
  await getPool().query(
    `UPDATE deep_research_submissions
        SET hook_active_until = NOW() + ($2 || ' seconds')::interval
      WHERE deep_research_id = $1`,
    [deepResearchId, String(ttlSeconds)],
  );
}

/**
 * Adaptive selection for the reconciler. Cadences match D2:
 *   - <5min:  poll every 60s
 *   - 5-30min: poll every 120s
 *   - 30min-24h: poll every 300s
 *   - >24h: poll once per hour (final attempts before abandon)
 *
 * Multi-replica strategy: NOT FOR UPDATE SKIP LOCKED. Holding row locks
 * across the reconciler's per-row Perplexity poll (~5s) + Pub/Sub publish
 * (~1s, more if degraded) would (a) deadlock when reconcileOne calls
 * pool-based helpers like finalizeSubmission/markPolled (different pool
 * connection blocks waiting for the outer tx's row lock; outer tx awaits
 * the helper → in-process deadlock) and (b) hold the outer DB tx open
 * during a slow Pub/Sub call.
 *
 * Instead: accept that two replicas may both pick the same rows and do
 * the same work in parallel. The cost is bounded:
 *   - Perplexity poll endpoint is free (3000-6000 RPM cap, we use <2 RPS)
 *   - All registry writes are idempotent (ON CONFLICT / WHERE final_status IS NULL)
 *   - Publishes are deduped by PB ingester via metadata.idempotency_key
 *     (the same dedup that handles hook-vs-reconciler races)
 *
 * Net: at most N× wasted work per replica count, but no correctness gap.
 *
 * Hook-active skip (Gap #5): rows where hook_active_until > NOW() are
 * actively owned by a hook polling Perplexity. Skip — the reconciler is the
 * backstop, not a duplicate poller. This also bounds the cost of multi-
 * replica duplication: in the steady state most rows have an active hook,
 * so duplicate-work windows are short.
 */
export async function selectDueForReconciliation(limit: number): Promise<DeepResearchSubmissionRow[]> {
  const result = await getPool().query<{
    deep_research_id:     string;
    submission_id:        string;
    tenant_id:            string;
    agent_id:             string | null;
    vendor:               DeepResearchVendor;
    reasoning_effort:     'low' | 'medium' | 'high';
    estimate_cost_micros: string;
    submitted_at:         Date;
    last_polled_at:       Date | null;
    polled_count:         number;
  }>(
    `SELECT deep_research_id, submission_id, tenant_id, agent_id,
            vendor, reasoning_effort, estimate_cost_micros, submitted_at,
            last_polled_at, polled_count
       FROM deep_research_submissions
      WHERE final_status IS NULL
        AND (hook_active_until IS NULL OR hook_active_until < NOW())
        AND (
          (NOW() - submitted_at < INTERVAL '5 minutes'
            AND (last_polled_at IS NULL
              OR NOW() - last_polled_at >= INTERVAL '50 seconds'))
          OR (NOW() - submitted_at BETWEEN INTERVAL '5 minutes' AND INTERVAL '30 minutes'
            AND (last_polled_at IS NULL
              OR NOW() - last_polled_at >= INTERVAL '110 seconds'))
          OR (NOW() - submitted_at BETWEEN INTERVAL '30 minutes' AND INTERVAL '24 hours'
            AND (last_polled_at IS NULL
              OR NOW() - last_polled_at >= INTERVAL '290 seconds'))
          OR (NOW() - submitted_at >= INTERVAL '24 hours'
            AND (last_polled_at IS NULL
              OR NOW() - last_polled_at >= INTERVAL '55 minutes'))
        )
      ORDER BY submitted_at
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(r => ({
    deepResearchId:     r.deep_research_id,
    submissionId:       r.submission_id,
    tenantId:           r.tenant_id,
    agentId:            r.agent_id,
    vendor:             r.vendor,
    reasoningEffort:    r.reasoning_effort,
    estimateCostMicros: Number(r.estimate_cost_micros),
    submittedAt:        r.submitted_at,
    lastPolledAt:       r.last_polled_at,
    polledCount:        r.polled_count,
    finalStatus:        null,
    finalCostMicros:    null,
    finalizedAt:        null,
  }));
}

/**
 * Janitor: prune finalized rows past retention. Called from the in-process
 * reconciler loop (TR-7) to amortize over normal traffic.
 */
export async function sweepFinalizedSubmissions(retentionDays: number): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM deep_research_submissions
      WHERE final_status IS NOT NULL
        AND finalized_at < NOW() - ($1 || ' days')::interval`,
    [String(retentionDays)],
  );
  return result.rowCount ?? 0;
}
