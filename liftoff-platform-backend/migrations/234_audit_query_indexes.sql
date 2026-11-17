-- 230_audit_query_indexes.sql
-- Composite indexes to support unified audit endpoint range scans for the
-- three sources that lack a (tenant_id, time) index suitable for the
-- per-source partial filter.

-- Note: audit_log is already covered by migration 220's `idx_audit_log_active
-- (tenant_id, timestamp DESC) WHERE deleted_at IS NULL`. The unified query
-- adds `AND user_id IS NOT NULL` which is filtered on the heap; EXPLAIN
-- confirms that's acceptable at expected row volumes. If perf testing later
-- shows this is hot enough to warrant a more specific index, add
-- `idx_audit_log_tenant_active_human (tenant_id, timestamp DESC)
--  WHERE deleted_at IS NULL AND user_id IS NOT NULL` then.

CREATE INDEX IF NOT EXISTS idx_internal_agent_audit_tenant_created
  ON internal_agent_audit(tenant_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_tenant_user_created
  ON agent_chat_messages(tenant_id, created_at DESC)
  WHERE role = 'user';

CREATE INDEX IF NOT EXISTS idx_agent_audit_logs_tenant_human_created
  ON agent_audit_logs(tenant_id, created_at DESC)
  WHERE triggered_by LIKE 'human:%';

-- Source 6: event_deliveries (inbound webhook deliveries)
-- The existing event_deliveries indexes are source-scoped (idx for the
-- /webhook/deliveries per-agent lookup). The unified read needs a
-- tenant-scoped composite for the range scan.
CREATE INDEX IF NOT EXISTS idx_event_deliveries_tenant_received
  ON event_deliveries(tenant_id, received_at DESC);
