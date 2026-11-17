/**
 * A cache WRITE is billed, and at its own rate.
 *
 * Anthropic charges a cache write at 1.25x the input rate and a cache read at
 * 0.1x — two numbers that both look like "cache" and differ by 12.5x.
 * `MODEL_PRICING` has published `cacheWrite5mPricePerMillion` for every Anthropic
 * model since the table existed, `pricing-tiers.ts` folds it through the
 * conditional bands, and `model-registry-loader.ts` sets it. Nothing multiplied it
 * by a token count: `calculateCost` had no parameter to receive one, so the rate
 * was correct, reachable, and billed nothing on the Anthropic engine.
 */

import { calculateCost, getModelPricing } from '../pricing';

describe('calculateCost and cache writes', () => {
  const MODEL = 'claude-opus-5';

  it('publishes a 5-minute cache-write rate for the model under test', () => {
    // If this ever stops being true the assertions below would pass vacuously.
    const p = getModelPricing(MODEL, 'anthropic');
    expect(p?.cacheWrite5mPricePerMillion).toBe(6.25);
    expect(p?.inputPricePerMillion).toBe(5.0);
    expect(p?.cachedInputPricePerMillion).toBe(0.5);
  });

  it('charges cache writes at 1.25x input, on top of every other bucket', () => {
    const without = calculateCost(MODEL, 'anthropic', 1_000, 100, 10_000);
    const with_ = calculateCost(MODEL, 'anthropic', 1_000, 100, 10_000, { cacheWriteTokens: 40_000 });
    expect(without).not.toBeNull();
    expect(with_).not.toBeNull();
    // 40,000 at $6.25/M = $0.25, added to whatever the rest cost.
    expect(with_!.costUsd - without!.costUsd).toBeCloseTo(0.25, 10);
  });

  it('does not reallocate input: Anthropic reports input exclusive of both cache counts', () => {
    // The fresh-input charge must be unchanged by the presence of cache writes.
    // If cache writes were ever subtracted from input, this is what would move.
    const a = calculateCost(MODEL, 'anthropic', 1_000, 0, 0);
    const b = calculateCost(MODEL, 'anthropic', 1_000, 0, 0, { cacheWriteTokens: 500_000 });
    expect(b!.costUsd - a!.costUsd).toBeCloseTo(500_000 * 6.25 / 1e6, 10);
    expect(a!.costUsd).toBeCloseTo(1_000 * 5.0 / 1e6, 10);
  });

  it('reports the rate it priced at, so a stored row can reproduce the charge', () => {
    const r = calculateCost(MODEL, 'anthropic', 10, 10, 0, { cacheWriteTokens: 10 });
    expect(r!.cacheWritePricePerMillion).toBe(6.25);
  });

  it('is a no-op for a vendor that does not charge for a cache write', () => {
    // Every OpenAI-convention provider writes its cache for free. Passing the
    // count must not invent a charge where the model publishes no rate.
    const p = getModelPricing('gpt-5.2', 'openai');
    if (p && !p.cacheWrite5mPricePerMillion) {
      const a = calculateCost('gpt-5.2', 'openai', 1_000, 100, 0);
      const b = calculateCost('gpt-5.2', 'openai', 1_000, 100, 0, { cacheWriteTokens: 100_000 });
      expect(b!.costUsd).toBeCloseTo(a!.costUsd, 12);
      expect(b!.cacheWritePricePerMillion).toBeUndefined();
    }
  });

  it('treats a zero or absent count as no charge', () => {
    const base = calculateCost(MODEL, 'anthropic', 100, 10, 0);
    expect(calculateCost(MODEL, 'anthropic', 100, 10, 0, { cacheWriteTokens: 0 })!.costUsd)
      .toBeCloseTo(base!.costUsd, 12);
    expect(calculateCost(MODEL, 'anthropic', 100, 10, 0, {})!.costUsd)
      .toBeCloseTo(base!.costUsd, 12);
  });

  it('prices a large cache-heavy turn, and the write is not a rounding detail', () => {
    // A high-volume shape: hundreds of millions of cache reads at a vendor
    // write/read ratio of about 0.14 implies on the order of a hundred million
    // cache writes, which would bill nothing.
    const reads = 840_478_932;
    const writes = Math.round(reads * 0.1371);
    const withWrites = calculateCost(MODEL, 'anthropic', 621_221, 19_853_483, reads, { cacheWriteTokens: writes });
    const without = calculateCost(MODEL, 'anthropic', 621_221, 19_853_483, reads);
    const missed = withWrites!.costUsd - without!.costUsd;
    expect(missed).toBeGreaterThan(700);
    expect(missed).toBeLessThan(740);
  });
});
