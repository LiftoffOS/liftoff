-- Conditional pricing overrides for the OpenRouter-hosted models.
--
-- OpenRouter publishes a `pricing.overrides` array per endpoint that REPLACES
-- the base rates when a request matches a condition: a prompt-token threshold
-- (long-context pricing) or a daily UTC window (time-of-day pricing). Migration
-- 285 modelled pricing as three flat columns, which misprices any model whose
-- endpoint publishes overrides, for example:
--
--   qwen/qwen3.7-flash      base 0.03/0.13   >32k: 0.10/0.40   >256k: 0.20/0.80
--   qwen/qwen3-coder-plus   base 0.65/3.25   >32k: 1.17/5.85   >128k: 1.95/9.75
--   qwen/qwen3.7-plus       base 0.32/1.28                     >256k: 0.96/3.84
--
-- qwen3.7-flash is the Qwen SMALL tier and its first band starts at 32,000
-- prompt tokens, which is a routine turn once skills and tool results are
-- injected. So flat pricing under-attributes on the common path, not the tail,
-- and in the one direction that costs the business money. Every Grok model
-- also doubles above 200k.
--
-- Nullable, no backfill, no default. NULL means "this vendor publishes no
-- conditional rates" and every existing row keeps today's behaviour exactly —
-- the evaluator returns base untouched when the column is null, which is what
-- makes this change additive for Anthropic, OpenAI and Google.
--
-- Stored in OUR per-million units, matching input_per_m / output_per_m /
-- cache_read_per_m, NOT OpenRouter's per-token units. The conversion happens
-- once, in the sync job (src/scripts/sync-model-pricing.ts), so nothing
-- downstream has to remember which units a given number is in.
--
-- Shape (array; every rate key optional, absent keys inherit the base columns):
--   [{"minPromptTokens": 32000, "input": 0.10, "output": 0.40, "cacheRead": 0.02}]
--   [{"utcStart": 1630, "utcEnd": 30, "input": 0.14, "output": 0.21}]
--
-- Evaluation semantics live in src/llm/pricing-tiers.ts and are NOT obvious:
-- the threshold is STRICTLY greater, the reprice covers the whole request
-- rather than the excess tokens, and multiple applicable entries fold per key
-- in array order rather than one winning outright.

ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS pricing_overrides JSONB;

COMMENT ON COLUMN model_pricing.pricing_overrides IS
  'Conditional rate overrides from the vendor, in per-million units. Array of {minPromptTokens?, utcStart?, utcEnd?, input?, output?, cacheRead?, cacheWrite5m?, cacheWrite1h?}. An entry applies when ALL its condition fields match (minPromptTokens is STRICTLY greater-than); applicable entries fold in array order, last-writer-wins per key, absent keys inheriting the base columns. NULL = vendor publishes no conditional rates. Evaluated by src/llm/pricing-tiers.ts.';
