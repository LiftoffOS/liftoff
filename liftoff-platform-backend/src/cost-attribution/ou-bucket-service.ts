// Shared write-time helper that converts a raw cost_usd amount into
// 1-3 BucketAssignment entries, atomically incrementing
// billing_controls.ous_consumed_this_period under FOR UPDATE.
//
// This is the single conversion point: cost_usd → ou_consumed → customer_cost_usd.
// All ingesters call this; /insights and Plan Usage both read columns it produced.

import type { PoolClient } from 'pg';
import { log } from '../infrastructure/logging';
import { getBillingProvider } from '../billing/provider';

export interface BucketAssignment {
  ouConsumed:       number;    // portion of the source event in this bucket
  costUsd:          number;    // raw model cost prorated to this portion
  customerCostUsd:  number;    // what the customer is charged for these OUs
  costBucket:       'included' | 'precommit' | 'reload';
  sourceIdSuffix:   '/included' | '/precommit' | '/reload' | ''; // '' only when single-bucket
}

interface DefinitionRateCache {
  value: number;
  fetchedAt: number;
}
let definitionRateCache: DefinitionRateCache | null = null;
const DEFINITION_RATE_TTL_MS = 5 * 60 * 1000;

export function _resetOuDefinitionRateCacheForTesting(): void {
  definitionRateCache = null;
  premiumCache = null;
}

/** What produced a cost, for pricing. `pass_through` is a supplier's own
 *  charge the platform resells unchanged — a data capability, a web tool;
 *  `platform` is work the platform itself does — inference, the sandbox. */
export type ChargeClass = 'pass_through' | 'platform';

let premiumCache: { value: number | null; fetchedAt: number } | null = null;

/** The premium a resold supplier charge carries, e.g. 1.10 for ten per cent.
 *  Null when the setting is absent, which leaves pass-through cost priced
 *  exactly as it was. Cached like the definition rate. */
export async function getPassThroughPremium(client: PoolClient): Promise<number | null> {
  // A premium is a RESELLER'S margin: migration 519 defines it as the
  // supplier's charge, times this, being what the workspace pays. That needs a
  // reseller. With no billing system there is not one — the operator holds the
  // account with the supplier and pays the supplier directly — so the 1.10 the
  // migration seeds would mark their own spend up by ten per cent on every
  // connector_call and web_tool and show them the marked-up figure as their
  // cost.
  //
  // Same class as the $0-under-BYOK defect: a cost surface rendering a number
  // it cannot stand behind. Every query succeeds, every card renders, and the
  // total is wrong in a direction nobody checks.
  //
  // Guarded here rather than by a migration that deletes the row, so it holds
  // whatever the table says and needs no deployment to have run anything.
  if (getBillingProvider().kind === 'unbilled') return null;

  if (premiumCache && Date.now() - premiumCache.fetchedAt < DEFINITION_RATE_TTL_MS) {
    return premiumCache.value;
  }
  try {
    const { rows } = await client.query<{ value: string }>(
      `SELECT value::text AS value FROM billing_system_settings WHERE key = 'pass_through_premium'`,
    );
    const raw = rows[0]?.value;
    const parsed = raw === undefined ? NaN : parseFloat(raw);
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    premiumCache = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    // A read that failed says nothing about the setting: price as before
    // rather than guess a premium in either direction.
    log.warn({ err: (err as Error).message }, 'ou-bucket-service: pass_through_premium unreadable; pricing pass-through cost as platform cost');
    return null;
  }
}

export async function getOuDefinitionRateUsd(client: PoolClient): Promise<number> {
  if (definitionRateCache && Date.now() - definitionRateCache.fetchedAt < DEFINITION_RATE_TTL_MS) {
    return definitionRateCache.value;
  }
  try {
    const { rows } = await client.query<{ value: string }>(
      `SELECT value::text AS value FROM billing_system_settings WHERE key = 'ou_definition_rate_usd'`,
    );
    if (!rows[0]) {
      // Migration 206 seeds the row; missing means the migration didn't run yet
      // or the row was manually deleted. Fall back but make it loud.
      log.error({ key: 'ou_definition_rate_usd' },
        'ou-bucket-service: billing_system_settings row missing — falling back to 0.01');
      definitionRateCache = { value: 0.01, fetchedAt: Date.now() };
      return 0.01;
    }
    const value = parseFloat(rows[0].value);
    if (!(value > 0)) {
      log.error({ key: 'ou_definition_rate_usd', raw: rows[0].value },
        'ou-bucket-service: billing_system_settings value not positive — falling back to 0.01');
      definitionRateCache = { value: 0.01, fetchedAt: Date.now() };
      return 0.01;
    }
    definitionRateCache = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    // Defensive fallback for transient DB errors. Don't poison the cache so
    // the next call retries.
    log.error({ error: (err as Error).message },
      'ou-bucket-service: failed to load ou_definition_rate_usd — falling back to 0.01 for this call only');
    return 0.01;
  }
}

