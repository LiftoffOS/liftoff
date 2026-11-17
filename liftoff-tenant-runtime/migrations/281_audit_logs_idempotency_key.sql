-- Make selected audit_logs rows retry-safe. When sandbox-executor receives
-- a duplicate /v2/execute call (HTTP retry from tool-gateway, supervisor
-- re-drive), the audit row collapses to a single insert via the caller-
-- supplied idempotency_key. Rows without a key (every existing call site)
-- remain insert-many like before.

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_audit_logs_tenant_idempotency
  ON audit_logs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
