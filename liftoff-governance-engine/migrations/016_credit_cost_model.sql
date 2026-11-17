-- Migration 016: Credit cost model for configurable per-action pricing.
--
-- src/usage-ledger/credit-cost-service.ts queries:
--   SELECT * FROM credit_cost_model
--   WHERE action_type = $1
--     AND (tenant_id = $2 OR tenant_id IS NULL)
--     AND (connector = $3 OR connector IS NULL)
--     AND effective_from <= $4
--     AND (effective_until IS NULL OR effective_until > $4)
-- The table was missing; the query failure caused a fallback to
-- DEFAULT_CREDIT_COSTS in-process constants so credit accounting worked
-- but was not configurable per-tenant or per-connector. This migration
-- makes operator-configured pricing possible.
--
-- Rows with tenant_id IS NULL are system-wide defaults. Per-tenant rows
-- (tenant_id IS NOT NULL) override system defaults for that tenant. Rows
-- with connector IS NULL apply to all connectors; connector-specific rows
-- take priority over connector-agnostic rows for the same action_type.

CREATE TABLE IF NOT EXISTS credit_cost_model (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT,                               -- NULL = system default
  action_type     TEXT            NOT NULL,
  connector       TEXT,                               -- NULL = all connectors
  credits_per_action NUMERIC(18, 6) NOT NULL,
  effective_from  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,                        -- NULL = no expiry
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, action_type, connector, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_credit_cost_model_lookup
  ON credit_cost_model (action_type, effective_from DESC);
