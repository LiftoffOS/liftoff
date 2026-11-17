-- Model Pricing History
-- Versioned pricing table so historical cost can always be recomputed accurately.
-- The in-memory MODEL_PRICING dictionary in pricing.ts remains the hot cache for runtime;
-- this table is the audit trail and the source for backfill / analytics queries.

CREATE TABLE model_pricing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_price_per_million NUMERIC(10, 4) NOT NULL,
  output_price_per_million NUMERIC(10, 4) NOT NULL,
  cached_input_price_per_million NUMERIC(10, 4),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,  -- NULL = currently active rate
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active rate per provider+model at any time
CREATE UNIQUE INDEX idx_pricing_active
  ON model_pricing_history (provider, model_id) WHERE effective_to IS NULL;

-- Fast lookup for historical cost recomputation
CREATE INDEX idx_pricing_lookup
  ON model_pricing_history (provider, model_id, effective_from);

COMMENT ON TABLE model_pricing_history IS 'Versioned pricing rates per provider+model. effective_to IS NULL means currently active.';
COMMENT ON COLUMN model_pricing_history.effective_to IS 'NULL = currently active rate. Set when a new rate supersedes this one.';
