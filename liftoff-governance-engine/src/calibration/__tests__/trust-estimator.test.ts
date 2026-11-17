// A6 — the deterministic trust estimator (pure selection math).

import { falseClearRateAt, estimateThreshold, type TrustObservation } from '../trust-constants';

const obs = (passRate: number, falseClear: boolean): TrustObservation => ({ passRate, falseClear });

describe('falseClearRateAt', () => {
  it('is the false-clear fraction among cells that clear at the threshold', () => {
    const data = [obs(0.9, true), obs(0.95, false), obs(0.99, false), obs(0.7, true)];
    // threshold 0.9 clears the first three: 1 false-clear / 3 = 0.333…
    expect(falseClearRateAt(data, 0.9)).toBeCloseTo(1 / 3);
    // threshold 0.96 clears only 0.99: 0 false-clears.
    expect(falseClearRateAt(data, 0.96)).toBe(0);
  });

  it('is 0 when nothing clears', () => {
    expect(falseClearRateAt([obs(0.5, true)], 0.9)).toBe(0);
    expect(falseClearRateAt([], 0.9)).toBe(0);
  });
});

describe('estimateThreshold', () => {
  it('returns the LOWEST threshold that still holds the false-clear rate at/below target', () => {
    // Two bad (false-clear) cells at 0.9 and 0.92; clean cells at 0.97+.
    const data = [obs(0.9, true), obs(0.92, true), obs(0.97, false), obs(0.98, false), obs(0.99, false)];
    // target 0 ⇒ must exclude both bad cells ⇒ lowest clean-only threshold is 0.93.
    const t = estimateThreshold(data, 0, 0.8, 1.0);
    expect(t).not.toBeNull();
    expect(falseClearRateAt(data, t as number)).toBe(0);
    expect(t as number).toBeLessThanOrEqual(0.97);
    expect(t as number).toBeGreaterThan(0.92);
  });

  it('tolerates the target: a small false-clear rate is acceptable at a lower threshold', () => {
    const data = [obs(0.9, true), obs(0.91, false), obs(0.92, false), obs(0.93, false)];
    // target 0.25 ⇒ 1/4 at threshold 0.9 is acceptable ⇒ lowest is 0.8-ish (clamp floor).
    const t = estimateThreshold(data, 0.25, 0.8, 1.0);
    expect(t).toBeCloseTo(0.8);
  });

  it('returns null when no in-range threshold can meet the target', () => {
    // Every cell is a false clear at a passRate spanning the whole clamp, so no threshold
    // between 0.8 and 1.0 excludes them all.
    const data = [obs(0.85, true), obs(0.9, true), obs(0.95, true), obs(1.0, true)];
    expect(estimateThreshold(data, 0, 0.8, 1.0)).toBeNull();
  });

  it('cold start: no observations ⇒ the lowest threshold trivially meets the target (rate 0)', () => {
    // With no data every threshold has false-clear rate 0, so the estimator returns clampMin.
    // (The loop still HOLDS because sampleCount 0 < floor — this only asserts the pure math.)
    expect(estimateThreshold([], 0, 0.8, 1.0)).toBeCloseTo(0.8);
  });
});
