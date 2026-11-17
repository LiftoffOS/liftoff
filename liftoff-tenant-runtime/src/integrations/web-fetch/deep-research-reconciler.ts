// In-process reconciler that polls the originating vendor for unresolved
// deep_research submissions. Backstop for the hook fast path: if the hook
// missed (Pub/Sub outage, process crash, 408 ceiling, withRetry exhaustion),
// the reconciler fetches the real status from the vendor and emits the
// missing event(s) through the same Pub/Sub channel.
//
// Multi-vendor (migration 236):
//   The registry now carries a `vendor` column; the reconciler dispatches to
//   per-vendor poll endpoints and cost extractors via VendorAdapter (below).
//   The status-normalization layer collapses each vendor's status enum into
//   a shared {completed, failed, pending, unreachable} outcome so the
//   downstream emit + finalize logic stays vendor-agnostic.
//
// Idempotency model (Gap #2):
//   The reconciler ALWAYS emits BOTH a pre-charge AND a delta (or refund
//   pair for ABANDONED). Same idempotency keys the hook uses (`${id}` for
//   pre-charge, `${id}/delta` for delta). PB ingester dedupes against any
//   event the hook already published. End state: customer billed exactly
//   once, correctly, regardless of which path (hook vs reconciler)
//   delivered which event first.
//
// No local usage_events mirror:
//   Earlier revisions of this plan had the reconciler also call
//   usageLedgerService.recordUsage to keep tenant-runtime's usage_events
//   table in sync. Dropped because usage_events is only an
//   ingester-backstop source for the control plane, and the Pub/Sub push +
//   outbox path already covers that responsibility. Net: reconciler-recovered
//   rows do NOT appear in tenant-runtime's local usage_events, but billing in
//   PB cost_attribution_events IS correct. Acceptable trade.
//
//   The original second reason — that recordUsage's burn_state decrement had
//   no idempotency_key dedup, so a hook+reconciler race double-counted local
//   burn state — no longer applies: burn_state is decommissioned and
//   recordUsage writes the ledger row and nothing else (INV-TR-012).

import { logger } from '../../infrastructure/logging';
import { getWebToolSecret } from './web-tool-secrets';
import { publishWebToolEvent, type WebToolSpendEvent } from './event-publisher';
import { enqueueOutbox } from './deep-research-outbox';
import { exactCostMicros, type PerplexityUsage } from './perplexity-client';
import {
  computeOpenAICostMicros,
  countSearchCalls,
  type OpenAIResponse,
} from './openai-client';
import {
  computeGoogleCostMicros,
  type GoogleInteraction,
} from './google-client';
import {
  selectDueForReconciliation,
  finalizeSubmission,
  markPolled,
  sweepFinalizedSubmissions,
  type DeepResearchSubmissionRow,
  type DeepResearchVendor,
} from './deep-research-registry';

const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_BATCH_SIZE = 100;

// Abandon after 24h matches the final adaptive cadence tier in
// selectDueForReconciliation. Perplexity Community threads document a
// "stuck IN_PROGRESS for hours" bug pattern; 24h gives those a chance to
// resolve before we refund. Same ceiling applies to OpenAI/Google — both
// vendors document 24h as the maximum reasonable hold for background
// deep-research work.
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

// 90 days finalized retention — enough for month-end reconciliation against
// vendor invoices, short enough that the registry table doesn't grow
// unbounded.
const FINALIZED_RETENTION_DAYS = 90;

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
const OPENAI_BASE_URL = 'https://api.openai.com';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const VENDOR_POLL_TIMEOUT_MS = 15_000;

interface PerplexityAsyncStatusResponse {
  status: 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | string;
  response: {
    choices: Array<{ message: { content: string } }>;
    search_results?: Array<{ url: string; title?: string; date?: string }>;
    usage: PerplexityUsage;
  } | null;
  error_message?: string | null;
}

let reconcilerHandle: ReturnType<typeof setInterval> | null = null;
// Overlap guard (Gap #7): a slow reconcile pass (vendors unreachable +
// many rows × 15s timeout each) can exceed RECONCILE_INTERVAL_MS. Skip the
// next tick rather than running two concurrent passes in the same replica.
let reconcileInProgress = false;

