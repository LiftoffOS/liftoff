// What the gateway saw beats what the engine said — and by how much.
//
// Two pure functions, in their own module so the arithmetic can be asserted
// directly. It is arithmetic worth asserting: it decides money, and both of its
// failure modes are silent. Take too little and the under-count this whole change
// exists to fix survives; take too much and a run is billed twice for the same
// tokens.
//
// Two engines here report less than the vendor charged, and neither gap can be
// closed by reading another of the engine's own fields: opencode splits reasoning
// out of the completion count it reports, and the Gemini CLI never names thinking
// at all. So the gateway's totals are the correction, and the SHAPE of the
// correction is what this module is about — see `gatewayShortfall`.

import type { GatewayRunUsage } from '../byok/gateway-usage';
import type { CostResult } from '../llm/pricing';

/** Anthropic's published cache-write multiple of the input rate.
 *
 *  Used only as the fallback when the rate table carries no explicit cache-write
 *  rate for a model that nonetheless produced cache-write tokens. That
 *  combination should not happen and is not worth billing zero for: a missing
 *  rate is a gap in the table, not evidence the write was free. */
const CACHE_WRITE_MULTIPLE_OF_INPUT = 1.25;

/** The engine's own run-wide totals, as its steps reported them. */
export interface EngineTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

export interface GatewayShortfall {
  costUsd: number;
  /** The counts the shortfall was computed from. They travel with the money so
   *  the row the invocation writes and the charge it carries come out of one
   *  calculation rather than two that have to be kept in step. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** True when the charge is the VENDOR's own figure rather than a reconstruction
   *  from tokens. Decides whether the total is worth persisting on the invocation
   *  row, which is the same test `priceRunSteps` already applies: a rate snapshot
   *  cannot reproduce it, so it has to be stored. */
  vendorReported: boolean;
}

/**
 * The spend the gateway counted and the engine did not, priced.
 *
 * WHY A SHORTFALL RATHER THAN A REPLACEMENT. The obvious move is to discard the
 * engine's counts and price the gateway's totals instead. It is wrong for one
 * specific reason: a conditional rate band keys off a SINGLE request's prompt
 * size, and these totals are a SUM over every request the run made. Pricing a sum
 * against a threshold charges a band no single call reached — a 60-step run
 * averaging 5k tokens sums to 300k and would be billed a 200k long-context rate
 * not one of its steps came near. Several models we serve have bands starting at
 * 32k, so that is the common case rather than an edge.
 *
 * So the per-step pricing stands with its bands intact, and only the DIFFERENCE is
 * added, at the rates the run's dominant step already resolved.
 *
 * THAT IS NOT A REASON TO SKIP A COUNT, and reading it as one is how this shipped
 * under-billing. Adding a delta at an already-resolved rate tests no threshold, so
 * EVERY billable count is compared: input, the cache read, the cache write and
 * output. The first version compared only the write and the output, and dropped an
 * entire second request's 10,265 input tokens that the gateway could see and the
 * engine had never reported.
 *
 * WHAT THE VENDOR CHARGED BEATS ALL OF IT. Where every gateway request reported its
 * own cost, that sum IS the money for those requests and no reconstruction from
 * tokens can improve on it — on a gateway-served model it cannot even match it,
 * because one model is served by many endpoints at different prices and the listed
 * slug rate is short by the serving endpoint's premium. A turn whose tokens
 * reconstructed to $0.01411360 at the slug rate was charged $0.01853990. So the
 * vendor's figure is preferred outright, and the token arithmetic is the fallback
 * for the direct-API vendors, which publish a price list and report no per-call
 * charge.
 *
 * `max(0, …)`, never a subtraction, everywhere. The engine legitimately reports
 * MORE than the gateway: a turn that fell back to a direct path mid-run, a
 * delegated child whose calls never passed the door, a run the gateway served only
 * part of. Treating the gateway's figure as authoritative there would un-bill real
 * spend, which is the same defect in the other direction.
 */
