-- migrations/129_tenant_memory_strategy.sql

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS memory_layer_strategy TEXT NOT NULL DEFAULT 'all'
    CHECK (memory_layer_strategy IN ('all', 'narrow_with_peer')),
  ADD COLUMN IF NOT EXISTS influence_last_recomputed TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenants_memory_strategy
  ON tenants(memory_layer_strategy)
  WHERE memory_layer_strategy != 'all';
