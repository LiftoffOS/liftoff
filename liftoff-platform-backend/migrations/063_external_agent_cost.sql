-- Add cost tracking fields to external agents
-- Allows workspace owners to track how much each external collaborator costs

ALTER TABLE external_agents ADD COLUMN IF NOT EXISTS cost_amount DECIMAL(10, 2);
ALTER TABLE external_agents ADD COLUMN IF NOT EXISTS cost_type VARCHAR(20) CHECK (cost_type IN ('per_task', 'per_month'));
