-- migrations/004_missing_tables.sql
-- Add byok_vendor_config, byok_rate_limit_buckets, byok_revocation_cache,
-- and processed_events tables missing from the initial schema.

BEGIN;

-- Vendor configuration: replaces hardcoded pricing in anthropic-adapter.ts.
-- One row per vendor; pricing is JSONB keyed by model name.
CREATE TABLE byok_vendor_config (
  vendor         TEXT        PRIMARY KEY,
  base_url       TEXT        NOT NULL,
  allowed_models TEXT[]      NOT NULL DEFAULT '{}',
  -- pricing JSONB: { "<model>": { "in_micros": N, "out_micros": N,
  --                               "cache_read_micros": N, "cache_write_micros": N } }
  -- Values are micros per million tokens.
  pricing        JSONB       NOT NULL DEFAULT '{}',
  enabled        BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO byok_vendor_config (vendor, base_url, allowed_models, pricing) VALUES (
  'anthropic',
  'https://api.anthropic.com',
  ARRAY[
    'claude-opus-4',    'claude-opus-4-5',
    'claude-sonnet-4',  'claude-sonnet-4-5',  'claude-sonnet-4-6',
    'claude-haiku-4',   'claude-haiku-4-5'
  ],
  '{
    "claude-opus-4":     {"in_micros": 15000000, "out_micros": 75000000, "cache_read_micros": 1500000,  "cache_write_micros": 18750000},
    "claude-opus-4-5":   {"in_micros": 15000000, "out_micros": 75000000, "cache_read_micros": 1500000,  "cache_write_micros": 18750000},
    "claude-sonnet-4":   {"in_micros":  3000000, "out_micros": 15000000, "cache_read_micros":  300000,  "cache_write_micros":  3750000},
    "claude-sonnet-4-5": {"in_micros":  3000000, "out_micros": 15000000, "cache_read_micros":  300000,  "cache_write_micros":  3750000},
    "claude-sonnet-4-6": {"in_micros":  3000000, "out_micros": 15000000, "cache_read_micros":  300000,  "cache_write_micros":  3750000},
    "claude-haiku-4":    {"in_micros":   250000, "out_micros":  1250000, "cache_read_micros":   30000,  "cache_write_micros":   312500},
    "claude-haiku-4-5":  {"in_micros":   800000, "out_micros":  4000000, "cache_read_micros":   80000,  "cache_write_micros":  1000000}
  }'::jsonb
);

-- Distributed rate-limit buckets (Postgres-backed, correct across all instances).
-- Primary key is (bucket_key, window_start) — one row per key per time window.
-- bucket_key format: "{credentialId}:{vendor}:{windowEpochSeconds}"
CREATE TABLE byok_rate_limit_buckets (
  bucket_key   TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 0,
  limit_count  INTEGER     NOT NULL,
  CONSTRAINT byok_rate_limit_buckets_pkey PRIMARY KEY (bucket_key, window_start)
);

-- Revocation cache: short-lived DB signal for cross-instance invalidation.
-- The in-memory cache has a 10s TTL; this table bridges the gap between instances.
-- Rows expire after 120s (well beyond any in-memory TTL).
CREATE TABLE byok_revocation_cache (
  credential_id UUID        PRIMARY KEY REFERENCES byok_credentials(id) ON DELETE CASCADE,
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '120 seconds'
);

CREATE INDEX idx_byok_revocation_expires ON byok_revocation_cache(expires_at);

-- Processed events: inbound idempotency for Pub/Sub push subscriptions.
CREATE TABLE processed_events (
  event_id     UUID        PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
