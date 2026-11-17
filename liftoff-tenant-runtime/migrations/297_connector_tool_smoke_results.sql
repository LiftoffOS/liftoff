-- C.2 — Per-tenant connector-tool smoke results.
--
-- The hourly /api/internal/connector-tool-smoke cron picks one read-only
-- function per (tenant, connector_manifest) and dispatches it via the
-- normal tool-gateway path. We record the outcome here so:
--   * the dashboard can show "Gmail last smoked 2026-06-23 14:00 OK 142ms"
--   * the alerting layer can fire on (ok=false, recent_failures>=3)
--   * an operator can audit which action was actually dispatched per binding
--
-- Index design: hot read query is "WHERE tenant_id=? AND connector_manifest_id=?
-- ORDER BY ran_at DESC LIMIT 24" — the latest 24 hours of smokes per binding.
-- A two-column (tenant, manifest) + DESC ran_at composite serves that exactly.

CREATE TABLE connector_tool_smoke_results (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_manifest_id    uuid        NOT NULL REFERENCES connector_manifests(id) ON DELETE CASCADE,
  action                   text        NOT NULL,
  ok                       boolean     NOT NULL,
  error_code               text,
  error_message            text,
  latency_ms               integer,
  ran_at                   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_smoke_tenant_manifest_ran
  ON connector_tool_smoke_results (tenant_id, connector_manifest_id, ran_at DESC);

-- Bucket-ordering index — the cron hash-shards tenants into 6 buckets and
-- runs one bucket per hour. The dashboard's "smoke run history" view groups
-- by ran_at hour, so DESC(ran_at) by itself is also useful for that.
CREATE INDEX idx_smoke_ran_at ON connector_tool_smoke_results (ran_at DESC);

COMMENT ON TABLE connector_tool_smoke_results IS
  'C.2: per-tenant per-connector hourly read-only smoke results. Hash-sharded 6 buckets so each binding gets probed every 6 hours.';
