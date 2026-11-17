// Stalled-run billing reconciler (ADR-031 fast-follow).
//
// A stalled run (swept by stalled-run-reconciler) never aggregated its per-call
// tokens onto the invocation and never published invocation-completed, so its LLM
// consumption never drained to the OU boundary — the invocation-level token/price
// columns stay 0/NULL while the real per-call spend sits in llm_usage_log. Neither
// the spend-subscriber (no completion event) nor the runtime-ingester (its feed
// cursors past started_at and prices from the 0-token invocation columns) recovers
// it, and billing-queued-reconciliation cannot be relied on to be scheduled.
// This closes that gap:
// for every reconciliation_status='pending' invocation we reconstruct the true
// cost from llm_usage_log (per-model, multi-model-aware) and publish
// invocation-completed ourselves so the standard OU drain fires.
//
// Idempotency: the spend-subscriber dedups by invocation_id (billing_spend_events
// WHERE invocation_id=$1 ... ON CONFLICT DO NOTHING), so a re-published invocation
// never double-drains. We therefore publish-then-mark; a crash in between simply
// re-publishes next tick (deduped) and re-marks.
//
// Gated on STALLED_RUN_RECONCILER_ENABLED (same as the sweep). NOT gated on
// isExecutionAllowed: accounting already-incurred cost is correct even for a
// suspended tenant (suspension gates new execution, not past-cost settlement).

import { getPoolForService } from '../infrastructure/database';
import { publisher } from '../infrastructure/pubsub';
import { logger } from '../infrastructure/logging';
import { calculateCost } from '../llm/pricing';
import type { LLMProvider } from '../llm/types';

const BATCH = 500;

function isEnabled(): boolean {
  return process.env.STALLED_RUN_RECONCILER_ENABLED === '1';
}

function pool() {
  return getPoolForService('default');
}

/** One llm_usage_log row joined to its pending invocation. Deliberately NOT
 *  pre-aggregated in SQL: conditional pricing bands are evaluated per REQUEST
 *  against that request's prompt size, so a per-(provider,model) SUM would feed
 *  the threshold a number no single call ever had. See the query comment. */
interface ModelRow {
  id: string;
  agent_id: string;
  thread_id: string | null;
  triggered_by: string | null;
  trigger_ref: string | null;
  started_at: Date;
  provider: string | null;
  model: string | null;
  in_tok: string;
  out_tok: string;
  cached_tok: string;
  /** When this individual call happened — the basis for UTC-windowed rates. */
  ts: Date | null;
}

export interface StalledBillingResult {
  drained: number; // invocations whose real cost was published to the OU boundary
  costUsd: number; // total reconstructed cost drained this cycle
  cleaned: number; // pending invocations with no billable spend, settled to 'reconciled'
  unpriceable: number; // pending invocations with a model that has no pricing, marked 'unrecoverable'
}

