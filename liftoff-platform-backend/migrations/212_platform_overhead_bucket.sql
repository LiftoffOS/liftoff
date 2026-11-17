-- Add 'platform_overhead' to the cost_bucket enum so the ingest layer can
-- mark Liftoff-internal LLM consumption (CAIO/HRBP planning, distillation,
-- agent-creation analyses, /insights chat) as not-customer-chargeable.
--
-- Semantics — see src/cost-attribution/event-classification.ts:
--   'included'          → customer pays via base subscription fee
--   'precommit'         → customer pays via slider precommit at sub creation
--   'reload'            → customer pays from reload_balance_usd as it drains
--   'platform_overhead' → Liftoff absorbs (folded into subscription margin);
--                         customer_cost_usd MUST be 0; does NOT increment
--                         billing_controls.ous_consumed_this_period; does NOT
--                         drain reload_balance_usd; does NOT fire Stripe meter.
--   'unknown'           → boundary state for legacy / unclassified rows.
--
-- The cost_usd column stays populated on platform_overhead rows so Liftoff
-- can track its own per-tenant platform spend in admin dashboards without
-- exposing the number to customers.

ALTER TABLE billing_spend_events
  DROP CONSTRAINT IF EXISTS billing_spend_events_cost_bucket_check;
ALTER TABLE billing_spend_events
  ADD CONSTRAINT billing_spend_events_cost_bucket_check
  CHECK (cost_bucket IN ('included','precommit','reload','platform_overhead','unknown'));

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT IF EXISTS cost_attribution_events_cost_bucket_check;
ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_cost_bucket_check
  CHECK (cost_bucket IN ('included','precommit','reload','platform_overhead','unknown'));
