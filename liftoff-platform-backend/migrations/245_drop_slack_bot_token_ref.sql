-- Migration 245: drop the legacy plaintext slack_bot_token_ref column.
--
-- Migration 244 added slack_bot_token_secret_path as the canonical Secret
-- Manager path for per-agent Slack bot tokens. The lazy plaintext-to-SM
-- migration in bot-token-service.resolveBotToken + the startup backfill
-- in bot-token-backfill.runBotTokenBackfillAtStartup must, before this
-- migration runs, have moved every existing token into Secret Manager and
-- NULLed the legacy column.
--
-- Pre-flight guard: refuse to drop the column if any installed row still
-- has a non-null plaintext value. That would mean the backfill never
-- ran (or partially failed) and dropping would lose tokens. The DO block
-- raises a clear error in that case so the deploy fails loudly rather
-- than silently destroying secrets.

DO $$
DECLARE
  unmigrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unmigrated_count
    FROM agent_slack_installs
   WHERE slack_bot_token_ref IS NOT NULL
     AND install_status = 'installed';

  IF unmigrated_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop slack_bot_token_ref: % installed rows still have '
      'plaintext tokens. Wait for bot-token-backfill to drain them (see '
      'bot_token_backfill_complete log events with total_unmigrated=0), '
      'or run the backfill manually before retrying.', unmigrated_count;
  END IF;
END $$;

ALTER TABLE agent_slack_installs
  DROP COLUMN slack_bot_token_ref;
