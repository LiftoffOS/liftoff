-- 415: escalation dedupe keyed on WHAT failed and on WHICH graph version.
--
-- createEscalation collapses repeat escalations into the newest open row for
-- (tenant_id, agent_id, kind), bumping occurrence_count and OVERWRITING reason.
-- That was right for the case it was built for — one agent re-escalating one
-- unresolved blocker every scheduled run — and wrong for every other: two
-- different defects on one agent fold into a single row whose text is
-- whichever came last, whose count is the sum of two problems, and which a
-- redistill that fixed one of them keeps bumping for the other.
--
-- Two columns let a caller say which class of failure this is and which
-- compiled graph it happened on:
--
--   reason_fingerprint   `<class>:<stable ids>`, e.g. `unsatisfied_output:s3,s7`,
--                        `condition_dead_end:s4`, `recovery_cap:s9`,
--                        `permanent:auth_expired:s2`, `expiry:clarification`.
--                        NULL for callers that supply none (every
--                        customer-facing escalation), whose rows keep deduping
--                        exactly as they do today, among themselves.
--   instruction_version  compiled_instructions.version at the time. A repaired
--                        graph starts a fresh row; the old one stops growing.
--
-- The dedupe compares both with IS NOT DISTINCT FROM, so NULL matches NULL and
-- nothing else. Idempotent: every statement guards on existence.

ALTER TABLE workflow_escalations
  ADD COLUMN IF NOT EXISTS reason_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS instruction_version INTEGER;

CREATE INDEX IF NOT EXISTS workflow_escalations_fingerprint_idx
  ON workflow_escalations (tenant_id, agent_id, kind, status, reason_fingerprint, instruction_version);
