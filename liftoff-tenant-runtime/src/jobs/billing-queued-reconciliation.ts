// Billing-queued reconciliation job
// Finds invocations stuck in billing_queued='pending' and re-publishes them
// to the invocation-completed Pub/Sub topic.
//
// Stuck invocations arise when the fire-and-forget publish in
// publishInvocationCompleted() failed silently after the agent run completed.
// Cloud Scheduler invokes it every 15 minutes via
// /api/internal/billing-queued-reconciliation (r5_scheduler_jobs.tf).
//
// The selection window is bounded at BOTH ends, and the older bound is the
// load-bearing one. Downstream, each republished event fires a Stripe meter
// event stamped with the invocation's original time, and Stripe rejects any
// meter event older than 35 calendar days. An unbounded replay therefore
// cannot bill the rows it picks up: it writes spend rows, drains the tenant's
// prepaid balance, and can trigger an auto-reload charge, while the meter
// event itself is refused and the row stays unmetered for every later backfill
// to retry forever.
//
// Anything past that horizon is not billable through the meter by any route,
// so it is closed out as 'expired' instead. That also keeps the pending count
// convergent — without it the job would report the same backlog on every run
// and the count could never be alerted on.

import { pool } from '../infrastructure/database';
import { publisher } from '../infrastructure/pubsub';
import { invocationsService } from '../invocations/service';
import { logger } from '../infrastructure/logging';
import { FRESH_INPUT_TOKENS_SQL } from '../llm/pricing';

interface PendingInvocation {
  id: string;
  tenant_id: string;
  agent_id: string;
  cost_usd: string | null;
  started_at: Date;
  provider: string | null;
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cached_input_price_per_million: string | null;
  grounding_queries: number | null;
  grounding_cost_usd: string | null;
  thread_id: string | null;
  triggered_by: string | null;
  trigger_ref: string | null;
}

/** Stripe rejects a meter event whose timestamp is older than 35 calendar days
 *  (https://docs.stripe.com/api/billing/meter-event/object, `timestamp`). This
 *  is the vendor's number, not a tuning knob — raising it does not make an
 *  older event billable, it only sends one Stripe will refuse. */
const STRIPE_METER_MAX_AGE_DAYS = 35;

/** Close out invocations the meter can no longer accept.
 *
 *  Runs on every pass and before the replay, so a backlog cannot keep the
 *  pending count pinned above zero and mask a live failure behind it. */
async function expireUnbillablePending(): Promise<number> {
  const result = await pool.query(
    `UPDATE invocations
        SET billing_queued = 'expired'
      WHERE billing_queued = 'pending'
        AND completed_at IS NOT NULL
        AND completed_at <= NOW() - ($1::int * INTERVAL '1 day')`,
    [STRIPE_METER_MAX_AGE_DAYS],
  );
  const expired = result.rowCount ?? 0;
  if (expired > 0) {
    logger.info({
      message: 'billing-queued-reconciliation: expired invocations past the meter horizon',
      expired,
      maxAgeDays: STRIPE_METER_MAX_AGE_DAYS,
    });
  }
  return expired;
}

export async function runBillingQueuedReconciliation(): Promise<void> {
  const billingEnv = process.env.ENVIRONMENT || 'dev';
  const billingProject = process.env.BILLING_PUBSUB_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
  const billingTopicName = `projects/${billingProject}/topics/invocation-completed-${billingEnv}`;

  await expireUnbillablePending();

  // Find invocations that have been pending for more than 5 minutes.
  // The 5-minute window prevents racing with in-flight publishes from
  // concurrent agent runs.
  // Provider-aware fresh-input formula — see FRESH_INPUT_TOKENS_SQL in
  // src/llm/pricing.ts. Anthropic input_tokens excludes cached; OpenAI /
  // Google include it. Bug history: pre-fix this SQL used a raw
  // (input - cached) and produced negative cost on Anthropic cache hits.
  const result = await pool.query<PendingInvocation>(
    `SELECT id, tenant_id, agent_id, started_at,
       provider, model_id, input_tokens, output_tokens, cached_tokens,
       cached_input_price_per_million, grounding_queries, grounding_cost_usd,
       thread_id, triggered_by, trigger_ref,
       -- Token cost is per-million (÷1e6); grounding_cost_usd is already in USD
       -- (per-query $0.014) so it is added OUTSIDE the division. Without it, a
       -- reconciliation retry would undercharge any grounded Gemini invocation.
       ((${FRESH_INPUT_TOKENS_SQL}::numeric * COALESCE(input_price_per_million, 0) +
         COALESCE(cached_tokens, 0)::numeric * COALESCE(cached_input_price_per_million, 0) +
         output_tokens::numeric * COALESCE(output_price_per_million, 0)) / 1000000.0
        + COALESCE(grounding_cost_usd, 0)) AS cost_usd
     FROM invocations
     WHERE billing_queued = 'pending'
       AND completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL '5 minutes'
       AND completed_at > NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY completed_at ASC
     LIMIT 500`,
    [STRIPE_METER_MAX_AGE_DAYS],
  );

  if (result.rows.length === 0) {
    logger.debug({ message: 'billing-queued-reconciliation: no pending invocations' });
    return;
  }

  logger.info({
    message: 'billing-queued-reconciliation: re-publishing pending invocations',
    count: result.rows.length,
  });

  let published = 0;
  let failed = 0;

  for (const row of result.rows) {
    const costUsd = parseFloat(row.cost_usd ?? '0');
    try {
      await publisher.publish(billingTopicName, {
        tenantId:         row.tenant_id,
        invocationId:     row.id,
        agentId:          row.agent_id,
        costUsd,
        occurredAt:       row.started_at.toISOString(),
        isReconciliation: true,
        provider:         row.provider ?? undefined,
        model:            row.model_id ?? undefined,
        inputTokens:      row.input_tokens ?? undefined,
        outputTokens:     row.output_tokens ?? undefined,
        cachedTokens:     row.cached_tokens ?? undefined,
        groundingQueries: row.grounding_queries || undefined,
        groundingCostUsd: row.grounding_cost_usd ? parseFloat(row.grounding_cost_usd) || undefined : undefined,
        threadId:         row.thread_id ?? null,
        triggeredBy:      row.triggered_by ?? undefined,
        triggerRef:       row.trigger_ref ?? null,
      });
      await invocationsService.markBillingQueued(row.id, 'published');
      published++;
    } catch (err) {
      failed++;
      logger.warn({
        message: 'billing-queued-reconciliation: failed to re-publish invocation',
        invocationId: row.id,
        tenantId: row.tenant_id,
        error: (err as Error).message,
      });
    }
  }

  logger.info({
    message: 'billing-queued-reconciliation: complete',
    published,
    failed,
    total: result.rows.length,
  });
}