export interface RateLadder {
  preConsumed:   number;
  includedEnd:   number;
  precommitEnd:  number;
  includedRate:  number;
  precommitRate: number;
  reloadRate:    number;
}

// The number of OUs that costs a workspace exactly `priceUsd`, starting from
// where its consumption already stands. The inverse of the bucket split below,
// and exact across a boundary: an event that starts in one band and finishes
// in another is worth the capacity of the first plus what the remainder buys
// in the second, so the price comes out right whether or not the ladder's
// three rates agree (one live workspace's do not).
//
// Null when a band it would have to consume is free -- an exempt workspace, or
// one whose ladder has a zero rung. No quantity of free OUs adds up to a
// positive price, so there is no answer to give and the caller falls back to
// the definition. That costs an exempt workspace nothing either way: it is
// charged nothing and still meters, drains and reports like a paying one.
//
// Exported for the data source rates (src/data-sources/service.ts), which quote
// the NEXT call at the workspace's current band with this same function, so
// the rate a person reads and the rate a call is booked at cannot drift.
export function ousWorth(priceUsd: number, ladder: RateLadder): number | null {
  const bands = [
    { capacity: Math.max(0, ladder.includedEnd - ladder.preConsumed),                              rate: ladder.includedRate  },
    { capacity: Math.max(0, ladder.precommitEnd - Math.max(ladder.preConsumed, ladder.includedEnd)), rate: ladder.precommitRate },
    { capacity: Infinity,                                                                          rate: ladder.reloadRate    },
  ];
  let remaining = priceUsd;
  let ous = 0;
  for (const band of bands) {
    if (band.capacity <= 0) continue;
    if (!(band.rate > 0)) return null;
    const bandValue = band.capacity * band.rate;
    if (remaining <= bandValue) return ous + remaining / band.rate;
    ous += band.capacity;
    remaining -= bandValue;
  }
  return null; // unreachable: the reload band is unbounded
}

/** The billing_controls columns a rate ladder is read from. */
export const RATE_LADDER_COLUMNS = `plan_included_ous, precommit_extra_ous, referral_bonus_ous,
            included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
            ous_consumed_this_period`;

export interface RateLadderRow {
  plan_included_ous: string; precommit_extra_ous: string; referral_bonus_ous: string;
  included_rate_usd_per_ou: string; precommit_rate_usd_per_ou: string; reload_rate_usd_per_ou: string;
  ous_consumed_this_period: string;
}

/** A workspace's bands and where its consumption stands, from its
 *  billing_controls row. The one reading of those columns: the booking path
 *  below and the data source rates' quote both go through it. */
export function rateLadderFrom(ctrl: RateLadderRow): RateLadder {
  const preConsumed  = parseFloat(ctrl.ous_consumed_this_period);
  const includedEnd  = Number(BigInt(ctrl.plan_included_ous));
  // The referee half of the referral programme extends the precommit band for
  // the workspace's first period. It sits with the precommit OUs rather than
  // with the included ones because it is capacity granted on top of the plan,
  // not part of what the plan's base fee bought — and because the period reset
  // takes it away again, which included_ous must never be subject to.
  const precommitEnd = includedEnd
    + Number(BigInt(ctrl.precommit_extra_ous))
    + Number(BigInt(ctrl.referral_bonus_ous));
  return {
    preConsumed,
    includedEnd,
    precommitEnd,
    includedRate:  parseFloat(ctrl.included_rate_usd_per_ou),
    precommitRate: parseFloat(ctrl.precommit_rate_usd_per_ou),
    reloadRate:    parseFloat(ctrl.reload_rate_usd_per_ou),
  };
}

