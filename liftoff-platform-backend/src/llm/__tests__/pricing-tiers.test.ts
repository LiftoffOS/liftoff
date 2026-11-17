// Conditional pricing override evaluator.
//
// Every assertion here is a billing assertion. The five semantics under test
// are each counterintuitive, each verified against openrouter.ai's own docs,
// and each one is a defect the moment it is "simplified" in the obvious
// direction: >= instead of >, marginal instead of whole-request, select instead
// of fold, inclusive instead of half-open, and a day list read as decoration
// rather than as a condition.
import {
  effectivePricing,
  totalPromptTokensFor,
  freshInputTokensFor,
  type PricingOverride,
} from '../pricing-tiers';
import { computeRowCost, MODEL_PRICING } from '../pricing';

const BASE = { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 };
const AT = new Date('2026-08-28T12:00:00Z');

describe('minPromptTokens is STRICTLY greater', () => {
  const overrides: PricingOverride[] = [{ minPromptTokens: 200_000, input: 10, output: 20 }];

  it('does NOT apply at exactly the threshold', () => {
    // The single most likely thing to get wrong. OpenRouter: "applies when the
    // total prompt tokens of a request are strictly greater than this
    // threshold". A prompt of exactly 200,000 pays the BASE rate.
    const p = effectivePricing(BASE, overrides, { promptTokens: 200_000, at: AT });
    expect(p.input).toBe(1);
    expect(p.output).toBe(2);
  });

  it('applies one token above the threshold', () => {
    const p = effectivePricing(BASE, overrides, { promptTokens: 200_001, at: AT });
    expect(p.input).toBe(10);
    expect(p.output).toBe(20);
  });

  it('does not apply below the threshold', () => {
    const p = effectivePricing(BASE, overrides, { promptTokens: 199_999, at: AT });
    expect(p.input).toBe(1);
  });
});

describe('the override is a WHOLE-REQUEST reprice, not a marginal rate', () => {
  it('bills every input token at the override rate, not just the excess', () => {
    // 300k tokens over a 200k threshold. Graduated (the intuitive-but-wrong
    // reading) would be 200k*1 + 100k*10 = 1.2M units. Whole-request is
    // 300k*10 = 3.0M units. The vendor bills the latter.
    const overrides: PricingOverride[] = [{ minPromptTokens: 200_000, input: 10 }];
    const p = effectivePricing(BASE, overrides, { promptTokens: 300_000, at: AT });
    const cost = (300_000 * p.input) / 1_000_000;
    expect(cost).toBeCloseTo(3.0, 10);
    expect(cost).not.toBeCloseTo(1.2, 10);
  });
});

describe('applicable entries FOLD per key, they do not select', () => {
  it('later entries win per key', () => {
    const overrides: PricingOverride[] = [
      { minPromptTokens: 32_000, input: 10, output: 20 },
      { minPromptTokens: 128_000, input: 30 }, // output deliberately absent
    ];
    const p = effectivePricing(BASE, overrides, { promptTokens: 200_000, at: AT });
    expect(p.input).toBe(30);  // later entry wins
    expect(p.output).toBe(20); // inherited from the EARLIER applicable entry
  });

  it('a key absent from every applicable entry inherits BASE, not zero', () => {
    // The failure mode this guards: materializing absent keys as 0 would make a
    // long-context request free on the dimensions the vendor did not restate.
    const overrides: PricingOverride[] = [{ minPromptTokens: 32_000, input: 10 }];
    const p = effectivePricing(BASE, overrides, { promptTokens: 50_000, at: AT });
    expect(p.output).toBe(2);
    expect(p.cacheRead).toBe(5);
    expect(p.cacheWrite5m).toBe(3);
  });

  it('only the entries whose conditions match take part in the fold', () => {
    const overrides: PricingOverride[] = [
      { minPromptTokens: 32_000, input: 10 },
      { minPromptTokens: 256_000, input: 99 }, // not reached at 50k
    ];
    const p = effectivePricing(BASE, overrides, { promptTokens: 50_000, at: AT });
    expect(p.input).toBe(10);
  });

  it('treats an explicit 0 rate as a real value, not as absent', () => {
    const overrides: PricingOverride[] = [{ minPromptTokens: 1, cacheRead: 0 }];
    const p = effectivePricing(BASE, overrides, { promptTokens: 100, at: AT });
    expect(p.cacheRead).toBe(0);
  });
});

