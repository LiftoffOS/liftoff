// Cost Attribution Repository
// Wraps all DB access for cost_attribution_events and related tables.
//
// RLS scope: cost_attribution_events / cost_attribution_snapshots are RLS-on
// (migration 200). Ingester writes (insertEvents) are cross-tenant batch
// operations — admin scope is correct. Tenant-scoped reads (getCostBreakdown,
// getCostByAgent) run under tenant scope. Snapshot writes use admin scope
// because they're computed from cross-tenant aggregations.

import { getPool, withAdminScope, withTenantScope } from '../infrastructure/database';
import type { Pool } from 'pg';
import { applyOuConsumption, applyOuRefund, getOuDefinitionRateUsd, type ChargeClass } from './ou-bucket-service';
import { classifyChargeability } from './event-classification';
import { applyReloadDrain, fireAutoReloadClaim, type AutoReloadClaim } from './reload-drain';
import { publishBillingSuspensionChange } from '../billing/billing-suspension-publisher';
import { fireOuMeterEventDurable } from '../billing/ou-meter-event';
// withAdminScope is the right wrapper for cross-tenant ingester writes, see
// ingestEventWithBuckets below for the rationale.

// Use the main pool for ingester operations. The cost-attribution-ingester previously
// used a separate lazy pool, but cold connections to Cloud SQL via the Auth Proxy take
// ~10s to establish — longer than any pool's connect timeout. The main pool's
// connections are kept warm by health check traffic, avoiding that cost entirely.
export function getIngesterPool(): Pool {
  return getPool();
}
import type {
  CostAttributionEvent,
  CostAttributionSnapshot,
  AttributionQuery,
  CostBreakdown,
  CostByAgent,
  EventSource,
  EventType,
} from './types';

// ── Event insertion ────────────────────────────────────────────────────

/** Insert a batch of events, skipping duplicates (source+source_id+event_type). */

/** Which pricing a cost falls under. A vendor's own charge that the platform
 *  resells unchanged — a connector's capability call, a web tool — is
 *  pass-through and carries the premium in `billing_system_settings`;
 *  inference, embeddings, the sandbox and platform infrastructure are the
 *  platform's own work and price as they always have. A keyless source costs
 *  nothing, so neither pricing charges for it. */
function chargeClassFor(eventType: EventType): ChargeClass {
  return eventType === 'connector_call' || eventType === 'web_tool' ? 'pass_through' : 'platform';
}

export async function insertEvents(events: CostAttributionEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  // Batch contains events with potentially different tenant_ids (ingesters
  // poll multiple tenants in a single run) — admin scope is the only correct
  // choice; per-event withTenantScope would open N transactions and lose
  // batch performance.
  return withAdminScope(
    {
      caller: 'cost-attribution.insertEvents',
      reason: 'cross-tenant ingester batch insert',
    },
    async (client) => {
      let inserted = 0;
      for (const e of events) {
        const result = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            e.tenantId,
            e.agentId ?? null,
            e.workflowId ?? null,
            e.actionId ?? null,
            e.threadId ?? null,
            e.invocationId ?? null,
            e.parentInvocationId ?? null,
            e.connector ?? null,
            e.entityType ?? null,
            e.actionType ?? null,
            e.purpose ?? null,
            e.eventType,
            e.source,
            e.sourceId ?? null,
            e.provider ?? null,
            e.model ?? null,
            e.inputTokens ?? null,
            e.outputTokens ?? null,
            e.cachedTokens ?? null,
            e.costUsd,
            e.hostingMode ?? null,
            e.correlationConfidence ?? null,
            e.occurredAt,
            e.ouConsumed,
            e.customerCostUsd,
            e.costBucket,
            e.usageQuantity ?? null,
            e.usageUnit ?? null,
          ],
        );
        inserted += result.rowCount ?? 0;
      }
      return inserted;
    },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves accountId for a tenantId (small tenants table; cheap query, no cache).
//
// `tenants.id` is a uuid, and the source tables the ingesters sweep hold
// tenant_id as TEXT. A value that is not a uuid — a label a verification
// wrote where an id belongs — names no tenant, and asking Postgres about it
// raises 22P02 instead of returning no row. Every ingester resolves the
// account before it advances its cursor, so one such row parked the sweep on
// itself: no cost attribution for any tenant until the row was gone.
export async function resolveAccountIdForTenant(tenantId: string): Promise<string | null> {
  if (!UUID.test(tenantId)) return null;
  const pool = getPool();
  const r = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return r.rows[0]?.account_id ?? null;
}

