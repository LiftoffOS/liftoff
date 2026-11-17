// computeRowCost — pricing fallback tests
//
// Focus: an unknown / empty model must NOT bill at $0 (silent revenue leak).
// It is billed conservatively at the 'default' (Sonnet) rate, and the defect
// is surfaced via an error log so the missing model gets added.

const mockError = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: mockError, debug: jest.fn() },
}));

import { computeRowCost, MODEL_PRICING, setModelPricingRates, type ModelPricing } from '../pricing';

beforeEach(() => jest.clearAllMocks());

describe('computeRowCost', () => {
  it('prices a known model from its own MODEL_PRICING entry', () => {
    // 1M input @ $1.00 + 1M output @ $5.00 = $6.00 for haiku-4-5
    const cost = computeRowCost('anthropic', 'claude-haiku-4-5', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(6.0, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('prices a GLM (openrouter) model from its provider-prefixed entry', () => {
    // 1M input @ $2.31 + 1M output @ $8.00 = $10.31 for glm-5.2
    const cost = computeRowCost('openrouter', 'z-ai/glm-5.2', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(10.31, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('falls back to the conservative default (Sonnet) rate for an unknown model — never $0', () => {
    const cost = computeRowCost('anthropic', 'some-unlisted-model', 1_000_000, 1_000_000, 0, 0);
    const def = MODEL_PRICING['default'];
    const expected = (1_000_000 * def.input + 1_000_000 * def.output) / 1_000_000;
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(expected, 6);
    // Defect is still surfaced so the missing model gets added.
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('falls back to default pricing for an empty model string (NULL model COALESCEd to "")', () => {
    const cost = computeRowCost('', '', 500_000, 200_000, 0, 0);
    const def = MODEL_PRICING['default'];
    const expected = (500_000 * def.input + 200_000 * def.output) / 1_000_000;
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(expected, 6);
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('includes cache-read and cache-creation tokens at the matched entry rates', () => {
    const cost = computeRowCost('anthropic', 'claude-haiku-4-5', 0, 0, 1_000_000, 1_000_000);
    const p = MODEL_PRICING['claude-haiku-4-5'];
    const expected = (1_000_000 * p.cacheWrite5m + 1_000_000 * p.cacheRead) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 6);
  });
});

describe('computeRowCost — DB-sourced rate overlay (model_pricing sync)', () => {
  afterEach(() => setModelPricingRates(null)); // never leak the overlay into other tests

  const rate = (over: Partial<ModelPricing>): ModelPricing => ({
    input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...over,
  });

  it('DB-sourced rate wins over the static MODEL_PRICING entry', () => {
    // Static glm-5.2 is $2.31/$8.00 → $10.31; override to $0.50/$1.00 → $1.50.
    setModelPricingRates(new Map([['openrouter:z-ai/glm-5.2', rate({ input: 0.5, output: 1.0 })]]));
    const cost = computeRowCost('openrouter', 'z-ai/glm-5.2', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(1.5, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('falls back to the static entry when the DB map lacks the key', () => {
    setModelPricingRates(new Map([['openrouter:z-ai/glm-5-turbo', rate({ input: 9, output: 9 })]]));
    // glm-5.2 is absent from the DB map → static $10.31 still applies, no error.
    const cost = computeRowCost('openrouter', 'z-ai/glm-5.2', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(10.31, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('clearing the overlay (null) restores pure static pricing', () => {
    setModelPricingRates(new Map([['openrouter:z-ai/glm-5.2', rate({ input: 0.5, output: 1.0 })]]));
    setModelPricingRates(null);
    const cost = computeRowCost('openrouter', 'z-ai/glm-5.2', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(10.31, 6);
  });
});

describe('vendor-published long-context bands', () => {
  // Both vendors say the same thing in different words: past the threshold the
  // WHOLE request reprices, input and output together, not just the excess.
  // Getting that wrong is not a rounding error — it is charging a customer a
  // band no part of their call was in, or eating the difference on every large
  // prompt.
  const at = new Date('2026-08-30T12:00:00Z');

  describe('gemini-3.1-pro-preview (Vertex, 200k)', () => {
    it('bills a short-context call at the base rate', () => {
      // 100k input, 10k output, entirely under the threshold.
      // 100_000/1e6 * 2.00 + 10_000/1e6 * 12.00 = 0.20 + 0.12
      const cost = computeRowCost('google', 'gemini-3.1-pro-preview', 100_000, 10_000, 0, 0, at);
      expect(cost).toBeCloseTo(0.32, 6);
    });

    it('reprices the WHOLE request past 200k, output included', () => {
      // 250_000/1e6 * 4.00 + 10_000/1e6 * 18.00 = 1.00 + 0.18
      const cost = computeRowCost('google', 'gemini-3.1-pro-preview', 250_000, 10_000, 0, 0, at);
      expect(cost).toBeCloseTo(1.18, 6);
    });

    it('treats the threshold as STRICTLY greater', () => {
      // Exactly 200k is still the base band. 200_000/1e6 * 2.00 = 0.40
      const cost = computeRowCost('google', 'gemini-3.1-pro-preview', 200_000, 0, 0, 0, at);
      expect(cost).toBeCloseTo(0.40, 6);
    });

    it('measures the threshold on TOTAL prompt tokens, cached portion included', () => {
      // Google reports prompt tokens INCLUSIVE of the cached part, so 250k total
      // with 200k cached is over the line — and the fresh 50k bills at the long
      // input rate while the cached 200k bills at the long cache-read rate.
      // 50_000/1e6 * 4.00 + 200_000/1e6 * 0.40 = 0.20 + 0.08
      const cost = computeRowCost('google', 'gemini-3.1-pro-preview', 250_000, 0, 0, 200_000, at);
      expect(cost).toBeCloseTo(0.28, 6);
    });
  });

  describe('the Flash models publish one price for both bands', () => {
    it('charges gemini-3.5-flash the same either side of 200k', () => {
      const under = computeRowCost('google', 'gemini-3.5-flash', 100_000, 0, 0, 0, at);
      const over = computeRowCost('google', 'gemini-3.5-flash', 300_000, 0, 0, 0, at);
      // Non-global rate, 1.65/M: 0.165 and 0.495, i.e. purely linear.
      expect(under).toBeCloseTo(0.165, 6);
      expect(over).toBeCloseTo(0.495, 6);
    });
  });

  describe('gpt-5.6 (OpenAI, 272k)', () => {
    it('bills a short-context call at the base rate', () => {
      // 100_000/1e6 * 4.00 + 10_000/1e6 * 20.00 = 0.40 + 0.20
      const cost = computeRowCost('openai', 'gpt-5.6-sol', 100_000, 10_000, 0, 0, at);
      expect(cost).toBeCloseTo(0.60, 6);
    });

    it('reprices the WHOLE request past 272k', () => {
      // 300_000/1e6 * 8.00 + 10_000/1e6 * 30.00 = 2.40 + 0.30
      const cost = computeRowCost('openai', 'gpt-5.6-sol', 300_000, 10_000, 0, 0, at);
      expect(cost).toBeCloseTo(2.70, 6);
    });
  });

  // The GPT-6 line carries the same 272,000 boundary, published in the same
  // words on all three model pages: "Prompts with more than 272K input tokens
  // are priced at 2x input and cache rates and 1.5x output for the full
  // request."
  describe('gpt-6 (OpenAI, 272k)', () => {
    it('bills a short-context call at the base rate, per tier', () => {
      // astra  100_000/1e6 * 10.00 + 10_000/1e6 * 50.00 = 1.00 + 0.50
      expect(computeRowCost('openai', 'gpt-6-astra', 100_000, 10_000, 0, 0, at)).toBeCloseTo(1.50, 6);
      // sol    100_000/1e6 *  2.00 + 10_000/1e6 * 10.00 = 0.20 + 0.10
      expect(computeRowCost('openai', 'gpt-6-sol', 100_000, 10_000, 0, 0, at)).toBeCloseTo(0.30, 6);
      // luna   100_000/1e6 *  0.10 + 10_000/1e6 *  0.50 = 0.01 + 0.005
      expect(computeRowCost('openai', 'gpt-6-luna', 100_000, 10_000, 0, 0, at)).toBeCloseTo(0.015, 6);
    });

    it('reprices the WHOLE request past 272k — 2x input, 1.5x output', () => {
      // astra  300_000/1e6 * 20.00 + 10_000/1e6 * 75.00 = 6.00 + 0.75
      expect(computeRowCost('openai', 'gpt-6-astra', 300_000, 10_000, 0, 0, at)).toBeCloseTo(6.75, 6);
      // sol    300_000/1e6 *  4.00 + 10_000/1e6 * 15.00 = 1.20 + 0.15
      expect(computeRowCost('openai', 'gpt-6-sol', 300_000, 10_000, 0, 0, at)).toBeCloseTo(1.35, 6);
      // luna   300_000/1e6 *  0.20 + 10_000/1e6 *  0.75 = 0.06 + 0.0075
      expect(computeRowCost('openai', 'gpt-6-luna', 300_000, 10_000, 0, 0, at)).toBeCloseTo(0.0675, 6);
    });

    it('leaves a request of exactly 272,000 on the short band', () => {
      // minPromptTokens is STRICTLY greater (pricing-tiers.ts). A >= here would
      // over-charge every request landing exactly on the boundary.
      // 272_000/1e6 * 2.00 = 0.544, against 1.088 on the long band.
      expect(computeRowCost('openai', 'gpt-6-sol', 272_000, 0, 0, 0, at)).toBeCloseTo(0.544, 6);
      expect(computeRowCost('openai', 'gpt-6-sol', 272_001, 0, 0, 0, at)).toBeCloseTo(1.088004, 6);
    });

    it('bands the cache rates too, on both sides', () => {
      // A cache read is 2x past the threshold, same as fresh input. Written out
      // because an override that omits a key inherits BASE rather than scaling
      // — a half-written entry bills the short cache rate on a long request.
      // sol short: 100_000 fresh @ 2.00 + 100_000 cached @ 0.20 = 0.20 + 0.02
      expect(computeRowCost('openai', 'gpt-6-sol', 200_000, 0, 0, 100_000, at)).toBeCloseTo(0.22, 6);
      // sol long:  200_000 fresh @ 4.00 + 100_000 cached @ 0.40 = 0.80 + 0.04
      expect(computeRowCost('openai', 'gpt-6-sol', 300_000, 0, 0, 100_000, at)).toBeCloseTo(0.84, 6);
      // A cache WRITE is 2x as well: 1M @ 2.50 short, @ 5.00 long.
      expect(computeRowCost('openai', 'gpt-6-sol', 100_000, 0, 1_000_000, 0, at)).toBeCloseTo(2.70, 6);
      expect(computeRowCost('openai', 'gpt-6-sol', 300_000, 0, 1_000_000, 0, at)).toBeCloseTo(6.20, 6);
    });
  });

  // ── GPT-6.1 Sol: the same price everywhere except the cache read ───────────
  //
  // 6.1 Sol replaces 6 Sol in the medium slot at an IDENTICAL base rate — $2 in,
  // $2.50 cache write, $10 out, and the same $4 / $5 / $15 long band past the
  // same 272k threshold. Exactly one figure moved: the CACHED INPUT rate halves,
  // $0.10 against $0.20, and $0.20 against $0.40 on the long band.
  //
  // That is 5% of base input where every sibling in this family is 10% — astra
  // $1.00 on $10, luna $0.01 on $0.10 — which is why it reads like an error and
  // is not one. It is the vendor's published figure, the same shape as Opus 5.5's
  // 5% cache read. A reader who "restores" the family pattern doubles what every
  // cache read costs, on the tier that caches most, and no test would have
  // objected before this one.
  describe('gpt-6.1-sol (OpenAI, the 5% cache read)', () => {
    it('bills fresh input and output exactly as its predecessor did', () => {
      // 100_000/1e6 * 2.00 + 10_000/1e6 * 10.00 = 0.20 + 0.10
      expect(computeRowCost('openai', 'gpt-6.1-sol', 100_000, 10_000, 0, 0, at)).toBeCloseTo(0.30, 6);
      expect(computeRowCost('openai', 'gpt-6.1-sol', 100_000, 10_000, 0, 0, at))
        .toBeCloseTo(computeRowCost('openai', 'gpt-6-sol', 100_000, 10_000, 0, 0, at), 6);
    });

    it('reads cache at HALF its predecessor’s rate', () => {
      // 1M cached @ $0.10 = 0.10, against gpt-6-sol's 1M @ $0.20 = 0.20.
      expect(computeRowCost('openai', 'gpt-6.1-sol', 0, 0, 0, 1_000_000, at)).toBeCloseTo(0.10, 6);
      expect(computeRowCost('openai', 'gpt-6-sol', 0, 0, 0, 1_000_000, at)).toBeCloseTo(0.20, 6);
    });

    it('halves the LONG-band cache read too, which an override must state outright', () => {
      // An override entry that omits a key inherits BASE rather than scaling, so
      // a long-band cacheRead left unwritten would bill $0.10 on a request the
      // vendor charges $0.20 for. Stated, and asserted.
      //
      // `input` is the WHOLE prompt including the cached part, so fresh input is
      // input − cacheRead: 1_300_000 − 1_000_000 = 300_000 fresh.
      // 300_000 fresh @ 4.00 + 1M cached @ 0.20 = 1.20 + 0.20
      expect(computeRowCost('openai', 'gpt-6.1-sol', 1_300_000, 0, 0, 1_000_000, at)).toBeCloseTo(1.40, 6);
      // and its predecessor, at the rate its own rows ran on: 1.20 + 0.40
      expect(computeRowCost('openai', 'gpt-6-sol', 1_300_000, 0, 0, 1_000_000, at)).toBeCloseTo(1.60, 6);
    });

    it('keeps the 272k threshold, strictly greater, like the rest of the family', () => {
      expect(computeRowCost('openai', 'gpt-6.1-sol', 272_000, 0, 0, 0, at)).toBeCloseTo(0.544, 6);
      expect(computeRowCost('openai', 'gpt-6.1-sol', 272_001, 0, 0, 0, at)).toBeCloseTo(1.088004, 6);
    });

    it('never falls to the conservative default — the row is really reachable', () => {
      // The fallback is a Sonnet-shaped rate, which for a $2 model is plausible
      // enough to hide a missing row completely.
      computeRowCost('openai', 'gpt-6.1-sol', 1000, 1000, 0, 0, at);
      expect(mockError).not.toHaveBeenCalled();
    });
  });
});

// ── Opus 5.5 and Opus 5 price differently, and both must keep working ──────
//
// The large tier moved from Opus 5 to Opus 5.5, which is CHEAPER. That makes the
// old rate load-bearing rather than obsolete: every llm_usage_log row already
// written against claude-opus-5 ran at $5 / $25 and must keep pricing there.
// Deleting the old entry would not fail — computeRowCost falls back to the
// conservative default — it would silently reprice history at another model's
// rate, on every historic row, with every surface still looking healthy.
//
// The cache-read figure is the one worth pinning explicitly. Opus 5.5 reads at
// $0.20/MTok, which is 5% of its base input, NOT the 10% every other Anthropic
// row in the table uses. It is the vendor's own published number; a reader who
// "corrects" it to $0.40 doubles what every cache hit costs.
describe('computeRowCost — the Opus 5.5 large tier and the Opus 5 it replaced', () => {
  it('prices Opus 5.5 at its own published rate', () => {
    // 1M input @ $4.00 + 1M output @ $20.00 = $24.00
    const cost = computeRowCost('anthropic', 'claude-opus-5-5', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(24.0, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('still prices Opus 5 at the rate its historic rows actually ran at', () => {
    // 1M input @ $5.00 + 1M output @ $25.00 = $30.00
    const cost = computeRowCost('anthropic', 'claude-opus-5', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(30.0, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('reads Opus 5.5 cache at 5% of base input, not the usual 10%', () => {
    // 1M cache-read tokens @ $0.20 — and Opus 5's 1M @ $0.50 for contrast.
    expect(computeRowCost('anthropic', 'claude-opus-5-5', 0, 0, 0, 1_000_000)).toBeCloseTo(0.2, 6);
    expect(computeRowCost('anthropic', 'claude-opus-5', 0, 0, 0, 1_000_000)).toBeCloseTo(0.5, 6);
  });

  it('writes Opus 5.5 cache at the usual 1.25x of base input', () => {
    // 1M cache-write tokens @ $5.00 (computeRowCost bills writes at the 5m tier).
    expect(computeRowCost('anthropic', 'claude-opus-5-5', 0, 0, 1_000_000, 0)).toBeCloseTo(5.0, 6);
  });

  it('never silently bills the new large-tier model at the conservative default', () => {
    // The fallback is a net, not a rate. If this ever fires for the large tier,
    // the MODEL_PRICING entry has gone missing and every row is being charged
    // at another model's price.
    computeRowCost('anthropic', 'claude-opus-5-5', 1000, 1000, 0, 0);
    expect(mockError).not.toHaveBeenCalled();
  });
});

// ── The medium tier moved to Sonnet 5.5, at the same rate ─────────────────
//
// Unlike the Opus swap above, this one changes no number: Sonnet 5.5 carries
// Sonnet 5's exact rates. That is what makes it easy to ship broken — there is
// no figure to check, only a row that has to EXIST. Without it computeRowCost
// falls back to the conservative 'default' $3 / $15 and bills 1.5x on the
// busiest tier in the estate, on every row, while every surface still looks
// healthy and only an error log says otherwise.
//
// The cache read is the figure most likely to be got wrong here, and this file
// got it wrong for six weeks: it is $0.10, the SAME 5% of base input that Opus
// 5.5 reads at, not the 10% every model before this generation read at. The 5.5
// generation moved the whole family off 0.1x, so the cache read is the one rate
// on this row that cannot be carried across from Sonnet 5 — and reading it as
// 10% doubles what a cache hit costs on the tier that does the most caching.
describe('computeRowCost — the Sonnet 5.5 medium tier and the models it displaced', () => {
  it('prices Sonnet 5.5 at its own published rate', () => {
    // 1M input @ $2.00 + 1M output @ $10.00 = $12.00
    const cost = computeRowCost('anthropic', 'claude-sonnet-5-5', 1_000_000, 1_000_000, 0, 0);
    expect(cost).toBeCloseTo(12.0, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('still prices Sonnet 5 and Sonnet 4.6 at the rates their historic rows ran at', () => {
    // Sonnet 5 matched 5.5's price; Sonnet 4.6 did not, at $3 / $15.
    expect(computeRowCost('anthropic', 'claude-sonnet-5', 1_000_000, 1_000_000, 0, 0))
      .toBeCloseTo(12.0, 6);
    expect(computeRowCost('anthropic', 'claude-sonnet-4-6', 1_000_000, 1_000_000, 0, 0))
      .toBeCloseTo(18.0, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('reads Sonnet 5.5 cache at 5% of base input, like Opus 5.5 and unlike Sonnet 5', () => {
    // 1M cache-read tokens @ $0.10. The vendor publishes the figure twice — in
    // the model pricing table and in the cache-hit multiplier table ("Claude
    // Sonnet 5.5 — 0.05x — $0.10 USD"). Pinned against the shape of the defect
    // it replaces: a rate carried across from the model a row succeeds, under a
    // comment asserting that it should be.
    expect(computeRowCost('anthropic', 'claude-sonnet-5-5', 0, 0, 0, 1_000_000))
      .toBeCloseTo(0.1, 6);
    // Sonnet 5 keeps the 10% its own rows were billed at. The two must differ:
    // equal figures here would mean one of them is the other's copy.
    expect(computeRowCost('anthropic', 'claude-sonnet-5', 0, 0, 0, 1_000_000))
      .toBeCloseTo(0.2, 6);
  });

  it('writes Sonnet 5.5 cache at the usual 1.25x of base input', () => {
    // 1M cache-write tokens @ $2.50 (computeRowCost bills writes at the 5m tier).
    expect(computeRowCost('anthropic', 'claude-sonnet-5-5', 0, 0, 1_000_000, 0))
      .toBeCloseTo(2.5, 6);
  });

  it('never silently bills the new medium-tier model at the conservative default', () => {
    // The conservative default IS the Sonnet rate pair from two generations ago,
    // so a missing row here is especially quiet: the number it produces is
    // plausible. Only the error log distinguishes it.
    computeRowCost('anthropic', 'claude-sonnet-5-5', 1000, 1000, 0, 0);
    expect(mockError).not.toHaveBeenCalled();
  });
});

// ── The OpenAI ladder moved to GPT-6, and every model it left keeps billing ──
//
// The same property the Opus block above asserts, for the generation the
// OpenAI ladder just left — and here it is ENUMERATED rather than sampled,
// because the failure is invisible by construction and there are seven ids to
// lose it on.
//
// computeRowCost never bills $0: an id with no entry falls back to the
// conservative default rate. So deleting one of these does not break a test,
// break a page, or raise an alert. It reprices every historic `llm_usage_log`
// row naming that model at ANOTHER MODEL'S rate, on every read, forever, while
// the cost cards, the Cost Breakdown table and the invoices all keep looking
// healthy. There is no later signal — the rows are already written, and the
// number they render is simply wrong from then on.
//
// The rates below are what these models ACTUALLY RAN AT, not what anything
// costs today. They are deliberately not read back out of MODEL_PRICING:
// asserting a table against itself passes with any value in it. Each figure is
// restated here from the vendor's published price list for that model, so a
// hand edit to a rate has to be made twice, in two files, to go unnoticed.
describe('the models the GPT-6 ladder replaced still price at their own historic rates', () => {
  // [id, 1M fresh input, 1M output] on the SHORT band.
  const RETIRED_OPENAI_RATES: ReadonlyArray<readonly [string, number, number]> = [
    // The GPT-5.6 ladder (migration 396), replaced by GPT-6 at migration 527.
    ['gpt-5.6-sol', 4.00, 20.00],
    ['gpt-5.6-terra', 2.00, 12.00],
    ['gpt-5.6-luna', 0.20, 1.20],
    // The GPT-5.4 family, and the gpt-5.5 the ladder passed through at
    // migration 395. No cache-write tier on any of them.
    ['gpt-5.4', 2.50, 10.00],
    ['gpt-5.4-2026-03-05', 2.50, 10.00],
    ['gpt-5.4-mini', 0.15, 0.60],
    ['gpt-5.4-nano', 0.10, 0.40],
  ];

  it.each(RETIRED_OPENAI_RATES)(
    'prices %s at the rate its historic rows actually ran at',
    (modelId, inputPerM, outputPerM) => {
      // A TENTH of a million each way, so the expectation is the published pair
      // divided by ten and stays readable as those two rates.
      //
      // NOT 1M input, the round number the Opus block above can afford: the
      // GPT-5.6 line carries a 272,000 long-context band, so a 1M-token prompt
      // bills at 2x input and 1.5x output and the assertion would be reading
      // the long rate while claiming to read the short one. 100,000 is short on
      // every entry in this table.
      const cost = computeRowCost('openai', modelId as string, 100_000, 100_000, 0, 0);
      expect(cost).toBeCloseTo(((inputPerM as number) + (outputPerM as number)) / 10, 6);
      // The fallback is a net, not a rate. If this fires, the entry is gone and
      // the number above came from the default rate rather than from the model.
      expect(mockError).not.toHaveBeenCalled();
    },
  );

  it('keeps the long band on the GPT-5.6 line, which is where its big rows bill', () => {
    // A retired model loses its band the same silent way it loses its rate, and
    // the band is the half that moves real money: these are the rows big enough
    // to have crossed 272k.
    //
    // 300_000/1e6 * 8.00 + 10_000/1e6 * 30.00 = 2.40 + 0.30
    expect(computeRowCost('openai', 'gpt-5.6-sol', 300_000, 10_000, 0, 0)).toBeCloseTo(2.70, 6);
    // 300_000/1e6 * 4.00 + 10_000/1e6 * 18.00 = 1.20 + 0.18
    expect(computeRowCost('openai', 'gpt-5.6-terra', 300_000, 10_000, 0, 0)).toBeCloseTo(1.38, 6);
    // 300_000/1e6 * 0.40 + 10_000/1e6 * 1.80 = 0.12 + 0.018
    expect(computeRowCost('openai', 'gpt-5.6-luna', 300_000, 10_000, 0, 0)).toBeCloseTo(0.138, 6);
    expect(mockError).not.toHaveBeenCalled();
  });

  it('does not let a GPT-6 rate reach the GPT-5.6 name it reuses', () => {
    // The trap this whole block exists around: `sol` and `luna` appear in both
    // generations, at different prices AND different tiers. gpt-6-sol is half
    // of gpt-5.6-sol's input rate; gpt-6-luna is half of gpt-5.6-luna's. If a
    // rename ever collapses the two, every historic row on the old id silently
    // bills at the new generation's price.
    // 100,000 input tokens — short band on both generations, so this compares
    // base rate against base rate rather than one model's band against
    // another's.
    expect(computeRowCost('openai', 'gpt-5.6-sol', 100_000, 0, 0, 0)).toBeCloseTo(0.40, 6);
    expect(computeRowCost('openai', 'gpt-6-sol', 100_000, 0, 0, 0)).toBeCloseTo(0.20, 6);
    expect(computeRowCost('openai', 'gpt-5.6-luna', 100_000, 0, 0, 0)).toBeCloseTo(0.02, 6);
    expect(computeRowCost('openai', 'gpt-6-luna', 100_000, 0, 0, 0)).toBeCloseTo(0.01, 6);
    expect(mockError).not.toHaveBeenCalled();
  });
});
