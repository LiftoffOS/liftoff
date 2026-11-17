-- 220_audit_log_deleted_at.sql
--
-- Add `deleted_at` to audit_log so DSAR / right-to-erasure flows can
-- soft-delete rows the same way every other tenant-owned table does.
--
-- Background: audit_log was missing from the generic soft-delete pipeline
-- entirely. Three modules carried `audit_log: 'audit_logs'` in their
-- ENTITY_TABLE_MAP (the actual table is `audit_log` singular), so the
-- soft-delete UPDATE silently targeted a non-existent table and the
-- DataManagementRepository.createAuditEntry log line was the only thing
-- that recorded the attempt. The plural→singular typo is fixed in the
-- accompanying code change; this migration provides the column it needs.
--
-- Hard-deletion is handled separately by `cleanup_old_audit_logs()` (see
-- migration 002), which DELETEs rows past the SOC-2 retention window
-- (7 years per retention-service.ts). Soft-deleted rows still age out on
-- that schedule via their `timestamp` column, so adding deleted_at does
-- not change the retention contract — only the "remove from active
-- queries" path.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Partial index — soft-deleted rows are a small fraction of total, and
-- every read filter is `WHERE deleted_at IS NULL`. A partial index keeps
-- the existing common-case index lookups fast while supporting the new
-- predicate.
CREATE INDEX IF NOT EXISTS idx_audit_log_active
  ON audit_log(tenant_id, timestamp DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN audit_log.deleted_at IS
  'Soft-delete marker set by DSAR / right-to-erasure deletion-service. NULL = active. Readers must filter `deleted_at IS NULL`. Soft-deleted rows are hard-deleted by cleanup_old_audit_logs() after the DSAR grace window (default 30 days), independent of the SOC-2 retention timer that governs active rows.';

-- Extend cleanup_old_audit_logs() to also hard-delete soft-deleted rows
-- past a DSAR grace window. Existing behavior (hard-delete by timestamp age)
-- is preserved exactly; this adds a second predicate so DSAR-soft-deleted
-- rows don't have to wait the full SOC-2 retention window before they are
-- actually erased from disk.
--
-- The second parameter is OPTIONAL with a 30-day default. Callers that
-- only pass retention_days keep the legacy behavior except that
-- soft-deleted rows >30 days old are now also collected, which is the
-- desired DSAR-completion guarantee.
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(
    retention_days INTEGER DEFAULT 365,
    dsar_grace_days INTEGER DEFAULT 30
)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM audit_log
    WHERE timestamp < NOW() - (retention_days || ' days')::INTERVAL
       OR (deleted_at IS NOT NULL
           AND deleted_at < NOW() - (dsar_grace_days || ' days')::INTERVAL);
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