describe('UTC windows are half-open and may wrap past midnight', () => {
  const at = (hhmm: string) => new Date(`2026-08-28T${hhmm}:00Z`);

  it('includes the start and EXCLUDES the end', () => {
    const o: PricingOverride[] = [{ utcStart: 1630, utcEnd: 1800, input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('16:30') }).input).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('17:59') }).input).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('18:00') }).input).toBe(1);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('16:29') }).input).toBe(1);
  });

  it('wraps past midnight when start > end', () => {
    const o: PricingOverride[] = [{ utcStart: 1630, utcEnd: 30, input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('23:00') }).input).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('00:15') }).input).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('00:30') }).input).toBe(1);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('12:00') }).input).toBe(1);
  });

  it('requires BOTH conditions when an entry declares tokens AND a window', () => {
    const o: PricingOverride[] = [{ minPromptTokens: 1000, utcStart: 1600, utcEnd: 1800, input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 2000, at: at('17:00') }).input).toBe(10);
    expect(effectivePricing(BASE, o, { promptTokens: 500,  at: at('17:00') }).input).toBe(1);
    expect(effectivePricing(BASE, o, { promptTokens: 2000, at: at('19:00') }).input).toBe(1);
  });

  it('ignores a half-specified window rather than guessing the missing bound', () => {
    const o: PricingOverride[] = [{ utcStart: 1600, input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: at('17:00') }).input).toBe(1);
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
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: FRIDAY }).input).toBe(10);
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: MONDAY }).input).toBe(10);
    // The defect this field exists to stop: without the day list, 02:00 on a
    // Saturday is inside the window and bills at the weekday peak rate.
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: SATURDAY }).input).toBe(1);
  });

  it('is AND-ed with the window, not folded into it', () => {
    // A named day OUTSIDE the window is still base — both conditions must hold.
    const fridayNoon = new Date('2026-09-11T12:00:00Z');
    expect(effectivePricing(BASE, weekdayPeak, { promptTokens: 1, at: fridayNoon }).input).toBe(1);
  });

  it('matches a day list with no window at all, on those days only', () => {
    // DeepSeek's weekend entry has this exact shape — days, no window. Dropping
    // the day list turns it into an UNCONDITIONAL entry, which is how a band
    // meant for two days comes to price all seven.
    const weekend: PricingOverride[] = [{ utcDays: ['saturday', 'sunday'], input: 10 }];
    expect(effectivePricing(BASE, weekend, { promptTokens: 1, at: SATURDAY }).input).toBe(10);
    expect(effectivePricing(BASE, weekend, { promptTokens: 1, at: FRIDAY }).input).toBe(1);
  });

  it('names no day when the list is empty, and so matches nothing', () => {
    const o: PricingOverride[] = [{ utcDays: [], input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: FRIDAY }).input).toBe(1);
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: SATURDAY }).input).toBe(1);
  });

  it('compares case-insensitively — the value is the vendor\'s own string', () => {
    const o: PricingOverride[] = [{ utcDays: ['Friday'], input: 10 }];
    expect(effectivePricing(BASE, o, { promptTokens: 1, at: FRIDAY }).input).toBe(10);
  });

  it('leaves an entry with no day list applying on every day', () => {
    const o: PricingOverride[] = [{ utcStart: 100, utcEnd: 400, input: 10 }];
    for (const at of [FRIDAY, SATURDAY, MONDAY]) {
      expect(effectivePricing(BASE, o, { promptTokens: 1, at }).input).toBe(10);
    }
  });
});

describe('no overrides is byte-for-byte todays behaviour', () => {
  it('returns the base object untouched for undefined and for empty', () => {
    expect(effectivePricing(BASE, undefined, { promptTokens: 9e9, at: AT })).toBe(BASE);
    expect(effectivePricing(BASE, [], { promptTokens: 9e9, at: AT })).toBe(BASE);
  });

  it('returns base when no entry matches, without copying', () => {
    const o: PricingOverride[] = [{ minPromptTokens: 1_000_000, input: 99 }];
    expect(effectivePricing(BASE, o, { promptTokens: 10, at: AT })).toBe(BASE);
  });
});

describe('token basis follows the provider reporting convention', () => {
  it('Anthropic reports input EXCLUSIVE of cache, so the total is the sum', () => {
    expect(totalPromptTokensFor('anthropic', 1000, 500, 200)).toBe(1700);
    expect(totalPromptTokensFor('anthropic-vertex', 1000, 500, 200)).toBe(1700);
  });

  it('OpenAI-wire reports a prompt total that already includes cache', () => {
    // Summing here would trip a threshold early on every cache-heavy request.
    expect(totalPromptTokensFor('openrouter', 1000, 500, 0)).toBe(1000);
    expect(totalPromptTokensFor('openai', 1000, 500, 0)).toBe(1000);
    expect(totalPromptTokensFor('google', 1000, 500, 0)).toBe(1000);
  });

  it('fresh input subtracts cache for OpenAI-wire and never goes negative', () => {
    expect(freshInputTokensFor('openrouter', 1000, 400)).toBe(600);
    expect(freshInputTokensFor('anthropic', 1000, 400)).toBe(1000);
    // The runtime's historical negative-cost bug: input=3, cached=11040.
    expect(freshInputTokensFor('openai', 3, 11_040)).toBe(0);
  });
});

