-- Migration 409: mark a team run that a Liftoff support session set in motion.
--
-- Completes the set. 407 covers REST writes, 408 covers chat turns, and this
-- covers runs, which are the case that could not be done from this repo alone:
-- every insert path for agent_audit_logs is service-auth from tenant-runtime,
-- running long after the dispatching request has ended, so there is no
-- req.delegation to read. The operator's account id now travels with the
-- execution instead (tenant-runtime migration 379) and comes back on the
-- POST to /api/agent-audit-logs.
--
-- Nullable and NULL on every ordinary row, like its two siblings: the presence
-- of a value is the statement.

BEGIN;

ALTER TABLE agent_audit_logs ADD COLUMN impersonated_by UUID REFERENCES accounts(id);

CREATE INDEX idx_agent_audit_logs_impersonated_by
  ON agent_audit_logs (impersonated_by, created_at DESC)
  WHERE impersonated_by IS NOT NULL;

COMMIT;