/**
 * Normalized per-row outcome returned by each vendor adapter. The reconciler
 * core uses this to drive the shared emit + finalize logic so vendor
 * differences are confined to fetchStatus.
 *
 *   'completed':  vendor confirmed success; actualCostMicros is exact.
 *   'failed':     vendor confirmed failure (FAILED / cancelled / expired /
 *                 budget_exceeded / null response on COMPLETED). May carry a
 *                 partial cost if the vendor billed us for partial work.
 *   'pending':    vendor confirmed still running (IN_PROGRESS / queued /
 *                 requires_action), OR a COMPLETED response that we couldn't
 *                 extract usage from (we wait for the next pass instead of
 *                 fabricating a cost).
 *   'unreachable': network error, non-2xx that isn't a final-state signal,
 *                 or JSON parse failure. Row stays unresolved; next pass retries.
 */
type NormalizedStatus =
  | { kind: 'completed'; actualCostMicros: number }
  | { kind: 'failed'; actualCostMicros: number; errorMessage?: string }
  | { kind: 'pending' }
  | { kind: 'unreachable' };

interface VendorAdapter {
  vendor: DeepResearchVendor;
  fetchStatus(submissionId: string): Promise<NormalizedStatus>;
}

// ── Perplexity adapter ──────────────────────────────────────────────────────

