-- Migration 408: mark a chat turn sent by support acting as the customer.
--
-- audit_log.impersonated_by (migration 407) records every REST write a support
-- session makes, but the CONTENT rows carry no marker. A row in
-- agent_chat_messages looks identical whether the operator sent it or the
-- customer did, so "which messages did support actually send" was answerable
-- only by correlating a support_delegation.request audit row against a message
-- timestamp. That works and is reliable, but it is a join across time rather
-- than a column anyone can filter on.
--
-- The turn is the right grain: agent_chat_turns already holds sender_account_id
-- for exactly this attribution question, one row per user message, and the
-- messages hang off it.
--
-- Internal only, like 407. The product deliberately shows a support session as
-- the customer; this exists so WE can tell the difference afterwards.
--
-- Not applied to agent_audit_logs, which would be the equivalent for team runs.
-- Every insert path for that table is service-auth from tenant-runtime, running
-- long after the dispatching request is gone, so the marker has to travel out
-- to the runtime and back. That is a cross-repo change and is not in this one.

BEGIN;

ALTER TABLE agent_chat_turns ADD COLUMN impersonated_by UUID REFERENCES accounts(id);

CREATE INDEX idx_agent_chat_turns_impersonated_by
  ON agent_chat_turns (impersonated_by, created_at DESC)
  WHERE impersonated_by IS NOT NULL;

COMMIT;
