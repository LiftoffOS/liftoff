-- Migration 110: Fix messaging_nickname values to be proper slugs
--
-- Migration 107 backfilled messaging_nickname with raw role names
-- (e.g., "Engineering Program Manager"). They need to be slugified
-- (e.g., "engineering-program-manager") for use as Slack handles.

UPDATE internal_agents
SET messaging_nickname = LEFT(
  LOWER(REGEXP_REPLACE(REGEXP_REPLACE(role, '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g')),
  35
),
updated_at = NOW()
WHERE messaging_nickname IS NOT NULL
  AND deleted_at IS NULL
  AND messaging_nickname ~ '[A-Z\s]';
