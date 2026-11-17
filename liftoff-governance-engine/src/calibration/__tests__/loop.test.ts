// Guardrailed calibration loop unit tests. Store + constant are injected so no DB is
// touched; each test isolates ONE guardrail.

import { runCalibration, type CalibrationStore } from '../loop';
import type { CalibrationConstant, CalibrationEvidence, CalibrationRunRow } from '../types';

const WSTART = new Date('2026-07-01T00:00:00Z');
const WEND = new Date('2026-07-08T00:00:00Z');

function makeStore(opts: {
  current?: number | null;
  lastPromoted?: number | null;
  recent?: Array<Pick<CalibrationRunRow, 'estimatorOutput' | 'appliedValue' | 'outcome'>>;
}): CalibrationStore & { rows: CalibrationRunRow[] } {
  const rows: CalibrationRunRow[] = [];
  // In-force value defaults to the last-promoted value when not set explicitly.
  const inForce = opts.current !== undefined ? opts.current : (opts.lastPromoted ?? null);
  return {
    rows,
    currentValue: async () => inForce,
    lastPromotedValue: async () => opts.lastPromoted ?? null,
    recentRuns: async (_t, _n, limit) => (opts.recent ?? []).slice(0, limit),
    insertRun: async (row) => {
      rows.push(row);
    },
  };
}

function makeConstant(over: Partial<CalibrationConstant> & { evidence: Partial<CalibrationEvidence> }): CalibrationConstant {
  const { evidence, ...rest } = over;
  return {
    name: 'X',
    clampMin: 0.5,
    clampMax: 1.0,
    conservativeDefault: 1.0,
    maxStep: 0.05,
    hysteresisK: 1,
    floorSamples: 10,
    guardrailPromoteCeiling: 0.05,
    guardrailRollbackCeiling: 0.05,
    gatherEvidence: async (): Promise<CalibrationEvidence> => ({
      // distinguish an explicit null (estimator produced nothing) from an absent override.
      estimatorOutput: evidence.estimatorOutput === undefined ? 0.8 : evidence.estimatorOutput,
      sampleCount: evidence.sampleCount ?? 100,
      guardrail: evidence.guardrail ?? (() => 0),
    }),
    ...rest,
  };
}

