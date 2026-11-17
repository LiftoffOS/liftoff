BEGIN;

-- byok_credentials: proxy key metadata (raw Anthropic key lives in Secret Manager)
CREATE TABLE byok_credentials (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL,
  user_id       TEXT        NOT NULL,
  vendor        TEXT        NOT NULL DEFAULT 'anthropic',
  key_hash      TEXT        NOT NULL UNIQUE,   -- SHA-256(liftoff_sk_*) hex
  key_prefix    TEXT        NOT NULL,          -- liftoff_sk_{first8}
  key_hint      TEXT        NOT NULL,          -- last 4 chars of raw token
  secret_name   TEXT        NOT NULL,          -- Secret Manager ID, NOT the raw key
  label         TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active', -- active|revoked
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_byok_credentials_key_hash ON byok_credentials(key_hash);
CREATE INDEX idx_byok_credentials_tenant   ON byok_credentials(tenant_id, user_id);
CREATE INDEX idx_byok_credentials_active   ON byok_credentials(tenant_id) WHERE status = 'active';

-- byok_usage_log: per-request usage, partitioned by started_at month
CREATE TABLE byok_usage_log (
  id                          BIGSERIAL   NOT NULL,
  tenant_id                   UUID        NOT NULL,
  user_id                     TEXT        NOT NULL,
  credential_id               UUID        NOT NULL,
  vendor                      TEXT        NOT NULL DEFAULT 'anthropic',
  model                       TEXT        NOT NULL,
  request_id                  TEXT        NOT NULL,        -- vendor-assigned; idempotency key for billing
  input_tokens                BIGINT      NOT NULL DEFAULT 0,
  output_tokens               BIGINT      NOT NULL DEFAULT 0,
  cached_input_tokens         BIGINT      NOT NULL DEFAULT 0,
  cache_creation_input_tokens BIGINT      NOT NULL DEFAULT 0,
  cost_micros                 BIGINT      NOT NULL DEFAULT 0,
  status                      TEXT        NOT NULL DEFAULT 'pending', -- pending|final|disconnected|error
  billing_reported_at         TIMESTAMPTZ,
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at                TIMESTAMPTZ,
  error_message               TEXT
) PARTITION BY RANGE (started_at);

-- Initial partitions (monthly)
CREATE TABLE byok_usage_log_y2026_m04 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE byok_usage_log_y2026_m05 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE byok_usage_log_y2026_m06 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE byok_usage_log_y2026_m07 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE byok_usage_log_y2026_m08 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE byok_usage_log_y2026_m09 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE byok_usage_log_y2026_m10 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE byok_usage_log_y2026_m11 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE byok_usage_log_y2026_m12 PARTITION OF byok_usage_log
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE UNIQUE INDEX idx_byok_usage_log_request_id ON byok_usage_log(request_id, started_at);
CREATE INDEX idx_byok_usage_log_tenant  ON byok_usage_log(tenant_id, started_at);
CREATE INDEX idx_byok_usage_log_pending ON byok_usage_log(status) WHERE status = 'pending';
CREATE INDEX idx_byok_usage_log_cred    ON byok_usage_log(credential_id, started_at);

-- outbox_events: reuse @liftoffos/outbox schema for billing event publishing
CREATE TABLE outbox_events (
  id              BIGSERIAL   PRIMARY KEY,
  event_id        UUID        NOT NULL UNIQUE,
  event_type      TEXT        NOT NULL,
  schema_version  INTEGER     NOT NULL,
  tenant_id       UUID        NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_service  TEXT        NOT NULL DEFAULT 'byok-proxy',
  trace_id        TEXT,
  payload         JSONB       NOT NULL DEFAULT '{}',
  published_at    TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox_events(published_at) WHERE published_at IS NULL;

COMMIT;
