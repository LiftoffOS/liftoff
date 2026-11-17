ALTER TABLE agent_audit_logs ADD COLUMN IF NOT EXISTS proxy_key_id UUID;
CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_proxy_key_id ON agent_audit_logs(proxy_key_id);
