// Daily ledger-vs-Stripe reconciliation for the `operating_unit_consumed` meter.
//
// WHY THIS EXISTS. Our side of OU metering is complete; Stripe's side needs
// checking too. Without it, a gap — whole days with zero billing_spend_events
// rows — can go unnoticed for months, because nothing compares what we
// recorded against what Stripe received.
//
// WHAT THIS COMPARES: quantity sent vs quantity received. NOT money. The OU
// meter is telemetry — its price is $0.00 because every OU bucket is prepaid
// (base fee covers included + precommit; reload drains the customer's wallet),
// so a dollar comparison would be meaningless. Transport integrity is the
// thing worth alarming on.
//
// A NOTE ON THE LEDGER SIDE. The two senders pass different bases, and this
// module deliberately mirrors that rather than inventing a third:
//   - spend-subscriber.ts (LLM real-time)  → data.costUsd        (raw)
//   - cost-attribution/repository.ts       → customerCostUsd     (bucket-rated)
// Summing each path with the expression its own sender uses is what makes
// "expected" match "actual" when nothing is wrong. If the two are ever
// unified, change BOTH the sender and the matching arm below together — a
// reconciler that encodes a basis the senders do not use reports permanent
// false drift, which is worse than no reconciler at all.

import Stripe from 'stripe';
import { withAdminScope, getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { OU_METER_EVENT_NAME } from './ou-meter-event';

// Sub-cent. The senders serialize at 6 decimals (costUsd.toFixed(6)) and Stripe
// aggregates in floating point, so an exact equality check would flag noise.
// Anything at or below this is arithmetic dust; anything above it is a missing
// or duplicated event.
const TOLERANCE_USD = 0.005;

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) _stripe = new Stripe(await getStripeSecretKey());
  return _stripe;
}

export function _resetStripeForTesting(): void { _stripe = null; }

/** Yesterday's UTC day, [start, end). */
export function lastCompleteUtcDay(now: Date): { start: Date; end: Date; day: string } {
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  return { start, end, day: start.toISOString().slice(0, 10) };
}

interface LedgerRow {
  account_id:        string;
  stripe_customer_id: string | null;
  billing_exempt:    boolean;
  ledger_value:      string;
}

/**
 * Accounts with metered-path consumption in the window, with the value each
 * sender actually passed.
 *
 * Population is driven by CONSUMPTION, not by Stripe and not by
 * subscription_items. The old ou-report joined `subscription_items WHERE
 * item_type='ou_usage'`, which is exactly why three exempt accounts were
 * invisible to it.
 *
 * billing_exempt is selected to set the EXPECTATION (exempt ⇒ Stripe must be
 * zero), never to filter the measurement — INV-PB-011 keeps it out of the sums.
 */
