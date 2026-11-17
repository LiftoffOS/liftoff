import { COMPOSIO_COST_PER_CALL_USD, composioCallsToCostUsd } from '../composio-pricing';

describe('Composio pricing', () => {
  it('exposes the Ridiculously Cheap marginal rate ($0.299 / 1K calls)', () => {
    // Pinning the constant — if anyone changes it without updating the
    // module docstring + reconciling historical cost rows, this test
    // forces a conversation.
    expect(COMPOSIO_COST_PER_CALL_USD).toBe(0.000299);
  });

  it('computes call-count × per-call rate', () => {
    expect(composioCallsToCostUsd(1)).toBe(0.000299);
    expect(composioCallsToCostUsd(1000)).toBeCloseTo(0.299, 6);
    expect(composioCallsToCostUsd(200_000)).toBeCloseTo(59.8, 4); // 200K × $0.000299
  });

  it('returns 0 for non-positive or non-finite input', () => {
    expect(composioCallsToCostUsd(0)).toBe(0);
    expect(composioCallsToCostUsd(-5)).toBe(0);
    expect(composioCallsToCostUsd(NaN)).toBe(0);
    expect(composioCallsToCostUsd(Infinity)).toBe(0);
  });
});
