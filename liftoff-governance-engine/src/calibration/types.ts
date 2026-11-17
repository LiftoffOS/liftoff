// automatic self-calibration types.
//
// A calibrated constant is one that is genuinely DISTRIBUTION-DEPENDENT (it moves with the
// observed data). Everything else is a plain policy constant and does NOT belong here.
// Each calibrated constant declares its guardrails as data — the loop (loop.ts) is generic
// over them.

export type CalibrationOutcome = 'hold' | 'promote' | 'rollback';

/** The estimator + guardrail evidence for one (tenant, constant, window). Supplied by the
 *  constant's estimator against the observed data; injected in tests. */
export interface CalibrationEvidence {
  /** Deterministic estimator output over the window (the raw target value), or null when the
   *  data cannot produce a value (⇒ hold). */
  estimatorOutput: number | null;
  /** Count of LABELED observations in the window. Below the constant's floor ⇒ hold. */
  sampleCount: number;
  /** Guardrail metric (lower is better; e.g. false-clear rate) for a hypothetical value,
   *  evaluated on the held-out window. Used for shadow-before-promote and the rollback
   *  circuit-breaker. */
  guardrail(value: number): Promise<number> | number;
}

export interface CalibrationConstant {
  /** Stable key stored in calibration_runs.constant_name. */
  name: string;
  /** Compiled-in hard clamp the estimator can never exit. */
  clampMin: number;
  clampMax: number;
  /** Conservative default = the SAFE NO-OP end of the clamp; used until the floor is first met.
   *  For a trust pass-rate threshold this is the HARDEST value (never auto-clear). */
  conservativeDefault: number;
  /** Max absolute change per window (bounded step). */
  maxStep: number;
  /** The estimator must agree in the SAME direction for this many consecutive windows before a
   *  move promotes (hysteresis). 1 = no hysteresis. */
  hysteresisK: number;
  /** No recalibration until at least this many labeled observations in the window. */
  floorSamples: number;
  /** Shadow-before-promote ceiling (ABSOLUTE): a candidate is promoted only if its guardrail on
   *  the held-out window is at or below this. Absolute, NOT relative-to-incumbent — a relative
   *  "no worse than incumbent" check structurally blocks every threshold-LOOSENING (a lower
   *  trust threshold clears more and can only raise the false-clear rate), so the ladder could
   *  never loosen. This ceiling = the estimator's target operating point; the estimator already
   *  selects a value meeting it, and the higher rollback ceiling is the live safety net. */
  guardrailPromoteCeiling: number;
  /** After promotion, if the live guardrail exceeds this hard ceiling the loop reverts to the
   *  last-known-good value and records outcome='rollback'. Must be ≥ guardrailPromoteCeiling
   *  (headroom above the target before an auto-revert fires). */
  guardrailRollbackCeiling: number;
  /** Fetch the evidence for this constant over [windowStart, windowEnd) for one tenant. */
  gatherEvidence(tenantId: string, windowStart: Date, windowEnd: Date): Promise<CalibrationEvidence>;
}

export interface CalibrationRunRow {
  tenantId: string;
  constantName: string;
  windowStart: Date;
  windowEnd: Date;
  sampleCount: number;
  estimatorOutput: number | null;
  appliedValue: number;
  outcome: CalibrationOutcome;
  guardrailDelta: { incumbent: number; candidate: number } | null;
}
