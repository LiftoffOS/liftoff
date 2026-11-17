-- Relax the agent_audit_logs.triggered_by CHECK constraint to allow
-- 'agent:<uuid>' (in addition to bare 'agent').
--
-- The original 029 constraint allowed only 'human:<uuid>' or bare 'agent' /
-- 'cron' / 'event:<topic>'. The Zod validator on POST /api/agent-audit-logs
-- and the runtime's per-tool-call audit writers were both later updated to
-- emit 'agent:<uuid>' so the row can be linked back to a specific runtime
-- agent, but the DB CHECK was never updated. The result: every per-tool-call
-- audit-log mirror from the tenant runtime hit HTTP 500 with a constraint
-- violation that the router's catch handler swallowed into a generic
-- "Internal server error" response, leaving the failure invisible.
--
-- This migration rewrites the constraint to match the Zod validator format:
--   ^(human:<uuid>|agent(:<uuid>)?|cron|event:<topic>|system)$

ALTER TABLE agent_audit_logs DROP CONSTRAINT IF EXISTS agent_audit_logs_triggered_by_check;

ALTER TABLE agent_audit_logs ADD CONSTRAINT agent_audit_logs_triggered_by_check
  CHECK (triggered_by ~ '^(human:[a-f0-9-]+|agent(:[a-f0-9-]+)?|cron|event:[a-zA-Z0-9_-]+|system)$');
