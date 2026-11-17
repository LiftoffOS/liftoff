-- Drop the budget_estimate column from workforce_plans.
--
-- The budget__estimate CAIO tool has been removed. The speculative cost
-- estimation was inconsistent with the teambuilder flow (which has no
-- cost estimation) and produced unreliable numbers. Real cost visibility
-- belongs on the billing/usage dashboard after agents run, not as a
-- forecast during planning.
ALTER TABLE workforce_plans DROP COLUMN IF EXISTS budget_estimate;
