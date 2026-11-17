-- Add agent_id to review_slack_messages so chatUpdateAllSiblingCards can
-- pick the EXACT bot install that posted the card. chat.update requires the
-- same bot that posted the message — looking up via LIMIT 1 on
-- agent_slack_installs is incorrect when a workspace has multiple installed
-- per-agent apps (each app has its own bot user + bot token; chat.update
-- with another app's token returns ok=false / cant_update_message).
--
-- Nullable so existing rows (created before this migration) survive; the
-- read path falls back to the LIMIT-1 behaviour for NULL agent_id.

ALTER TABLE review_slack_messages
  ADD COLUMN IF NOT EXISTS agent_id UUID;

CREATE INDEX IF NOT EXISTS idx_review_slack_messages_by_agent
  ON review_slack_messages (tenant_id, agent_id)
  WHERE agent_id IS NOT NULL;

COMMENT ON COLUMN review_slack_messages.agent_id IS
  'Per-agent Slack app that posted this card. Used to pick the same bot for chat.update sibling updates. Nullable for pre-migration backfill compatibility.';
