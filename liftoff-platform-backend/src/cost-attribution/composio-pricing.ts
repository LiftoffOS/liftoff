// Composio MCP pricing model.
//
// Composio's three-tier plan (https://composio.dev/pricing):
//
//   Totally Free        20 K  tool calls / mo   community support           $0
//   Ridiculously Cheap  200 K tool calls / mo + $0.299 / 1 K additional     $29
//   Serious Business    2 M   tool calls / mo + $0.249 / 1 K additional    $229
//
// We're sitting on the Free tier today but our cost attribution can't
// afford to read "free" off as zero — the moment we exceed 20 K calls in
// a month or upgrade tiers, every prior cost calculation snaps to a new
// per-call rate and historical comparisons rebase. Pinning the per-call
// rate to the Ridiculously Cheap plan's marginal rate ($0.299 / 1 K =
// $0.000299 / call) gives us:
//
//   1. A stable forward-looking cost that survives the inevitable plan
//      upgrade — historical reports don't restate.
//   2. The conservative-but-realistic margin we'd pay if we burn through
//      the included 200 K calls in a month. Treating included-tier calls
//      as free would understate cost-of-goods and over-state customer
//      margin on Composio-heavy workloads.
//   3. The marginal rate, not the amortised rate, because that's what
//      bills incrementally — a customer using 1 K extra Composio calls
//      adds exactly $0.299 to our COGS, regardless of where they sit in
//      the 200 K-call envelope.
//
// One Composio tool call → one connector_call event in cost-attribution
// with source='composio_mcp'.

/**
 * Marginal cost per Composio tool call, in USD.
 *
 * Source: Composio "Ridiculously Cheap" tier — $0.299 per additional
 * thousand calls beyond the 200 K included pool. We apply it to every
 * call (not just overage) so historical totals don't restate when the
 * plan changes.
 */
export const COMPOSIO_COST_PER_CALL_USD = 0.000299;

/**
 * Multiply call count by the per-call rate. Centralised so the rate
 * change is a one-line edit + one re-run of the parity tests.
 */
export function composioCallsToCostUsd(callCount: number): number {
  if (!Number.isFinite(callCount) || callCount < 0) return 0;
  return callCount * COMPOSIO_COST_PER_CALL_USD;
}
