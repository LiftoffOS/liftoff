-- Migration 315: drop the per-agent Slack app tables (ADR-040)
--
-- Per-agent Slack apps are retired. One Liftoff app per environment serves
-- every agent (slack_workspace_installs + slack_conversation_agents,
-- migration 314), and the code that minted per-agent apps — the Manifest API
-- service and the config-token rotation chain — has been deleted along with
-- the apps themselves and every install row.
--
-- Drain both tables before applying: the drop discards any remaining
-- per-agent install rows.

DROP TABLE IF EXISTS agent_slack_installs;
DROP TABLE IF EXISTS agent_slack_apps;

-- posted_via distinguished per-agent cards from workspace-app cards so
-- chat.update could pick the right token. With one app there is one token.
ALTER TABLE review_slack_messages DROP COLUMN IF EXISTS posted_via;
