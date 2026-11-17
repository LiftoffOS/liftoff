-- Fix trigger_config cron expressions that were incorrectly set by the
-- distillation LLM. The distillation prompt has been fixed to extract
-- the exact frequency from the user's description, but existing agents
-- with */5 need correction since users described "every minute".
UPDATE agents
SET trigger_config = jsonb_set(trigger_config, '{cronExpr}', '"*/1 * * * *"')
WHERE trigger_config->>'cronExpr' = '*/5 * * * *'
  AND trigger_config->>'type' = 'cron';
