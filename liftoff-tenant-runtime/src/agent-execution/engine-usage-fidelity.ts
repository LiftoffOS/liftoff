// Which engines can be billed from what they say about themselves — and the one
// emit site that says whether a turn got a gateway session.
//
// Every engine reports a usage summary when it finishes. On most of them that
// summary is priceable and a gateway session is a second, independent witness to
// it. On two it is NOT priceable, and the difference is money:
//
//   opencode          splits reasoning out of the completion count it publishes,
//                     so its output figure is short by the thinking it did.
//   google-gemini-cli exposes `total`, `input` and `output` and never `thoughts`
//                     or `tool`, so its residual cannot even be split between the
//                     input and output rates.
//
// Both missing figures are on the vendor's own response, which is what a gateway
// session puts something in front of. When the session does not open the run
// still succeeds — that is deliberate, a control-plane problem must not stop a
// customer's agent — and on those two engines it quietly under-bills instead.
//
// The list lives HERE rather than at the emit site because it is read twice: by
// the counter's label, and by the fence that asserts an engine cannot be added to
// the runtime without someone deciding which half it is in.

import type { ExecutionEngineId } from './adapter/vendors';
import * as metrics from '../observability/runtime-extensions-metrics';

/**
 * Engines whose own usage summary cannot be priced.
 *
 * A run on one of these WITHOUT a gateway session is an under-charge, not a lost
 * cross-check. Adding an engine here is a claim about the vendor's reporting, so
 * it belongs with evidence — see the two cases named above.
 *
 * ENGINE_SUBSET_OK: this is one half of a partition, not a list that should name
 * every engine. `engineUsageFidelity` answers 'complete' for everything NOT here,
 * so a new engine is classified the moment it exists — the safe way round, since
 * the claim being made about a member is that its vendor under-reports, and that
 * needs evidence rather than a default. The test beside this file asserts every
 * resolvable engine has an expected answer, which is the exhaustive half.
 */
export const ENGINES_THAT_CANNOT_PRICE_THEMSELVES: readonly ExecutionEngineId[] = [
  'opencode',
  'google-gemini-cli',
];

/** What a missing gateway session costs on this engine: a cross-check, or money. */
export type UsageFidelity = 'complete' | 'incomplete';

export function engineUsageFidelity(engineId: ExecutionEngineId): UsageFidelity {
  return ENGINES_THAT_CANNOT_PRICE_THEMSELVES.includes(engineId) ? 'incomplete' : 'complete';
}

/**
 * Say whether this turn got a gateway session, always — opened or not.
 *
 * BOTH OUTCOMES ARE EMITTED, because a counter that only fires on failure has no
 * denominator: "eleven bypasses" means nothing without the number of runs it is
 * eleven out of, and the rate is the thing worth alerting on. The labels are
 * closed and low-cardinality so this can carry a log-based metric; the ids go in
 * the structured log beside it rather than into a label.
 */
export function noteGatewaySessionOutcome(input: {
  engineId: ExecutionEngineId;
  /** Whether `openByokSession` returned a session. */
  opened: boolean;
  /** The provider the run resolved to, for slicing by vendor. */
  resolvedProvider?: string;
}): void {
  const fidelity = engineUsageFidelity(input.engineId);
  metrics.gateway_session_total.inc({
    engine: input.engineId,
    opened: input.opened ? 'yes' : 'no',
    fidelity,
    provider: input.resolvedProvider,
  });
}
