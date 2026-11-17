-- Migration 012: Rate limiting persistence tables.
--
-- src/admission/rate-limiter.ts implements a token-bucket rate limiter.
-- It attempts to persist bucket state to rate_limit_buckets (so buckets
-- survive process restarts) and reads per-tenant overrides from
-- rate_limit_configs. Both tables were missing, causing the persist step
-- to fail silently (try-catch) and tenant overrides to fall back to
-- DEFAULT_CONFIGS. These tables make rate limiting durable without changing
-- the fallback behaviour.
--
-- resource_id is NOT NULL (empty string '' represents a global/tenant-level
-- bucket with no specific resource). This allows ON CONFLICT (tenant_id,
-- bucket_type, resource_id) to work correctly — NULLs break ON CONFLICT
-- equality matching in Postgres.

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  tenant_id       TEXT            NOT NULL,
  bucket_type     TEXT            NOT NULL,
  resource_id     TEXT            NOT NULL DEFAULT '',
  tokens          NUMERIC(18, 6)  NOT NULL,
  last_refill_at  TIMESTAMPTZ     NOT NULL,
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, bucket_type, resource_id)
);

-- Per-tenant overrides for rate limit capacity and refill parameters.
-- Rows here supersede DEFAULT_CONFIGS for specific tenants; tenants without
-- a row fall back to the in-process defaults unchanged.
CREATE TABLE IF NOT EXISTS rate_limit_configs (
  tenant_id           TEXT            NOT NULL,
  bucket_type         TEXT            NOT NULL,
  capacity            NUMERIC(18, 6)  NOT NULL,
  refill_rate         NUMERIC(18, 6)  NOT NULL,
  refill_interval_ms  INTEGER         NOT NULL,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, bucket_type)
);