describe('runCalibration guardrails', () => {
  it('(floor) holds the conservative default on thin data and still writes an audit row', async () => {
    const store = makeStore({ lastPromoted: null });
    const c = makeConstant({ floorSamples: 10, evidence: { estimatorOutput: 0.7, sampleCount: 5 } });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('hold');
    expect(row.appliedValue).toBe(1.0); // conservative default
    expect(row.estimatorOutput).toBe(0.7);
    expect(store.rows).toHaveLength(1);
  });

  it('(floor) holds when the estimator cannot produce a value', async () => {
    const store = makeStore({ lastPromoted: null });
    const c = makeConstant({ evidence: { estimatorOutput: null, sampleCount: 500 } });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('hold');
    expect(row.appliedValue).toBe(1.0);
  });

  it('(clamp) pins an out-of-range estimate to the clamp before promoting', async () => {
    const store = makeStore({ lastPromoted: null });
    // estimate 0.3 is below clampMin 0.5; big step so clamp is what bounds it.
    const c = makeConstant({ maxStep: 1.0, evidence: { estimatorOutput: 0.3, sampleCount: 100 } });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('promote');
    expect(row.appliedValue).toBeCloseTo(0.5); // clamped, not 0.3
  });

  it('(bounded step) moves at most maxStep toward the target', async () => {
    const store = makeStore({ lastPromoted: null });
    const c = makeConstant({ maxStep: 0.05, evidence: { estimatorOutput: 0.5, sampleCount: 100 } });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('promote');
    expect(row.appliedValue).toBeCloseTo(0.95); // 1.0 - 0.05, not 0.5
  });

  it('(hysteresis) a single qualifying window holds; a second same-direction window promotes', async () => {
    // K=2 ⇒ needs 1 prior run whose estimator pointed the same way (below current).
    const first = await runCalibration(
      't1',
      makeConstant({ hysteresisK: 2, evidence: { estimatorOutput: 0.8, sampleCount: 100 } }),
      WSTART,
      WEND,
      makeStore({ lastPromoted: null, recent: [] }),
    );
    expect(first.outcome).toBe('hold'); // no prior agreement yet

    const second = await runCalibration(
      't1',
      makeConstant({ hysteresisK: 2, evidence: { estimatorOutput: 0.8, sampleCount: 100 } }),
      WSTART,
      WEND,
      makeStore({ lastPromoted: null, recent: [{ estimatorOutput: 0.85, appliedValue: 1.0, outcome: 'hold' }] }),
    );
    expect(second.outcome).toBe('promote');
    expect(second.appliedValue).toBeCloseTo(0.95);
  });

  it('(hysteresis) a prior window pointing the OTHER way blocks promotion', async () => {
    const row = await runCalibration(
      't1',
      makeConstant({ hysteresisK: 2, evidence: { estimatorOutput: 0.8, sampleCount: 100 } }),
      WSTART,
      WEND,
      // prior estimator 1.2 is ABOVE current 1.0 (opposite direction) ⇒ no agreement.
      makeStore({ lastPromoted: null, recent: [{ estimatorOutput: 1.2, appliedValue: 1.0, outcome: 'hold' }] }),
    );
    expect(row.outcome).toBe('hold');
  });

  it('(shadow) refuses to promote a candidate whose guardrail exceeds the absolute promote ceiling', async () => {
    const store = makeStore({ lastPromoted: null });
    const c = makeConstant({
      maxStep: 0.05,
      guardrailPromoteCeiling: 0.05,
      // candidate 0.95 → 0.10 false-clear, above the 0.05 promote ceiling ⇒ hold (the absolute
      // check; a relative "no worse than the 0.02 incumbent" check would ALSO hold here, but it
      // would wrongly block a loosening whose candidate is still within target — see loop.ts §5).
      evidence: { estimatorOutput: 0.5, sampleCount: 100, guardrail: (v) => (v >= 1.0 ? 0.02 : 0.1) },
    });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('hold');
    expect(row.guardrailDelta).toEqual({ incumbent: 0.02, candidate: 0.1 });
  });

  it('(shadow) PROMOTES a loosening whose candidate is within target even though it is worse than the incumbent', async () => {
    // The regression the OLD relative check wrongly blocked: incumbent 1.0 → 0 false-clear,
    // candidate 0.95 → 0.02 (worse than 0, but within the 0.05 promote ceiling) ⇒ promote.
    const store = makeStore({ lastPromoted: null });
    const c = makeConstant({
      maxStep: 0.05,
      guardrailPromoteCeiling: 0.05,
      evidence: { estimatorOutput: 0.5, sampleCount: 100, guardrail: (v) => (v >= 1.0 ? 0.0 : 0.02) },
    });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('promote');
    expect(row.appliedValue).toBeCloseTo(0.95);
  });

  it('(promote) moves the value when floor, clamp, hysteresis and shadow all pass', async () => {
    const store = makeStore({ lastPromoted: null });
    const c = makeConstant({ maxStep: 0.05, evidence: { estimatorOutput: 0.8, sampleCount: 100, guardrail: () => 0 } });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('promote');
    expect(row.appliedValue).toBeCloseTo(0.95);
  });

  it('(rollback) reverts to the prior good value when the live guardrail breaches the ceiling', async () => {
    // in force = 0.85; its live guardrail 0.20 > ceiling 0.05 ⇒ revert to 0.95.
    const store = makeStore({
      current: 0.85,
      lastPromoted: 0.85,
      recent: [
        { estimatorOutput: 0.85, appliedValue: 0.85, outcome: 'promote' },
        { estimatorOutput: 0.95, appliedValue: 0.95, outcome: 'promote' },
      ],
    });
    const c = makeConstant({
      guardrailRollbackCeiling: 0.05,
      evidence: { estimatorOutput: 0.8, sampleCount: 100, guardrail: (v) => (v <= 0.85 ? 0.2 : 0.0) },
    });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('rollback');
    expect(row.appliedValue).toBeCloseTo(0.95);
  });

  it('(rollback) SKIPS a prior promote that also breaches (no re-fire), walking to a good one', async () => {
    // In force 0.80 (breaches). Newest prior promote 0.85 ALSO breaches; only 0.95 is good.
    const store = makeStore({
      current: 0.80,
      lastPromoted: 0.80,
      recent: [
        { estimatorOutput: 0.80, appliedValue: 0.80, outcome: 'promote' },
        { estimatorOutput: 0.85, appliedValue: 0.85, outcome: 'promote' },
        { estimatorOutput: 0.95, appliedValue: 0.95, outcome: 'promote' },
      ],
    });
    const c = makeConstant({
      guardrailRollbackCeiling: 0.05,
      evidence: { estimatorOutput: 0.7, sampleCount: 100, guardrail: (v) => (v <= 0.85 ? 0.2 : 0.0) },
    });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('rollback');
    expect(row.appliedValue).toBeCloseTo(0.95); // 0.85 skipped (still breaches), walks to 0.95
  });

  it('(rollback) falls back to the conservative default when there is no prior good value', async () => {
    const store = makeStore({
      current: 0.85,
      lastPromoted: 0.85,
      recent: [{ estimatorOutput: 0.85, appliedValue: 0.85, outcome: 'promote' }],
    });
    const c = makeConstant({
      conservativeDefault: 1.0,
      guardrailRollbackCeiling: 0.05,
      evidence: { estimatorOutput: 0.8, sampleCount: 100, guardrail: (v) => (v <= 0.85 ? 0.2 : 0.0) },
    });
    const row = await runCalibration('t1', c, WSTART, WEND, store);
    expect(row.outcome).toBe('rollback');
    expect(row.appliedValue).toBeCloseTo(1.0);
  });
});
