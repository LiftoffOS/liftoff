-- Migration 244: per-agent Slack as the canonical Slack identity (foundation).
--
-- Adds Secret-Manager-path storage for per-agent per-workspace bot tokens
-- alongside a workspace display name. Plaintext bot tokens previously
-- written into slack_bot_token_ref are lazily migrated into Secret Manager
-- by bot-token-service on first read; a follow-up migration drops the
-- legacy column once the backfill window is complete.
--
-- Safe to run on a live system: all column changes are additive.

ALTER TABLE agent_slack_installs
  ADD COLUMN IF NOT EXISTS slack_bot_token_secret_path TEXT,
  ADD COLUMN IF NOT EXISTS slack_team_name TEXT;

COMMENT ON COLUMN agent_slack_installs.slack_bot_token_secret_path IS 'Secret Manager path for the bot token. Canonical storage. slack_bot_token_ref kept transiently for the plaintext-to-SM migration window.';

COMMENT ON COLUMN agent_slack_installs.slack_team_name IS 'Slack workspace display name, cached from oauth.v2.access response. Used in admin UI to identify which workspace a given install belongs to.';

-- Best-effort: use slack_team_id as a placeholder display name for any row
-- where it is null. The OAuth callback writes real names from the
-- oauth.v2.access response on next install.
UPDATE agent_slack_installs
   SET slack_team_name = slack_team_id
 WHERE slack_team_name IS NULL;
