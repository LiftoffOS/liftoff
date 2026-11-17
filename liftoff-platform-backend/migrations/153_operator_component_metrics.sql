-- Operator dashboard: component health metrics
-- Stores per-component latency and HTTP status samples for the /api/operator/system-health endpoint.
-- Written by the agent runtime and coordinator; read by the operator dashboard service.

CREATE TABLE IF NOT EXISTS component_metrics (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  component   TEXT        NOT NULL,
  status      INTEGER     NOT NULL,       -- HTTP status code recorded for the call
  latency_ms  INTEGER     NOT NULL DEFAULT 0,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_component_metrics_component_ts
  ON component_metrics (component, timestamp DESC);

-- Partition-friendly: retain rolling 30-day window via a cron job; no FK needed.
