-- 333: mark an account as never-charged, at the charge boundary only.
--
-- Internal accounts must exercise the SAME system customers do: a real plan,
-- real metering, real OU bucket drains, real dashboards, and — the part that
-- matters — the same admission gate. An exemption that skipped admission would
-- leave exempt accounts never testing the gate everyone else hits. So the
-- exemption sits at exactly the two points where money leaves the building:
--
--   * billing/threshold-charge-service.ts — no charge call; the threshold still
--     advances (exempt is treated as settled), so no outstanding balance
--     accrues and no suspension follows from a charge that never happened.
--   * the Stripe `operating_unit_consumed` meter fires — spend-subscriber on
--     the LLM real-time path, and cost-attribution's ingest path that the
--     web-tool subscriber delegates to.
--
-- Everything upstream is untouched: buckets drain, ledger rows write,
-- current_period_spend_usd accumulates, and the dashboard shows real
-- consumption. Everything downstream of Stripe simply never happens.
--
-- Deliberately its own column rather than a `billing_tier` value: exemption is
-- orthogonal to which tier an account is on — an exempt account still has a
-- real tier, real rates and a real plan — and folding two independent facts
-- into one enum is how you end up unable to answer "is this account charged?"
-- without reading code.
--
-- NOT an execution exemption. billing/execution-guard.ts is unchanged:
-- `billing_controls.suspended` still stops an exempt account dead, because the
-- operator hard stop has to keep working on every account without exception.
--
-- billing_controls is account-keyed with no tenant_id column and no RLS
-- (see migration 138), so this is a plain ALTER — no policy, no census entry.

ALTER TABLE billing_controls
  ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN billing_controls.billing_exempt IS
  'TRUE = this account never produces a Stripe charge or meter event. Applied at the charge boundary ONLY: threshold charges are skipped (and treated as settled, so no outstanding balance accrues) and operating_unit_consumed meter events are not fired. Metering, OU bucket drains, ledger writes, spend counters, dashboards and admission are all unchanged, and an explicit suspended=TRUE still stops the account. Set for internal accounts.';

-- Partial index: the operator question is "which accounts are exempt", and the
-- answer is a handful of rows out of the whole table.
CREATE INDEX IF NOT EXISTS idx_billing_controls_billing_exempt
  ON billing_controls (account_id)
  WHERE billing_exempt;
