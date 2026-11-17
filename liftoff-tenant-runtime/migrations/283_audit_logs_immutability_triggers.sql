-- Replace audit_logs immutability rules with triggers.
--
-- Migration 016 used CREATE RULE ... DO INSTEAD NOTHING to make audit_logs
-- append-only. Postgres rejects any INSERT ... ON CONFLICT against a table
-- with INSERT or UPDATE rules (regardless of whether the ON CONFLICT
-- action is DO NOTHING or DO UPDATE — the planner refuses to reason about
-- rule + on-conflict interactions). Migration 281 introduced the partial
-- unique index uidx_audit_logs_tenant_idempotency and audit/service.ts's
-- insertAuditLog now relies on ON CONFLICT (tenant_id, idempotency_key)
-- DO NOTHING for retry-safety. Every audit write that carries an
-- idempotency_key (sandbox dispatch, cloud-tasks retries, scheduled
-- invocations) currently fails with "INSERT with ON CONFLICT clause
-- cannot be used with table that has INSERT or UPDATE rules".
--
-- Triggers don't have this restriction. Replace the rules with BEFORE
-- triggers that RAISE exceptions on UPDATE/DELETE — same append-only
-- semantics, no on-conflict conflict.

DROP RULE IF EXISTS audit_logs_no_update ON audit_logs;
DROP RULE IF EXISTS audit_logs_no_delete ON audit_logs;

CREATE OR REPLACE FUNCTION audit_logs_immutable_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (immutability guard); attempted % blocked', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable_guard();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable_guard();
