-- Cost Attribution Module
--
-- Partitioned event log (one row per billable unit) that aggregates
-- costs from tenant-runtime invocations, governance connector calls,
-- byok-proxy LLM calls, and GCP billing into a single queryable store.
--
-- Partition key: occurred_at (RANGE, monthly).
-- Idempotency key: (source, source_id, event_type) — prevents
-- double-ingest when ingesters replay their cursors.

-- ── Main event log ────────────────────────────────────────────────────

CREATE TABLE cost_attribution_events (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             TEXT        NOT NULL,
  agent_id              TEXT,
  workflow_id           TEXT,
  action_id             TEXT,
  thread_id             TEXT,
  invocation_id         TEXT,
  parent_invocation_id  TEXT,
  connector             TEXT,
  entity_type           TEXT,
  action_type           TEXT,
  purpose               TEXT,
  event_type            TEXT        NOT NULL,
  source                TEXT        NOT NULL,
  source_id             TEXT,
  provider              TEXT,
  model                 TEXT,
  input_tokens          BIGINT,
  output_tokens         BIGINT,
  cached_tokens         BIGINT,
  cost_usd              NUMERIC(18,8) NOT NULL,
  hosting_mode          TEXT,
  -- Attribution quality: 'direct' (agentId in scope) | 'exact' (trace-matched)
  --                      | 'fuzzy' (timestamp-matched) | 'unmatched'
  correlation_confidence TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cost_attribution_events_event_type_check
    CHECK (event_type IN (
      'llm_invocation', 'embedding', 'connector_call', 'infra_compute',
      'byok_llm', 'credit', 'sandbox',
      'cloud_scheduler', 'kms_operation', 'cloud_tasks',
      'cloud_storage_op', 'cloud_build'
    )),
  CONSTRAINT cost_attribution_events_source_check
    CHECK (source IN (
      'tenant_runtime', 'governance', 'byok_proxy',
      'gcp_billing', 'gcp_billing_platform', 'platform_llm'
    )),
  CONSTRAINT cost_attribution_events_correlation_check
    CHECK (correlation_confidence IN ('direct', 'exact', 'fuzzy', 'unmatched')),
  -- Partition key must be part of PRIMARY KEY on partitioned tables (PostgreSQL requirement)
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Monthly partitions — 18 months forward from April 2026
CREATE TABLE cost_attribution_events_y2026m04
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE cost_attribution_events_y2026m05
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE cost_attribution_events_y2026m06
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE cost_attribution_events_y2026m07
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE cost_attribution_events_y2026m08
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE cost_attribution_events_y2026m09
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE cost_attribution_events_y2026m10
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE cost_attribution_events_y2026m11
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE cost_attribution_events_y2026m12
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE cost_attribution_events_y2027m01
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE cost_attribution_events_y2027m02
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE cost_attribution_events_y2027m03
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE cost_attribution_events_y2027m04
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE cost_attribution_events_y2027m05
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE cost_attribution_events_y2027m06
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE cost_attribution_events_y2027m07
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE cost_attribution_events_y2027m08
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE cost_attribution_events_y2027m09
  PARTITION OF cost_attribution_events
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');

-- Default partition catches anything outside the pre-created range
-- (e.g. historical backfill, future months not yet created)
CREATE TABLE cost_attribution_events_default
  PARTITION OF cost_attribution_events DEFAULT;

-- Indexes (created on parent; PostgreSQL propagates to partitions)
CREATE INDEX idx_cae_tenant_occurred   ON cost_attribution_events (tenant_id, occurred_at);
CREATE INDEX idx_cae_agent             ON cost_attribution_events (tenant_id, agent_id, occurred_at)
  WHERE agent_id IS NOT NULL;
CREATE INDEX idx_cae_action            ON cost_attribution_events (action_id)
  WHERE action_id IS NOT NULL;
CREATE INDEX idx_cae_invocation        ON cost_attribution_events (invocation_id)
  WHERE invocation_id IS NOT NULL;
CREATE INDEX idx_cae_thread            ON cost_attribution_events (tenant_id, thread_id)
  WHERE thread_id IS NOT NULL;
CREATE INDEX idx_cae_source            ON cost_attribution_events (source, source_id)
  WHERE source_id IS NOT NULL;

-- Idempotency: prevents double-ingest from cursor replay.
-- occurred_at is required in the unique index because PostgreSQL demands
-- all partitioning columns appear in any unique constraint on a partitioned table.
CREATE UNIQUE INDEX idx_cae_source_idempotency
  ON cost_attribution_events (source, source_id, event_type, occurred_at)
  WHERE source_id IS NOT NULL;

-- ── Hourly/daily rollup snapshots ──────────────────────────────────────

CREATE TABLE cost_attribution_snapshots (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT        NOT NULL,
  agent_id            TEXT,
  workflow_id         TEXT,
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  granularity         TEXT        NOT NULL,
  total_cost_usd      NUMERIC(18,8) NOT NULL DEFAULT 0,
  llm_cost_usd        NUMERIC(18,8) NOT NULL DEFAULT 0,
  connector_cost_usd  NUMERIC(18,8) NOT NULL DEFAULT 0,
  infra_cost_usd      NUMERIC(18,8) NOT NULL DEFAULT 0,
  total_invocations   BIGINT      NOT NULL DEFAULT 0,
  total_actions       BIGINT      NOT NULL DEFAULT 0,
  total_input_tokens  BIGINT      NOT NULL DEFAULT 0,
  total_output_tokens BIGINT      NOT NULL DEFAULT 0,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT cost_attribution_snapshots_granularity_check
    CHECK (granularity IN ('hour', 'day', 'month')),
  UNIQUE (tenant_id, agent_id, period_start, granularity)
);

CREATE INDEX idx_cas_tenant_period
  ON cost_attribution_snapshots (tenant_id, period_start, granularity);

-- ── Ingestion cursors (for resumable ingest + backfill) ────────────────

CREATE TABLE cost_attribution_cursors (
  source      TEXT        PRIMARY KEY,
  last_id     TEXT,
  last_ts     TIMESTAMPTZ,
  completed   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Anthropic billing reconciliation log ──────────────────────────────

CREATE TABLE anthropic_billing_reconciliation (
  date                DATE        NOT NULL,
  purpose_group       TEXT        NOT NULL,
  anthropic_cost_usd  NUMERIC(18,8) NOT NULL,
  internal_cost_usd   NUMERIC(18,8) NOT NULL,
  discrepancy_pct     NUMERIC(6,4) NOT NULL,
  reconciled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, purpose_group)
);
