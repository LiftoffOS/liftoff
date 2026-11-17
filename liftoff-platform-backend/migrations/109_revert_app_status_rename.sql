-- Migration 109: Revert the unnecessary column rename from migration 108
-- app_status was a pointless rename of install_status that broke everything.
-- Rename it back.

ALTER TABLE agent_slack_apps RENAME COLUMN app_status TO install_status;
ALTER TABLE agent_slack_apps DROP CONSTRAINT IF EXISTS agent_slack_apps_app_status_check;
ALTER TABLE agent_slack_apps ADD CONSTRAINT agent_slack_apps_install_status_check
  CHECK (install_status IN ('active', 'deleted', 'error'));
