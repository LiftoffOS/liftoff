-- Migration 058: Backfill trigger configs for active agents missing them
-- Fixes agents that were created/activated without proper trigger configuration

BEGIN;

-- Set trigger_config and agent_type for agents that have cron-like instructions
-- but are missing trigger configs. Default to every 5 minutes for safety.
-- Agents can be updated to a different schedule via the UI.
UPDATE internal_agents
SET
  trigger_config = '{"type": "cron", "cronExpr": "*/5 * * * *"}'::jsonb,
  agent_type = 'C',
  updated_at = NOW()
WHERE
  trigger_config IS NULL
  AND status IN ('active', 'paused')
  AND (
    user_instructions ILIKE '%every%minute%'
    OR user_instructions ILIKE '%every%hour%'
    OR user_instructions ILIKE '%scheduled%'
    OR user_instructions ILIKE '%cron%'
    OR system_prompt ILIKE '%every%minute%'
    OR system_prompt ILIKE '%every%hour%'
    OR system_prompt ILIKE '%scheduled%'
  );

-- Also fix any agent explicitly typed as 'C' but missing trigger config
-- Set a default daily schedule so they don't silently fail on activation
UPDATE internal_agents
SET
  trigger_config = '{"type": "cron", "cronExpr": "0 */6 * * *"}'::jsonb,
  updated_at = NOW()
WHERE
  agent_type = 'C'
  AND trigger_config IS NULL;

COMMIT;
