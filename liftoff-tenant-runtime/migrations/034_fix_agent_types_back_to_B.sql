-- Migration 034: Fix agent types back to B for cron-triggered agents
-- Migration 028 incorrectly set agent_type='C' for agents with cron triggers.
-- Type C requires explicit workflow_steps. Type B uses LLM + system prompt.
-- Trigger type (cron/event/manual) is orthogonal to agent type (A/B/C).

UPDATE agents
SET agent_type = 'B', updated_at = NOW()
WHERE agent_type = 'C'
  AND (workflow_steps IS NULL OR workflow_steps = 'null'::jsonb OR workflow_steps = '[]'::jsonb);
