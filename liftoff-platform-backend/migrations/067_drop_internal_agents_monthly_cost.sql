-- Drop vestigial monthly_cost column from internal_agents.
-- This column was always 0 (see migrations 064, 065).
-- Real monthly cost is fetched live from tenant runtime via getAgentMonthlyCosts().

ALTER TABLE internal_agents DROP COLUMN monthly_cost;
