-- Migration 001: Initial governance-engine schema.
--
-- First-pass schema for the governance plane. Tables mirror the shapes
-- already used in tenant-runtime's inline governance code + platform-backend's
-- HITL APIs, but are the authoritative storage for this service going forward.
--
-- Tables (12 total):
--   actions                  — action ledger (immutable row per tool call).
--                              PARTITIONED BY RANGE(created_at) — monthly.
--   compensation_actions     — reverse-action records (refund / delete / etc).
--   compensation_plans       — multi-step compensation sequence state.
--   usage_events             — usage ledger (per-unit cost accounting).
--                              PARTITIONED BY RANGE(created_at) — monthly.
--   burn_state               — per-tenant credit burn state (period snapshot).
--   refunds                  — credit refund records linked to actions.
--   audit_logs               — cross-surface audit trail.
--   hitl_approval_requests   — HITL approval queue + decisions.
--   human_feedback           — late HITL feedback + reflection input stream.
--   kill_switches            — global/tenant/agent/connector kill-switch state.
--   action_allowlists        — per-capability allowlist entries.
--   cached_entitlements      — admission's local entitlement cache.
--
-- Naming conventions:
--   - RLS tenant variable is `app.current_tenant_id` (NOT `app.tenant_id`).
--     Matches platform-backend migration 095 / connector-service migration 002.
--     The older tenant-runtime inline governance path still uses the legacy
--     `app.tenant_id` name until that caller is migrated.
--   - Env-var token is GOVERNANCE_SERVICE_TOKEN (see README); unrelated to
--     schema but noted here for cross-reference.
--
-- RLS: tenant-scoped tables get policy
--   `tenant_id = current_setting('app.current_tenant_id', true)`
-- The `kill_switches` table is tenant-scoped when tenant_id is non-empty; the
-- special sentinel '__global__' stores platform-wide switches and is visible
-- to every tenant (read-only).
-- `cached_entitlements` is read primarily by admission code paths that have
-- already resolved the tenant context above the query layer; it still gets
-- RLS for defense-in-depth.
--
-- Partitioning: `actions` and `usage_events` are RANGE-partitioned on
-- `created_at` at monthly grain. The primary key for partitioned tables
-- must include the partition key, so PK = (id, created_at) on both.
-- Pre-created 18 monthly partitions (2026-04 through 2027-09).
-- TODO(phase3-followup): automate partition creation via pg_partman or a
-- Cloud Scheduler job so we don't start returning write errors in 2027-10.
--
-- This is FIRST-PASS. Follow-up migrations will refine the column set from
-- the actual tenant-runtime source (e.g. workflow_id / task_id columns on
-- actions, decision metadata on approvals).

-- ─── actions (action ledger) — PARTITIONED BY created_at ────────────

