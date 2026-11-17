-- Migration 099: Governance Write-Ahead Log
--
-- Part of the governance-engine split. The tenant-runtime writes
-- audit records here SYNCHRONOUSLY BEFORE calling governance-engine's
-- Record RPC, so a governance-engine outage cannot lose audit data. A
-- background drainer (src/governance/wal-drainer.ts) replays unreplicated
-- rows to governance-engine and marks them replicated=true on success.
--
-- Columns:
--   idempotency_key — unique per (tenant, action). Safe to replay.
--   action_payload — the RecordRequest proto fields, serialized as JSON.
--   result         — external response + status (proto JSON or error blob).
--   cost_usd       — normalised cost from the tool gateway.
--   vendor_latency_ms — measured latency, included in RecordRequest.
--   replicated     — true once Record returned 202 Accepted.
--
-- RLS: tenant-scoped, guarded via app.tenant_id set by withTenantScope().
-- tenant-runtime uses `app.tenant_id` (migrations 016/017/079/082); only
-- 083_sandbox_execution_environments.sql strayed to `app.current_tenant_id`.
-- The tenant_id column here is TEXT (per plan), so no ::uuid cast.

CREATE TABLE governance_wal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id TEXT,
  idempotency_key TEXT NOT NULL,
  action_payload JSONB NOT NULL,
  result JSONB,
  cost_usd NUMERIC,
  vendor_latency_ms INTEGER,
  replicated BOOLEAN NOT NULL DEFAULT false,
  replicated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

-- Partial index for the drainer: scan only unreplicated rows in FIFO order.
CREATE INDEX idx_governance_wal_unreplicated ON governance_wal (replicated, created_at)
  WHERE NOT replicated;

-- Row-Level Security — tenant isolation via app.current_tenant_id.
ALTER TABLE governance_wal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_governance_wal ON governance_wal
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

COMMENT ON TABLE governance_wal IS
  'Write-ahead log for governance-engine Record RPC. Rows are written synchronously at tool-call time and drained to governance-engine by a background loop. Retention: purge replicated rows after 24h.';
