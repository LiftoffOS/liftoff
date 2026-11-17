-- Durable record of every HITL gate decision (approve/reject) per
-- (tenant, agent, action_class, gate_reason). An agent's earned trust tier is computed from
-- this ledger over a trailing window. Fed by tenant-runtime approval resolutions
-- (source='hitl_resolve', source_key='<approvalId>:<actionClass>') and platform-backend
-- late-feedback flags (source='late_feedback', source_key='<feedbackId>:<actionClass>');
-- redelivery is idempotent via the tenant-scoped source_key UNIQUE.

CREATE TABLE IF NOT EXISTS action_trust_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action_class TEXT NOT NULL,          -- bareToolActionName of one pending tool call
  gate_reason TEXT NOT NULL,           -- level_1_gate|destructive_gate|sensitive_work|merge_to_main
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL DEFAULT 'hitl_resolve',   -- 'hitl_resolve' | 'late_feedback'
  -- immutable source key = '<approvalId>:<actionClass>' (hitl_resolve) or
  -- '<feedbackId>:<actionClass>' (late_feedback). Makes redelivery/retry idempotent.
  source_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_key)       -- tenant-scoped idempotency key (a source_key is
);                                     -- meaningful only within its tenant)

CREATE INDEX idx_atd_class  ON action_trust_decisions (tenant_id, agent_id, action_class, decided_at DESC);
CREATE INDEX idx_atd_reason ON action_trust_decisions (tenant_id, agent_id, gate_reason, decided_at DESC);

-- GOV RLS convention (migration 001 header: variable is app.current_tenant_id).
-- FORCE + WITH CHECK to match every other trust table (canonical-DDL convention):
-- FORCE so the table owner can't bypass the policy, WITH CHECK so an insert cannot
-- write another tenant's row even under a mis-set GUC.
ALTER TABLE action_trust_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_trust_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY atd_tenant_isolation ON action_trust_decisions
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