export function gatewayShortfall(
  gatewayUsage: GatewayRunUsage | null | undefined,
  engine: EngineTotals,
  rates: CostResult,
  /** What this run's steps have already been charged, so a vendor-reported total
   *  is compared against it rather than added on top of it. Zero means "nothing
   *  priced yet", under which the vendor's whole figure is the shortfall. */
  alreadyPricedUsd = 0,
): GatewayShortfall {
  const none: GatewayShortfall = {
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    vendorReported: false,
  };
  // ZERO REQUESTS MEANS THIS RUN NEVER CAME THROUGH THE DOOR, which is the normal
  // case for any provider without a gateway session. Its totals are zeroes and
  // must not be read as counts — that is the whole reason `requests` is on the
  // wire beside them.
  if (!gatewayUsage || gatewayUsage.requests <= 0) return none;

  const counts = {
    inputTokens: Math.max(0, gatewayUsage.inputTokens - engine.inputTokens),
    cacheReadTokens: Math.max(0, gatewayUsage.cacheReadTokens - engine.cachedTokens),
    cacheWriteTokens: Math.max(0, gatewayUsage.cacheWriteTokens - engine.cacheWriteTokens),
    outputTokens: Math.max(0, gatewayUsage.outputTokens - engine.outputTokens),
  };

  // The vendor's own figure, but only when it covers EVERY request the gateway
  // served. A sum over some of them is not the run's charge, and preferring a
  // partial sum over a complete token reconstruction would under-bill by whatever
  // the silent requests cost.
  if (
    gatewayUsage.vendorCostUsd !== null
    && gatewayUsage.vendorCostRequests === gatewayUsage.requests
  ) {
    const vendorShortfall = Math.max(0, gatewayUsage.vendorCostUsd - alreadyPricedUsd);
    // The counts still travel. A row whose charge came from the vendor still has
    // to say what it was charged for, and a reconciliation reads the counts.
    return { ...counts, costUsd: vendorShortfall, vendorReported: vendorShortfall > 0 };
  }

  if (
    counts.inputTokens === 0 && counts.cacheReadTokens === 0
    && counts.cacheWriteTokens === 0 && counts.outputTokens === 0
  ) {
    return none;
  }

  // A cache READ is billed at its own rate where the model publishes one. A
  // missing cached rate falls back to the input rate rather than to zero: a read
  // that was served is a read that was charged, and the model simply does not
  // discount it.
  const cacheReadRate = rates.cachedInputPricePerMillion ?? rates.inputPricePerMillion;
  const cacheWriteRate = rates.cacheWritePricePerMillion
    ?? rates.inputPricePerMillion * CACHE_WRITE_MULTIPLE_OF_INPUT;
  const costUsd =
    (counts.inputTokens * rates.inputPricePerMillion) / 1_000_000
    + (counts.cacheReadTokens * cacheReadRate) / 1_000_000
    + (counts.cacheWriteTokens * cacheWriteRate) / 1_000_000
    + (counts.outputTokens * rates.outputPricePerMillion) / 1_000_000;
  return { ...counts, costUsd, vendorReported: false };
}

/**
 * The counts the invocation row records, once the gateway has had its say.
 *
 * Separate from the pricing because the two answer different questions and are
 * read by different things: the money is `costUsd`, and these are the COUNTS a
 * later reconciliation reproduces the charge from. They have to agree, which is
 * why both follow the same rule — the larger of the two witnesses, per count,
 * with the gateway invisible on a run it never served.
 */
export function preferGatewayCounts(
  gatewayUsage: GatewayRunUsage | null | undefined,
  engine: EngineTotals,
): EngineTotals {
  if (!gatewayUsage || gatewayUsage.requests <= 0) return engine;
  return {
    inputTokens: Math.max(engine.inputTokens, gatewayUsage.inputTokens),
    outputTokens: Math.max(engine.outputTokens, gatewayUsage.outputTokens),
    cachedTokens: Math.max(engine.cachedTokens, gatewayUsage.cacheReadTokens),
    cacheWriteTokens: Math.max(engine.cacheWriteTokens, gatewayUsage.cacheWriteTokens),
  };
}