CREATE TABLE actions (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- PK must include the partition key (created_at) per Postgres rules.
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_actions_tenant_created
  ON actions (tenant_id, created_at DESC);
-- Idempotency key must be unique per tenant; the partition key is included
-- because unique indexes on partitioned tables must contain the partition
-- columns.
CREATE UNIQUE INDEX idx_actions_idempotency
  ON actions (tenant_id, idempotency_key, created_at)
  WHERE idempotency_key IS NOT NULL;

-- Initial monthly partitions (2026-04 through 2027-09 — 18 months).
-- Extend / automate via pg_partman before 2027-10.
CREATE TABLE actions_2026_04 PARTITION OF actions FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE actions_2026_05 PARTITION OF actions FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE actions_2026_06 PARTITION OF actions FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE actions_2026_07 PARTITION OF actions FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE actions_2026_08 PARTITION OF actions FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE actions_2026_09 PARTITION OF actions FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE actions_2026_10 PARTITION OF actions FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE actions_2026_11 PARTITION OF actions FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE actions_2026_12 PARTITION OF actions FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE actions_2027_01 PARTITION OF actions FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE actions_2027_02 PARTITION OF actions FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE actions_2027_03 PARTITION OF actions FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE actions_2027_04 PARTITION OF actions FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE actions_2027_05 PARTITION OF actions FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE actions_2027_06 PARTITION OF actions FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE actions_2027_07 PARTITION OF actions FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE actions_2027_08 PARTITION OF actions FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE actions_2027_09 PARTITION OF actions FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');

-- ─── compensation_actions ──────────────────────────────────────────
-- Tracks reverse-action records (refund/restore/semantic/manual). Canonical
-- column set derived from tenant-runtime src/action-ledger/repository.ts.
-- TODO: verify against src/action-ledger/repository.ts actual column list.

CREATE TABLE compensation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  -- FK to actions uses the composite key (id, created_at); we don't enforce
  -- the FK here because `actions` is partitioned and cross-partition FKs in
  -- Postgres are awkward. We still carry the action_id + action_created_at
  -- pair so callers can join.
  action_id UUID NOT NULL,
  action_created_at TIMESTAMPTZ,
  compensation_type TEXT NOT NULL, -- reverse | restore | semantic | manual
  target_connector TEXT,
  target_entity_type TEXT,
  target_ref TEXT,
  compensation_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  executed_at TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compensation_actions_tenant_created
  ON compensation_actions (tenant_id, created_at DESC);
CREATE INDEX idx_compensation_actions_action
  ON compensation_actions (action_id);

-- ─── compensation_plans ─────────────────────────────────────────────
-- Tracks multi-step compensation sequences keyed by workflow.
-- TODO: verify against src/action-ledger/repository.ts actual column list.

CREATE TABLE compensation_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  workflow_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  actions_total INTEGER NOT NULL DEFAULT 0,
  actions_completed INTEGER NOT NULL DEFAULT 0,
  actions_failed INTEGER NOT NULL DEFAULT 0,
  compensation_strategy TEXT NOT NULL DEFAULT 'sequential', -- sequential | parallel | best_effort
  plan_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_compensation_plans_tenant_created
  ON compensation_plans (tenant_id, created_at DESC);
CREATE INDEX idx_compensation_plans_workflow
  ON compensation_plans (workflow_id);

-- ─── usage_events (usage ledger) — PARTITIONED BY created_at ────────

CREATE TABLE usage_events (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  units NUMERIC(18, 6) NOT NULL DEFAULT 0,
  cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_usage_events_tenant_created
  ON usage_events (tenant_id, created_at DESC);
CREATE INDEX idx_usage_events_tenant_type
  ON usage_events (tenant_id, event_type);

CREATE TABLE usage_events_2026_04 PARTITION OF usage_events FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE usage_events_2026_05 PARTITION OF usage_events FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE usage_events_2026_06 PARTITION OF usage_events FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE usage_events_2026_07 PARTITION OF usage_events FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE usage_events_2026_08 PARTITION OF usage_events FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE usage_events_2026_09 PARTITION OF usage_events FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE usage_events_2026_10 PARTITION OF usage_events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE usage_events_2026_11 PARTITION OF usage_events FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE usage_events_2026_12 PARTITION OF usage_events FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE usage_events_2027_01 PARTITION OF usage_events FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE usage_events_2027_02 PARTITION OF usage_events FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE usage_events_2027_03 PARTITION OF usage_events FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE usage_events_2027_04 PARTITION OF usage_events FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE usage_events_2027_05 PARTITION OF usage_events FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE usage_events_2027_06 PARTITION OF usage_events FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE usage_events_2027_07 PARTITION OF usage_events FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE usage_events_2027_08 PARTITION OF usage_events FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE usage_events_2027_09 PARTITION OF usage_events FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');

-- ─── burn_state (per-tenant credit burn snapshot) ───────────────────

CREATE TABLE burn_state (
  tenant_id TEXT PRIMARY KEY,
  period_start DATE NOT NULL,
  credits_used NUMERIC(18, 6) NOT NULL DEFAULT 0,
  credits_remaining NUMERIC(18, 6) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── refunds ────────────────────────────────────────────────────────
-- Credit refund records. Follows tenant-runtime src/usage-ledger/repository.ts
-- (recordRefund INSERT INTO refunds (tenant_id, action_id, credits, reason)).
-- TODO: verify against src/usage-ledger/repository.ts actual column list.

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  action_id UUID NOT NULL,
  credits NUMERIC(18, 6) NOT NULL,
  -- Alias: some callers think in dollars; we carry both so the receipts
  -- surface doesn't have to re-derive.
  credit_amount NUMERIC(18, 6) GENERATED ALWAYS AS (credits) STORED,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refunds_tenant_created
  ON refunds (tenant_id, created_at DESC);
CREATE INDEX idx_refunds_action ON refunds (action_id);

-- ─── audit_logs ─────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, created_at DESC);

-- ─── hitl_approval_requests ─────────────────────────────────────────

CREATE TABLE hitl_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id TEXT,
  action_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_hitl_approvals_tenant_status
  ON hitl_approval_requests (tenant_id, status);
CREATE INDEX idx_hitl_approvals_tenant_requested
  ON hitl_approval_requests (tenant_id, requested_at DESC);

-- ─── human_feedback ────────────────────────────────────────────────
-- Late HITL feedback + reflection input stream. Mirrors tenant-runtime
-- migrations 001 + 057 (columns agent_id, task_id, tenant_id, feedback,
-- feedback_type, feedback_id, created_at).
-- TODO: verify against src/hitl-enforcement/service.ts actual column usage.

CREATE TABLE human_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id UUID,
  task_id UUID,
  action_id UUID,
  feedback TEXT NOT NULL,
  feedback_body JSONB,
  feedback_type TEXT NOT NULL, -- approval | rejection | correction | annotation
  reviewer TEXT,
  -- Idempotency key from platform-backend late-feedback retries. Unique
  -- when non-null.
  feedback_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_human_feedback_feedback_id
  ON human_feedback (feedback_id)
  WHERE feedback_id IS NOT NULL;
CREATE INDEX idx_human_feedback_tenant_agent_created
  ON human_feedback (tenant_id, agent_id, created_at DESC);
CREATE INDEX idx_human_feedback_tenant_created
  ON human_feedback (tenant_id, created_at DESC);

-- ─── kill_switches ──────────────────────────────────────────────────

-- tenant_id = '__global__' sentinel means platform-wide switch.
-- switch_name examples: 'global', 'tenant', 'agent:<id>', 'connector:<type>'.
CREATE TABLE kill_switches (
  tenant_id TEXT NOT NULL,
  switch_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'off',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, switch_name)
);

-- ─── action_allowlists ──────────────────────────────────────────────

CREATE TABLE action_allowlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  pattern JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_action_allowlists_tenant
  ON action_allowlists (tenant_id, connector_type, entity_type, action_type);

-- ─── cached_entitlements ────────────────────────────────────────────
-- Admission's local entitlement cache, populated from the entitlements
-- subscriber. One row per tenant; re-written on entitlements-updated
-- events. The JSON payload mirrors the platform-backend entitlement
-- envelope so admission can read it directly.
-- TODO: verify against src/admission/ + src/entitlements-client/repository.ts actual columns.

CREATE TABLE cached_entitlements (
  tenant_id TEXT PRIMARY KEY,
  entitlements_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_version INTEGER NOT NULL DEFAULT 1,
  operational_status TEXT NOT NULL DEFAULT 'pending',
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cached_entitlements_expires
  ON cached_entitlements (expires_at);

-- ─── Row-Level Security on tenant-scoped tables ─────────────────────
-- RLS variable is `app.current_tenant_id`. The older
-- tenant-runtime inline path still uses the legacy `app.tenant_id` name
-- until that caller is migrated.

ALTER TABLE actions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE compensation_actions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE compensation_plans     ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE burn_state             ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds                ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE hitl_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_feedback         ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_allowlists      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cached_entitlements    ENABLE ROW LEVEL SECURITY;

CREATE POLICY actions_tenant_isolation ON actions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY compensation_actions_tenant_isolation ON compensation_actions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY compensation_plans_tenant_isolation ON compensation_plans
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY usage_events_tenant_isolation ON usage_events
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY burn_state_tenant_isolation ON burn_state
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY refunds_tenant_isolation ON refunds
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY hitl_approvals_tenant_isolation ON hitl_approval_requests
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY human_feedback_tenant_isolation ON human_feedback
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY action_allowlists_tenant_isolation ON action_allowlists
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE POLICY cached_entitlements_tenant_isolation ON cached_entitlements
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- kill_switches: tenant scope + visibility for '__global__' rows.
ALTER TABLE kill_switches ENABLE ROW LEVEL SECURITY;

CREATE POLICY kill_switches_visibility ON kill_switches
  FOR SELECT
  USING (
    tenant_id = '__global__'
    OR tenant_id = current_setting('app.current_tenant_id', true)
  );
CREATE POLICY kill_switches_write ON kill_switches
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

-- ─── Admin role (BYPASSRLS) ─────────────────────────────────────────

-- Background jobs (ledger aggregation, billing rollups, audit export)
-- need cross-tenant visibility. Follows the connector-service /
-- tenant-runtime convention.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'governance_admin') THEN
    CREATE ROLE governance_admin WITH BYPASSRLS LOGIN;
  END IF;
END $$;

-- ─── Updated-at trigger for tables that track it ────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER burn_state_updated_at BEFORE UPDATE ON burn_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER kill_switches_updated_at BEFORE UPDATE ON kill_switches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER cached_entitlements_updated_at BEFORE UPDATE ON cached_entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
