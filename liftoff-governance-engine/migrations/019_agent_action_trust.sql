-- Migration 019: per-(agent, action) reliability ledger — "earned autonomy"
-- trust substrate.
--
-- SHADOW SUBSTRATE ONLY. This table backs a background rollup + a read
-- endpoint. It is deliberately NOT consulted by checkHitlGate() or any
-- admission/enforcement path yet — a later change may let a well-behaved
-- agent's routine action (tier = 'auto') auto-clear an otherwise-gated HITL
-- check, and demote an agent whose actions start getting rejected/failing.
-- Until that wiring lands, nothing reads `tier` for enforcement.
--
-- Grain: one row per (tenant_id, agent_id, action_class). `action_class` is
-- the bare tool action normalized the SAME way hitl-enforcement does it (the
-- segment after the last `__`; see toolActionMatchesNameSet in
-- src/hitl-enforcement/service.ts and src/action-trust/normalize.ts).
--
--   runs    = passes + rejects (total graded outcomes in the trailing window)
--   passes  = actions with status = 'completed'
--   rejects = actions with status = 'failed'  +  HITL rejections of that class
--   tier    = computeTier(runs, passes, rejects)  ∈ {'watch','queue','auto'}
--
-- RLS: matches the established tenant-scoped-table convention in this repo
-- (migrations 001 / 009 / 010) — ENABLE ROW LEVEL SECURITY + a
-- tenant-isolation policy keyed on current_setting('app.current_tenant_id').
-- The cross-tenant rollup runs as the governance_admin BYPASSRLS role (same
-- role the backfill/reconcile/partition jobs use); the tenant-scoped read
-- goes through withTenantScope() as governance_app.

CREATE TABLE agent_action_trust (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  action_class     TEXT NOT NULL,
  runs             INTEGER NOT NULL DEFAULT 0,
  passes           INTEGER NOT NULL DEFAULT 0,
  rejects          INTEGER NOT NULL DEFAULT 0,
  tier             TEXT NOT NULL DEFAULT 'watch',
  tier_changed_at  TIMESTAMPTZ,
  last_outcome_at  TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per (tenant, agent, action_class); the rollup UPSERTs on this key.
CREATE UNIQUE INDEX idx_agent_action_trust_unique
  ON agent_action_trust (tenant_id, agent_id, action_class);

-- Tenant-scoped lookups (read endpoint) and per-agent scans (rollup upsert).
CREATE INDEX idx_agent_action_trust_tenant_agent
  ON agent_action_trust (tenant_id, agent_id);

ALTER TABLE agent_action_trust ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_action_trust_tenant_isolation ON agent_action_trust
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- set_updated_at() is defined in migration 001.
CREATE TRIGGER agent_action_trust_updated_at BEFORE UPDATE ON agent_action_trust
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
