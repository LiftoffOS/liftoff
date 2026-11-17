// the generic guardrailed calibration loop.
//
// One pure-ish function evaluates one (tenant, constant, window) and returns/records exactly
// one calibration_runs row. It implements the seven guardrails in order; each is what makes
// "automatic, no human review" safe:
//
//   (6) auto-rollback circuit-breaker  — checked first: a live guardrail breach reverts to
//                                        last-known-good before anything else.
//   (2) sample-size floor              — thin data holds (the cold-start no-op).
//   (3) hard clamp                     — estimator output pinned into [min,max].
//   (4) bounded step + hysteresis      — move at most maxStep, and only after K windows agree.
//   (5) shadow-before-promote          — candidate guardrail within the absolute promote ceiling.
//   (7) audit artifact                 — every path writes an immutable row.
//   (1) selection rule                 — lives in the constant's estimator (gatherEvidence).
//
// The store is injected so the loop is unit-testable without a database.

import type { CalibrationConstant, CalibrationOutcome, CalibrationRunRow } from './types';

export interface CalibrationStore {
  /** The value currently IN FORCE — the most recent run's applied_value regardless of outcome
   *  (promote/hold/rollback all leave a value in force). This is what serving reads and what the
   *  loop steps from, so a rollback actually changes the served value. Null before the first run. */
  currentValue(tenantId: string, name: string): Promise<number | null>;
  /** Most recent promoted applied_value for (tenant, constant), or null if never promoted. Used
   *  only to decide whether the rollback circuit-breaker is armed (skipped on the cold-start default). */
  lastPromotedValue(tenantId: string, name: string): Promise<number | null>;
  /** Recent run rows (most-recent first) for hysteresis + last-known-good lookup. */
  recentRuns(
    tenantId: string,
    name: string,
    limit: number,
  ): Promise<Array<Pick<CalibrationRunRow, 'estimatorOutput' | 'appliedValue' | 'outcome'>>>;
  insertRun(row: CalibrationRunRow): Promise<void>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function boundedStep(current: number, target: number, maxStep: number): number {
  const delta = clamp(target - current, -maxStep, maxStep);
  return current + delta;
}

export async function runCalibration(
  tenantId: string,
  constant: CalibrationConstant,
  windowStart: Date,
  windowEnd: Date,
  store: CalibrationStore,
): Promise<CalibrationRunRow> {
  const [inForce, lastPromoted] = await Promise.all([
    store.currentValue(tenantId, constant.name),
    store.lastPromotedValue(tenantId, constant.name),
  ]);
  const current = inForce ?? constant.conservativeDefault;
  const evidence = await constant.gatherEvidence(tenantId, windowStart, windowEnd);

  const record = async (
    outcome: CalibrationOutcome,
    appliedValue: number,
    guardrailDelta: { incumbent: number; candidate: number } | null,
  ): Promise<CalibrationRunRow> => {
    const row: CalibrationRunRow = {
      tenantId,
      constantName: constant.name,
      windowStart,
      windowEnd,
      sampleCount: evidence.sampleCount,
      estimatorOutput: evidence.estimatorOutput,
      appliedValue,
      outcome,
      guardrailDelta,
    };
    await store.insertRun(row);
    return row;
  };

  // (6) AUTO-ROLLBACK CIRCUIT-BREAKER. Armed only once a value has been promoted (never on the
  // cold-start default). If the LIVE in-force value's guardrail has breached the hard ceiling,
  // revert to the last-known-good and stop. Because serving reads currentValue (the in-force
  // value, updated below), the reverted value actually takes effect — not merely an audit record.
  if (lastPromoted !== null) {
    const liveGuardrail = await evidence.guardrail(current);
    if (Number.isFinite(liveGuardrail) && liveGuardrail > constant.guardrailRollbackCeiling) {
      // Walk the promote history newest→oldest and revert to the most recent promoted value that
      // is STILL within the rollback ceiling on this window (true last-known-good). Re-checking
      // each candidate avoids reverting to a value that also breaches (which would re-fire every
      // window). Fall back to the conservative default — the known-safe end — when none qualifies.
      const recent = await store.recentRuns(tenantId, constant.name, 50);
      const priorPromotes = recent
        .filter((r) => r.outcome === 'promote' && Number.isFinite(r.appliedValue) && r.appliedValue !== current)
        .map((r) => r.appliedValue);
      let reverted = clamp(constant.conservativeDefault, constant.clampMin, constant.clampMax);
      let revertedGuardrail = await evidence.guardrail(reverted);
      for (const v of priorPromotes) {
        const g = await evidence.guardrail(v);
        if (Number.isFinite(g) && g <= constant.guardrailRollbackCeiling) {
          reverted = clamp(v, constant.clampMin, constant.clampMax);
          revertedGuardrail = g;
          break;
        }
      }
      return record('rollback', reverted, { incumbent: liveGuardrail, candidate: revertedGuardrail });
    }
  }

  // (2) SAMPLE-SIZE FLOOR — thin data or no estimate ⇒ hold. This is the cold-start no-op:
  // with no labeled data the loop runs and returns `hold`, holding the conservative default.
  if (evidence.sampleCount < constant.floorSamples || evidence.estimatorOutput === null) {
    return record('hold', current, null);
  }

  // (3) HARD CLAMP, then (4) BOUNDED STEP.
  const clamped = clamp(evidence.estimatorOutput, constant.clampMin, constant.clampMax);
  const candidate = boundedStep(current, clamped, constant.maxStep);
  if (candidate === current) {
    // Estimator agrees with the value in force (within a step) — nothing to move.
    return record('hold', current, null);
  }

  // (4) HYSTERESIS — the estimator must have pointed the SAME direction (relative to the value
  // in force) for the last K-1 windows as well, so no single window swings the value.
  if (constant.hysteresisK > 1) {
    const need = constant.hysteresisK - 1;
    const recent = await store.recentRuns(tenantId, constant.name, need);
    const dirNow = Math.sign(clamped - current);
    const agree =
      recent.length >= need &&
      recent.every((r) => r.estimatorOutput !== null && Math.sign(r.estimatorOutput - current) === dirNow);
    if (!agree) {
      return record('hold', current, null);
    }
  }

  // (5) SHADOW-BEFORE-PROMOTE — the candidate's guardrail on the held-out window must be at or
  // below the constant's ABSOLUTE promote ceiling (its target operating point). This is NOT a
  // relative "no worse than the incumbent" check: a lower trust threshold clears strictly more
  // and can only RAISE the false-clear rate, so a relative check would block every loosening and
  // the ladder could never move off its conservative default. The estimator already picks a
  // value meeting the ceiling on its window; this confirms it on the held-out evaluation, and
  // the higher rollback ceiling (§6, live) is the post-promotion safety net.
  const gIncumbent = await evidence.guardrail(current);
  const gCandidate = await evidence.guardrail(candidate);
  const delta = { incumbent: gIncumbent, candidate: gCandidate };
  if (gCandidate > constant.guardrailPromoteCeiling) {
    return record('hold', current, delta);
  }

  return record('promote', candidate, delta);
}
