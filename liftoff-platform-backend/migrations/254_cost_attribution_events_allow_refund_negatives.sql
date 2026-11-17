-- Migration 254: drop ou_consumed >= 0 CHECK to allow refund rows.
--
-- Deep-research realtime billing writes a single
-- cost_attribution_events row per refund (deep_research over-estimate true-up
-- or FAILED full-refund) with:
--   cost_usd          = signed negative (the delta)
--   ou_consumed       = -refund.ouRefunded         (negative)
--   customer_cost_usd = -refund.customerCreditUsd  (negative)
--   cost_bucket       = 'reload'
--
-- The legacy `ou_consumed >= 0` CHECK constraint blocks these inserts. The
-- application semantics enforce the sign convention (only the refund branch
-- writes negatives, and only when applyOuRefund returned a non-null result —
-- i.e. counter was actually decremented).
--
-- cost_usd and customer_cost_usd had no nonneg constraints to begin with,
-- so they're already refund-ready. Only ou_consumed needs relaxing.

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_ou_consumed_nonneg;
