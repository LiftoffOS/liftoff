-- Migration 255: restore the dropped nonneg constraint with a stronger
-- same-sign invariant that permits refund rows.
--
-- Migration 254 dropped cost_attribution_events_ou_consumed_nonneg to unblock
-- the PB-3 refund branch (deep_research over-estimate true-ups and FAILED
-- full-refunds write negative ou_consumed). Bare drop leaves no integrity
-- check at all — a future bug could write mixed-sign rows (positive cost_usd
-- with negative ou_consumed, or vice versa) and silently corrupt the OU
-- counter and Stripe meter aggregations.
--
-- This migration replaces the bare nonneg with the actual invariant the
-- application maintains:
--
--   "On any single row, cost_usd, ou_consumed, and customer_cost_usd all
--    share the same sign direction. Customer-chargeable consumption writes
--    all non-negative values. Refunds (applyOuRefund) write all
--    non-positive values."
--
-- Three valid row shapes:
--   1. Standard consumption row (customer or platform_overhead):
--        cost_usd >= 0  AND  ou_consumed >= 0  AND  customer_cost_usd >= 0
--   2. Customer refund row (PB-3 refund branch, cost_bucket='reload' per D2.4):
--        cost_usd <= 0  AND  ou_consumed <= 0  AND  customer_cost_usd <= 0
--   3. Edge: an exact zero row could fall into either side; we accept either.
--
-- Pre-deploy backfill check confirmed 0 violators across all live rows
-- (6880 standard + 2 refund — synthetic test events).

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_same_sign
    CHECK (
      (cost_usd >= 0 AND ou_consumed >= 0 AND customer_cost_usd >= 0)
      OR
      (cost_usd <= 0 AND ou_consumed <= 0 AND customer_cost_usd <= 0)
    );
