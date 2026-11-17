-- 439: record the cache-WRITE tokens an invocation was billed for.
--
-- Anthropic charges a cache write at 1.25x the input rate, and a cache read at
-- 0.1x — a 12.5x difference between two numbers that both look like "cache".
-- `MODEL_PRICING` has published `cacheWrite5mPricePerMillion` for every Anthropic
-- model since the table existed, `pricing-tiers.ts` folds it through the
-- conditional bands, and the registry loader sets it. Nothing multiplied it by a
-- token count: `calculateCost` had no parameter to receive one and the Anthropic
-- adapter spent `cache_creation_input_tokens` on the context guard alone. So the
-- rate was correct, reachable, and billed nothing.
--
-- That matters here more than anywhere else because `claude-agent-sdk` is the
-- primary engine, and it is cache-heavy by design: cache writes are a material
-- share of what its runs consume.
--
-- Two columns, for the same reason the invocation already stores both tokens and
-- rates: the count is what happened, and the rate is what it was priced at. A
-- reconciliation that reads this row must be able to reproduce the charge without
-- consulting today's rate table, which may have moved since.
--
-- Both NULL for every provider that does not charge for a cache write, which is
-- every OpenAI-convention vendor, and for every row written before this.

ALTER TABLE invocations
  ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS cache_write_price_per_million NUMERIC(12,6);

COMMENT ON COLUMN invocations.cache_write_tokens IS
  'Tokens spent WRITING the prompt cache (Anthropic cache_creation_input_tokens). Billed at 1.25x input; additive to input_tokens, which arrives exclusive of both cache reads and writes. NULL where the vendor does not charge for one.';

COMMENT ON COLUMN invocations.cache_write_price_per_million IS
  'The 5-minute cache-write rate this invocation was priced at. The 1-hour tier is published but unreachable: nothing in this runtime requests that TTL.';
