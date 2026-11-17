-- Migration 379: mark a run that a Liftoff support session set in motion.
--
-- Pairs with the control plane's `audit_log.impersonated_by` (PB migration 407)
-- and `agent_chat_turns.impersonated_by` (PB 408). Those two cover REST writes
-- and chat turns, both of which happen inside the delegated HTTP request. A team
-- RUN does not: the request that dispatched it is long gone by the time the run
-- finishes and writes its audit rows here, so the operator's identity has to
-- travel with the execution rather than be read off a request.
--
-- The chain is: PB stamps `impersonatedBy` on the chat turn body ->
-- interactive-chat/chat-turn-handler validates it -> ExecuteTaskInput ->
-- ExecutionContext -> here, and out again on the outbox payload to PB's
-- /api/agent-audit-logs.
--
-- Strict `accounts.id` only, never the overloaded triggered_by_user_id which
-- also carries slack:<uid> forms. The control plane validates it as a UUID, so
-- a synthetic id would 400 and drop the whole audit row.
--
-- Internal only. Nothing in the product tells the customer a support session
-- ran their team; this exists so we can tell afterwards.

BEGIN;

ALTER TABLE audit_logs ADD COLUMN impersonated_by UUID;

CREATE INDEX idx_audit_logs_impersonated_by
  ON audit_logs (impersonated_by, created_at DESC)
  WHERE impersonated_by IS NOT NULL;

-- Also on the invocation, beside triggered_by_user_id, and for the same reason
-- that column exists there.
--
-- A delegated child run inherits the human from its parent by READING the
-- parent invocation row (agent-execution/service.ts resolves
-- parentTriggeredByUserId that way, once per fan-out). Without an equivalent
-- column the operator would have to be threaded by hand through
-- delegateToAgents and runDelegationChild and every future fan-out caller, and
-- the first caller that forgot would silently drop the attribution one hop in.
-- Storing it makes inheritance work the same way at every depth, for free.
ALTER TABLE invocations ADD COLUMN impersonated_by UUID;

-- started_at, not created_at: this table has no created_at column (migration
-- 015 gives it started_at / completed_at).
CREATE INDEX idx_invocations_impersonated_by
  ON invocations (impersonated_by, started_at DESC)
  WHERE impersonated_by IS NOT NULL;

COMMIT;
