-- Align agent_audit_logs.triggered_by CHECK with the Zod validator
-- (src/agent-audit-logs/router.ts triggeredBySchema).
--
-- Migration 079 left the DB constraint at `human:[a-f0-9-]+`, but the Zod
-- schema was later widened (SE-007) to accept provider-namespaced human ids
-- like `human:slack:<uid>` and `human:teams:<aadObjectId>`. The result: Zod
-- accepted the value, the DB CHECK rejected it, and the audit row was silently
-- dropped (the router catches the insert failure and logs "Failed to insert
-- agent audit log"). Teams hits this whenever an unmatched user resolves to
-- `teams:<aadObjectId>` → `human:teams:<...>`.
--
-- Widen the constraint to exactly match the validator so Slack/Teams-originated
-- audit rows persist. The new pattern is a strict superset of 079, so no
-- existing row can violate it.

ALTER TABLE agent_audit_logs DROP CONSTRAINT IF EXISTS agent_audit_logs_triggered_by_check;
ALTER TABLE agent_audit_logs ADD CONSTRAINT agent_audit_logs_triggered_by_check
  CHECK (triggered_by ~ '^(human:[A-Za-z0-9_.:-]+|agent(:[a-f0-9-]+)?|cron|event:[a-zA-Z0-9_.-]+|system(:[a-zA-Z0-9_.-]+)?)$');
