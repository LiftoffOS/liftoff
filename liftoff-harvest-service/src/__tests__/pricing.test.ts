import { computeCostUsd, MODEL_PRICING } from '../pricing';

describe('computeCostUsd', () => {
  it('returns positive number for known claude-haiku model', () => {
    const cost = computeCostUsd('claude-haiku-4-5', 1000, 500);
    expect(cost).toBeGreaterThan(0);
  });

  it('returns the default-pricing cost for an unknown model (does not throw)', () => {
    const unknown = computeCostUsd('does-not-exist', 1000, 500);
    const expected =
      (1000 / 1000) * MODEL_PRICING.default.inputPer1k +
      (500 / 1000) * MODEL_PRICING.default.outputPer1k;
    expect(unknown).toBeCloseTo(expected, 8);
  });

  it('scales linearly with token count', () => {
    const a = computeCostUsd('claude-haiku-4-5', 1000, 1000);
    const b = computeCostUsd('claude-haiku-4-5', 2000, 2000);
    expect(b).toBeCloseTo(a * 2, 8);
  });

  it('returns 0 when both token counts are 0', () => {
    expect(computeCostUsd('claude-haiku-4-5', 0, 0)).toBe(0);
  });
});
