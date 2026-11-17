-- 219_consolidate_webhook_audit.sql
--
-- Backfill historical event_source_audit_log rows into audit_log, then drop
-- the dedicated table. After this migration, audit_log is the single source
-- of truth for webhook administrative events.
--
-- Motivation (problems with the standalone event_source_audit_log table from
-- migration 218):
--   1. source_id REFERENCES event_sources(id) ON DELETE CASCADE — deleting
--      a webhook wiped its entire audit trail. Defeats the purpose of an
--      audit log.
--   2. Inconsistent writers across the module: provisioner.ts used the
--      writeAuditLogInTx helper, service.ts used 4 raw INSERTs. Easy to add
--      a new mutation and forget the audit row.
--   3. settings_updated rows only stored the changed field NAMES, never
--      before/after values.
--
-- The audit_log table (migration 002) already has previous_state / new_state
-- JSONB columns, no destructive FK CASCADEs, and is the canonical surface
-- the unified /api/audit endpoint reads from. Consolidating eliminates the
-- second table and the dual-write/drift risk.
--
-- Note: rows with actor_user_id IS NULL are dropped. Every webhook
-- administrative action today is initiated by an authenticated user
-- (provisioner / service layer routes are tenant-membership-gated), so this
-- WHERE filter is a defensive no-op rather than a data loss vector.

INSERT INTO audit_log (
  id, event_type, timestamp, tenant_id, user_id,
  resource_type, resource_id, action,
  previous_state, new_state, metadata, trace_id
)
SELECT
  'audit-mig219-' || id::text,
  'webhook.' || action,
  created_at,
  tenant_id,
  actor_user_id,
  'event_source',
  source_id::text,
  action,
  NULLIF(metadata->'previousState', 'null'::jsonb),
  COALESCE(NULLIF(metadata->'newState', 'null'::jsonb), metadata),
  COALESCE(metadata, '{}'::jsonb),
  NULL
FROM event_source_audit_log
WHERE actor_user_id IS NOT NULL;

DROP TABLE event_source_audit_log;