async function loadLedgerSide(start: Date, end: Date): Promise<LedgerRow[]> {
  // billing_spend_events and cost_attribution_events are FORCE RLS; this
  // aggregates across every tenant, so admin scope is the only correct option.
  const { rows } = await withAdminScope(
    {
      caller: 'billing.ou-meter-reconciliation.loadLedgerSide',
      reason: 'cross-tenant OU meter reconciliation against Stripe',
    },
    (client) => client.query<LedgerRow>(
      `WITH llm AS (
         -- spend-subscriber sends raw cost_usd, one event per invocation_id.
         -- Bucket-suffixed sibling rows (/included, /precommit, /reload) share
         -- one meter event, so summing every row would over-count a
         -- boundary-crossing invocation. Take the invocation's total once.
         SELECT account_id, SUM(cost_usd) AS v
           FROM billing_spend_events
          WHERE occurred_at >= $1 AND occurred_at < $2
            AND stripe_metered_at IS NOT NULL
          GROUP BY account_id
       ),
       ingest AS (
         -- ingestEventWithBuckets sends the summed customerCostUsd, and only
         -- when it is > 0. platform_overhead never reaches the meter at all.
         --
         -- cost_attribution_events is keyed by tenant_id, not account_id, so
         -- this joins through tenants. tenant_runtime is excluded because
         -- spend-subscriber owns that path and the llm arm above already
         -- counts it -- including it here would double the LLM contribution.
         -- Cast the UUID side to text, never the column to uuid. tenant_id here
         -- is TEXT and carries a non-UUID sentinel: gcp_billing_platform rows
         -- are written with tenant_id='platform', so coercing the column raises
         -- 22P02 on that row and takes the whole reconciliation down. Casting
         -- the uuid side is total, and the join drops the sentinel rows on its
         -- own because no tenant id equals 'platform'.
         --
         -- Comparing the columns without the cast fails with
         -- "operator does not exist: uuid = text" for exactly this reason.
         SELECT t.account_id, SUM(cae.customer_cost_usd) AS v
           FROM cost_attribution_events cae
           JOIN tenants t ON t.id::text = cae.tenant_id
          WHERE cae.occurred_at >= $1 AND cae.occurred_at < $2
            AND cae.cost_bucket <> 'platform_overhead'
            AND cae.source <> 'tenant_runtime'
          GROUP BY t.account_id
       ),
       combined AS (
         SELECT account_id, SUM(v) AS ledger_value
           FROM (SELECT * FROM llm UNION ALL SELECT * FROM ingest) u
          GROUP BY account_id
       )
       SELECT c.account_id::text          AS account_id,
              bc.stripe_customer_id,
              COALESCE(bc.billing_exempt, FALSE) AS billing_exempt,
              c.ledger_value::text        AS ledger_value
         FROM combined c
         LEFT JOIN billing_controls bc ON bc.account_id = c.account_id
        WHERE c.ledger_value > 0`,
      [start, end],
    ),
  );
  return rows;
}

/** Resolve the meter id by event name so no config can drift out from under us. */
async function resolveMeterId(stripe: Stripe): Promise<string | null> {
  const meters = await stripe.billing.meters.list({ limit: 100 });
  const m = meters.data.find(x => x.event_name === OU_METER_EVENT_NAME && x.status === 'active');
  return m?.id ?? null;
}

/**
 * Backlog signals — cheap, and currently watched by nothing. Both are leading
 * indicators of the same failure the day-comparison catches after the fact.
 */
