-- Standing HITL approval policies.
-- When a human approves or rejects a gate with "always apply this decision",
-- a row is written here so future tool calls with the same (tenant_id, agent_id,
-- gate_reason) are auto-resolved without creating a new approval request.

CREATE TABLE IF NOT EXISTS hitl_approval_policies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  gate_reason   TEXT NOT NULL,   -- 'level_1_gate' | 'destructive_gate' | 'sensitive_work' etc.
  decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,      -- NULL = never expires
  UNIQUE (tenant_id, agent_id, gate_reason)
);

CREATE INDEX idx_hitl_policies_lookup ON hitl_approval_policies (tenant_id, agent_id, gate_reason);
