-- Backfill messaging_nickname for existing agents
-- Derives from role, truncated to 35 chars (Slack's app name limit)
-- Idempotent: only updates rows where messaging_nickname is NULL

UPDATE internal_agents
SET messaging_nickname = LEFT(role, 35),
    updated_at = NOW()
WHERE messaging_nickname IS NULL AND deleted_at IS NULL;
