-- Claude Code Model Pricing
-- Stores per-model cost rates for estimated cost calculation.
-- Uses exact model name matching (not regex) with effective_from for historical accuracy.

CREATE TABLE IF NOT EXISTS claude_code_model_pricing (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name              TEXT NOT NULL,           -- exact model name, e.g., 'claude-opus-4-6'
  input_cost              NUMERIC NOT NULL,        -- USD per million tokens
  output_cost             NUMERIC NOT NULL,
  cache_write_multiplier  NUMERIC NOT NULL DEFAULT 1.25,
  cache_read_multiplier   NUMERIC NOT NULL DEFAULT 0.1,
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_name, effective_from)
);

-- Index for the cost lateral join (exact match on model_name + effective_from range)
CREATE INDEX idx_model_pricing_lookup ON claude_code_model_pricing (model_name, effective_from DESC);

-- Seed current Anthropic pricing (idempotent — ON CONFLICT skips duplicates)
INSERT INTO claude_code_model_pricing (model_name, input_cost, output_cost) VALUES
  ('claude-opus-4-6', 5, 25),
  ('claude-opus-4-5', 5, 25),
  ('claude-sonnet-4-6', 3, 15),
  ('claude-sonnet-4-5', 3, 15),
  ('claude-sonnet-4', 3, 15),
  ('claude-haiku-4-5', 1, 5),
  ('claude-haiku-3-5', 0.8, 4)
ON CONFLICT (model_name, effective_from) DO NOTHING;
