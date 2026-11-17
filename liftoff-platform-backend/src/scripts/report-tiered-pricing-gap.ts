// tiered-pricing-gap — how much did flat-rate pricing under-attribute?
//
// READ-ONLY. This script writes nothing, to any table, ever. It exists to put a
// number on a question that must be answered before anyone decides whether to
// settle it: the OpenRouter models we serve carry conditional rate bands that
// src/llm/pricing.ts did not evaluate until migration 379, so every request
// over a threshold was billed at the base rate. Three Qwen models have had
// bands since the day they were registered (migration 322), one of them from
// 32,000 prompt tokens — routine, not exotic.
//
// WHY THIS IS A REPORT AND NOT A REPAIR
//
// A faithful historical correction is not available, and the honest move is to
// say so rather than build something that looks like one. applyOuConsumption
// splits each event across 1-3 buckets against the bucket state AT THAT MOMENT
// (included → precommit → reload) and atomically advances billing_controls.
// Those balances have since been consumed, reloaded and rolled into new
// periods. The bucket state a months-old event should have drained no longer
// exists, so "replay it correctly" has no correct answer to replay.
//
// What IS available is the delta, computed exactly, grouped so a human can
// decide what to do with it. Settling it (as a current-period adjustment, the
// only operation the bucket machinery actually supports) is a business call on
// these numbers, not an engineering step, and deliberately lives outside this
// script.
//
// The existing backfill-runner is also NOT the tool for this: it INSERTs events
// that were never ingested, with ou_consumed 0 and ON CONFLICT DO NOTHING. It
// cannot correct the cost of a row already there.
//
// Rates come from the LIVE vendor, never a literal in this repo: the script
// refuses to run until it has re-synced model_pricing from OpenRouter, because
// a gap computed against a stale local table measures nothing.
//
// Run:
//   REPORT_SINCE=2026-01-01 node dist/scripts/report-tiered-pricing-gap.js
import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, withAdminScope, closePools } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { MODEL_PRICING, computeRowCost } from '../llm/pricing';
import { refreshModelPricingRates } from '../llm/model-pricing-loader';

const BATCH = 5_000;

interface GapRow {
  tenant_id: string;
  provider: string;
  model: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  cost_usd: string;
  occurred_at: Date;
}

interface Bucket {
  tenantId: string;
  model: string;
  period: string;
  rows: number;
  bookedUsd: number;
  correctUsd: number;
}

/** Models whose CURRENT synced rates carry conditional bands. Derived, never
 *  hardcoded: a list typed here would silently miss the next model to gain a
 *  band, which is the exact failure this whole change is repairing. */
function bandedModelKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (pricing.overrides && pricing.overrides.length > 0) keys.add(key);
  }
  return keys;
}

