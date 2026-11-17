-- Keep the external display name of a chat sender we could not map to an account.
--
-- agent_chat_turns.sender_account_id is NULL whenever a Slack or Teams user has
-- no Liftoff account. Until now that meant the message was rendered with no
-- attribution at all: in a shared thread, an anonymous message is worse than no
-- feature, because the reader cannot tell whether it was a colleague, a guest,
-- or themselves from another surface.
--
-- Every adapter already knows who it was — the Slack, Teams and MCP workers all
-- pass `userDisplayName` into the turn — so nothing new has to be fetched. The
-- name was simply being dropped on the floor at write time.
--
-- Nullable and unbackfilled on purpose: rows written before this migration have
-- no label to recover, and inventing one would be worse than leaving them blank.

ALTER TABLE agent_chat_turns ADD COLUMN sender_label TEXT;

COMMENT ON COLUMN agent_chat_turns.sender_label IS
  'External display name (Slack/Teams/MCP) for senders with no Liftoff account. NULL when sender_account_id resolves, and for turns predating migration 307.';
