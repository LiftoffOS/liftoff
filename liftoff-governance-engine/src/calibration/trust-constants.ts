// the calibrated TRUST pass-rate operating points.
//
// Only two GOV constants are genuinely distribution-dependent: the pass-rate thresholds that
// decide the auto and queue tiers. TRUST_MIN_RUNS / TRUST_WINDOW_DAYS are policy constants and
// are NOT calibrated.
//
// SELECTION RULE (deterministic): set the threshold to the LOWEST pass-rate that still holds
// the labeled false-clear rate at or below a fixed target operating point. A "false clear" is
// an action that cleared but a later late_feedback marked wrong — observable directly from
// action_trust_decisions (source='late_feedback', decision='rejected'). The guardrail metric
// is that same false-clear rate, so shadow-before-promote and the rollback circuit-breaker
// watch exactly what the estimator optimizes.

import { withTenantScope } from '../infrastructure/database';
import type { CalibrationConstant, CalibrationEvidence } from './types';

/** One labeled cell: an (agent, action_class) with its window pass-rate and whether a later
 *  late_feedback rejection marked one of its clears wrong. */
export interface TrustObservation {
  passRate: number;
  falseClear: boolean;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** False-clear rate among observations that WOULD clear at `threshold` (passRate >= threshold).
 *  Lower is better; 0 when nothing clears. This is the guardrail metric. */
export function falseClearRateAt(obs: readonly TrustObservation[], threshold: number): number {
  const cleared = obs.filter((o) => o.passRate >= threshold);
  if (cleared.length === 0) return 0;
  return cleared.filter((o) => o.falseClear).length / cleared.length;
}

/**
 * The lowest threshold in [clampMin, clampMax] (stepped by `grid`) whose cleared set has a
 * false-clear rate <= target. Returns null when NO threshold in range meets the target (⇒ the
 * loop holds the conservative value). Lower threshold = more auto-clearing, so "lowest that
 * still meets the target" is the least-conservative safe operating point.
 */
export function estimateThreshold(
  obs: readonly TrustObservation[],
  target: number,
  clampMin: number,
  clampMax: number,
  grid = 0.01,
): number | null {
  for (let t = clampMin; t <= clampMax + 1e-9; t += grid) {
    const rounded = Math.round(t * 100) / 100;
    if (falseClearRateAt(obs, rounded) <= target) return rounded;
  }
  return null;
}

async function fetchObservations(tenantId: string, windowStart: Date, windowEnd: Date): Promise<TrustObservation[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ pass_rate: string; false_clear: boolean }>(
      `WITH cells AS (
         SELECT agent_id, action_class,
           count(*) FILTER (WHERE source = 'hitl_resolve') AS resolved,
           count(*) FILTER (WHERE source = 'hitl_resolve' AND decision = 'approved') AS approved,
           count(*) FILTER (WHERE source = 'late_feedback' AND decision = 'rejected') AS late_rejects
         FROM action_trust_decisions
         WHERE tenant_id = $1 AND decided_at >= $2 AND decided_at < $3
         GROUP BY agent_id, action_class
       )
       SELECT (approved::float / resolved) AS pass_rate, (late_rejects > 0) AS false_clear
       FROM cells WHERE resolved > 0`,
      [tenantId, windowStart, windowEnd],
    );
    return res.rows.map((r) => ({ passRate: Number(r.pass_rate), falseClear: r.false_clear }));
  });
}

/** Build a trust CalibrationConstant. `target` is the fixed false-clear operating point (a
 *  policy input to the estimator, not itself calibrated) AND the absolute shadow-promote
 *  ceiling. `rollbackCeiling` (≥ target) is the live breach that auto-reverts. */
function makeTrustConstant(name: string, target: number, clampMin: number, rollbackCeiling: number): CalibrationConstant {
  const clampMax = 1.0; // hardest = require a perfect record = "never auto-clear" (safe no-op)
  return {
    name,
    clampMin,
    clampMax,
    conservativeDefault: clampMax, // cold start: never clear until data earns a lower threshold
    maxStep: envNum('CALIB_MAX_STEP', 0.05),
    hysteresisK: envNum('CALIB_HYSTERESIS_K', 2),
    floorSamples: envNum('CALIB_MIN_SAMPLES', 50),
    // Promote if the candidate's shadow false-clear is within the target; the estimator already
    // selects a value meeting it, so this confirms it on the held-out window (absolute, not
    // relative — a relative check would block every loosening; see loop.ts §5).
    guardrailPromoteCeiling: target,
    guardrailRollbackCeiling: rollbackCeiling,
    async gatherEvidence(tenantId, windowStart, windowEnd): Promise<CalibrationEvidence> {
      const obs = await fetchObservations(tenantId, windowStart, windowEnd);
      return {
        estimatorOutput: estimateThreshold(obs, target, clampMin, clampMax),
        sampleCount: obs.length,
        guardrail: (value: number) => falseClearRateAt(obs, value),
      };
    },
  };
}

// auto tier = NO human sees the action, so a tight 2% false-clear target (revert at 5%). queue
// tier = a human still reviews the queued item, so a looser 10% target (revert at 15%) — the
// rollback ceiling must stay ABOVE the target or the tier would revert the moment it reached it.
export const TRUST_AUTO_PASS_RATE = makeTrustConstant(
  'TRUST_AUTO_PASS_RATE',
  envNum('CALIB_TRUST_AUTO_TARGET_FALSE_CLEAR', 0.02),
  0.8,
  envNum('CALIB_TRUST_AUTO_ROLLBACK_CEILING', 0.05),
);
export const TRUST_QUEUE_PASS_RATE = makeTrustConstant(
  'TRUST_QUEUE_PASS_RATE',
  envNum('CALIB_TRUST_QUEUE_TARGET_FALSE_CLEAR', 0.1),
  0.6,
  envNum('CALIB_TRUST_QUEUE_ROLLBACK_CEILING', 0.15),
);

export const TRUST_CONSTANTS: CalibrationConstant[] = [TRUST_AUTO_PASS_RATE, TRUST_QUEUE_PASS_RATE];