// Atomically increments billing_controls.ous_consumed_this_period and returns
// 1-3 bucket assignments for the source event. The caller writes one ledger row
// per returned assignment. Single bucket → 1 row with sourceIdSuffix=''. Spans
// two buckets → 2 rows with /base, /precommit (or /precommit, /reload). Spans
// all three (large single invocation crossing both boundaries) → 3 rows.
//
// Concurrency: holds FOR UPDATE on the billing_controls row from the moment
// the function returns until the caller's transaction commits, so dedup checks
// + counter increments serialize correctly across concurrent Pub/Sub redeliveries.
//
// Idempotency: pass `options.isDuplicate` to dedup-check the target ledger
// table BEFORE the counter is incremented. If the callback returns true, the
// helper returns [] without touching the counter — preventing the redelivery
// double-count race that would otherwise occur because applyOuConsumption
// runs before the per-bucket INSERT … ON CONFLICT in the caller.
export async function applyOuConsumption(
  client: PoolClient,
  accountId: string,
  rawCostUsd: number,
  options?: { isDuplicate?: (client: PoolClient) => Promise<boolean>; chargeClass?: ChargeClass },
): Promise<BucketAssignment[]> {
  // Resolve all three rates + counter atomically (FOR UPDATE serialises concurrent writers).
  // Rates always come from billing_controls — the canonical per-tenant rate source.
  // For self-serve tenants these were copied from plan_catalog at subscription-activated
  // time; for Enterprise tenants they were set directly by
  // POST /api/admin/accounts/:accountId/enterprise-provisioning.
  const { rows } = await client.query<RateLadderRow>(
    `SELECT ${RATE_LADDER_COLUMNS}
       FROM billing_controls WHERE account_id = $1
       FOR UPDATE`,
    [accountId],
  );
  const ctrl = rows[0];
  if (!ctrl) return []; // unprovisioned tenant — drop silently

  // Cheap zero-cost short-circuit BEFORE the dedup SELECT. If the source event
  // has no positive cost, there is nothing to bucket and no counter to bump —
  // skip the lookup query, which is wasted work that holds the FOR UPDATE
  // lock longer than necessary.
  if (!(rawCostUsd > 0)) return [];

  // Dedup check while holding the FOR UPDATE lock. Concurrent redeliveries
  // serialize on the same lock, so the first delivery completes (writes ledger
  // row, commits) before the second delivery's check runs and now sees the row.
  if (options?.isDuplicate && await options.isDuplicate(client)) {
    return [];
  }

  const { preConsumed, includedEnd, precommitEnd, includedRate, precommitRate, reloadRate } = rateLadderFrom(ctrl);

  // How many OUs this cost consumes.
  //
  // PLATFORM work -- inference, the sandbox, anything the platform itself runs
  // -- consumes at the OU DEFINITION: one OU is a cent of cost, and what the
  // workspace pays for it is its own rate per OU, which is the markup.
  //
  // PASS-THROUGH work -- a supplier's own charge the platform resells
  // unchanged: a data capability, a web tool -- is priced at that charge plus
  // one premium, `pass_through_premium`. The OUs are then whatever costs the
  // workspace exactly that price at its own rates, which is what holds the
  // premium equal across workspaces: a rate of $0.02 an OU buys the same
  // supplier dollar as $0.03125 does, it simply takes more OUs. Deriving the
  // OUs from the definition instead would give a discounted rate a discount on
  // the supplier's charge too, and below about $0.011 an OU that sells under
  // cost. Absent setting, unreadable setting, or a free band it would have to
  // consume: the definition path, exactly as before this existed.
  const premium = options?.chargeClass === 'pass_through' ? await getPassThroughPremium(client) : null;
  const passThroughOus = premium === null ? null : ousWorth(
    rawCostUsd * premium,
    { preConsumed, includedEnd, precommitEnd, includedRate, precommitRate, reloadRate },
  );
  const ouTotal = passThroughOus ?? rawCostUsd / await getOuDefinitionRateUsd(client);
  if (!(ouTotal > 0)) return [];
  const postConsumed = preConsumed + ouTotal;

  // Slice the consumption across up to three buckets.
  const includedOus  = Math.max(0, Math.min(postConsumed, includedEnd)  - preConsumed);
  const precommitOus = Math.max(0, Math.min(postConsumed, precommitEnd) - Math.max(preConsumed, includedEnd));
  const reloadOus    = Math.max(0, postConsumed                          - Math.max(preConsumed, precommitEnd));

  const buckets: Array<{ ous: number; rate: number; bucket: 'included' | 'precommit' | 'reload' }> = [
    { ous: includedOus,  rate: includedRate,  bucket: 'included'  as const },
    { ous: precommitOus, rate: precommitRate, bucket: 'precommit' as const },
    { ous: reloadOus,    rate: reloadRate,    bucket: 'reload'    as const },
  ].filter(b => b.ous > 0);

  // Commit both period counters in one statement.
  //
  // `current_period_spend_usd` had NO writer anywhere -- not this repo, not
  // liftoff-billing, not the runtime, no trigger. It was read by
  // threshold-charge-service (which compares it against the $100/$200/$500/$1k
  // graduated schedule) and by the admin account-state read, and reset to 0 by
  // the annual allocation job, but nothing ever advanced it. Prod proved it:
  // an account with 4,874.609 OUs consumed still reported 0.000000. So
  // threshold charging could never fire for a post_pay account even in
  // principle, because its trigger was permanently zero.
  //
  // It accumulates customer_cost_usd, not raw cost_usd: the thresholds are
  // amounts of money the customer owes, so the counter feeding them has to be
  // denominated the same way. Platform-overhead consumption never reaches this
  // function (classifyChargeability diverts it before applyOuConsumption), so
  // absorbed cost cannot inflate the counter.
  //
  // Computed after the bucket split because the per-bucket rates are what turn
  // OUs into dollars; the split itself depends only on values read before this
  // statement, and the FOR UPDATE taken above is still held, so folding both
  // counters into one UPDATE keeps them atomic with each other.
  const customerCostTotal = buckets.reduce((sum, b) => sum + b.ous * b.rate, 0);

  await client.query(
    `UPDATE billing_controls
        SET ous_consumed_this_period = ous_consumed_this_period + $2,
            current_period_spend_usd = current_period_spend_usd + $3
      WHERE account_id = $1`,
    [accountId, ouTotal, customerCostTotal],
  );

  // If only one bucket is non-zero, emit without a sourceId suffix.
  if (buckets.length === 1) {
    const b = buckets[0];
    return [{
      ouConsumed:      b.ous,
      costUsd:         rawCostUsd,
      customerCostUsd: b.ous * b.rate,
      costBucket:      b.bucket,
      sourceIdSuffix:  '',
    }];
  }

  // Multi-bucket: prorate raw cost_usd across buckets, suffix the source_id.
  return buckets.map(b => ({
    ouConsumed:      b.ous,
    costUsd:         rawCostUsd * (b.ous / ouTotal),
    customerCostUsd: b.ous * b.rate,
    costBucket:      b.bucket,
    sourceIdSuffix:  `/${b.bucket}` as '/included' | '/precommit' | '/reload',
  }));
}

