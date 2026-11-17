-- HITL Enforcement Tables
-- Tenant Runtime HITL Enforcement

-- Local cache of tenant oversight settings (synced via GCP Pub/Sub events)
CREATE TABLE tenant_oversight_cache (
    tenant_id UUID PRIMARY KEY,
    entity_version INT NOT NULL,
    autonomy VARCHAR(20) NOT NULL,
    escalation VARCHAR(20) NOT NULL,
    sensitive_work JSONB NOT NULL,
    communication VARCHAR(20) NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE tenant_oversight_cache IS 'Cached copy of tenant oversight settings synced from control plane. Used for HITL gate decisions at runtime.';

-- HITL approval requests
CREATE TABLE hitl_approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [FIX: BE-001] Add FK constraint to tenants
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    task_id UUID NOT NULL REFERENCES workflow_tasks(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    hitl_level INTEGER NOT NULL,
    pending_tool_calls JSONB NOT NULL,
    -- [FIX: SE-008] Store hash for tamper detection
    tool_calls_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    decided_by TEXT,
    -- [FIX: SE-001] Store approver role for audit
    decided_by_role TEXT,
    decision TEXT CHECK (decision IN ('approved', 'rejected')),
    rejection_reason TEXT,
    decided_at TIMESTAMP WITH TIME ZONE,
    -- [FIX: BE-010] Idempotency key
    idempotency_key TEXT UNIQUE,
    -- [FIX: TE-006] Expiry for stale approvals
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes [FIX: BE-002]
CREATE INDEX idx_hitl_approvals_pending
  ON hitl_approval_requests(tenant_id, status) WHERE status = 'pending';
CREATE INDEX idx_hitl_approvals_workflow ON hitl_approval_requests(workflow_id);
CREATE INDEX idx_hitl_approvals_task ON hitl_approval_requests(task_id);
CREATE INDEX idx_hitl_approvals_agent ON hitl_approval_requests(agent_id);
CREATE INDEX idx_hitl_approvals_expires ON hitl_approval_requests(expires_at) WHERE status = 'pending';

-- Auto-expire stale approvals
CREATE OR REPLACE FUNCTION expire_stale_approvals() RETURNS void AS $$
BEGIN
  UPDATE hitl_approval_requests
  SET status = 'expired', updated_at = NOW()
  WHERE status = 'pending' AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Auto-update trigger for updated_at
CREATE TRIGGER update_hitl_approval_requests_updated_at
    BEFORE UPDATE ON hitl_approval_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE hitl_approval_requests IS 'Stores pending human-in-the-loop approval requests for tool execution.';
COMMENT ON COLUMN hitl_approval_requests.hitl_level IS '1=Full approval, 2=Destructive only, 3=Balanced, 4=Autonomous checkpoints, 5=Fully autonomous';
COMMENT ON COLUMN hitl_approval_requests.reason IS 'Why HITL was triggered: level_1_gate, destructive_gate, super_destructive_gate, sensitive_work, communication_review';
COMMENT ON COLUMN hitl_approval_requests.tool_calls_hash IS 'SHA-256 hash of pending_tool_calls for tamper detection';
