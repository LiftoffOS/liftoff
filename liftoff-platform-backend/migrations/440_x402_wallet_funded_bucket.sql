-- Add 'x402_wallet_funded' to the cost_bucket vocabulary, and 'call' to the
-- usage_unit vocabulary.
--
-- x402 vendors (gloria premium first; browserbase, google-trends, strale,
-- quicknode to follow) are paid PER CALL in USDC from the platform's x402
-- wallet — no vendor account, no subscription. The connector-service executor
-- reports the settled amount as the call's costUsd, the tenant runtime ledgers
-- it, and the usage-ledger ingester books it here.
--
-- Semantics — the bucket says whose money paid the VENDOR (the platform x402
-- wallet), and unlike 'byok_customer_funded' the customer IS charged for it:
--   cost_usd          — the settled USDC amount (what the wallet paid).
--   ou_consumed       — real OU consumption via applyOuConsumption: the
--                       customer is charged the correct number of Operating
--                       Units through the SAME conversion every other
--                       customer-chargeable event uses.
--   customer_cost_usd — the OU-rated value from those bucket assignments.
--   cost_bucket       — 'x402_wallet_funded': one row per call carrying the
--                       totals, in place of the per-bucket sibling rows the
--                       plain customer path writes. The funding-pot split
--                       still happens (counter increment, reload drain) —
--                       the ROW records the x402 funding of the vendor side.
--   usage_quantity=1, usage_unit='call' — vendor invoices for x402 are
--                       per-call, so reconciliation against on-chain settled
--                       USDC counts calls and sums cost_usd.
--
-- A customer-billed total that sums customer_cost_usd needs no change: these
-- rows carry a real customer_cost_usd, unlike 'byok_customer_funded' /
-- 'platform_overhead' / 'unknown' rows where it is zero.
--
-- Mirrors migration 412 (byok_customer_funded): both CHECK constraints are
-- rewritten with the full list. usage_unit's closed vocabulary (migration 331)
-- gains 'call' in the same migration as the TypeScript union — migration 253
-- is the cautionary tale for shipping the type without the constraint value.

ALTER TABLE billing_spend_events
  DROP CONSTRAINT IF EXISTS billing_spend_events_cost_bucket_check;
ALTER TABLE billing_spend_events
  ADD CONSTRAINT billing_spend_events_cost_bucket_check
  CHECK (cost_bucket IN ('included','precommit','reload','platform_overhead','byok_customer_funded','x402_wallet_funded','unknown'));

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT IF EXISTS cost_attribution_events_cost_bucket_check;
ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_cost_bucket_check
  CHECK (cost_bucket IN ('included','precommit','reload','platform_overhead','byok_customer_funded','x402_wallet_funded','unknown'));

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT IF EXISTS cost_attribution_events_usage_unit_check;
ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_usage_unit_check
    CHECK (usage_unit IS NULL OR usage_unit IN ('characters', 'audio_tokens', 'audio_seconds', 'call'));
