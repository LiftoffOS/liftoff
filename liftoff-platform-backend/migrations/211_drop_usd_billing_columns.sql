-- Migration B: drop legacy USD-allocation schema. After this, the only
-- per-tenant USD wallet is reload_balance_usd; OU consumption is tracked
-- via the new ou_consumed/customer_cost_usd/cost_bucket triple on the
-- ledgers and ous_consumed_this_period on billing_controls.

ALTER TABLE billing_controls
  DROP COLUMN monthly_allocation_usd,
  DROP COLUMN prepaid_balance_usd;       -- replaced by ous_consumed_this_period + reload_balance_usd

-- is_annual_plan STAYS. The annual-allocation-reset cron (src/jobs/annual-plan-allocation-reset.ts)
-- still needs to identify annual subscribers because invoice.paid only fires once per year
-- for them — without the cron, their ous_consumed_this_period would accumulate across all 12
-- months of the contract. See "Annual pricing" subsection in ADR-012 for the cron's rewrite.

-- billing_spend_events legacy columns:
--   ou_spend_usd was the USD-cost-of-OUs computed per event using the old
--     ou_pricing tier rate. The new model writes customer_cost_usd (bucket-rated)
--     instead; spend-subscriber.ts no longer populates ou_spend_usd. Drop it.
--   ou_pricing_id was an FK to ou_pricing for cost-audit-by-tier; ou_pricing
--     itself is dropped below. Drop the FK column first so the table drop
--     doesn't fail on dangling reference.
ALTER TABLE billing_spend_events
  DROP COLUMN ou_spend_usd,
  DROP COLUMN ou_pricing_id;

DROP TABLE ou_pricing;