/**
 * Credit a previously-debited OU consumption. Used for deep_research
 * over-estimate true-up and FAILED refunds.
 *
 * Per D2.4 of the deep-research-realtime-billing plan: we decrement
 * ous_consumed_this_period and write a single cost_attribution_events row
 * with cost_bucket='reload' and negative cost_usd, regardless of the
 * original consumption's bucket distribution. Reversing the exact bucket
 * mix would require querying the original cost_attribution_events rows by
 * source_id prefix and prorating — significant complexity for sub-dollar
 * refunds. Aggregate counter integrity is preserved; the cost_bucket
 * distribution drifts slightly.
 *
 * Concurrency + idempotency: mirrors applyOuConsumption (FOR UPDATE on
 * billing_controls, isDuplicate callback under the lock).
 */
export async function applyOuRefund(
  client: PoolClient,
  accountId: string,
  refundCostUsd: number,   // positive — caller passes Math.abs(deltaCostUsd)
  options?: { isDuplicate?: (client: PoolClient) => Promise<boolean> },
): Promise<{ ouRefunded: number; customerCreditUsd: number } | null> {
  if (refundCostUsd <= 0) return null;

  const { rows: [ctrl] } = await client.query<{
    ous_consumed_this_period: string;
    reload_rate_usd_per_ou: string;
  }>(
    `SELECT ous_consumed_this_period, reload_rate_usd_per_ou
       FROM billing_controls WHERE account_id = $1
       FOR UPDATE`,
    [accountId],
  );
  if (!ctrl) return null;

  if (options?.isDuplicate && await options.isDuplicate(client)) return null;

  const definitionRate = await getOuDefinitionRateUsd(client);
  const ouToRefund     = refundCostUsd / definitionRate;
  const reloadRate     = parseFloat(ctrl.reload_rate_usd_per_ou);

  // Decrement counter. Floor at 0 to avoid negative ous_consumed (would
  // confuse downstream billing reports).
  // Mirror the consumption path: both period counters move together, so a
  // refund walks `current_period_spend_usd` back down rather than leaving it
  // ratcheted. Without this the counter would only ever rise, and a tenant
  // with heavy deep-research true-ups would drift toward a threshold charge it
  // never actually earned. Floored at 0 for the same reason the OU counter is.
  //
  // The credit is valued at reloadRate, matching customerCreditUsd below and
  // the refund's own cost_bucket='reload' row (see the header note: reversing
  // the exact original bucket mix is deliberately not attempted).
  const customerCreditUsd = ouToRefund * reloadRate;

  await client.query(
    `UPDATE billing_controls
        SET ous_consumed_this_period = GREATEST(0, ous_consumed_this_period - $2),
            current_period_spend_usd = GREATEST(0, current_period_spend_usd - $3)
      WHERE account_id = $1`,
    [accountId, ouToRefund, customerCreditUsd],
  );

  return {
    ouRefunded: ouToRefund,
    customerCreditUsd,
  };
}