// Per-row helper used by every ingester after PR 1. For one source-row with a
// raw cost_usd, this is the single canonical "consume OUs for this tenant"
// boundary. Every customer-chargeable side-effect — counter increment, ledger
// rows, reload-balance drain, suspension-on-zero — happens here, atomically
// inside one admin-scope transaction.
//
// Two paths inside, picked by classifyChargeability():
//
//   • platform_overhead → Liftoff-absorbed (CAIO/HRBP planning, distillation,
//     /insights chat, gcp_billing_platform). Writes a single ledger row with
//     customer_cost_usd=0 and cost_bucket='platform_overhead' so ops can track
//     per-tenant platform spend, but does NOT touch billing_controls (no
//     counter increment, no reload drain). cost_usd is preserved for ops.
//
//   • customer → user workload. applyOuConsumption locks billing_controls
//     FOR UPDATE, dedups against the existing ledger, splits the consumption
//     across 1-3 buckets, increments ous_consumed_this_period; we then INSERT
//     one row per assignment and call applyReloadDrain to debit the wallet
//     for any reload-bucket portion. Auto-reload firing is deferred to the
//     real-time spend-subscriber path (we don't want to make a Stripe call
//     inside an ingester batch).
//
// Why withAdminScope: cost_attribution_events is RLS-on (migration 200) and
// billing_controls.account_id is not bound 1:1 to a single tenant_id (one
// account can own multiple tenants), so a per-event tenant scope wouldn't
// cover the billing_controls FOR UPDATE in applyOuConsumption. Admin scope
// matches the cross-tenant batch insert pattern used by `insertEvents` above.
export async function ingestEventWithBuckets(
  accountId: string,
  baseSourceId: string,
  rawCostUsd: number,
  template: Omit<CostAttributionEvent, 'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'>,
): Promise<number> {
  // Negative cost = refund (deep_research over-estimate true-up or FAILED
  // refund). Route through the refund branch below; only zero rawCostUsd is
  // a no-op now.
  if (rawCostUsd === 0) return 0;
  const chargeability = classifyChargeability({
    source: template.source,
    purpose: template.purpose ?? null,
    agentId: template.agentId ?? null,
    byokFunded: template.byokFunded === true,
  });

  interface TxResult {
    inserted: number;
    /** This charge took the prepaid balance below zero and suspended the
     *  account inside the transaction; published post-commit. */
    suspendedNow: boolean;
    stopReason: 'zero_prepaid_balance' | 'prepaid_floor' | null;
    /** Set only for customer-chargeable rows where a meter should fire post-commit. */
    meter: { stripeCustomerId: string; customerCostUsd: number } | null;
    /** This charge took the balance to the auto-reload threshold; fired post-commit. */
    autoReloadClaim?: AutoReloadClaim | null;
  }

  const txResult = await withAdminScope<TxResult>(
    {
      caller: 'cost-attribution.ingestEventWithBuckets',
      reason: chargeability === 'platform_overhead'
        ? 'platform-overhead ledger row (no counter, no drain, no Stripe meter)'
        : chargeability === 'byok_customer_funded'
          ? 'BYOK ledger row — the customer paid the vendor directly (no counter, no drain, no Stripe meter)'
          : 'cross-tenant ingester per-row insert + billing_controls FOR UPDATE + reload drain',
      actor: `account:${accountId}`,
    },
    async (client) => {
      // ── BYOK path ──────────────────────────────────────────────────────
      // The customer's own provider key paid for these tokens. Charging OUs
      // for them would bill them twice for the same request.
      //
      // Column conventions, and each is load-bearing:
      //   cost_usd          — the real vendor cost, NON-zero. It is what the
      //                       customer paid their provider, and it is what a
      //                       future "your keys covered $X this month" line is
      //                       computed from.
      //   ou_consumed       — 0. No bucket is drained, so deriving a notional
      //                       OU figure here would be a number with no debit
      //                       behind it. Matches the strict-vendor web-tool row.
      //   customer_cost_usd — 0. Liftoff billed nothing for this call.
      //   cost_bucket       — 'byok_customer_funded' (migration 412).
      //
      // Token counts are written exactly as they are for a managed call. That
      // is not a nicety: zero-rating is only auditable if the row says what was
      // zero-rated, the product still has to report usage, and a mid-run
      // fallback to the managed key has to be distinguishable from this.
      //
      // Any platform fee stays a separate, explicit OU line elsewhere. It must
      // not be smuggled in here as a discounted token rate, or the ledger stops
      // meaning one thing.
      if (chargeability === 'byok_customer_funded') {
        // Cross-ledger dedup, for the same reason the customer path has one and
        // by the same rule. spend-subscriber books a BYOK invocation in real
        // time and runtime-ingester's poll backstops the same invocation
        // minutes later; the partial unique index below cannot catch that pair,
        // because the two paths carry DIFFERENT occurred_at values (the
        // publisher's completion time vs the feed's startedAt) and the index is
        // on (source, source_id, event_type, occurred_at). Without this the run
        // gets two ledger rows, and every token count and vendor-cost figure
        // for it doubles.
        const already = await client.query(
          `SELECT 1
             FROM cost_attribution_events
            WHERE tenant_id = $1
              AND source = $2
              AND event_type = $3
              AND (source_id = $4 OR source_id LIKE $4 || '/%')
            LIMIT 1`,
          [template.tenantId, template.source, template.eventType, baseSourceId],
        );
        if ((already.rowCount ?? 0) > 0) return { inserted: 0, suspendedNow: false, stopReason: null, meter: null };

        const r = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket, item_id,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            template.tenantId,
            template.agentId ?? null,
            template.workflowId ?? null,
            template.actionId ?? null,
            template.threadId ?? null,
            template.invocationId ?? null,
            template.parentInvocationId ?? null,
            template.connector ?? null,
            template.entityType ?? null,
            template.actionType ?? null,
            template.purpose ?? null,
            template.eventType,
            template.source,
            baseSourceId,
            template.provider ?? null,
            template.model ?? null,
            template.inputTokens ?? null,
            template.outputTokens ?? null,
            template.cachedTokens ?? null,
            rawCostUsd,
            template.hostingMode ?? null,
            template.correlationConfidence ?? null,
            template.occurredAt,
            0,
            0,
            'byok_customer_funded',
            template.itemId ?? null,
            template.usageQuantity ?? null,
            template.usageUnit ?? null,
          ],
        );
        return { inserted: r.rowCount ?? 0, suspendedNow: false, stopReason: null, meter: null };
      }

      // ── Platform-overhead path ─────────────────────────────────────────
      if (chargeability === 'platform_overhead') {
        // ou_consumed is still derived (cost_usd / definition_rate) so ops
        // dashboards can show per-tenant platform load in OU units. The
        // customer-facing fields are zeroed.
        const definitionRate = await getOuDefinitionRateUsd(client);
        const ouConsumed = rawCostUsd / definitionRate;
        const r = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket, item_id,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            template.tenantId,
            template.agentId ?? null,
            template.workflowId ?? null,
            template.actionId ?? null,
            template.threadId ?? null,
            template.invocationId ?? null,
            template.parentInvocationId ?? null,
            template.connector ?? null,
            template.entityType ?? null,
            template.actionType ?? null,
            template.purpose ?? null,
            template.eventType,
            template.source,
            baseSourceId,
            template.provider ?? null,
            template.model ?? null,
            template.inputTokens ?? null,
            template.outputTokens ?? null,
            template.cachedTokens ?? null,
            rawCostUsd,
            template.hostingMode ?? null,
            template.correlationConfidence ?? null,
            template.occurredAt,
            ouConsumed,
            0,
            'platform_overhead',
            template.itemId ?? null,
            template.usageQuantity ?? null,
            template.usageUnit ?? null,
          ],
        );
        return { inserted: r.rowCount ?? 0, suspendedNow: false, stopReason: null, meter: null };
      }

      // ── What counts as "already billed" for one invocation ───────────
      // Three source_id shapes name the same invocation, and the dedup below
      // has to recognise all three or a backstop bills a run twice:
      //
      //   <id>                    the invocation's own event
      //   <id>/included|/reload   the bucket split of ONE event
      //   <id>:resume:<pauseId>   the continuation of a run that paused
      //
      // The `:resume:` sibling is the load-bearing one. A run that pauses for a
      // person never completes and never publishes: `completeInvocation` is
      // called only by the two fresh finalizers and the resumed one, never by a
      // pause. The paused half's spend is carried into the continuation's steps
      // and billed by the continuation's event, which therefore covers the WHOLE
      // run. The invocation row then holds those same tokens.
      //
      // So when runtime-ingester sweeps the feed as a backstop for invocations
      // that published nothing, it finds that row and prices it — and without
      // the `:resume:` arm it cannot see that the continuation already paid for
      // it. That is not a near-miss: the sweep bills the full run a second time,
      // on top of a correct event, and the two rows are indistinguishable from
      // legitimate ones afterwards.
      //
      // `:` rather than `/` is deliberate on the runtime's side — a `/` sibling
      // would make a late redelivery of the paused half's own event read as a
      // duplicate of the continuation — so matching on `/` alone can never be
      // enough. Do not narrow this predicate to one shape.
      //
      // ── D2.4 Refund path ─────────────────────────────────────────────
      // Negative rawCostUsd. Only emitted today by deep_research delta
      // events (over-estimate true-up) and PB-4's cleanup cron (FAILED
      // refunds). Route through applyOuRefund which decrements the
      // counter and is internally dedup-safe via the isDuplicate callback
      // pattern that mirrors applyOuConsumption.
      //
      // Per D2.4 we collapse to cost_bucket='reload' regardless of the
      // original consumption's bucket distribution. Reversing bucket-by-
      // bucket would require querying the matching positive sibling rows
      // and prorating — significant complexity for sub-dollar refunds.
      if (rawCostUsd < 0) {
        const refund = await applyOuRefund(client, accountId, Math.abs(rawCostUsd), {
          isDuplicate: async (c) => {
            const r = await c.query(
              `SELECT 1 FROM cost_attribution_events
                WHERE source = $1 AND event_type = $2
                  AND (source_id = $3 OR source_id LIKE $3 || '/%')
                LIMIT 1`,
              [template.source, template.eventType, baseSourceId],
            );
            return (r.rowCount ?? 0) > 0;
          },
        });
        if (!refund) return { inserted: 0, suspendedNow: false, stopReason: null, meter: null };

        // Single ledger row, reload bucket, negative cost_usd. Mirrors
        // the column list of the platform_overhead INSERT above so
        // downstream readers (snapshot aggregator, monitor) see a
        // consistent shape.
        const r = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket, item_id,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            template.tenantId,
            template.agentId ?? null,
            template.workflowId ?? null,
            template.actionId ?? null,
            template.threadId ?? null,
            template.invocationId ?? null,
            template.parentInvocationId ?? null,
            template.connector ?? null,
            template.entityType ?? null,
            template.actionType ?? null,
            template.purpose ?? null,
            template.eventType,
            template.source,
            baseSourceId,                  // no bucket suffix for refunds
            template.provider ?? null,
            template.model ?? null,
            template.inputTokens ?? null,
            template.outputTokens ?? null,
            template.cachedTokens ?? null,
            rawCostUsd,                    // negative
            template.hostingMode ?? null,
            template.correlationConfidence ?? null,
            template.occurredAt,
            -refund.ouRefunded,            // negative OU
            -refund.customerCreditUsd,     // negative customer cost
            'reload' as const,
            template.itemId ?? null,
            template.usageQuantity ?? null,
            template.usageUnit ?? null,
          ],
        );
        return { inserted: r.rowCount ?? 0, suspendedNow: false, stopReason: null, meter: null };
      }

      // ── x402 wallet-funded path ──────────────────────────────────────
      // The platform's x402 wallet paid the VENDOR (a per-call USDC
      // micropayment — gloria premium and the other x402 vendors), and the
      // customer IS charged for the call: applyOuConsumption runs exactly as
      // on the plain customer path below (counter increment, bucket split,
      // reload drain), so the correct number of Operating Units drains.
      //
      // What differs is the LEDGER ROW: one row per call, carrying the
      // assignment totals, with cost_bucket='x402_wallet_funded' (migration
      // 440) — the bucket records that the platform wallet funded the vendor
      // side, which is what the on-chain reconciliation sums
      // (the raw-cost total over cost_bucket='x402_wallet_funded' vs settled
      // USDC), and usage_quantity=1 / usage_unit='call' counts the calls a
      // per-call vendor invoices.
      //
      // Checked BEFORE the strict web-tool bypass on purpose: 'browserbase'
      // is on that vendor list for its BYOK web-tool lane, and a future
      // browserbase x402 CONNECTOR row must not fall into the $0 'unknown'
      // bypass just because the names collide.
      if (template.x402Funded === true) {
        // The Stripe OU meter fires from HERE for x402 rows, unlike the
        // other source='tenant_runtime' shapes below. Their exclusion exists
        // because a real-time subscriber already meters the same event and
        // firing twice double-reports; x402 connector calls have NO
        // real-time sibling — this poll is their only ingestion — so
        // skipping would leave every x402 charge off the meter entirely.
        // Replays stay safe twice over: applyOuConsumption's isDuplicate
        // returns before this fires again, and Stripe dedups on the
        // identifier. billing_exempt nulls the customer id and nothing else
        // (INV-PB-011): an exempt account still meters buckets, drains and
        // ledgers — only the Stripe event is suppressed.
        const ctrl = (await client.query<{ stripe_customer_id: string | null; billing_exempt: boolean }>(
          `SELECT stripe_customer_id, billing_exempt FROM billing_controls WHERE account_id = $1`,
          [accountId],
        )).rows[0] ?? null;
        const x402StripeCustomerId = ctrl?.billing_exempt ? null : ctrl?.stripe_customer_id ?? null;

        const assignments = await applyOuConsumption(client, accountId, rawCostUsd, {
          chargeClass: chargeClassFor(template.eventType),
          isDuplicate: async (c) => {
            const r = await c.query(
              `SELECT 1 FROM cost_attribution_events
                WHERE source = $1 AND event_type = $2
                  AND (source_id = $3
                       OR source_id LIKE $3 || '/%'
                       OR source_id LIKE $3 || ':resume:%')
                LIMIT 1`,
              [template.source, template.eventType, baseSourceId],
            );
            return (r.rowCount ?? 0) > 0;
          },
        });
        if (assignments.length === 0) return { inserted: 0, suspendedNow: false, stopReason: null, meter: null };
        const ouConsumed = assignments.reduce((sum, a) => sum + a.ouConsumed, 0);
        const customerCostUsd = assignments.reduce((sum, a) => sum + a.customerCostUsd, 0);
        const r = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket, item_id,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            template.tenantId,
            template.agentId ?? null,
            template.workflowId ?? null,
            template.actionId ?? null,
            template.threadId ?? null,
            template.invocationId ?? null,
            template.parentInvocationId ?? null,
            template.connector ?? null,
            template.entityType ?? null,
            template.actionType ?? null,
            template.purpose ?? null,
            template.eventType,
            template.source,
            baseSourceId,
            template.provider ?? null,
            template.model ?? null,
            template.inputTokens ?? null,
            template.outputTokens ?? null,
            template.cachedTokens ?? null,
            rawCostUsd,
            template.hostingMode ?? null,
            template.correlationConfidence ?? null,
            template.occurredAt,
            ouConsumed,
            customerCostUsd,
            'x402_wallet_funded',
            template.itemId ?? null,
            template.usageQuantity ?? null,
            template.usageUnit ?? null,
          ],
        );
        // Drain reload_balance_usd in the same tx as the counter increment,
        // as the customer path below does.
        const drain = await applyReloadDrain(client, accountId, assignments, { fireAutoReload: true });
        const inserted = r.rowCount ?? 0;
        return {
          inserted,
          suspendedNow: drain?.suspendedNow === true,
          stopReason: drain?.stopReason ?? null,
          autoReloadClaim: drain?.autoReloadClaim ?? null,
          meter:
            inserted > 0 && x402StripeCustomerId && customerCostUsd > 0
              ? { stripeCustomerId: x402StripeCustomerId, customerCostUsd }
              : null,
        };
      }

      // ── Strict-vendor web-tool bypass (Phase 6) ──────────────────────
      // For the BYOK web-tool vendors (firecrawl, anchor, browserbase,
      // tavily, exa, webclaw), the tenant paid the vendor directly via their
      // connected connector. Record the row for tenant analytics, but never
      // charge OUs.
      //
      // The bypass is a property of the FUNDING, not of the vendor. It reads
      // as a vendor list only because six of the eight can be funded exactly
      // one way. steel and browser_use are the other two: the platform holds
      // a key of its own for each, so a workspace that connected nothing
      // browses on OUR account and owes us for the hours, while a workspace
      // on its own key owes us nothing. Same vendor, same table, opposite
      // charge.
      //
      // Convention on this row's numeric columns:
      //   cost_usd          — vendor-reported cost in USD (what the tenant
      //                       actually paid the vendor). NON-zero for these
      //                       rows so per-tenant analytics ("how much did
      //                       this team spend on Firecrawl?") work.
      //   ou_consumed       — always 0. BYOK calls don't drain OU buckets.
      //   customer_cost_usd — always 0. Liftoff didn't bill the customer
      //                       anything for this call.
      //   cost_bucket       — 'unknown'. Bucket assignment is meaningless
      //                       for non-OU charges; the DB CHECK constraint
      //                       in migration 209 allows this literal.
      //
      // Downstream readers (snapshot aggregator, /insights, vendor-spend
      // monitor) MUST filter on cost_bucket NOT IN ('unknown',
      // 'platform_overhead') when computing customer-billed totals, or
      // they double-count.
      const STRICT_WEBTOOL_VENDORS = new Set([
        'firecrawl', 'anchor', 'browserbase', 'tavily', 'exa', 'webclaw',
        'steel', 'browser_use',
      ]);
      // The vendors the PLATFORM also holds a key for. For everything else on
      // the list above, "the tenant paid the vendor" is the only way the call
      // could have happened, so no funding field can change the answer — and
      // that matters: a stray or mistaken 'platform' on a firecrawl row must
      // not start charging a workspace for a call its own key made.
      //
      // Tavily and Exa are included because the platform's keys for both are
      // pay-as-you-go, and the runtime reads and researches on them for a
      // team bound to neither, reporting funding 'platform' on those rows.
      const PLATFORM_FUNDABLE_WEBTOOL_VENDORS = new Set(['steel', 'browser_use', 'tavily', 'exa']);
      // Which funding this row had, and therefore whether the bypass applies.
      //
      // The two ways to get this wrong are both silent and both expensive:
      // bypass unconditionally and we give away every browser hour the platform
      // key paid for; drop the vendor outright and every workspace running on
      // its OWN Steel or Browser Use key is charged a second time for hours it
      // already paid the vendor directly.
      //
      // Absent funding means tenant-funded. That is the honest default for two
      // reasons: it is what every other strict vendor on this list is, and it
      // is what a browser_use row WAS before the platform took a key — so an
      // event still in flight from an older runtime keeps the behaviour it was
      // published under. It also errs the safe way, since not charging is our
      // loss and charging twice is the customer's.
      const platformFundedWebTool =
        !!template.connector
        && PLATFORM_FUNDABLE_WEBTOOL_VENDORS.has(template.connector)
        && template.webToolFunding === 'platform';
      const webToolBypass =
        !!template.connector
        && STRICT_WEBTOOL_VENDORS.has(template.connector)
        && !platformFundedWebTool;
      if (webToolBypass) {
        const r = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket, item_id,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            template.tenantId,
            template.agentId ?? null,
            template.workflowId ?? null,
            template.actionId ?? null,
            template.threadId ?? null,
            template.invocationId ?? null,
            template.parentInvocationId ?? null,
            template.connector,
            template.entityType ?? null,
            template.actionType ?? null,
            template.purpose ?? null,
            template.eventType,
            template.source,
            baseSourceId,
            template.provider ?? null,
            template.model ?? null,
            template.inputTokens ?? null,
            template.outputTokens ?? null,
            template.cachedTokens ?? null,
            rawCostUsd,
            template.hostingMode ?? null,
            template.correlationConfidence ?? null,
            template.occurredAt,
            0,           // ou_consumed
            0,           // customer_cost_usd
            'unknown',   // cost_bucket — strict-vendor rows never assigned a bucket
            template.itemId ?? null,
            template.usageQuantity ?? null,
            template.usageUnit ?? null,
          ],
        );
        return { inserted: r.rowCount ?? 0, suspendedNow: false, stopReason: null, meter: null };
      }

      // ── Customer-chargeable path ───────────────────────────────────────
      // Pass dedup callback so applyOuConsumption skips the counter increment if
      // the source event was already ingested (e.g. ingester replay after restart).
      // Match `${baseSourceId}` (single-bucket) and `${baseSourceId}/included`,
      // `/precommit`, `/reload` (multi-bucket sibling rows).
      //
      // For source='tenant_runtime' we ALSO check billing_spend_events because
      // spend-subscriber (the real-time path) writes that ledger inside its tx
      // and writes cost_attribution_events post-commit. In the millisecond
      // window between those, runtime-ingester's poll could see an event that
      // spend-subscriber already counted but hasn't ledgered to
      // cost_attribution_events yet. See spend-subscriber for the symmetric
      // check on the real-time side.
      const isTenantRuntime = template.source === 'tenant_runtime';

      // Resolve stripe_customer_id while we're already inside the admin tx, so
      // we can fire the Stripe meter event post-commit. tenant_runtime is
      // excluded: spend-subscriber fires that meter on the real-time path. If
      // spend-subscriber missed an invocation and runtime-ingester catches up
      // via this function, the dedup branch above (billing_spend_events check)
      // returns inserted=0 long before we'd reach here — so no meter is fired
      // and no double-charge occurs.
      //
      // `billing_exempt` nulls the customer id for the meter's purposes and
      // nothing else. This is the seam every non-LLM cost source funnels
      // through — Composio, web tools (the web-tool spend subscriber delegates
      // straight here), governance, embeddings — so gating it here is what
      // makes the exemption hold across all of them. Buckets still drain, the
      // ledger rows still write, the spend counter still moves: only the Stripe
      // invoice line never appears.
      const ctrlForMeter = isTenantRuntime
        ? null
        : (await client.query<{ stripe_customer_id: string | null; billing_exempt: boolean }>(
            `SELECT stripe_customer_id, billing_exempt FROM billing_controls WHERE account_id = $1`,
            [accountId],
          )).rows[0] ?? null;
      const stripeCustomerId = ctrlForMeter?.billing_exempt
        ? null
        : ctrlForMeter?.stripe_customer_id ?? null;

      // THE `:resume:` ARM IS LOAD-BEARING IN BOTH LEDGERS. A run that pauses
      // for a person never completes and never publishes under its own id —
      // `completeInvocation` is called by the two fresh finalizers and the
      // resumed one, never by a pause. The paused half's spend is carried into
      // the continuation's steps and billed by the continuation's event, under
      // `<id>:resume:<pauseId>`, which therefore covers the WHOLE run; the
      // invocation row ends up holding those same tokens.
      //
      // runtime-ingester then sweeps the feed as a backstop for invocations
      // that published nothing, finds that row and prices it. Without this arm
      // neither EXISTS can see that the continuation already paid, and the
      // sweep bills the full run a second time on top of a correct event.
      // `billing_spend_events` is the half that actually caught it: for a
      // paused run it holds ONLY the `:resume:` id.
      //
      // `:` rather than `/` is the runtime's own choice — `/` is the bucket
      // split of ONE event, and a `/` sibling would make a late redelivery of
      // one half read as a duplicate of the other — so matching `/` alone can
      // never be enough. Do not narrow either predicate to one shape.
      const assignments = await applyOuConsumption(client, accountId, rawCostUsd, {
        chargeClass: chargeClassFor(template.eventType),
        isDuplicate: async (c) => {
          const r = await c.query(
            isTenantRuntime
              ? `SELECT 1
                   WHERE EXISTS (
                     SELECT 1 FROM cost_attribution_events
                      WHERE source = $1 AND event_type = $2
                        AND (source_id = $3
                             OR source_id LIKE $3 || '/%'
                             OR source_id LIKE $3 || ':resume:%')
                   )
                      OR EXISTS (
                     SELECT 1 FROM billing_spend_events
                      WHERE invocation_id = $3
                         OR invocation_id LIKE $3 || '/%'
                         OR invocation_id LIKE $3 || ':resume:%'
                   )
                  LIMIT 1`
              : `SELECT 1 FROM cost_attribution_events
                  WHERE source = $1 AND event_type = $2
                    AND (source_id = $3
                         OR source_id LIKE $3 || '/%'
                         OR source_id LIKE $3 || ':resume:%')
                  LIMIT 1`,
            [template.source, template.eventType, baseSourceId],
          );
          return (r.rowCount ?? 0) > 0;
        },
      });
      if (assignments.length === 0) return { inserted: 0, suspendedNow: false, stopReason: null, meter: null };
      let inserted = 0;
      // An event that crosses a bucket boundary becomes 2-3 rows, each carrying
      // its own prorated slice of cost_usd. usage_quantity has to be sliced the
      // SAME way: writing the whole quantity on every row would make
      // SUM(usage_quantity) over-report by the number of rows, which is exactly
      // the number reconciliation against a vendor invoice depends on.
      const totalAssignedCostUsd = assignments.reduce((sum, a) => sum + a.costUsd, 0);
      for (const a of assignments) {
        const quantityShare = template.usageQuantity == null
          ? null
          : totalAssignedCostUsd === 0
            // Zero-cost rows cannot be split by cost. Single bucket keeps the
            // whole quantity; a split with no cost to apportion by puts it on
            // one row rather than duplicating it.
            ? (a === assignments[0] ? template.usageQuantity : 0)
            : template.usageQuantity * (a.costUsd / totalAssignedCostUsd);
        const r = await client.query(
          `INSERT INTO cost_attribution_events
             (tenant_id, agent_id, workflow_id, action_id, thread_id, invocation_id,
              parent_invocation_id, connector, entity_type, action_type, purpose,
              event_type, source, source_id, provider, model,
              input_tokens, output_tokens, cached_tokens, cost_usd,
              hosting_mode, correlation_confidence, occurred_at,
              ou_consumed, customer_cost_usd, cost_bucket, item_id,
              usage_quantity, usage_unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           ON CONFLICT (source, source_id, event_type, occurred_at) WHERE source_id IS NOT NULL
           DO NOTHING`,
          [
            template.tenantId,
            template.agentId ?? null,
            template.workflowId ?? null,
            template.actionId ?? null,
            template.threadId ?? null,
            template.invocationId ?? null,
            template.parentInvocationId ?? null,
            template.connector ?? null,
            template.entityType ?? null,
            template.actionType ?? null,
            template.purpose ?? null,
            template.eventType,
            template.source,
            `${baseSourceId}${a.sourceIdSuffix}`,
            template.provider ?? null,
            template.model ?? null,
            template.inputTokens ?? null,
            template.outputTokens ?? null,
            template.cachedTokens ?? null,
            a.costUsd,
            template.hostingMode ?? null,
            template.correlationConfidence ?? null,
            template.occurredAt,
            a.ouConsumed,
            a.customerCostUsd,
            a.costBucket,
            template.itemId ?? null,
            quantityShare,
            template.usageUnit ?? null,
          ],
        );
        inserted += r.rowCount ?? 0;
      }
      // Drain reload_balance_usd in the same tx as the counter increment that
      // produced the reload portion. A reload it claims fires post-commit
      // (see reload-drain.ts header).
      const drain = await applyReloadDrain(client, accountId, assignments, { fireAutoReload: true });

      // Compute the per-customer billable cost (sum of bucket assignments'
      // customerCostUsd — included-bucket usage is $0 here because the
      // customer has already paid for it via subscription). The actual Stripe
      // meter fire happens POST-COMMIT below, so we only return the inputs.
      const customerCostUsd =
        inserted > 0 ? assignments.reduce((sum, a) => sum + a.customerCostUsd, 0) : 0;

      return {
        inserted,
        suspendedNow: drain?.suspendedNow === true,
        stopReason: drain?.stopReason ?? null,
        autoReloadClaim: drain?.autoReloadClaim ?? null,
        meter:
          stripeCustomerId && customerCostUsd > 0
            ? { stripeCustomerId, customerCostUsd }
            : null,
      };
    },
  );

  // ── Post-commit: the account just ran out ────────────────────────────
  // This charge took the prepaid balance below zero and suspended the
  // account inside the transaction above. Every tenant under it hears now,
  // not on the runtime's next refresh: a minute of refusals-that-were-not is
  // a minute of spend on a balance already gone.
  if (txResult.suspendedNow) {
    void publishBillingSuspensionChange(accountId, 'suspended', txResult.stopReason ?? 'zero_prepaid_balance');
  }

  // ── Post-commit: the balance reached the auto-reload threshold ───────
  if (txResult.autoReloadClaim) {
    fireAutoReloadClaim(txResult.autoReloadClaim, accountId, template.tenantId, 'cost_attribution.ingest');
  }

  // ── Post-commit Stripe meter fire ────────────────────────────────────
  // Fire-and-forget — the helper logs but does not throw. Stripe enforces
  // idempotency on `identifier` so retries (or ingester replays) are safe.
  // This closes the gap where Composio (and any future non-LLM cost source)
  // would drain OUs without ever appearing on the customer's Stripe invoice.
  // Durable variant: this path has no stripe_metered_at/backfill recovery,
  // so a failed fire is persisted to ou_meter_event_retries for the hourly
  // drain instead of being lost.
  if (txResult.meter) {
    void fireOuMeterEventDurable({
      stripeCustomerId: txResult.meter.stripeCustomerId,
      costUsd: txResult.meter.customerCostUsd,
      identifier: baseSourceId,
      occurredAt: template.occurredAt,
    });
  }

  return txResult.inserted;
}

