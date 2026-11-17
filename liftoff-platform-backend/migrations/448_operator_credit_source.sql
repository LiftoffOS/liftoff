-- Add 'operator_credit' as a new EventSource for cost_attribution_events.
--
-- When Liftoff fails a customer — work that ran and produced nothing usable, an
-- outage, a bug that burned their allowance — the remedy is to hand the
-- Operating Units back. applyOuRefund already does exactly that: it decrements
-- ous_consumed_this_period and current_period_spend_usd together, floors both
-- at zero, and writes one negative ledger row. Its only caller was
-- ingestEventWithBuckets reacting to a cost source reporting a negative cost,
-- so no operator could reach it.
--
-- The grant travels as a NEGATIVE-COST EVENT through that same boundary rather
-- than as a new allowance column or a new cost_bucket:
--
--   * not a cost_bucket, because migration 440 settles that the bucket records
--     WHOSE MONEY PAID THE VENDOR ('byok_customer_funded', 'x402_wallet_funded').
--     A goodwill grant does not change that — the platform pays the vendor
--     exactly as it always does.
--
--   * not an allowance column, because carry-over cannot be expressed against a
--     single per-period counter: ous_consumed_this_period resets while a column
--     would not, so an unconsumed grant would re-grant its band every period
--     forever.
--
-- The event_type stays 'credit', which migration 133 already permits. The
-- usage-ledger ingester writes 'credit' too, under source='tenant_runtime', so
-- the pair (source, event_type) keeps the two apart without a new type value.
--
-- Constraint lives on the parent partitioned table; PostgreSQL propagates the
-- change to every monthly partition automatically.

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_source_check;

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_source_check
    CHECK (source IN (
      'tenant_runtime', 'governance', 'developer_proxy',
      'gcp_billing', 'gcp_billing_platform', 'platform_llm',
      'composio_mcp', 'operator_credit'
    ));
