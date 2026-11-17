-- Migration 228: Backfill price snapshots for Anthropic and Vertex-Claude
-- invocations that wrote NULL prices because of the hyphenated-vs-dotted
-- pricing-key mismatch.
--
-- The provider TIER_MODELS were rewritten to emit hyphenated IDs
-- (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5) while MODEL_PRICING
-- keys remained dotted (claude-opus-4.6 etc). getModelPricing() returned
-- null, agent-execution stored NULL into the price snapshot columns, and
-- spend-subscriber published $0 OUs. Affected window: from that change
-- until this migration runs.
--
-- The pricing fix in pricing.ts closes the forward path;
-- this migration repairs the rows already written so that:
--   • cost-on-read (tokens * price_per_million / 1e6) yields correct values
--   • cost-attribution-events backfill via runtime-ingester (cursor reset
--     after this runs) sees non-null price snapshots and emits non-zero
--     cost events, which then drain OU buckets and tick the per-account
--     counter in platform-backend.
--
-- Rates sourced from src/llm/pricing.ts MODEL_PRICING (canonical):
--   anthropic / vertex-ai : claude-opus-4.6   = $5  / $25 / $0.50 cache-read
--                           claude-sonnet-4.6 = $3  / $15 / $0.30
--                           claude-haiku-4.5  = $1  / $5  / $0.10
--
-- Filter shape mirrors migration 103: only touch rows where the price
-- snapshot is currently NULL (i.e. the row was written by the buggy code
-- path). Rows with any price stored are left intact, so this is a no-op
-- after the first run.

-- ── claude-opus-4-6 (anthropic + anthropic-vertex) ────────────────────
UPDATE invocations
SET
  input_price_per_million        = 5.00,
  output_price_per_million       = 25.00,
  cached_input_price_per_million = 0.50
WHERE provider IN ('anthropic', 'anthropic-vertex')
  AND (model_id = 'claude-opus-4-6' OR model_id LIKE 'claude-opus-4-6-________')
  AND input_price_per_million IS NULL;

-- ── claude-sonnet-4-6 (anthropic + anthropic-vertex) ──────────────────
UPDATE invocations
SET
  input_price_per_million        = 3.00,
  output_price_per_million       = 15.00,
  cached_input_price_per_million = 0.30
WHERE provider IN ('anthropic', 'anthropic-vertex')
  AND (model_id = 'claude-sonnet-4-6' OR model_id LIKE 'claude-sonnet-4-6-________')
  AND input_price_per_million IS NULL;

-- ── claude-haiku-4-5 (anthropic + anthropic-vertex) ───────────────────
UPDATE invocations
SET
  input_price_per_million        = 1.00,
  output_price_per_million       = 5.00,
  cached_input_price_per_million = 0.10
WHERE provider IN ('anthropic', 'anthropic-vertex')
  AND (model_id = 'claude-haiku-4-5' OR model_id LIKE 'claude-haiku-4-5-________')
  AND input_price_per_million IS NULL;