describe('computeRowCost applies bands end to end', () => {
  // qwen3.7-flash is the Qwen SMALL tier and its first band starts at 32k, so
  // this is the model where the old flat-rate behaviour was most wrong.
  const MODEL = 'qwen/qwen3.7-flash';

  it('has bands configured in the static seed', () => {
    expect(MODEL_PRICING[`openrouter:${MODEL}`].overrides?.length).toBe(2);
  });

  it('bills the base rate below the first threshold', () => {
    const cost = computeRowCost('openrouter', MODEL, 10_000, 0, 0, 0, AT);
    expect(cost).toBeCloseTo((10_000 * 0.03) / 1_000_000, 12);
  });

  it('bills the whole request at the band rate above the first threshold', () => {
    const cost = computeRowCost('openrouter', MODEL, 100_000, 0, 0, 0, AT);
    expect(cost).toBeCloseTo((100_000 * 0.10) / 1_000_000, 12);
  });

  it('escalates to the second band above 256k', () => {
    const cost = computeRowCost('openrouter', MODEL, 300_000, 0, 0, 0, AT);
    expect(cost).toBeCloseTo((300_000 * 0.20) / 1_000_000, 12);
  });

  it('prices Grok under its native id even when the row carries OpenRouter\'s slug', () => {
    // Configurations written before Grok left OpenRouter still say
    // `x-ai/grok-4.6`. Under the raw key that matches nothing and the row bills
    // at the conservative Sonnet default — a rate belonging to another model.
    const slug   = computeRowCost('xai', 'x-ai/grok-4.6', 100_000, 0, 0, 0, AT);
    const native = computeRowCost('xai', 'grok-4.6',      100_000, 0, 0, 0, AT);
    expect(slug).toBeCloseTo(native, 12);
    expect(native).toBeCloseTo((100_000 * 2.0) / 1_000_000, 12);
  });

  it('leaves the other OpenRouter-hosted vendors on their namespaced keys', () => {
    // Only Grok moved. GLM still bills to OpenRouter and is still keyed there,
    // so stripping publisher segments generally would break it.
    // Rate read from the table rather than restated: what is under test is that
    // the gateway key resolves at all, and a literal here only pins whatever the
    // rate happened to be on the day it was written.
    const glm = computeRowCost('openrouter', 'z-ai/glm-5.2', 100_000, 0, 0, 0, AT);
    expect(glm).toBeCloseTo((100_000 * MODEL_PRICING['glm:z-ai/glm-5.2'].input) / 1_000_000, 12);
  });

  it('Grok doubles AT 200k, because xAI\'s threshold is inclusive', () => {
    // xAI: "requests whose prompt REACHES 200k tokens are billed at the higher
    // rate for all tokens in the request." `minPromptTokens` is strictly
    // greater, so an inclusive 200k is spelled 199_999 — and this is the case
    // that catches anyone who tidies it back to 200_000.
    const under  = computeRowCost('xai', 'grok-4.6', 199_999, 0, 0, 0, AT);
    const at200k = computeRowCost('xai', 'grok-4.6', 200_000, 0, 0, 0, AT);
    expect(under).toBeCloseTo((199_999 * 2.0) / 1_000_000, 12);
    expect(at200k).toBeCloseTo((200_000 * 4.0) / 1_000_000, 12);
  });
});

describe('cached tokens are not billed twice (OpenAI-wire)', () => {
  it('charges the cached portion once, at the cache-read rate', () => {
    // prompt_tokens INCLUDES the cached portion for OpenAI-wire providers, so
    // 1,000,000 input with 400,000 cached is 600,000 fresh + 400,000 cached.
    // Billing input in full AND the cache read again — what this repo did
    // before — over-charged by 400,000 * input.
    const rate = MODEL_PRICING['glm:z-ai/glm-5.2'];
    const cost = computeRowCost('openrouter', 'z-ai/glm-5.2', 1_000_000, 0, 0, 400_000, AT);
    const expected = (600_000 * rate.input) / 1_000_000 + (400_000 * rate.cacheRead) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
    // The split is the assertion, so pin it independently of the rate: billing
    // input in full would add 400,000 more at the input rate.
    expect(cost).toBeLessThan((1_000_000 * rate.input) / 1_000_000);
  });

  it('leaves Anthropic rows unchanged — their input is already exclusive', () => {
    const cost = computeRowCost('anthropic', 'claude-haiku-4-5', 1_000_000, 0, 0, 1_000_000, AT);
    const expected = (1_000_000 * 1.0) / 1_000_000 + (1_000_000 * 0.10) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });
});
