// Conditional pricing override evaluator — the tenant-runtime mirror.
//
// These assertions are deliberately the SAME assertions as platform-backend's
// src/llm/__tests__/pricing-tiers.test.ts. The two planes price the same call,
// and nothing at runtime compares their answers, so the only thing keeping them
// honest is that both are pinned to identical expectations here. If you change
// a number in one file, the other is now a bug.
import {
  effectivePricing,
  totalPromptTokensFor,
  type PricingOverride,
} from '../pricing-tiers';
import { calculateCost, MODEL_PRICING, freshInputTokensFor } from '../pricing';

const BASE = {
  inputPricePerMillion: 1,
  outputPricePerMillion: 2,
  cachedInputPricePerMillion: 5,
  cacheWrite5mPricePerMillion: 3,
  cacheWrite1hPricePerMillion: 4,
};
const AT = new Date('2026-08-28T12:00:00Z');

describe('minPromptTokens is STRICTLY greater', () => {
  const overrides: PricingOverride[] = [{ minPromptTokens: 200_000, input: 10, output: 20 }];

  it('does NOT apply at exactly the threshold', () => {
    const p = effectivePricing(BASE, overrides, { promptTokens: 200_000, at: AT });
    expect(p.inputPricePerMillion).toBe(1);
    expect(p.outputPricePerMillion).toBe(2);
  });

  it('applies one token above the threshold', () => {
    const p = effectivePricing(BASE, overrides, { promptTokens: 200_001, at: AT });
    expect(p.inputPricePerMillion).toBe(10);
    expect(p.outputPricePerMillion).toBe(20);
  });
});

describe('whole-request reprice, not marginal', () => {
  it('bills every input token at the override rate', () => {
    const overrides: PricingOverride[] = [{ minPromptTokens: 200_000, input: 10 }];
    const p = effectivePricing(BASE, overrides, { promptTokens: 300_000, at: AT });
    expect((300_000 * p.inputPricePerMillion) / 1_000_000).toBeCloseTo(3.0, 10);
  });
});

describe('applicable entries fold per key', () => {
  it('later wins per key; absent keys inherit base', () => {
    const overrides: PricingOverride[] = [
      { minPromptTokens: 32_000, input: 10, output: 20 },
      { minPromptTokens: 128_000, input: 30 },
    ];
    const p = effectivePricing(BASE, overrides, { promptTokens: 200_000, at: AT });
    expect(p.inputPricePerMillion).toBe(30);
    expect(p.outputPricePerMillion).toBe(20);
    expect(p.cachedInputPricePerMillion).toBe(5);
  });

  it('treats an explicit 0 as a real rate', () => {
    const overrides: PricingOverride[] = [{ minPromptTokens: 1, cacheRead: 0 }];
    expect(
      effectivePricing(BASE, overrides, { promptTokens: 100, at: AT }).cachedInputPricePerMillion,
    ).toBe(0);
  });
});

describe('UTC windows are half-open and wrap past midnight', () => {
  const at = (hhmm: string) => new Date(`2026-08-28T${hhmm}:00Z`);

  it('includes start, excludes end', () => {
    const o: PricingOverride[] = [{ utcStart: 1630, utcEnd: 1800, input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('16:30') }).inputPricePerMillion).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('18:00') }).inputPricePerMillion).toBe(1);
  });

  it('wraps when start > end', () => {
    const o: PricingOverride[] = [{ utcStart: 1630, utcEnd: 30, input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('23:00') }).inputPricePerMillion).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('00:15') }).inputPricePerMillion).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('00:30') }).inputPricePerMillion).toBe(1);
  });
});

describe('utcDays confines an entry to named UTC weekdays', () => {
  // Real dates, named, because "does Saturday count as a weekday" is the whole
  // question and an opaque timestamp hides the answer.
  const FRIDAY   = new Date('2026-09-11T02:00:00Z');
  const SATURDAY = new Date('2026-09-12T02:00:00Z');
  const MONDAY   = new Date('2026-09-14T02:00:00Z');

  const weekdayPeak: PricingOverride[] = [{
    utcDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    utcStart: 100,
    utcEnd: 400,
    input: 10,
  }];

  it('applies on a named day and not on an unnamed one', () => {
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: FRIDAY }).inputPricePerMillion).toBe(10);
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: MONDAY }).inputPricePerMillion).toBe(10);
    // The defect this field exists to stop: without the day list, 02:00 on a
    // Saturday is inside the window and bills at the weekday peak rate.
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: SATURDAY }).inputPricePerMillion).toBe(1);
  });

  it('is AND-ed with the window, not folded into it', () => {
    const fridayNoon = new Date('2026-09-11T12:00:00Z');
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: fridayNoon }).inputPricePerMillion).toBe(1);
  });

  it('matches a day list with no window at all, on those days only', () => {
    // DeepSeek's weekend entry has this exact shape — days, no window.
    const weekend: PricingOverride[] = [{ utcDays: ['saturday', 'sunday'], input: 10 }];
    expect(effectivePricing(BASE, weekend, { promptTokens: 1, at: SATURDAY }).inputPricePerMillion).toBe(10);
    expect(effectivePricing(BASE, weekend, { promptTokens: 1, at: FRIDAY }).inputPricePerMillion).toBe(1);
  });

  it('names no day when the list is empty, and so matches nothing', () => {
    const o: PricingOverride[] = [{ utcDays: [], input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: FRIDAY }).inputPricePerMillion).toBe(1);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: SATURDAY }).inputPricePerMillion).toBe(1);
  });

  it('compares case-insensitively — the value is the vendor\'s own string', () => {
    const o: PricingOverride[] = [{ utcDays: ['Friday'], input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: FRIDAY }).inputPricePerMillion).toBe(10);
  });

  it('leaves an entry with no day list applying on every day', () => {
    const o: PricingOverride[] = [{ utcStart: 100, utcEnd: 400, input: 10 }];
    for (const at of [FRIDAY, SATURDAY, MONDAY]) {
      expect(effectivePricing(BASE, o, { promptTokens: 1, at }).inputPricePerMillion).toBe(10);
    }
  });
});

