-- Migration 103: Correct invocation pricing snapshots for chat turns.
-- chat-turn-handler.ts hardcoded 'claude-sonnet-4-20250514' (Sonnet $3/$15 per MTok)
-- as the model for all chat invocations regardless of the agent's actual model config.
-- This corrects input_price_per_million and output_price_per_million for records
-- that have the wrong pricing stored. Cost on read = (tokens * price_per_million / 1e6).
--
-- Only corrects records where the stored price doesn't match the model's known price.
-- Records with NULL pricing are left as-is (cost will be NULL until updated).

-- Opus 4.x corrections ($5/$25 per MTok)
UPDATE invocations
SET
  input_price_per_million  = 5.00,
  output_price_per_million = 25.00
WHERE model_id IN ('claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-5')
  AND (
    input_price_per_million  IS DISTINCT FROM 5.00 OR
    output_price_per_million IS DISTINCT FROM 25.00
  )
  AND input_price_per_million IS NOT NULL;

-- Haiku 4.5 corrections ($1/$5 per MTok)
UPDATE invocations
SET
  input_price_per_million  = 1.00,
  output_price_per_million = 5.00
WHERE model_id IN ('claude-haiku-4-5', 'claude-haiku-4-5-20251001')
  AND (
    input_price_per_million  IS DISTINCT FROM 1.00 OR
    output_price_per_million IS DISTINCT FROM 5.00
  )
  AND input_price_per_million IS NOT NULL;