// ── Cursor management ─────────────────────────────────────────────────

export async function getCursor(source: EventSource): Promise<{ lastTs: Date | null; lastId: string | null }> {
  const pool = getIngesterPool();
  const result = await pool.query(
    `SELECT last_ts, last_id FROM cost_attribution_cursors WHERE source = $1`,
    [source],
  );
  if (result.rows.length === 0) return { lastTs: null, lastId: null };
  return { lastTs: result.rows[0].last_ts as Date | null, lastId: result.rows[0].last_id as string | null };
}

export async function updateCursor(source: EventSource, lastTs: Date, lastId?: string): Promise<void> {
  const pool = getIngesterPool();
  await pool.query(
    `INSERT INTO cost_attribution_cursors (source, last_ts, last_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (source) DO UPDATE SET
       last_ts    = EXCLUDED.last_ts,
       last_id    = EXCLUDED.last_id,
       updated_at = NOW()`,
    [source, lastTs, lastId ?? null],
  );
}

// ── Query API ─────────────────────────────────────────────────────────

export async function getCostBreakdown(query: AttributionQuery): Promise<CostBreakdown> {
  const since  = query.since  ?? new Date(0);
  const until  = query.until  ?? new Date();

  const params: unknown[] = [query.tenantId, since, until];
  const agentFilter   = query.agentId   ? ` AND agent_id = $${params.push(query.agentId)}` : '';
  const workflowFilter = query.workflowId ? ` AND workflow_id = $${params.push(query.workflowId)}` : '';

  const result = await withTenantScope(query.tenantId, (client) =>
    client.query(
    // platform_overhead rows are Liftoff-absorbed (CAIO planning, distillation,
    // /insights chat, etc.) and never charged to the customer; they're already
    // customer_cost_usd=0 but we filter explicitly so a future column rename
    // doesn't accidentally surface them in the wrong direction.
    `SELECT
       COALESCE(SUM(customer_cost_usd), 0)                                                  AS total_cost_usd,
       COALESCE(SUM(CASE WHEN event_type = 'llm_invocation'  THEN customer_cost_usd END), 0) AS llm_cost_usd,
       COALESCE(SUM(CASE WHEN event_type = 'connector_call'  THEN customer_cost_usd END), 0) AS connector_cost_usd,
       COALESCE(SUM(CASE WHEN event_type = 'infra_compute'   THEN customer_cost_usd END), 0) AS infra_cost_usd,
       COALESCE(SUM(CASE WHEN event_type = 'developer_proxy_llm' THEN customer_cost_usd END), 0) AS developer_proxy_cost_usd,
       COALESCE(SUM(input_tokens), 0)                                               AS total_input_tokens,
       COALESCE(SUM(output_tokens), 0)                                              AS total_output_tokens,
       COUNT(CASE WHEN event_type = 'llm_invocation' THEN 1 END)                   AS total_invocations
     FROM cost_attribution_events
     WHERE tenant_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND cost_bucket <> 'platform_overhead'
       ${agentFilter}${workflowFilter}`,
    params,
    ),
  );

  const row = result.rows[0];
  return {
    totalCostUsd:      parseFloat(row.total_cost_usd),
    llmCostUsd:        parseFloat(row.llm_cost_usd),
    connectorCostUsd:  parseFloat(row.connector_cost_usd),
    infraCostUsd:      parseFloat(row.infra_cost_usd),
    developerProxyCostUsd: parseFloat(row.developer_proxy_cost_usd),
    totalInputTokens:  parseInt(row.total_input_tokens),
    totalOutputTokens: parseInt(row.total_output_tokens),
    totalInvocations:  parseInt(row.total_invocations),
  };
}

