-- Add 'byok_customer_funded' to the cost_bucket enum.
--
-- A customer who pastes their own Anthropic key has already paid Anthropic for
-- the tokens their agent burns. Leaving those calls in the 'included' /
-- 'precommit' / 'reload' buckets charges them a second time for the same
-- tokens, and it starts the moment the first key is saved — doing nothing here
-- is not neutral, it is a double charge.
--
-- Semantics — see src/cost-attribution/event-classification.ts:
--   'included'             → customer pays via base subscription fee
--   'precommit'            → customer pays via slider precommit at sub creation
--   'reload'               → customer pays from reload_balance_usd as it drains
--   'platform_overhead'    → Liftoff absorbs (folded into subscription margin)
--   'byok_customer_funded' → the CUSTOMER'S OWN provider key paid the vendor
--                            directly. customer_cost_usd MUST be 0 and
--                            ou_consumed MUST be 0; does NOT increment
--                            billing_controls.ous_consumed_this_period; does NOT
--                            drain reload_balance_usd; does NOT fire a Stripe
--                            meter event for the token line.
--   'unknown'              → boundary state for legacy / unclassified rows.
--
-- cost_usd stays populated, with the real token counts beside it. Three things
-- depend on that and none of them are optional:
--   * zero-rating is only auditable if the row also says what was zero-rated;
--   * a customer who turns BYOK on does not expect their usage dashboards to go
--     blank — if anything they look harder, to confirm the keys are being used;
--   * a turn served by the MANAGED key after the customer's was declined bills
--     normally, and telling the two apart needs a per-call record of which key
--     served it. This bucket is that record.
--
-- Which bucket a row lands in is decided by which key ACTUALLY served the
-- request, not by whether the tenant has a key on file. A mid-run fallback to
-- the managed key is ordinary customer consumption.
--
-- Every customer-facing total already filters on the bucket, so a reader that
-- sums customer spend must exclude this literal the same way it excludes
-- 'platform_overhead' and 'unknown' — customer_cost_usd is 0 on these rows, so
-- a sum over that column is correct without changes; a sum over cost_usd is not.

ALTER TABLE billing_spend_events
  DROP CONSTRAINT IF EXISTS billing_spend_events_cost_bucket_check;
ALTER TABLE billing_spend_events
  ADD CONSTRAINT billing_spend_events_cost_bucket_check
  CHECK (cost_bucket IN ('included','precommit','reload','platform_overhead','byok_customer_funded','unknown'));

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT IF EXISTS cost_attribution_events_cost_bucket_check;
ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_cost_bucket_check
  CHECK (cost_bucket IN ('included','precommit','reload','platform_overhead','byok_customer_funded','unknown'));