export async function reconcileStalledBilling(tenantId: string): Promise<StalledBillingResult> {
  if (!isEnabled()) return { drained: 0, costUsd: 0, cleaned: 0, unpriceable: 0 };

  const billingEnv = process.env.ENVIRONMENT || 'dev';
  const billingProject = process.env.BILLING_PUBSUB_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
  const billingTopicName = `projects/${billingProject}/topics/invocation-completed-${billingEnv}`;

  // Step 1 — bulk-settle the (dominant) pending population that has NO billable
  // consumption: 0-token error runs (migration 105 backfill) + dispatch-gap stalls
  // that died before any successful LLM call. One statement, no drain needed.
  const cleanRes = await pool().query(
    `UPDATE invocations i SET reconciliation_status = 'reconciled'
      WHERE i.tenant_id = $1::uuid
        AND i.reconciliation_status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM llm_usage_log l
                        WHERE l.invocation_id = i.id::text
                          AND (l.input_tokens > 0 OR l.output_tokens > 0))`,
    [tenantId],
  );
  const cleaned = cleanRes.rowCount ?? 0;

  // Step 2 — the small remaining set: pending invocations WITH billable spend.
  // Fetch a batch with their INDIVIDUAL llm_usage_log rows.
  //
  // This used to SUM per (provider, model) in SQL and price the sums once. That
  // is no longer safe: conditional rate bands key off a single request's prompt
  // size, so pricing an aggregate would test the threshold against a number no
  // call ever had. A run of 100 turns at 5k tokens sums to 500k and would be
  // charged a 200k long-context band that none of its turns came close to —
  // over-charging a customer for a band we could not point at a request to
  // justify. Rows arrive raw; the loop below sums TOKENS for reporting and sums
  // COST per row.
  const { rows } = await pool().query<ModelRow>(
    `WITH batch AS (
       SELECT id, agent_id, thread_id, triggered_by, trigger_ref, started_at
         FROM invocations
        WHERE tenant_id = $1::uuid AND reconciliation_status = 'pending'
        ORDER BY completed_at ASC NULLS LAST, id
        LIMIT $2
     )
     SELECT b.id, b.agent_id, b.thread_id, b.triggered_by, b.trigger_ref, b.started_at,
            l.provider, l.model,
            COALESCE(l.input_tokens, 0)::text  AS in_tok,
            COALESCE(l.output_tokens, 0)::text AS out_tok,
            COALESCE(l.cached_tokens, 0)::text AS cached_tok,
            l.timestamp AS ts
       FROM batch b
       LEFT JOIN llm_usage_log l ON l.invocation_id = b.id::text`,
    [tenantId, BATCH],
  );

  // Group per-model rows back into invocations.
  const byInv = new Map<string, { meta: ModelRow; models: ModelRow[] }>();
  for (const r of rows) {
    let e = byInv.get(r.id);
    if (!e) {
      e = { meta: r, models: [] };
      byInv.set(r.id, e);
    }
    if (r.provider && r.model) e.models.push(r);
  }

  let drained = 0;
  let unpriceable = 0;
  let totalCost = 0;

  for (const [invId, { meta, models }] of byInv) {
    let costUsd = 0;
    let inTok = 0;
    let outTok = 0;
    let cachedTok = 0;
    let priceable = true;
    // Dominant model (by input tokens) recorded on the invocation for /insights;
    // the drained costUsd is summed across ALL models so it is exact regardless.
    let domProvider: string | null = null;
    let domModel: string | null = null;
    let domIn = -1;

    // Dominant model is decided on TOTAL input tokens per model, so accumulate
    // that separately from the per-row cost — `models` is now one entry per LLM
    // call rather than one per (provider, model).
    const inputByModel = new Map<string, { provider: string; model: string; tokens: number }>();

    for (const m of models) {
      const i = Number(m.in_tok);
      const o = Number(m.out_tok);
      const c = Number(m.cached_tok);
      inTok += i;
      outTok += o;
      cachedTok += c;

      const key = `${m.provider}:${m.model}`;
      const agg = inputByModel.get(key) ?? {
        provider: m.provider as string,
        model: m.model as string,
        tokens: 0,
      };
      agg.tokens += i;
      inputByModel.set(key, agg);

      // Priced per call, with THIS call's prompt size and timestamp — the two
      // inputs a conditional band is evaluated against. `ts` is non-null in
      // practice (the row exists because it has tokens); started_at is a safe
      // stand-in for the pathological null rather than a reason to skip pricing.
      const priced = calculateCost(
        m.model as string,
        m.provider as LLMProvider,
        i, o, c,
        { at: m.ts ?? meta.started_at },
      );
      if (!priced) {
        priceable = false;
        continue;
      }
      costUsd += priced.costUsd;
    }

    for (const agg of inputByModel.values()) {
      if (agg.tokens > domIn) {
        domIn = agg.tokens;
        domProvider = agg.provider;
        domModel = agg.model;
      }
    }

    if (!priceable) {
      // A model has no pricing configured — we cannot account the cost exactly.
      // Mark 'unrecoverable' (migration-105 semantics) rather than silently
      // under-drain; the log line surfaces the model to add to MODEL_PRICING.
      await pool().query(
        `UPDATE invocations SET reconciliation_status = 'unrecoverable' WHERE id = $1`,
        [invId],
      );
      unpriceable++;
      logger.warn(
        { tenantId, invocationId: invId, models: models.map((m) => `${m.provider}/${m.model}`) },
        'stalled-billing-reconciler: model has no pricing, marked unrecoverable',
      );
      continue;
    }

    try {
      // Publish invocation-completed → spend-subscriber → ingestEventWithBuckets
      // (OU drain). isReconciliation flags it as a replay; dedup by invocation_id
      // makes it safe if the run was somehow already drained.
      await publisher.publish(billingTopicName, {
        tenantId,
        invocationId: invId,
        agentId: meta.agent_id,
        costUsd,
        occurredAt: meta.started_at.toISOString(),
        isReconciliation: true,
        provider: domProvider ?? undefined,
        model: domModel ?? undefined,
        inputTokens: inTok,
        outputTokens: outTok,
        cachedTokens: cachedTok,
        threadId: meta.thread_id ?? null,
        triggeredBy: meta.triggered_by ?? undefined,
        triggerRef: meta.trigger_ref ?? null,
      });
      // Backfill the invocation's token columns for record/insights accuracy and
      // settle it. Done after publish so a crash re-publishes (deduped) next tick.
      await pool().query(
        `UPDATE invocations
            SET input_tokens = $2, output_tokens = $3, cached_tokens = $4,
                reconciliation_status = 'reconciled'
          WHERE id = $1`,
        [invId, inTok, outTok, cachedTok],
      );
      drained++;
      totalCost += costUsd;
    } catch (err) {
      // Leave 'pending' — retried next cycle.
      logger.warn(
        { tenantId, invocationId: invId, err: (err as Error).message },
        'stalled-billing-reconciler: publish failed, will retry next cycle',
      );
    }
  }

  if (drained || cleaned || unpriceable) {
    logger.info(
      { tenantId, drained, cleaned, unpriceable, costUsd: Number(totalCost.toFixed(6)) },
      'stalled-billing-reconciler: cycle complete',
    );
  }
  return { drained, costUsd: Number(totalCost.toFixed(6)), cleaned, unpriceable };
}
