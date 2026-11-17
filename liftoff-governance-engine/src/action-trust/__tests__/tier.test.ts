// computeTier unit tests — the pure heart of the trust ledger.
//
// These assert the PROVISIONAL threshold behavior: insufficient evidence and
// low pass-rate both land in 'watch'; a strong, well-established record earns
// 'auto'; a regression mechanically demotes.

import {
  computeTier,
  passRateOf,
  MIN_RUNS_FOR_AUTO,
  MIN_RUNS_FOR_QUEUE,
  PROMOTE_PASS_RATE,
  DEMOTE_PASS_RATE,
} from '../tier';

describe('computeTier', () => {
  it('returns watch below MIN_RUNS_FOR_QUEUE even with a perfect record', () => {
    expect(computeTier(0, 0, 0)).toBe('watch');
    expect(computeTier(MIN_RUNS_FOR_QUEUE - 1, MIN_RUNS_FOR_QUEUE - 1, 0)).toBe('watch');
  });

  it('promotes to queue once there is enough evidence but not enough for auto', () => {
    // At/above MIN_RUNS_FOR_QUEUE, high pass-rate, but below MIN_RUNS_FOR_AUTO.
    const runs = MIN_RUNS_FOR_QUEUE;
    expect(runs).toBeLessThan(MIN_RUNS_FOR_AUTO);
    expect(computeTier(runs, runs, 0)).toBe('queue');
  });

  it('reaches auto with enough runs and a pass-rate at/above PROMOTE', () => {
    expect(computeTier(MIN_RUNS_FOR_AUTO, MIN_RUNS_FOR_AUTO, 0)).toBe('auto');
    // Exactly at the promote threshold with enough runs.
    const runs = 40;
    const passes = Math.ceil(runs * PROMOTE_PASS_RATE);
    expect(passRateOf(runs, passes)).toBeGreaterThanOrEqual(PROMOTE_PASS_RATE);
    expect(computeTier(runs, passes, runs - passes)).toBe('auto');
  });

  it('stays queue (not auto) when runs are high but pass-rate is only middling', () => {
    // pass-rate between DEMOTE and PROMOTE → trusted for queue, not auto.
    const runs = 50;
    const passes = Math.round(runs * 0.9); // 0.9 is in (DEMOTE=0.8, PROMOTE=0.95)
    const rate = passRateOf(runs, passes);
    expect(rate).toBeGreaterThanOrEqual(DEMOTE_PASS_RATE);
    expect(rate).toBeLessThan(PROMOTE_PASS_RATE);
    expect(computeTier(runs, passes, runs - passes)).toBe('queue');
  });

  it('demotes to watch when pass-rate falls below DEMOTE, regardless of history', () => {
    const runs = 100;
    const passes = Math.round(runs * 0.5); // well below DEMOTE
    expect(computeTier(runs, passes, runs - passes)).toBe('watch');
  });

  it('mechanically demotes an auto agent once rejects accumulate (regression)', () => {
    // Was auto: 20 runs, 20 passes.
    expect(computeTier(20, 20, 0)).toBe('auto');
    // Then a wave of rejections drags pass-rate under DEMOTE → watch.
    expect(computeTier(40, 20, 20)).toBe('watch');
    // A milder regression (pass-rate ~0.83) drops auto → queue, not all the
    // way to watch.
    expect(computeTier(48, 40, 8)).toBe('queue');
  });

  it('clamps malformed / negative inputs instead of over-trusting', () => {
    expect(computeTier(-5, -5, 0)).toBe('watch');
    expect(computeTier(30.9, 30.9, 0)).toBe('auto'); // floored, still strong
  });

  it('exposes provisional thresholds in a sane ordering', () => {
    expect(DEMOTE_PASS_RATE).toBeLessThan(PROMOTE_PASS_RATE);
    expect(MIN_RUNS_FOR_QUEUE).toBeLessThan(MIN_RUNS_FOR_AUTO);
  });
});

describe('passRateOf', () => {
  it('is 0 when there are no graded runs', () => {
    expect(passRateOf(0, 0)).toBe(0);
    expect(passRateOf(-1, 5)).toBe(0);
  });
  it('is passes / runs otherwise', () => {
    expect(passRateOf(4, 3)).toBeCloseTo(0.75);
  });
});
