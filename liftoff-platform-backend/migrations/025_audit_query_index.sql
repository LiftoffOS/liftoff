-- Composite index for audit query performance
-- Covers: WHERE tenant_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_tenant_member_audit_tenant_date
ON tenant_member_audit(tenant_id, created_at DESC);
