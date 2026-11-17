/**
 * Gemini 3.1 Pro reprices above 200K prompt tokens, and this runtime priced it flat.
 *
 * Google charges $2.00 / $12.00 / $0.20 up to 200K prompt tokens and
 * $4.00 / $18.00 / $0.40 above it (verified against Google's own pricing table
 * 2026-09-26). The mechanism to express that has existed since migration 379 —
 * `pricing.overrides`, evaluated by `pricing-tiers.ts` — and is used for OpenAI's
 * 272K band and for platform-backend's copy of this very entry. It was simply not
 * entered here, so every long-context Pro call would bill at half its input cost.
 *
 * `gemini-3.1-pro-preview` is the `large` tier AND the default model, so this is
 * the most-used Gemini id rather than an edge one.
 */

import { calculateCost } from '../pricing';

const MODEL = 'gemini-3.1-pro-preview';
const at = new Date('2026-09-26T12:00:00Z');

describe('the Gemini Pro long-context band', () => {
  it('bills the base rate at exactly 200K, because the threshold is STRICTLY greater', () => {
    const r = calculateCost(MODEL, 'google', 200_000, 1_000, 0, { at });
    expect(r!.inputPricePerMillion).toBe(2.0);
    expect(r!.outputPricePerMillion).toBe(12.0);
  });

  it('reprices the WHOLE request one token past the threshold', () => {
    const r = calculateCost(MODEL, 'google', 200_001, 1_000, 0, { at });
    expect(r!.inputPricePerMillion).toBe(4.0);
    expect(r!.outputPricePerMillion).toBe(18.0);
    // The whole request, not the excess: every one of the 200,001 input tokens
    // is charged at $4.00, which is what the band means.
    expect(r!.costUsd).toBeCloseTo((200_001 * 4.0 + 1_000 * 18.0) / 1e6, 10);
  });

  it('doubles the cached-input rate in the band too', () => {
    const r = calculateCost(MODEL, 'google', 300_000, 100, 50_000, { at });
    expect(r!.cachedInputPricePerMillion).toBe(0.4);
  });

  it('measures the threshold on the prompt TOTAL, which for Google already includes the cached part', () => {
    // Google's promptTokenCount is inclusive, so `inputTokens` alone is the
    // figure the band is tested against — subtracting the cached part first would
    // trip the band late on every cache-heavy request.
    const r = calculateCost(MODEL, 'google', 250_000, 100, 240_000, { at });
    expect(r!.inputPricePerMillion).toBe(4.0);
  });

  it('is what a flat table under-charged: half the input cost on a long call', () => {
    const banded = calculateCost(MODEL, 'google', 400_000, 5_000, 0, { at })!;
    const flatInput = (400_000 * 2.0 + 5_000 * 12.0) / 1e6;
    expect(banded.costUsd).toBeGreaterThan(flatInput * 1.9);
  });

  it('leaves the two Flash models flat, which is what Google publishes', () => {
    for (const m of ['gemini-3.5-flash', 'gemini-3.1-flash-lite']) {
      const small = calculateCost(m, 'google', 1_000, 100, 0, { at })!;
      const huge = calculateCost(m, 'google', 900_000, 100, 0, { at })!;
      expect(huge.inputPricePerMillion).toBe(small.inputPricePerMillion);
      expect(huge.outputPricePerMillion).toBe(small.outputPricePerMillion);
    }
  });

  it('suppresses the band for an aggregated total, which no single request reached', () => {
    // A sum over several calls is a number none of them had; testing it against a
    // threshold charges a band nothing justifies.
    const r = calculateCost(MODEL, 'google', 500_000, 1_000, 0, { at, aggregated: true });
    expect(r!.inputPricePerMillion).toBe(2.0);
  });
});
