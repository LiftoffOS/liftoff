-- Audit trail for CLAUDE.md amendments, consolidations, and auto-promotions.

CREATE TABLE instruction_amendment_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  amendment_type VARCHAR(50) NOT NULL,  -- 'slow_loop_synthesis', 'consolidation', 'auto_promotion', 'redistill_clear'
  source_memory_ids UUID[],
  before_md TEXT,
  after_md TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '365 days'
);

CREATE INDEX idx_amendment_audit_agent ON instruction_amendment_audit(agent_id, created_at DESC);
CREATE INDEX idx_amendment_audit_tenant ON instruction_amendment_audit(tenant_id, created_at DESC);
