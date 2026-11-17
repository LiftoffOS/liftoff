-- Distillation result cache.
-- Stores the output of a successful distillation keyed by a SHA-256 fingerprint
-- of the normalized input (role, responsibilities, integrations, additionalContext)
-- combined with a hash of the fetched tool catalog content. Cache misses trigger
-- a fresh LLM call; hits return the stored JSONB immediately, skipping the LLM.
CREATE TABLE distillation_cache (
  fingerprint TEXT PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  result      JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX distillation_cache_tenant_id_idx ON distillation_cache (tenant_id);
CREATE INDEX distillation_cache_expires_at_idx ON distillation_cache (expires_at);