export async function main(): Promise<void> {
  await initSecrets();
  await initDatabase();

  // Authoritative rates first. Without this the comparison is against whatever
  // the static seed happens to say, which is not what the vendor charges.
  const synced = await refreshModelPricingRates();
  log.info({ synced }, 'tiered-pricing-gap: model_pricing rates loaded');

  const since = process.env.REPORT_SINCE ? new Date(process.env.REPORT_SINCE) : new Date(0);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`REPORT_SINCE is not a valid ISO date: "${process.env.REPORT_SINCE}"`);
  }

  const banded = bandedModelKeys();
  if (banded.size === 0) {
    log.warn('tiered-pricing-gap: no model carries conditional bands — nothing to compare');
    return;
  }
  log.info({ models: [...banded] }, 'tiered-pricing-gap: models with conditional bands');

  const buckets = new Map<string, Bucket>();
  let scanned = 0;
  let cursor = since;

  for (;;) {
    // Cross-tenant read of every tenant's attributed LLM spend; admin scope is
    // the only correct choice, matching the ingesters.
    const { rows } = await withAdminScope(
      {
        caller: 'scripts.report-tiered-pricing-gap',
        reason: 'read-only cross-tenant scan of cost_attribution_events to quantify flat-rate under-attribution',
      },
      (client) => client.query<GapRow>(
        `SELECT tenant_id, provider, COALESCE(model, '') AS model,
                input_tokens, output_tokens, cached_tokens, cost_usd, occurred_at
           FROM cost_attribution_events
          WHERE event_type = 'llm_invocation'
            AND occurred_at > $1
            AND model IS NOT NULL
          ORDER BY occurred_at ASC
          LIMIT $2`,
        [cursor, BATCH],
      ),
    );
    if (rows.length === 0) break;

    for (const r of rows) {
      scanned++;
      // Same provider-aware key precedence computeRowCost uses, so a row this
      // scan skips is genuinely unbanded rather than merely keyed differently.
      if (!banded.has(`${r.provider}:${r.model}`) && !banded.has(r.model)) continue;

      const inputTokens  = Number(r.input_tokens)  || 0;
      const outputTokens = Number(r.output_tokens) || 0;
      const cachedTokens = Number(r.cached_tokens) || 0;

      // occurred_at, not now(): a band can be scoped to a UTC window, and the
      // whole point is what this row SHOULD have cost when it ran.
      //
      // cache_creation is passed as 0 because cost_attribution_events does not
      // carry it — it is Anthropic-only and no Anthropic model has bands, so
      // this cannot change a banded row's threshold. Stated rather than assumed,
      // since it WOULD matter the day an Anthropic model gains one.
      const correct = computeRowCost(
        r.provider, r.model, inputTokens, outputTokens, 0, cachedTokens, r.occurred_at,
      );

      const period = r.occurred_at.toISOString().slice(0, 7); // YYYY-MM
      const key = `${r.tenant_id}|${r.model}|${period}`;
      const b = buckets.get(key) ?? {
        tenantId: r.tenant_id, model: r.model, period,
        rows: 0, bookedUsd: 0, correctUsd: 0,
      };
      b.rows++;
      b.bookedUsd += Number(r.cost_usd) || 0;
      b.correctUsd += correct;
      buckets.set(key, b);
    }

    cursor = rows[rows.length - 1].occurred_at;
    if (rows.length < BATCH) break;
  }

  const results = [...buckets.values()]
    .map((b) => ({ ...b, deltaUsd: b.correctUsd - b.bookedUsd }))
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd));

  const totalDelta = results.reduce((s, r) => s + r.deltaUsd, 0);
  const affectedRows = results.reduce((s, r) => s + r.rows, 0);

  for (const r of results) {
    log.info(
      {
        event: 'tiered_pricing_gap_bucket',
        tenantId: r.tenantId, model: r.model, period: r.period, rows: r.rows,
        bookedUsd: Number(r.bookedUsd.toFixed(6)),
        correctUsd: Number(r.correctUsd.toFixed(6)),
        deltaUsd: Number(r.deltaUsd.toFixed(6)),
      },
      'tiered-pricing-gap: tenant/model/period',
    );
  }

  // The delta can be NEGATIVE as well as positive. Two corrections shipped
  // together and they push opposite ways: conditional bands raise cost on long
  // prompts, and the cached-token fix (this repo billed prompt_tokens in full
  // AND the cache read again, for every OpenAI-wire row) lowers it. Reporting a
  // signed total rather than an absolute is the point — "how much did we
  // under-charge" is the wrong question if the net is the other way.
  log.info(
    {
      event: 'tiered_pricing_gap_total',
      scannedRows: scanned,
      affectedRows,
      buckets: results.length,
      totalDeltaUsd: Number(totalDelta.toFixed(6)),
      sinceIso: since.toISOString(),
      note: 'positive = we under-attributed and would recover; negative = we over-attributed. READ-ONLY: nothing was written.',
    },
    'tiered-pricing-gap: complete',
  );
}

if (require.main === module) {
  main().then(
    () => closePools().then(() => process.exit(0)),
    (err) => {
      log.error({ err }, 'tiered-pricing-gap failed');
      closePools().finally(() => process.exit(1));
    },
  );
}