function perplexityAdapter(apiKey: string): VendorAdapter {
  return {
    vendor: 'perplexity',
    async fetchStatus(submissionId: string): Promise<NormalizedStatus> {
      let res: Response;
      try {
        res = await fetch(`${PERPLEXITY_BASE_URL}/async/chat/completions/${submissionId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(VENDOR_POLL_TIMEOUT_MS),
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, submission_id: submissionId, vendor: 'perplexity' },
          'deep_research_reconciler_vendor_unreachable');
        return { kind: 'unreachable' };
      }
      if (res.status === 404) {
        // Perplexity no longer recognizes the submission — finalize as failed
        // so the row doesn't poll forever.
        logger.warn({ submission_id: submissionId, vendor: 'perplexity' }, 'deep_research_reconciler_vendor_404');
        return { kind: 'failed', actualCostMicros: 0, errorMessage: `perplexity 404 for ${submissionId}` };
      }
      if (!res.ok) {
        logger.warn({ submission_id: submissionId, status: res.status, vendor: 'perplexity' },
          'deep_research_reconciler_vendor_non_2xx');
        return { kind: 'unreachable' };
      }
      let body: PerplexityAsyncStatusResponse;
      try {
        body = await res.json() as PerplexityAsyncStatusResponse;
      } catch (err) {
        logger.warn({ err: (err as Error).message, submission_id: submissionId, vendor: 'perplexity' },
          'deep_research_reconciler_vendor_json_invalid');
        return { kind: 'unreachable' };
      }

      // Gap #4 — COMPLETED + null response handling. Treat as FAILED.
      if (body.status === 'COMPLETED') {
        if (!body.response) {
          logger.warn({ submission_id: submissionId, vendor: 'perplexity' },
            'deep_research_reconciler_completed_null_response');
          return { kind: 'failed', actualCostMicros: 0 };
        }
        try {
          const cost = exactCostMicros(body.response.usage, 'deep_research');
          return { kind: 'completed', actualCostMicros: cost };
        } catch (err) {
          // Wait for next pass; better unresolved than fabricated cost.
          logger.error({ err: (err as Error).message, submission_id: submissionId, vendor: 'perplexity' },
            'deep_research_reconciler_cost_extraction_failed');
          return { kind: 'pending' };
        }
      }

      if (body.status === 'FAILED') {
        // Gap #3 — partial-cost extraction on FAILED.
        let partial = 0;
        try {
          if (body.response?.usage) {
            partial = exactCostMicros(body.response.usage, 'deep_research_failed_partial');
          }
        } catch {
          partial = 0;
        }
        return { kind: 'failed', actualCostMicros: partial, errorMessage: body.error_message ?? undefined };
      }

      return { kind: 'pending' };
    },
  };
}

// ── OpenAI adapter ──────────────────────────────────────────────────────────

function openaiAdapter(apiKey: string): VendorAdapter {
  return {
    vendor: 'openai',
    async fetchStatus(submissionId: string): Promise<NormalizedStatus> {
      let res: Response;
      try {
        res = await fetch(`${OPENAI_BASE_URL}/v1/responses/${submissionId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(VENDOR_POLL_TIMEOUT_MS),
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, submission_id: submissionId, vendor: 'openai' },
          'deep_research_reconciler_vendor_unreachable');
        return { kind: 'unreachable' };
      }
      if (res.status === 404) {
        logger.warn({ submission_id: submissionId, vendor: 'openai' }, 'deep_research_reconciler_vendor_404');
        return { kind: 'failed', actualCostMicros: 0, errorMessage: `openai 404 for ${submissionId}` };
      }
      if (!res.ok) {
        logger.warn({ submission_id: submissionId, status: res.status, vendor: 'openai' },
          'deep_research_reconciler_vendor_non_2xx');
        return { kind: 'unreachable' };
      }
      let body: OpenAIResponse;
      try {
        body = await res.json() as OpenAIResponse;
      } catch (err) {
        logger.warn({ err: (err as Error).message, submission_id: submissionId, vendor: 'openai' },
          'deep_research_reconciler_vendor_json_invalid');
        return { kind: 'unreachable' };
      }

      if (body.status === 'completed') {
        if (!body.usage) {
          // Contract break — wait for next pass; abandonment cutoff catches it eventually.
          logger.error({ submission_id: submissionId, vendor: 'openai' },
            'deep_research_reconciler_completed_missing_usage');
          return { kind: 'pending' };
        }
        try {
          const cost = await computeOpenAICostMicros(body.usage, countSearchCalls(body));
          return { kind: 'completed', actualCostMicros: cost };
        } catch (err) {
          logger.error({ err: (err as Error).message, submission_id: submissionId, vendor: 'openai' },
            'deep_research_reconciler_cost_extraction_failed');
          return { kind: 'pending' };
        }
      }

      // OpenAI's `expired` mirrors a 408-ceiling miss on our side; treat
      // as FAILED with whatever partial token + search-call spend we can
      // attribute (OpenAI bills us for any work that completed before
      // expiry — under-billing would silently eat that cost).
      if (body.status === 'failed' || body.status === 'expired') {
        let partial = 0;
        if (body.usage) {
          try {
            partial = await computeOpenAICostMicros(body.usage, countSearchCalls(body));
          } catch {
            partial = 0;
          }
        }
        return {
          kind: 'failed',
          actualCostMicros: partial,
          errorMessage: body.error?.message ?? body.status,
        };
      }

      // queued / in_progress
      return { kind: 'pending' };
    },
  };
}

// ── Google adapter ──────────────────────────────────────────────────────────