export async function getCostByAgent(
  tenantId: string,
  since: Date,
  until: Date,
): Promise<CostByAgent[]> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<{
      agent_id: string;
      customer_cost_usd: string;
      llm_customer_cost_usd: string;
      connector_customer_cost_usd: string;
      total_input_tokens: string;
      total_output_tokens: string;
      invocation_count: string;
    }>(
      // Excludes platform_overhead so the per-agent customer-cost view doesn't
      // include distill/capability_analysis (Liftoff-absorbed agent-creation
      // facilitation that happens to carry an agent_id).
      `SELECT
         agent_id,
         COALESCE(SUM(customer_cost_usd), 0) AS customer_cost_usd,
         COALESCE(SUM(CASE WHEN event_type = 'llm_invocation' THEN customer_cost_usd END), 0) AS llm_customer_cost_usd,
         COALESCE(SUM(CASE WHEN event_type = 'connector_call' THEN customer_cost_usd END), 0) AS connector_customer_cost_usd,
         COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COUNT(CASE WHEN event_type = 'llm_invocation' THEN 1 END) AS invocation_count
       FROM cost_attribution_events
       WHERE tenant_id = $1
         AND occurred_at >= $2
         AND occurred_at < $3
         AND agent_id IS NOT NULL
         AND cost_bucket <> 'platform_overhead'
       GROUP BY agent_id
       ORDER BY SUM(customer_cost_usd) DESC`,
      [tenantId, since, until],
    );
    return rows.map(r => ({
      agentId:          r.agent_id,
      totalCostUsd:     parseFloat(r.customer_cost_usd),         // now bucket-rated
      llmCostUsd:       parseFloat(r.llm_customer_cost_usd),
      connectorCostUsd: parseFloat(r.connector_customer_cost_usd),
      totalInputTokens: Number(r.total_input_tokens),
      totalOutputTokens: Number(r.total_output_tokens),
      invocationCount:  Number(r.invocation_count),
    }));
  });
}

