-- Stop support: a user-initiated abort travels the same signals table as the
-- mid-execution user-message interrupts (migration 235, which anticipated
-- widening this CHECK). Writers: the chat-turn stop intercept and the explicit
-- stop route. Consumers: the conversational and workflow execution loops, at
-- the same boundaries that consume user_message signals; abort wins when both
-- kinds are pending. The 7-day cleanup in the internal cron handler covers all
-- signal kinds, and the pending partial index is kind-agnostic.

ALTER TABLE agent_invocation_signals
  DROP CONSTRAINT IF EXISTS agent_invocation_signals_signal_kind_check;
ALTER TABLE agent_invocation_signals
  ADD CONSTRAINT agent_invocation_signals_signal_kind_check
  CHECK (signal_kind IN ('user_message', 'abort'));