function googleAdapter(apiKey: string): VendorAdapter {
  return {
    vendor: 'google',
    async fetchStatus(submissionId: string): Promise<NormalizedStatus> {
      let res: Response;
      try {
        res = await fetch(
          `${GEMINI_BASE_URL}/v1beta/interactions/${submissionId}?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(VENDOR_POLL_TIMEOUT_MS),
          },
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message, submission_id: submissionId, vendor: 'google' },
          'deep_research_reconciler_vendor_unreachable');
        return { kind: 'unreachable' };
      }
      if (res.status === 404) {
        logger.warn({ submission_id: submissionId, vendor: 'google' }, 'deep_research_reconciler_vendor_404');
        return { kind: 'failed', actualCostMicros: 0, errorMessage: `google 404 for ${submissionId}` };
      }
      if (!res.ok) {
        logger.warn({ submission_id: submissionId, status: res.status, vendor: 'google' },
          'deep_research_reconciler_vendor_non_2xx');
        return { kind: 'unreachable' };
      }
      let body: GoogleInteraction;
      try {
        body = await res.json() as GoogleInteraction;
      } catch (err) {
        logger.warn({ err: (err as Error).message, submission_id: submissionId, vendor: 'google' },
          'deep_research_reconciler_vendor_json_invalid');
        return { kind: 'unreachable' };
      }

      if (body.status === 'completed') {
        try {
          const cost = await computeGoogleCostMicros(body.usage);
          return { kind: 'completed', actualCostMicros: cost };
        } catch (err) {
          logger.error({ err: (err as Error).message, submission_id: submissionId, vendor: 'google' },
            'deep_research_reconciler_cost_extraction_failed');
          return { kind: 'pending' };
        }
      }

      // Google's terminal-but-not-completed statuses. budget_exceeded is the
      // account-level signal that mirrors how the hook surfaces 429; for the
      // reconciler this is a final state we record as failed with 0 cost
      // (Google doesn't bill us for budget-exceeded requests per published
      // billing rules).
      if (
        body.status === 'failed'
          || body.status === 'cancelled'
          || body.status === 'incomplete'
          || body.status === 'budget_exceeded'
      ) {
        let partial = 0;
        if (body.usage) {
          try {
            partial = await computeGoogleCostMicros(body.usage);
          } catch {
            partial = 0;
          }
        }
        return {
          kind: 'failed',
          actualCostMicros: partial,
          errorMessage: body.error?.message ?? body.status,
        };
      }

      // in_progress / requires_action
      return { kind: 'pending' };
    },
  };
}

/**
 * Emit BOTH pre-charge and delta for a submission resolved by the reconciler
 * (Gap #2). Same idempotency keys the hook uses — PB ingester dedupes
 * whichever the hook already delivered, so the union is exactly one
 * pre-charge + one delta per submission regardless of which path emitted
 * each event.
 *
 * Why both, not just the delta:
 *   Race scenario the hook can't fully prevent — hook fires precharge,
 *   recordUsage fails, publish fails, tryPublishOrOutbox itself fails, then
 *   crash. Registry row exists. Hook never delivered pre-charge to anywhere
 *   durable. If the reconciler only emitted a delta, customer would be
 *   billed (actual − estimate) instead of full actual. Emitting both
 *   guarantees the customer ledger sums to actual.
 *
 * Outbox-on-failure: each individual publish failure routes through the
 * same outbox the hook uses, so a Pub/Sub outage during the reconcile pass
 * still gets recovered by the drainer.
 */
async function emitPair(
  row: DeepResearchSubmissionRow,
  actualCostMicros: number,
  status: 'COMPLETED' | 'FAILED' | 'ABANDONED',
): Promise<void> {
  const occurredAt = new Date().toISOString();

  const prechargeEvent: WebToolSpendEvent = {
    tenantId:       row.tenantId,
    agentId:        row.agentId ?? undefined,
    connector:      row.vendor,
    eventType:      'web_deep_research',
    costUsd:        row.estimateCostMicros / 1_000_000,
    occurredAt:     row.submittedAt.toISOString(),    // original submit time, not now
    idempotencyKey: row.deepResearchId,
    metadata: {
      is_pre_charge:        true,
      reconciler_source:    true,
      reasoning_effort:     row.reasoningEffort,
      submission_id:        row.submissionId,
      deep_research_id:     row.deepResearchId,
    },
  };

  const deltaCostMicros = actualCostMicros - row.estimateCostMicros;
  const deltaEvent: WebToolSpendEvent = {
    tenantId:       row.tenantId,
    agentId:        row.agentId ?? undefined,
    connector:      row.vendor,
    eventType:      'web_deep_research',
    costUsd:        deltaCostMicros / 1_000_000,
    occurredAt,
    idempotencyKey: `${row.deepResearchId}/delta`,
    metadata: {
      is_delta:             true,
      reconciler_source:    true,
      final_status:         status,
      estimate_cost_micros: row.estimateCostMicros,
      actual_cost_micros:   actualCostMicros,
      submission_id:        row.submissionId,
      deep_research_id:     row.deepResearchId,
    },
  };

  // Sequential — preserves causal ordering on Pub/Sub for the rare case
  // where ordering matters to a downstream consumer. Both go through the
  // same outbox-on-failure path.
  await emitOne(prechargeEvent, 'pre_charge', row.deepResearchId, status);
  await emitOne(deltaEvent,     'delta',      row.deepResearchId, status);
}

async function emitOne(
  event: WebToolSpendEvent,
  outboxKind: 'pre_charge' | 'delta',
  deepResearchId: string,
  status: string,
): Promise<void> {
  const ok = await publishWebToolEvent(event);
  if (!ok) {
    await enqueueOutbox(deepResearchId, outboxKind, event, `reconciler publish failed for status=${status}`)
      .catch((err: Error) => logger.error({
        err: err.message,
        deep_research_id: deepResearchId,
        outbox_kind: outboxKind,
      }, 'deep_research_reconciler_emit_failed'));
  }
}

type ReconcileOutcome =
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'pending'
  | 'unreachable';

/**
 * Resolve a single row. The reconciler is allowed to fail any single row
 * without stopping the batch — reconcileOnce catches per-row throws.
 *
 * Vendor dispatch (Gap multi-vendor): row.vendor selects the adapter so
 * the per-vendor poll URL + cost extractor + status enum mapping is
 * confined to that adapter. Shared logic (abandonment cutoff, emit pair,
 * finalize) lives here.
 */
async function reconcileOne(row: DeepResearchSubmissionRow, adapters: Record<DeepResearchVendor, VendorAdapter | null>): Promise<ReconcileOutcome> {
  await markPolled(row.deepResearchId).catch(() => {});

  const adapter = adapters[row.vendor];
  if (!adapter) {
    // API key for this vendor wasn't available — log and skip. Next pass
    // retries (ensureKey is lazy).
    logger.error({ deep_research_id: row.deepResearchId, vendor: row.vendor },
      'deep_research_reconciler_no_adapter');
    return 'unreachable';
  }

  const status = await adapter.fetchStatus(row.submissionId);
  const ageMs = Date.now() - row.submittedAt.getTime();

  if (status.kind === 'completed') {
    await emitPair(row, status.actualCostMicros, 'COMPLETED');
    await finalizeSubmission({
      deepResearchId:  row.deepResearchId,
      finalStatus:     'completed',
      finalCostMicros: status.actualCostMicros,
    });
    logger.info({
      deep_research_id:   row.deepResearchId,
      vendor:             row.vendor,
      actual_cost_micros: status.actualCostMicros,
      delta_cost_micros:  status.actualCostMicros - row.estimateCostMicros,
      polled_count:       row.polledCount + 1,
      age_ms:             ageMs,
    }, 'deep_research_reconciler_completed');
    return 'completed';
  }

  if (status.kind === 'failed') {
    await emitPair(row, status.actualCostMicros, 'FAILED');
    await finalizeSubmission({
      deepResearchId:  row.deepResearchId,
      finalStatus:     'failed',
      finalCostMicros: status.actualCostMicros,
    });
    logger.info({
      deep_research_id:   row.deepResearchId,
      vendor:             row.vendor,
      actual_cost_micros: status.actualCostMicros,
      error:              status.errorMessage,
      age_ms:             ageMs,
    }, 'deep_research_reconciler_failed');
    return 'failed';
  }

  if (status.kind === 'unreachable') {
    return 'unreachable';
  }

  // status.kind === 'pending'. If past 24h, give up.
  if (ageMs >= ABANDON_AFTER_MS) {
    await emitPair(row, 0, 'ABANDONED');
    await finalizeSubmission({
      deepResearchId:  row.deepResearchId,
      finalStatus:     'abandoned',
      finalCostMicros: 0,
    });
    logger.warn({
      deep_research_id: row.deepResearchId,
      vendor:           row.vendor,
      age_hours:        ageMs / 3_600_000,
      polled_count:     row.polledCount + 1,
    }, 'deep_research_reconciler_abandoned');
    return 'abandoned';
  }
  return 'pending';
}

export interface ReconcileSummary {
  selected:    number;
  completed:   number;
  failed:      number;
  abandoned:   number;
  pending:     number;
  unreachable: number;
  errors:      number;
}

/**
 * Lazy per-vendor API-key resolution. We only fetch a vendor's secret if
 * a row in the current batch needs that vendor — most batches in steady
 * state are single-vendor.
 */
async function buildAdapters(vendors: Set<DeepResearchVendor>): Promise<Record<DeepResearchVendor, VendorAdapter | null>> {
  const out: Record<DeepResearchVendor, VendorAdapter | null> = {
    perplexity: null,
    openai:     null,
    google:     null,
  };
  for (const vendor of vendors) {
    let apiKey: string;
    try {
      apiKey = await getWebToolSecret(`${vendor}-api-key` as const);
    } catch (err) {
      logger.error({ err: (err as Error).message, vendor },
        'deep_research_reconciler_no_api_key');
      continue;
    }
    if (vendor === 'perplexity') out.perplexity = perplexityAdapter(apiKey);
    if (vendor === 'openai')     out.openai     = openaiAdapter(apiKey);
    if (vendor === 'google')     out.google     = googleAdapter(apiKey);
  }
  return out;
}

/**
 * Single reconciler pass. Pool-based — no explicit transaction (see
 * deep-research-registry.ts:selectDueForReconciliation for the multi-replica
 * + no-FOR-UPDATE-SKIP-LOCKED rationale).
 *
 * Per-row outcomes are tallied directly from reconcileOne's return value
 * — no extra SELECT per row. A row that throws is caught and counted as
 * 'errors'; next pass retries.
 */
export async function reconcileOnce(): Promise<ReconcileSummary> {
  const due = await selectDueForReconciliation(RECONCILE_BATCH_SIZE);
  const summary: ReconcileSummary = {
    selected: due.length, completed: 0, failed: 0, abandoned: 0, pending: 0, unreachable: 0, errors: 0,
  };
  if (due.length === 0) return summary;

  // Lazy: only resolve secrets for the vendors that appear in this batch.
  const vendors = new Set<DeepResearchVendor>(due.map(r => r.vendor));
  const adapters = await buildAdapters(vendors);

  for (const row of due) {
    try {
      const outcome = await reconcileOne(row, adapters);
      summary[outcome]++;
    } catch (err) {
      summary.errors++;
      logger.error({
        err: (err as Error).message,
        deep_research_id: row.deepResearchId,
        vendor:           row.vendor,
      }, 'deep_research_reconciler_row_failed');
    }
  }

  if (summary.completed + summary.failed + summary.abandoned + summary.errors > 0) {
    logger.info(summary as unknown as Record<string, unknown>, 'deep_research_reconciler_pass_complete');
  }
  return summary;
}

/**
 * Start the in-process reconciler loop. Called from src/index.ts on boot.
 * .unref() so the reconciler doesn't keep the process alive during shutdown.
 */
export function startReconciler(): void {
  if (process.env.DEEP_RESEARCH_RECONCILER_DISABLED === 'true') {
    logger.info({}, 'deep_research_reconciler_disabled_by_env');
    return;
  }
  if (reconcilerHandle) return;
  reconcilerHandle = setInterval(async () => {
    if (reconcileInProgress) {
      logger.warn({}, 'deep_research_reconciler_skipped_overlap');
      return;
    }
    reconcileInProgress = true;
    try {
      await reconcileOnce();
      // Janitor: prune finalized rows past retention. Cheap; in-loop.
      await sweepFinalizedSubmissions(FINALIZED_RETENTION_DAYS);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'deep_research_reconciler_loop_failed');
    } finally {
      reconcileInProgress = false;
    }
  }, RECONCILE_INTERVAL_MS);
  reconcilerHandle.unref();
  logger.info({ interval_ms: RECONCILE_INTERVAL_MS }, 'deep_research_reconciler_started');
}

/**
 * Graceful shutdown (Gap #8): called from the SIGTERM handler in src/index.ts.
 * Awaits any in-flight reconcile pass to complete (bounded to 5s) so we don't
 * tear down mid-publish. Cloud Run's SIGTERM grace window is 10s; we use half.
 */
export async function stopReconciler(): Promise<void> {
  if (reconcilerHandle) { clearInterval(reconcilerHandle); reconcilerHandle = null; }
  let waited = 0;
  while (reconcileInProgress && waited < 5_000) {
    await new Promise(r => setTimeout(r, 10));
    waited += 10;
  }
}
