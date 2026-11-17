-- Migration 019: enforce audit_logs immutability (append-only) + 2-year retention.
--
-- audit_logs is the security audit trail. Nothing legitimately mutates a row
-- after insert: insertAuditLog() (src/audit/service.ts) is INSERT-only, and the
-- mutable state ledger is the separate `actions` table (which the action-ledger
-- repository UPDATEs by design and is intentionally NOT covered here).
--
-- For SOC 2, immutability of the audit trail must be enforced by the database,
-- not left to convention. Enforcement is a TRIGGER rather than
-- `REVOKE UPDATE, DELETE` because a trigger also binds the table OWNER — REVOKE
-- does not restrict the owning role, and the service may connect as owner. The
-- only sanctioned deletion is the time-bounded retention purge defined below,
-- which signals itself with a session-local GUC the guard recognizes.

-- ── Append-only guard: block UPDATE and DELETE (except the retention purge) ──
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The retention purge sets this session-local GUC for its transaction so its
  -- time-bounded DELETE is admitted. Every other UPDATE/DELETE is rejected.
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'audit_logs is append-only: % is not permitted (updates never; deletes only via purge_audit_logs_older_than)',
    TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_mutate ON audit_logs;
CREATE TRIGGER audit_logs_no_mutate
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- ── Block TRUNCATE too ──
-- Row triggers do not fire on TRUNCATE, so without this the append-only
-- guarantee could be sidestepped with a single TRUNCATE. Statement-level.
CREATE OR REPLACE FUNCTION audit_logs_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE is not permitted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_no_truncate();

-- ── Retention: keep 2 years ──
-- A scheduled job calls this (Cloud Run Job or pg_cron). It sets the
-- session-local bypass GUC so ONLY this time-bounded delete is admitted by the
-- append-only guard; is_local = true auto-resets the GUC at transaction end, so
-- the bypass cannot leak to any later statement on a pooled connection.
-- Returns the number of rows purged.
CREATE OR REPLACE FUNCTION purge_audit_logs_older_than(
  p_interval interval DEFAULT interval '2 years'
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_deleted bigint;
BEGIN
  PERFORM set_config('app.audit_retention_purge', 'on', true);
  DELETE FROM audit_logs WHERE created_at < NOW() - p_interval;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

COMMENT ON FUNCTION purge_audit_logs_older_than(interval) IS
  'Deletes audit_logs older than the given interval (default 2 years). Sets app.audit_retention_purge so the append-only trigger admits the delete. Schedule via a Cloud Run Job or pg_cron; retention window is 2 years per compliance policy.';
