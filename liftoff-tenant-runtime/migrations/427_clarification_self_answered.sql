-- 427: a clarification the run answered itself.
--
-- The ask check (agent-execution/engine/ask-check.ts) reads a recovery
-- advisor's question against what the run already holds, and when the value
-- is there the run is not parked: the advisor is invoked once more with a
-- hint and continues. The ask still happened, and the record has to say so
-- and say how it was resolved, without an item on the review page. So the
-- row is written as any other clarification row is — clarification_source
-- 'recovery_llm', clarification_origin 'question' — but already 'fired', with
-- no pending pause, no expiry task and no notification, and its resolution
-- named here.
--
-- Widened, not replaced: every previously accepted value stays accepted. The
-- column's CHECK was declared inline in migration 419, so its constraint name
-- is the one Postgres generated.
ALTER TABLE agent_scheduled_invocations
  DROP CONSTRAINT IF EXISTS agent_scheduled_invocations_resolution_kind_check;
ALTER TABLE agent_scheduled_invocations
  ADD CONSTRAINT agent_scheduled_invocations_resolution_kind_check
  CHECK (resolution_kind IN ('answered', 'declined', 'expired', 'self_answered'));

COMMENT ON COLUMN agent_scheduled_invocations.resolution_kind IS
  'How a clarification-expiry row was resolved: answered, declined, expired, or self_answered (the run held the value it asked for and continued without parking). NULL on rows resolved before migration 419 and on every other objective.';
