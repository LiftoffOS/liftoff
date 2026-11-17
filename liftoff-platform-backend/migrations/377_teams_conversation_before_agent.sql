-- Migration 377: a Teams conversation can exist before an agent is chosen.
--
-- `agent_teams_conversations.agent_id` was NOT NULL, which encoded the
-- assumption that a conversation comes into being already bound to an agent.
-- It does not. The order of events in Teams is:
--
--   1. the app is installed for a user (by them, or proactively via Graph)
--   2. Teams sends the bot a conversationUpdate — the 1:1 chat now EXISTS and
--      the bot can post into it, which is exactly what the handler does when it
--      answers with the agent picker
--   3. the user picks an agent
--
-- The row could only be written at step 3, so between install and first pick a
-- person had a live chat with the bot and no stored address. Every proactive
-- review card to them reported "no teams conversation reference", with
-- last_success_at never set, while Slack reached the same people every time.
--
-- Nullable agent_id lets step 2 persist the reference honestly: the chat is
-- real, and nobody is talking in it yet. `listConversationsForAgent` filters on
-- agent_id and so continues to exclude unbound rows, which is correct — they
-- are not that agent's conversations. The reachability lookups deliberately do
-- not filter on it, because a 1:1 chat belongs to the user and the bot.
--
-- Widening a column is backward compatible: every existing row keeps its agent,
-- and every existing writer still supplies one.

ALTER TABLE agent_teams_conversations
  ALTER COLUMN agent_id DROP NOT NULL;

COMMENT ON COLUMN agent_teams_conversations.agent_id IS
  'Agent currently bound to this conversation. NULL for a personal chat that '
  'exists (the app is installed and the bot can post) but where no agent has '
  'been picked yet. Reachability lookups must not filter on this column: a 1:1 '
  'Teams chat is between the user and the BOT, and there is one bot.';

-- Reachability is looked up by (tenant, account) and by (tenant, aad user),
-- neither of which the existing indexes serve — both lead with agent_id.
CREATE INDEX IF NOT EXISTS idx_agent_teams_conv_personal_account
  ON agent_teams_conversations (tenant_id, account_id)
  WHERE scope = 'personal' AND account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_teams_conv_personal_aad_user
  ON agent_teams_conversations (tenant_id, aad_user_id)
  WHERE scope = 'personal' AND aad_user_id IS NOT NULL;
