import { calculateCost, freshInputTokensFor, getModelPricing, getHistoricalPricing, recordPricingChange, googleSearchGroundingCostUsd } from '../pricing';
import { TIER_MODELS as ANTHROPIC_TIER_MODELS } from '../providers/anthropic';
import { TIER_MODELS as OPENAI_TIER_MODELS } from '../providers/openai';
import { TIER_MODELS as GOOGLE_TIER_MODELS } from '../providers/google';
import type { LLMProvider } from '../types';

describe('googleSearchGroundingCostUsd', () => {
  it('charges $0.014 per query, floored at 0', () => {
    expect(googleSearchGroundingCostUsd(0)).toBe(0);
    expect(googleSearchGroundingCostUsd(1)).toBeCloseTo(0.014, 9);
    expect(googleSearchGroundingCostUsd(1000)).toBeCloseTo(14, 9);
    expect(googleSearchGroundingCostUsd(-5)).toBe(0);
  });
});

describe('Model Pricing', () => {
  describe('getModelPricing', () => {
    it('should return pricing for Claude Opus 4 on Vertex AI', () => {
      const pricing = getModelPricing('claude-opus-4', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(15.0);
      expect(pricing!.outputPricePerMillion).toBe(75.0);
      expect(pricing!.cachedInputPricePerMillion).toBe(1.5);
    });

    it('should return pricing for Claude Sonnet 4 on Vertex AI', () => {
      const pricing = getModelPricing('claude-sonnet-4', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(3.0);
      expect(pricing!.outputPricePerMillion).toBe(15.0);
    });

    it('should return pricing for Claude Opus 5 on Vertex AI', () => {
      const pricing = getModelPricing('claude-opus-5', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(5.0);
      expect(pricing!.outputPricePerMillion).toBe(25.0);
    });

    it('should return pricing for Claude Opus 4.6 on Vertex AI', () => {
      const pricing = getModelPricing('claude-opus-4.6', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(5.0);
      expect(pricing!.outputPricePerMillion).toBe(25.0);
    });

    it('should return pricing for Claude Sonnet 4 on Anthropic direct API', () => {
      const pricing = getModelPricing('claude-sonnet-4', 'anthropic');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(3.0);
      expect(pricing!.outputPricePerMillion).toBe(15.0);
    });

    it('should return pricing for Claude Opus 4 on Anthropic direct API', () => {
      const pricing = getModelPricing('claude-opus-4', 'anthropic');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(15.0);
      expect(pricing!.outputPricePerMillion).toBe(75.0);
    });

    it('should return pricing for GPT-5.5 (large tier)', () => {
      const pricing = getModelPricing('gpt-5.5', 'openai');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(5.0);
      expect(pricing!.outputPricePerMillion).toBe(30.0);
      expect(pricing!.cachedInputPricePerMillion).toBe(0.5);
    });

    it('should return pricing for GPT-5.4 mini', () => {
      const pricing = getModelPricing('gpt-5.4-mini', 'openai');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(0.75);
      expect(pricing!.outputPricePerMillion).toBe(4.5);
    });

    it('should return pricing for GPT-5.4 nano', () => {
      const pricing = getModelPricing('gpt-5.4-nano', 'openai');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(0.20);
      expect(pricing!.outputPricePerMillion).toBe(1.25);
    });

    it('should return pricing for Gemini 3.1 Flash Lite', () => {
      const pricing = getModelPricing('gemini-3.1-flash-lite', 'google');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(0.25);
      expect(pricing!.outputPricePerMillion).toBe(1.50);
      expect(pricing!.cachedInputPricePerMillion).toBe(0.025);
    });

    it('should return pricing for Gemini 3.1 Flash', () => {
      const pricing = getModelPricing('gemini-3.1-flash', 'google');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(0.30);
      expect(pricing!.outputPricePerMillion).toBe(2.50);
    });

    it('should normalize versioned model IDs by stripping date suffix', () => {
      const pricing = getModelPricing('claude-opus-4-20250514', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(15.0);
      expect(pricing!.outputPricePerMillion).toBe(75.0);
    });

    it('should normalize versioned Sonnet model IDs', () => {
      const pricing = getModelPricing('claude-sonnet-4.5-20250514', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(3.0);
    });

    // Regression: providers emit hyphenated 4.6-era IDs (claude-opus-4-6,
    // claude-sonnet-4-6, claude-haiku-4-5) while MODEL_PRICING keys use the
    // dotted form (claude-opus-4.6). Before normalizeModelId collapsed the
    // trailing "-major-minor" tail, every Anthropic invocation looked up null
    // and billed $0 OUs.
    it('should normalize hyphenated Anthropic version IDs (claude-opus-4-6 → claude-opus-4.6)', () => {
      const pricing = getModelPricing('claude-opus-4-6', 'anthropic');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(5.0);
      expect(pricing!.outputPricePerMillion).toBe(25.0);
    });

    it('should normalize hyphenated Anthropic version IDs on Vertex (claude-sonnet-4-6 → claude-sonnet-4.6)', () => {
      const pricing = getModelPricing('claude-sonnet-4-6', 'anthropic-vertex');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(3.0);
      expect(pricing!.outputPricePerMillion).toBe(15.0);
    });

    it('should normalize hyphenated Haiku 4.5 ID (claude-haiku-4-5 → claude-haiku-4.5)', () => {
      const pricing = getModelPricing('claude-haiku-4-5', 'anthropic');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(1.0);
      expect(pricing!.outputPricePerMillion).toBe(5.0);
    });

    it('should leave unversioned single-digit base names untouched (claude-opus-4 stays claude-opus-4)', () => {
      // Guards against an overzealous regex that would turn "claude-opus-4"
      // into "claude-opus.4" or similar — must only collapse a *pair* of
      // trailing digit segments.
      const pricing = getModelPricing('claude-opus-4', 'anthropic');
      expect(pricing).not.toBeNull();
      expect(pricing!.inputPricePerMillion).toBe(15.0);
    });

    // Source-of-truth regression: every model string a provider could possibly
    // emit via TIER_MODELS MUST resolve to a non-null pricing entry. If a new
    // tier mapping or model rename lands without a matching pricing row, this
    // test fails loudly instead of silently billing $0.
    describe('every TIER_MODELS entry must resolve to pricing', () => {
      const providerTierTable: Array<[LLMProvider, Record<string, string>]> = [
        ['anthropic',        ANTHROPIC_TIER_MODELS],
        ['openai',           OPENAI_TIER_MODELS],
        ['google',           GOOGLE_TIER_MODELS],
      ];

      for (const [provider, tierModels] of providerTierTable) {
        for (const [tier, modelId] of Object.entries(tierModels)) {
          it(`${provider} / ${tier} (${modelId}) has pricing`, () => {
            const pricing = getModelPricing(modelId, provider);
            expect(pricing).not.toBeNull();
            expect(pricing!.inputPricePerMillion).toBeGreaterThan(0);
            expect(pricing!.outputPricePerMillion).toBeGreaterThan(0);
          });
        }
      }
    });

    it('should return null for unknown models', () => {
      const pricing = getModelPricing('unknown-model-xyz', 'openai');
      expect(pricing).toBeNull();
    });

    it('should return null for known model with wrong provider', () => {
      // gpt-5.5 is only priced under openai, not google
      const pricing = getModelPricing('gpt-5.5', 'google');
      expect(pricing).toBeNull();
    });
  });

  describe('calculateCost', () => {
    it('should calculate cost correctly for Claude Sonnet 4 via Vertex AI', () => {
      const result = calculateCost('claude-sonnet-4', 'anthropic-vertex', 1000, 500);
      expect(result).not.toBeNull();
      // (1000 * 3.0 + 500 * 15.0) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
      expect(result!.costUsd).toBeCloseTo(0.0105, 6);
      expect(result!.inputPricePerMillion).toBe(3.0);
      expect(result!.outputPricePerMillion).toBe(15.0);
    });

    it('should calculate cost correctly for Claude Opus 4 via Vertex AI', () => {
      const result = calculateCost('claude-opus-4', 'anthropic-vertex', 1000, 500);
      expect(result).not.toBeNull();
      // (1000 * 15.0 + 500 * 75.0) / 1_000_000 = (15000 + 37500) / 1_000_000 = 0.0525
      expect(result!.costUsd).toBeCloseTo(0.0525, 6);
    });

    it('should calculate cost correctly for Claude Sonnet 4 via direct API', () => {
      const result = calculateCost('claude-sonnet-4', 'anthropic', 1000, 500);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBeCloseTo(0.0105, 6);
    });

    it('should calculate cost correctly for GPT-5.5', () => {
      const result = calculateCost('gpt-5.5', 'openai', 10000, 2000);
      expect(result).not.toBeNull();
      // (10000 * 5.0 + 2000 * 30.0) / 1_000_000 = (50000 + 60000) / 1_000_000 = 0.110
      expect(result!.costUsd).toBeCloseTo(0.110, 6);
    });

    it('should return zero cost for zero tokens', () => {
      const result = calculateCost('claude-sonnet-4', 'anthropic-vertex', 0, 0);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBe(0);
    });

    it('should return null for unknown model', () => {
      const result = calculateCost('unknown-model', 'openai', 1000, 500);
      expect(result).toBeNull();
    });

    it('should work with versioned model IDs', () => {
      const result = calculateCost('claude-opus-4-20250514', 'anthropic-vertex', 1000, 500);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBeCloseTo(0.0525, 6);
    });

    it('should apply cache-read discount: fresh tokens at full price, cached at cache-read price', () => {
      // Claude Opus 4: input=$15, output=$75, cacheRead=$1.5 per million.
      // Per Anthropic SDK contract, input_tokens is the FRESH count
      // (cache_read_input_tokens is reported separately and is NOT included
      // in input_tokens). Adapter passes input_tokens=800 (fresh), cached=200.
      // Cost = (800*15 + 200*1.5 + 500*75) / 1M = 0.0498
      const result = calculateCost('claude-opus-4', 'anthropic', 800, 500, 200);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBeCloseTo(0.0498, 6);
      expect(result!.cachedInputPricePerMillion).toBe(1.5);
    });

    it('should NOT double-count cached tokens (old bug: allInput*fullPrice + cached*cachePrice)', () => {
      // Anthropic semantics: input=800 (fresh-only), cached=200 (separate).
      // Correct:   (800*15 + 200*1.5 + 500*75) / 1M = 0.0498
      // Old buggy: (1000*15 + 200*1.5 + 500*75) / 1M = 0.0528
      // (would happen if input_tokens were treated as total, charged at full
      // input rate, AND cached re-charged at cache-read rate — double-billing.)
      const result = calculateCost('claude-opus-4', 'anthropic', 800, 500, 200);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBeLessThan(0.0528);
      expect(result!.costUsd).toBeCloseTo(0.0498, 6);
    });

    it('should produce same cost as no-cache path when cachedTokens is 0', () => {
      const withZeroCache = calculateCost('claude-opus-4', 'anthropic', 1000, 500, 0);
      const withoutCache = calculateCost('claude-opus-4', 'anthropic', 1000, 500);
      expect(withZeroCache).not.toBeNull();
      expect(withoutCache).not.toBeNull();
      expect(withZeroCache!.costUsd).toBeCloseTo(withoutCache!.costUsd, 9);
    });

    it('should apply cache-read discount for GPT-5.5 with cached tokens', () => {
      // GPT-5.5: input=$5.0, output=$30.0, cacheRead=$0.50 per million
      // 10000 total (4000 cached), 2000 output
      // freshInput = 6000, cost = (6000*5.0 + 4000*0.50 + 2000*30.0) / 1M
      // = (30000 + 2000 + 60000) / 1M = 0.092
      const result = calculateCost('gpt-5.5', 'openai', 10000, 2000, 4000);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBeCloseTo(0.092, 6);
      expect(result!.cachedInputPricePerMillion).toBe(0.5);
    });

    it('should handle cached tokens on model with no cache pricing (treats cache as zero-cost)', () => {
      // text-embedding-3-large has cachedInputPricePerMillion = null, mapped to undefined in CostResult.
      // prompt_token_count includes cached. 1000 total (200 cached) — cache block skipped.
      // freshInput = 800, output priced at 0 for embeddings.
      // cost = (800*0.13 + 500*0) / 1M
      const result = calculateCost('text-embedding-3-large', 'openai', 1000, 500, 200);
      expect(result).not.toBeNull();
      expect(result!.cachedInputPricePerMillion).toBeUndefined();
      // Cost excludes cached tokens entirely when no cache price is known
      expect(result!.costUsd).toBeCloseTo((800 * 0.13 + 500 * 0) / 1_000_000, 9);
    });

    it('should not produce negative cost when Anthropic reports cached > input', () => {
      // Anthropic can report cached > input: e.g. a Claude Sonnet 4.6
      // invocation with input_tokens=3, output_tokens=14, cached_tokens=11040.
      // Under the pre-fix formula `(input - cached) * input_rate` this yielded
      // a negative cost (~-$0.055) which silently short-circuited the OU drain
      // at PB's negative-cost guard — under-charging the customer.
      const result = calculateCost('claude-sonnet-4.6', 'anthropic', 3, 14, 11040);
      expect(result).not.toBeNull();
      expect(result!.costUsd).toBeGreaterThanOrEqual(0);
      // Correct cost = (3*3 + 11040*0.30 + 14*15) / 1M = (9 + 3312 + 210) / 1M = 0.003531
      expect(result!.costUsd).toBeCloseTo(0.003531, 6);
    });
  });

  describe('freshInputTokensFor', () => {
    it('returns input unchanged for Anthropic (input_tokens already excludes cached)', () => {
      expect(freshInputTokensFor('anthropic', 800, 200)).toBe(800);
      expect(freshInputTokensFor('anthropic-vertex', 800, 200)).toBe(800);
      // Regression: cached > input would have produced negative under the old subtraction.
      expect(freshInputTokensFor('anthropic', 3, 11040)).toBe(3);
    });

    it('subtracts cached from input for OpenAI / Google (input includes cached)', () => {
      expect(freshInputTokensFor('openai', 1000, 200)).toBe(800);
      expect(freshInputTokensFor('google', 1000, 200)).toBe(800);
    });

    it('clamps to 0 if cached > input on OpenAI / Google (defensive)', () => {
      expect(freshInputTokensFor('openai', 100, 200)).toBe(0);
      expect(freshInputTokensFor('google', 100, 200)).toBe(0);
    });
  });

  describe('pricing history functions', () => {
    // These are database-dependent — verify exports exist and types are correct.
    // Full integration tests require a running database.

    it('should export recordPricingChange', () => {
      expect(typeof recordPricingChange).toBe('function');
    });

    it('should export getHistoricalPricing', () => {
      expect(typeof getHistoricalPricing).toBe('function');
    });
  });
});

// ── Opus 5.5 is priced, and it is keyed on the DOTTED form ────────────────
//
// The large tier moved to claude-opus-5-5, which is CHEAPER than the Opus 5 it
// replaces. Two things have to hold and each fails silently on its own.
//
// THE KEY. normalizeModelId collapses a trailing `-N-N`, so `claude-opus-5-5`
// is looked up as `claude-opus-5.5`. A hyphenated MODEL_PRICING key would never
// be read — and a miss here is not a wrong number, it is NO number:
// getModelPricing returns null and the invocation runs having booked no cost at
// all. That is worse than the control plane's failure mode, which at least
// bills something.
//
// THE OLD RATE. Every invocation already written against claude-opus-5 ran at
// $5 / $25 and must keep pricing there. The old entry is load-bearing history,
// not dead weight.
describe('Opus 5.5 pricing and the dotted key', () => {
  it('prices the large model, resolving the dash form through normalizeModelId', () => {
    const pricing = getModelPricing('claude-opus-5-5', 'anthropic');

    expect(pricing).not.toBeNull();
    expect(pricing?.inputPricePerMillion).toBe(4.0);
    expect(pricing?.outputPricePerMillion).toBe(20.0);
    // 5% of base input, not the 10% every other Anthropic row uses. The
    // vendor's own published figure — not a typo to "correct" to $0.40.
    expect(pricing?.cachedInputPricePerMillion).toBe(0.2);
  });

  it('prices it identically on either Anthropic transport', () => {
    expect(getModelPricing('claude-opus-5-5', 'anthropic-vertex')?.inputPricePerMillion).toBe(4.0);
  });

  it('still prices Opus 5 at the rate its historic invocations ran at', () => {
    const pricing = getModelPricing('claude-opus-5', 'anthropic');

    expect(pricing?.inputPricePerMillion).toBe(5.0);
    expect(pricing?.outputPricePerMillion).toBe(25.0);
    expect(pricing?.cachedInputPricePerMillion).toBe(0.5);
  });

  it('computes a whole call, so the rate is reachable and not merely present', () => {
    // 1M input @ $4 + 1M output @ $20 = $24.
    const cost = calculateCost('claude-opus-5-5', 'anthropic', 1_000_000, 1_000_000, 0);

    expect(cost).not.toBeNull();
    expect(cost?.costUsd).toBeCloseTo(24.0, 6);
  });
});

// ── Sonnet 5.5 is priced, and the models it displaces still are ───────────
//
// The medium tier moved from claude-sonnet-4-6 to claude-sonnet-5-5. Unlike the
// Opus swap this is not a price change at all — 5.5 carries Sonnet 5's exact
// rates — which is precisely why it is easy to get wrong: there is no number to
// notice. What can go wrong is the KEY, and it goes wrong silently.
//
// normalizeModelId collapses a trailing `-N-N`, so the wire id
// `claude-sonnet-5-5` is looked up as `claude-sonnet-5.5`. A hyphenated key
// would never be read, and a miss is not a wrong rate but NO rate:
// getModelPricing returns null, calculateCost returns null, and the medium tier
// — the busiest one here — books nothing at all.
//
// The two models it displaces keep their own rates. Sonnet 4.6 ran at $3 / $15
// and every invocation already written against it must still price there; the
// per-model attribution of what already ran is not something a tier move gets
// to change.
describe('Sonnet 5.5 pricing, the dotted key, and the rates it displaces', () => {
  it('prices the medium model, resolving the dash form through normalizeModelId', () => {
    const pricing = getModelPricing('claude-sonnet-5-5', 'anthropic');

    expect(pricing).not.toBeNull();
    expect(pricing?.inputPricePerMillion).toBe(2.0);
    expect(pricing?.outputPricePerMillion).toBe(10.0);
    // The usual 10% of base input — NOT Opus 5.5's 5%. The two point releases
    // differ here, so the neighbouring row is not a template for this one.
    expect(pricing?.cachedInputPricePerMillion).toBe(0.2);
    expect(pricing?.cacheWrite5mPricePerMillion).toBe(2.5);
    expect(pricing?.cacheWrite1hPricePerMillion).toBe(4.0);
  });

  it('still prices Sonnet 4.6 at the rate its historic invocations ran at', () => {
    const pricing = getModelPricing('claude-sonnet-4-6', 'anthropic');

    expect(pricing?.inputPricePerMillion).toBe(3.0);
    expect(pricing?.outputPricePerMillion).toBe(15.0);
    expect(pricing?.cachedInputPricePerMillion).toBe(0.3);
  });

  it('still prices Sonnet 5 at its own rate', () => {
    const pricing = getModelPricing('claude-sonnet-5', 'anthropic');

    expect(pricing?.inputPricePerMillion).toBe(2.0);
    expect(pricing?.outputPricePerMillion).toBe(10.0);
  });

  it('computes a whole call, so the rate is reachable and not merely present', () => {
    // 1M input @ $2 + 1M output @ $10 = $12.
    const cost = calculateCost('claude-sonnet-5-5', 'anthropic', 1_000_000, 1_000_000, 0);

    expect(cost).not.toBeNull();
    expect(cost?.costUsd).toBeCloseTo(12.0, 6);
  });

  it('prices 5.5 and 4.6 differently, so a run is attributed to the model that served it', () => {
    const newer = calculateCost('claude-sonnet-5-5', 'anthropic', 1_000_000, 1_000_000, 0);
    const older = calculateCost('claude-sonnet-4-6', 'anthropic', 1_000_000, 1_000_000, 0);

    expect(newer?.costUsd).toBeCloseTo(12.0, 6);
    expect(older?.costUsd).toBeCloseTo(18.0, 6);
  });
});

// ── Claude Fable 5.1 is priced before anything routes to it ───────────────
//
// A pin to a model with no row does not fail: it records the tokens at zero.
// The cache read is 2.5% of base input ($0.25), the vendor's own figure.
describe('Claude Fable 5.1 pricing', () => {
  it('prices the dash form through the dotted key', () => {
    const pricing = getModelPricing('claude-fable-5-1', 'anthropic');

    expect(pricing).not.toBeNull();
    expect(pricing?.inputPricePerMillion).toBe(10.0);
    expect(pricing?.outputPricePerMillion).toBe(50.0);
    expect(pricing?.cachedInputPricePerMillion).toBe(0.25);
    expect(pricing?.cacheWrite5mPricePerMillion).toBe(12.5);
    expect(pricing?.cacheWrite1hPricePerMillion).toBe(20.0);
  });

  it('computes a whole call with cache reads', () => {
    // 1M fresh @ $10 + 1M output @ $50 + 1M cached @ $0.25 = $60.25.
    const cost = calculateCost('claude-fable-5-1', 'anthropic', 1_000_000, 1_000_000, 1_000_000);

    expect(cost?.costUsd).toBeCloseTo(60.25, 6);
  });
});

// ── The OpenAI ladder the control plane routes to is priced here ──────────
//
// OpenAI rates are not in the synced overlay (it carries only the
// OpenRouter-synced rows), so a routed id missing from the static table books
// $0.
describe('OpenAI GPT-6 and GPT-5.6 pricing', () => {
  it.each([
    ['gpt-6-astra',   10.0, 50.0, 1.0],
    // 6.1 Sol's cache read is 5% of base where every sibling is 10%. It is the
    // vendor's figure, not a typo, and this row is where a "correction" to 0.2
    // would be caught.
    ['gpt-6.1-sol',    2.0, 10.0, 0.1],
    ['gpt-6-sol',      2.0, 10.0, 0.2],
    ['gpt-6-luna',     0.1,  0.5, 0.01],
    ['gpt-5.6-sol',    4.0, 20.0, 0.4],
    ['gpt-5.6-terra',  2.0, 12.0, 0.2],
    ['gpt-5.6-luna',   0.2,  1.2, 0.02],
  ])('%s is priced at its published rate', (model, input, output, cacheRead) => {
    const pricing = getModelPricing(model, 'openai');

    expect(pricing?.inputPricePerMillion).toBe(input);
    expect(pricing?.outputPricePerMillion).toBe(output);
    expect(pricing?.cachedInputPricePerMillion).toBe(cacheRead);
  });

  it('the tier ladder is the GPT-6 line, large by price not by name', () => {
    expect(OPENAI_TIER_MODELS).toEqual({ large: 'gpt-6-astra', medium: 'gpt-6.1-sol', small: 'gpt-6-luna' });
  });

  it('reprices a whole request above 272K prompt tokens', () => {
    // OpenAI prompt_tokens includes the cached portion. 300K prompt, none cached,
    // 10K output on gpt-6-sol's long band: 300K @ $4 + 10K @ $15 = $1.35.
    const cost = calculateCost('gpt-6-sol', 'openai', 300_000, 10_000, 0);

    expect(cost?.costUsd).toBeCloseTo(1.35, 6);
  });

  it('keeps the short band at or below 272K', () => {
    // 272K @ $2 + 10K @ $10 = $0.644.
    const cost = calculateCost('gpt-6-sol', 'openai', 272_000, 10_000, 0);

    expect(cost?.costUsd).toBeCloseTo(0.644, 6);
  });
});
