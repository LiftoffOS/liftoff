-- Synced per-model pricing, single source of truth for open-weights (OpenRouter)
-- rates. Populated by the model-pricing-sync Cloud Run Job from the OpenRouter
-- models API (src/scripts/sync-model-pricing.ts). Kept SEPARATE from `models`:
-- pricing is high-churn (re-synced on a schedule); the model catalog is stable.
--
-- computeRowCost() (src/llm/pricing.ts) reads these rates DB-first, falling back
-- to the hardcoded MODEL_PRICING table when a row is absent (offline / first boot
-- / non-synced providers). All rates USD per MILLION tokens.
CREATE TABLE IF NOT EXISTS model_pricing (
  provider          VARCHAR(50)   NOT NULL,
  model_id          VARCHAR(255)  NOT NULL,
  input_per_m       NUMERIC(12,6) NOT NULL,
  output_per_m      NUMERIC(12,6) NOT NULL,
  cache_read_per_m  NUMERIC(12,6),
  source            VARCHAR(64)   NOT NULL,   -- 'openrouter-models-api'
  source_slug       VARCHAR(255),             -- exact OpenRouter slug fetched (audit)
  synced_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, model_id)
);
