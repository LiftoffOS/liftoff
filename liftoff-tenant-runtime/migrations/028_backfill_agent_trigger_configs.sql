-- Migration 028: Backfill trigger configs for agents missing them
-- Matches Platform Backend migration 058

BEGIN;

-- Set trigger_config and agent_type for agents with cron-like instructions
UPDATE agents
SET
  trigger_config = '{"type": "cron", "cronExpr": "*/5 * * * *"}'::jsonb,
  agent_type = 'C',
  updated_at = NOW()
WHERE
  trigger_config IS NULL
  AND lifecycle IN ('ACTIVE', 'PAUSED')
  AND (
    user_instructions ILIKE '%every%minute%'
    OR user_instructions ILIKE '%every%hour%'
    OR user_instructions ILIKE '%scheduled%'
    OR user_instructions ILIKE '%cron%'
    OR system_prompt ILIKE '%every%minute%'
    OR system_prompt ILIKE '%every%hour%'
    OR system_prompt ILIKE '%scheduled%'
  );

-- Fix any agent typed as 'C' but missing trigger config
UPDATE agents
SET
  trigger_config = '{"type": "cron", "cronExpr": "0 */6 * * *"}'::jsonb,
  updated_at = NOW()
WHERE
  agent_type = 'C'
  AND trigger_config IS NULL;

COMMIT;
