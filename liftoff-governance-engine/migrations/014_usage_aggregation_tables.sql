-- Migration 014: Usage aggregation persistence tables.
--
-- src/usage-ledger/aggregation-repository.ts computes period-level usage
-- snapshots (hourly/daily/weekly/monthly) from raw usage_events, generates
-- spend forecasts, and tracks aggregation job state. All three tables were
-- missing; aggregation jobs were failing silently with SQL errors. These
-- tables make the usage-ledger aggregation pipeline operational.

-- Aggregated usage by period. One row per (tenant, period, period_start).
-- The by_* JSONB columns break down usage by event_type, agent_id, and
-- connector so the frontend analytics queries don't have to GROUP BY
-- over the raw partitioned usage_events table on every request.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT            NOT NULL,
  period          TEXT            NOT NULL,  -- 'hourly' | 'daily' | 'weekly' | 'monthly'
  period_start    TIMESTAMPTZ     NOT NULL,
  period_end      TIMESTAMPTZ     NOT NULL,
  total_credits   NUMERIC(18, 6)  NOT NULL DEFAULT 0,
  total_actions   INTEGER         NOT NULL DEFAULT 0,
  by_event_type   JSONB           NOT NULL DEFAULT '{}',
  by_agent        JSONB           NOT NULL DEFAULT '{}',
  by_connector    JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_tenant_period
  ON usage_snapshots (tenant_id, period, period_start DESC);

-- Spend forecasts projected to end-of-period. One row per (tenant, forecast_date).
-- Replaced on each aggregation run; the most recent row is authoritative.
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT            NOT NULL,
  forecast_date       TIMESTAMPTZ     NOT NULL,
  period_end          TIMESTAMPTZ     NOT NULL,
  projected_credits   NUMERIC(18, 6)  NOT NULL,
  projected_actions   INTEGER         NOT NULL DEFAULT 0,
  confidence_interval JSONB           NOT NULL DEFAULT '{"low": 0, "high": 0}',
  trend               TEXT            NOT NULL DEFAULT 'stable',  -- 'increasing' | 'stable' | 'decreasing'
  trend_percentage    NUMERIC(5, 2)   NOT NULL DEFAULT 0,
  alerts              JSONB           NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_tenant_date
  ON forecast_snapshots (tenant_id, forecast_date DESC);

-- Job-level tracking for aggregation runs. Prevents concurrent duplicate
-- aggregations for the same (tenant, period, period_start) window.
CREATE TABLE IF NOT EXISTS aggregation_jobs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL,
  period          TEXT        NOT NULL,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, period, period_start)
);

CREATE INDEX IF NOT EXISTS idx_aggregation_jobs_status
  ON aggregation_jobs (status, created_at)
  WHERE status IN ('pending', 'running');
