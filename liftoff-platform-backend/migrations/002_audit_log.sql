-- Audit Log Table
-- Per Section 18 & 21: Structured audit logs for SOC 2 compliance

CREATE TABLE audit_log (
    id VARCHAR(255) PRIMARY KEY,
    event_type VARCHAR(255) NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    tenant_id UUID,
    user_id UUID,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255) NOT NULL,
    action VARCHAR(100) NOT NULL,
    previous_state JSONB,
    new_state JSONB,
    metadata JSONB NOT NULL DEFAULT '{}',
    ip_address VARCHAR(45),
    user_agent TEXT,
    trace_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_tenant ON audit_log(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_audit_log_user ON audit_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_log_trace ON audit_log(trace_id) WHERE trace_id IS NOT NULL;

-- Partition by month for efficient retention management
-- (In production, consider using table partitioning)

-- Function to clean up old audit logs (per retention policy)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM audit_log
    WHERE timestamp < NOW() - (retention_days || ' days')::INTERVAL;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE audit_log IS 'Structured audit logs for SOC 2 compliance. Contains all system events for audit trail.';