// ── Snapshot upsert ───────────────────────────────────────────────────

export async function upsertSnapshot(snapshot: CostAttributionSnapshot): Promise<void> {
  // Two different conflict targets because PostgreSQL partial unique indexes
  // require the ON CONFLICT predicate to match the index's WHERE clause exactly.
  // Migration 134 replaced the broken 4-column UNIQUE with two partial indexes:
  //   idx_cas_agent_period_uniq   — WHERE agent_id IS NOT NULL
  //   idx_cas_noagent_period_uniq — WHERE agent_id IS NULL
  const values = [
    snapshot.tenantId,
    snapshot.agentId ?? null,
    snapshot.workflowId ?? null,
    snapshot.periodStart,
    snapshot.periodEnd,
    snapshot.granularity,
    snapshot.totalCostUsd,
    snapshot.llmCostUsd,
    snapshot.connectorCostUsd,
    snapshot.infraCostUsd,
    snapshot.totalInvocations,
    snapshot.totalActions,
    snapshot.totalInputTokens,
    snapshot.totalOutputTokens,
  ];
  const updateClause = `
       total_cost_usd      = EXCLUDED.total_cost_usd,
       llm_cost_usd        = EXCLUDED.llm_cost_usd,
       connector_cost_usd  = EXCLUDED.connector_cost_usd,
       infra_cost_usd      = EXCLUDED.infra_cost_usd,
       total_invocations   = EXCLUDED.total_invocations,
       total_actions       = EXCLUDED.total_actions,
       total_input_tokens  = EXCLUDED.total_input_tokens,
       total_output_tokens = EXCLUDED.total_output_tokens,
       computed_at         = NOW()`;
  const insertCols = `(tenant_id, agent_id, workflow_id, period_start, period_end, granularity,
        total_cost_usd, llm_cost_usd, connector_cost_usd, infra_cost_usd,
        total_invocations, total_actions, total_input_tokens, total_output_tokens,
        computed_at)`;
  const insertVals = `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`;

  // cost_attribution_snapshots is RLS-on (migration 200). The snapshot
  // service computes per-tenant aggregates and writes them with the same
  // tenant_id — tenant scope is correct.
  await withTenantScope(snapshot.tenantId, async (client) => {
    if (snapshot.agentId != null) {
      await client.query(
        `INSERT INTO cost_attribution_snapshots ${insertCols}
         ${insertVals}
         ON CONFLICT (tenant_id, agent_id, period_start, granularity)
           WHERE agent_id IS NOT NULL
           DO UPDATE SET ${updateClause}`,
        values,
      );
    } else {
      await client.query(
        `INSERT INTO cost_attribution_snapshots ${insertCols}
         ${insertVals}
         ON CONFLICT (tenant_id, period_start, granularity)
           WHERE agent_id IS NULL
           DO UPDATE SET ${updateClause}`,
        values,
      );
    }
  });
}