describe('no overrides is todays behaviour', () => {
  it('returns base untouched', () => {
    expect(effectivePricing(BASE, undefined, { promptTokens: 9e9, at: AT })).toBe(BASE);
    expect(effectivePricing(BASE, [], { promptTokens: 9e9, at: AT })).toBe(BASE);
  });
});

describe('token basis follows the provider convention', () => {
  it('matches platform-backend exactly', () => {
    expect(totalPromptTokensFor('anthropic', 1000, 500, 200)).toBe(1700);
    expect(totalPromptTokensFor('anthropic-vertex', 1000, 500, 200)).toBe(1700);
    expect(totalPromptTokensFor('glm', 1000, 500, 0)).toBe(1000);
    expect(freshInputTokensFor('glm', 1000, 400)).toBe(600);
    expect(freshInputTokensFor('anthropic', 1000, 400)).toBe(1000);
  });
});

describe('calculateCost applies bands end to end', () => {
  const MODEL = 'qwen/qwen3.7-flash';

  it('has bands configured in the static seed', () => {
    expect(MODEL_PRICING[`openrouter:${MODEL}`].overrides?.length).toBe(2);
  });

  it('bills base below the first threshold and the band above it', () => {
    const below = calculateCost(MODEL, 'qwen', 10_000, 0, 0, { at: AT });
    const above = calculateCost(MODEL, 'qwen', 100_000, 0, 0, { at: AT });
    expect(below?.costUsd).toBeCloseTo((10_000 * 0.03) / 1_000_000, 12);
    expect(above?.costUsd).toBeCloseTo((100_000 * 0.10) / 1_000_000, 12);
  });

  it('prices Grok under its native id even when the config carries OpenRouter\'s slug', () => {
    // A config written before Grok left OpenRouter still says `x-ai/grok-4.6`.
    // The adapter strips it at the wire, so the CALL works; under the raw key
    // the rate lookup misses and the run records its tokens at zero cost — the
    // failure is silent, which is why it is pinned here.
    const slug   = calculateCost('x-ai/grok-4.6', 'xai', 100_000, 0, 0, { at: AT });
    const native = calculateCost('grok-4.6',      'xai', 100_000, 0, 0, { at: AT });
    expect(slug?.costUsd).toBeCloseTo(native?.costUsd ?? -1, 12);
    expect(native?.costUsd).toBeCloseTo((100_000 * 2.0) / 1_000_000, 12);
  });

  it('leaves the other OpenRouter-hosted vendors on their namespaced keys', () => {
    // Only Grok moved. GLM still bills to OpenRouter and is still keyed there.
    // Rate read from the table rather than restated: what is under test is that
    // the key resolves, and a literal here only pins whatever the rate happened
    // to be on the day it was written.
    const glm = calculateCost('z-ai/glm-5.2', 'glm', 100_000, 0, 0, { at: AT });
    const rate = MODEL_PRICING['glm:z-ai/glm-5.2'].inputPricePerMillion;
    expect(glm?.costUsd).toBeCloseTo((100_000 * rate) / 1_000_000, 12);
  });

  it('Grok doubles AT 200k, because xAI\'s threshold is inclusive', () => {
    // xAI: "requests whose prompt REACHES 200k tokens are billed at the higher
    // rate for all tokens in the request." `minPromptTokens` is strictly
    // greater, so an inclusive 200k is spelled 199_999 — and this is the case
    // that catches anyone who tidies it back to 200_000.
    const under  = calculateCost('grok-4.6', 'xai', 199_999, 0, 0, { at: AT });
    const at200k = calculateCost('grok-4.6', 'xai', 200_000, 0, 0, { at: AT });
    expect(under?.costUsd).toBeCloseTo((199_999 * 2.0) / 1_000_000, 12);
    expect(at200k?.costUsd).toBeCloseTo((200_000 * 4.0) / 1_000_000, 12);
  });

  it('reports the EFFECTIVE rate in the price snapshot, not the base', () => {
    // These values are persisted onto the invocation. Reporting the base while
    // charging the band would make the stored snapshot disagree with the money.
    const over = calculateCost('grok-4.6', 'xai', 200_001, 0, 0, { at: AT });
    expect(over?.inputPricePerMillion).toBe(4.0);
    expect(over?.outputPricePerMillion).toBe(12.0);
  });

  it('SUPPRESSES bands when the caller says the tokens are aggregated', () => {
    // A coding session reports per-model totals with no per-request breakdown.
    // Testing a threshold against that sum would charge a long-context band no
    // single request reached.
    const agg = calculateCost('grok-4.6', 'xai', 300_000, 0, 0, { aggregated: true });
    expect(agg?.costUsd).toBeCloseTo((300_000 * 2.0) / 1_000_000, 12);
  });
});
