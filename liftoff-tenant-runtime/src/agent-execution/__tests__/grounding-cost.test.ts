// Exercises the ACTUAL helper both invocation-completion sites in service.ts
// call (computeGroundingCost) — not a reimplementation — against the exact
// step.output shape the `case 'usage'` handler writes.
import { computeGroundingCost } from '../grounding-cost';

describe('computeGroundingCost', () => {
  it('sums webSearchRequests across usage steps and prices at $0.014/query', () => {
    // Shape matches what service.ts case 'usage' stores on each step.
    const steps = [
      { output: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, webSearchRequests: 2 } },
      { output: { inputTokens: 8, outputTokens: 4, cachedTokens: 0, webSearchRequests: 1 } },
      { output: { inputTokens: 3, outputTokens: 1, cachedTokens: 0, webSearchRequests: 0 } },
    ];
    const r = computeGroundingCost(steps, 'google');
    expect(r.queries).toBe(3);
    expect(r.costUsd).toBeCloseTo(0.042, 9);
  });

  it('returns zero cost when no step grounded', () => {
    const r = computeGroundingCost([{ output: { inputTokens: 5, outputTokens: 2, cachedTokens: 0 } }], 'google');
    expect(r).toEqual({ queries: 0, costUsd: 0 });
  });

  it('tolerates missing or empty step output', () => {
    const r = computeGroundingCost([{}, { output: undefined }, { output: { inputTokens: 1 } }], 'google');
    expect(r).toEqual({ queries: 0, costUsd: 0 });
  });
});
