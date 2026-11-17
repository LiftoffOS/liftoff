-- 312: correlate HITL approvals to the owning invocation. Historical rows stay
-- NULL and are treated as unattributable (null counts, never zero).
ALTER TABLE hitl_approval_requests ADD COLUMN IF NOT EXISTS invocation_id UUID NULL;
CREATE INDEX IF NOT EXISTS idx_hitl_requests_invocation
  ON hitl_approval_requests (tenant_id, invocation_id)
  WHERE invocation_id IS NOT NULL;