async function loadBacklogSignals(start: Date): Promise<{ unmetered: number; retryDepth: number }> {
  const unmeteredRes = await withAdminScope(
    {
      caller: 'billing.ou-meter-reconciliation.loadBacklogSignals',
      reason: 'count unmetered spend events older than the reconciled window',
    },
    (client) => client.query<{ n: string }>(
      // Scoped to rows that SHOULD have been metered. spend-subscriber sets
      // stripe_metered_at only on a successful fire, and it fires only when the
      // account has a stripe_customer_id and is not exempt -- so an exempt
      // account's rows stay NULL forever, by design.
      //
      // The first live run returned 3,686 against an unscoped count, on an
      // environment that is almost entirely exempt. A number that can never
      // reach zero is not an alarm; an operator learns to ignore it, which is
      // the false all-clear problem wearing the opposite mask. Counting only
      // the rows whose absence is genuinely a defect is what makes a non-zero
      // value mean something.
      //
      // This reads billing_exempt to set an OPERATIONAL EXPECTATION, not to
      // rate or report customer usage -- the same narrow use INV-PB-011 permits
      // for the exempt-must-be-zero assertion below.
      `SELECT COUNT(*)::text AS n
         FROM billing_spend_events bse
         JOIN billing_controls bc ON bc.account_id = bse.account_id
        WHERE bse.stripe_metered_at IS NULL
          AND bse.occurred_at < $1
          AND bc.billing_exempt = FALSE
          AND bc.stripe_customer_id IS NOT NULL`,
      [start],
    ),
  );
  // ou_meter_event_retries is not RLS — it is keyed by stripe_customer_id.
  const retryRes = await getPool().query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ou_meter_event_retries`,
  );
  return {
    unmetered:  parseInt(unmeteredRes.rows[0]?.n ?? '0', 10),
    retryDepth: parseInt(retryRes.rows[0]?.n ?? '0', 10),
  };
}

export interface ReconciliationResult {
  day:        string;
  checked:    number;
  matched:    number;
  drifted:    number;
  exemptMetered: number;
  stripeErrors: number;
  unmeteredBacklog: number;
  retryQueueDepth:  number;
}

export async function runOuMeterReconciliation(now: Date = new Date()): Promise<ReconciliationResult> {
  const { start, end, day } = lastCompleteUtcDay(now);
  const stripe = await getStripe();

  const meterId = await resolveMeterId(stripe);
  if (!meterId) {
    // Loud, and NOT a silent pass: with no meter there is nothing to compare,
    // and reporting "0 drift" would be a false all-clear of exactly the kind
    // ou-report used to give.
    log.error({ eventName: OU_METER_EVENT_NAME }, 'ou_meter_reconciliation: no active meter found');
    throw new Error(`no active Stripe meter for event_name=${OU_METER_EVENT_NAME}`);
  }

  const [ledger, backlog] = await Promise.all([
    loadLedgerSide(start, end),
    loadBacklogSignals(start),
  ]);

  const result: ReconciliationResult = {
    day, checked: 0, matched: 0, drifted: 0, exemptMetered: 0, stripeErrors: 0,
    unmeteredBacklog: backlog.unmetered,
    retryQueueDepth:  backlog.retryDepth,
  };

  for (const row of ledger) {
    const ledgerValue = parseFloat(row.ledger_value);
    let stripeValue = 0;
    let status: 'match' | 'drift' | 'exempt_metered' | 'stripe_error';
    let note: string | null = null;

    if (!row.stripe_customer_id) {
      // Consumption with no Stripe customer cannot have been metered. That is
      // expected for an unprovisioned account, so it is a match at zero rather
      // than drift — but the note keeps it visible.
      status = Math.abs(ledgerValue) <= TOLERANCE_USD ? 'match' : 'drift';
      note = 'no stripe_customer_id on billing_controls';
    } else {
      try {
        const summaries = await stripe.billing.meters.listEventSummaries(meterId, {
          customer:   row.stripe_customer_id,
          start_time: Math.floor(start.getTime() / 1000),
          end_time:   Math.floor(end.getTime()   / 1000),
        });
        stripeValue = summaries.data.reduce((s, x) => s + (x.aggregated_value ?? 0), 0);
        if (row.billing_exempt) {
          // An exempt account must consume on our side and reach Stripe not at
          // all. This is an assertion, not a skip: it is the check that would
          // catch an internal account accidentally being metered.
          status = Math.abs(stripeValue) <= TOLERANCE_USD ? 'match' : 'exempt_metered';
          if (status === 'exempt_metered') note = 'billing_exempt account reached the Stripe meter';
        } else {
          status = Math.abs(ledgerValue - stripeValue) <= TOLERANCE_USD ? 'match' : 'drift';
        }
      } catch (err) {
        // Recorded rather than swallowed: a summary call that could not run
        // knows nothing about the data, and must not look like a match.
        status = 'stripe_error';
        note = (err as Error).message.slice(0, 300);
      }
    }

    const delta = stripeValue - ledgerValue;
    await getPool().query(
      `INSERT INTO ou_meter_reconciliation
         (account_id, period_day, ledger_value, stripe_value, delta_value,
          billing_exempt, status, unmetered_backlog, retry_queue_depth, note, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (account_id, period_day) DO UPDATE SET
         ledger_value = EXCLUDED.ledger_value,
         stripe_value = EXCLUDED.stripe_value,
         delta_value  = EXCLUDED.delta_value,
         billing_exempt = EXCLUDED.billing_exempt,
         status       = EXCLUDED.status,
         unmetered_backlog = EXCLUDED.unmetered_backlog,
         retry_queue_depth = EXCLUDED.retry_queue_depth,
         note         = EXCLUDED.note,
         checked_at   = NOW()`,
      [row.account_id, day, ledgerValue, stripeValue, delta,
       row.billing_exempt, status, backlog.unmetered, backlog.retryDepth, note],
    );

    result.checked++;
    if (status === 'match')               result.matched++;
    else if (status === 'drift')          result.drifted++;
    else if (status === 'exempt_metered') result.exemptMetered++;
    else                                  result.stripeErrors++;

    if (status !== 'match') {
      log.error(
        { accountId: row.account_id, day, ledgerValue, stripeValue, delta, status, note },
        'ou_meter_reconciliation_drift',
      );
    }
  }

  log.info({ ...result }, 'ou_meter_reconciliation: complete');
  return result;
}
