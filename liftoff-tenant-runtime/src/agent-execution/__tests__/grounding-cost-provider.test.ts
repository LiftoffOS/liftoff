// computeGroundingCost is provider-aware, because a hosted web search costs a
// different amount at every vendor and is billed per CALL rather than per token.
//
// Every provider that runs a hosted search is named here explicitly. The one
// that bills 0 says WHY it bills 0, because "0" is the same value a missing
// implementation produces — Anthropic sat at 0 for months on exactly that
// ambiguity, while `WebSearch` was attached default-on to every Claude agent
// and Claude was the estate's default provider.
import { computeGroundingCost } from '../grounding-cost';

const steps = [{ output: { webSearchRequests: 2 } }, { output: { webSearchRequests: 1 } }];

it('google → $0.014/query', () => {
  expect(computeGroundingCost(steps, 'google')).toEqual({ queries: 3, costUsd: expect.closeTo(0.042, 9) });
});

it('openai → $0.01/call', () => {
  expect(computeGroundingCost(steps, 'openai')).toEqual({ queries: 3, costUsd: expect.closeTo(0.03, 9) });
});

it('xai → $0.005/call', () => {
  expect(computeGroundingCost(steps, 'xai')).toEqual({ queries: 3, costUsd: expect.closeTo(0.015, 9) });
});

it('anthropic → $0.010/call, the dearest of the four', () => {
  // $10 per 1,000 searches. Not a rounding difference from OpenAI's identical
  // rate by accident — both vendors publish $10/1k, and we billed one of them.
  expect(computeGroundingCost(steps, 'anthropic')).toEqual({ queries: 3, costUsd: expect.closeTo(0.03, 9) });
});

it('openrouter → 0, because it runs no hosted tools on our behalf', () => {
  // The only honest zero here: a fact about the vendor, not a missing rate.
  expect(computeGroundingCost(steps, 'openrouter')).toEqual({ queries: 3, costUsd: 0 });
});

it('no searches → 0', () => {
  expect(computeGroundingCost([{ output: {} }], 'openai')).toEqual({ queries: 0, costUsd: 0 });
});

it('every provider that runs hosted search bills something for it', () => {
  // The guard that would have caught Anthropic. A provider whose adapter
  // attaches a hosted web tool must have a rate: zero is indistinguishable from
  // a run that never searched, so the gap is invisible in every dashboard.
  const RUNS_HOSTED_SEARCH = ['google', 'openai', 'xai', 'anthropic'] as const;
  for (const provider of RUNS_HOSTED_SEARCH) {
    expect(computeGroundingCost(steps, provider).costUsd).toBeGreaterThan(0);
  }
});
