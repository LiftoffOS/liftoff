-- migrations/025_referral_credits.sql
--
-- The referral programme's money half.
--
-- The split with platform-backend follows the money boundary: that repo decides
-- WHETHER a referral counts — who is eligible, who was attributed to whom — and
-- this one decides what it is worth, when it can be spent, and is the only side
-- that touches Stripe. One grant per earning referral lives here.
--
-- WHY THE ROW IS NOT A BALANCE. Credit expires on a timer, and a timer means
-- each grant ages separately, so a single pooled figure per tenant stops
-- describing the state. Spend order is nearest expiry first. `expires_at` is
-- therefore per grant, and the page prints it: credit that disappears on a date
-- the customer was never shown is the same broken promise as a hidden fee.
--
-- WHY THERE ARE ONLY THREE STATUSES. `pending` is earned but not vested,
-- `granted` is spendable, and `reversed` is taken back — by a refund, by a
-- dispute, by the timer running out, by cancellation, or under the
-- investigate-and-disqualify clause. `reversed_reason` is what distinguishes
-- them, and it has to exist anyway: disqualification needs a state to move to
-- even if chargebacks were fully covered by the 60 day hold.
--
-- WHAT IS DELIBERATELY ABSENT. There is no negative balance and no clawback
-- against future earnings. That design was considered and rejected twice: it
-- misses fraudsters, because a negative balance is only collectable from
-- somebody who intends to keep earning, which describes the honest referrer and
-- not the attacker who abandons the workspace; and it is a griefing vector,
-- because referral links are public by design and anyone can sign up through
-- one, pay, and charge back. Spent credit that is reversed is absorbed.

CREATE TABLE referral_credits (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- platform-backend's referrals.id. Not a foreign key: that table is in
  -- another database entirely. UNIQUE is what makes earning idempotent under
  -- Stripe's at-least-once webhook delivery — one referral can only ever grant
  -- one credit, however many times the invoice is redelivered.
  referral_id       UUID          NOT NULL UNIQUE,
  -- The REFERRER's workspace: the one that earns and can spend. The referred
  -- side's reward is Operating Units and lives in billing_controls.
  tenant_id         UUID          NOT NULL,
  amount_usd        NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
  status            TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'reversed')),
  -- When the referred workspace's first full-priced invoice was paid.
  earned_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- earned_at + the 60 day hold. The hold is what makes a flat $20 safe: Core
  -- is $20/month, so earning $20 costs the referred side two paid months, and
  -- self-referral and circular rings lose money by construction. It is also
  -- what turns the common reversals — early refund, quick churn, a failed
  -- second payment — into free reversals of credit nobody has spent.
  available_at      TIMESTAMPTZ   NOT NULL,
  -- Set when the credit vests, to max(available_at + 90 days, the holder's next
  -- invoice). Two conditions because either alone breaks. The clock starts at
  -- availability rather than accrual, or a 90 day timer would leave 30 usable
  -- days; and the invoice floor exists because Liftoff sells annual billing, so
  -- a bare timer would expire an annual subscriber's credit before it could
  -- ever be applied — on the plan they paid more for up front.
  expires_at        TIMESTAMPTZ,
  -- The Stripe invoice this credit was actually consumed by. What
  -- creditAppliedUsd counts.
  applied_invoice_id TEXT,
  applied_at        TIMESTAMPTZ,
  -- The Stripe customer balance transaction that put the credit in front of
  -- Stripe. Kept so an application can be traced back without guessing at
  -- amounts and timestamps.
  stripe_balance_txn_id TEXT,
  reversed_reason   TEXT
    CHECK (reversed_reason IN (
      'refund', 'dispute', 'expired', 'cancelled', 'terms_violation', 'disqualified'
    )),
  reversed_at       TIMESTAMPTZ,
  -- The invoice whose payment earned this credit, so a refund or dispute of
  -- that payment can find its way back here.
  earning_invoice_id TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- A reversal must say why, and only a reversal may.
  CHECK ((status = 'reversed') = (reversed_reason IS NOT NULL))
);

-- The programme payload's totals, and the per-page credit lookup, are both
-- "this tenant's credits".
CREATE INDEX idx_referral_credits_tenant ON referral_credits (tenant_id, status);

-- The vesting sweep: pending credits whose hold has run out.
CREATE INDEX idx_referral_credits_vesting
  ON referral_credits (available_at)
  WHERE status = 'pending';

-- Application and the expiry sweep, both nearest expiry first over the same
-- set: vested, unspent, unreversed.
CREATE INDEX idx_referral_credits_spendable
  ON referral_credits (tenant_id, expires_at)
  WHERE status = 'granted' AND applied_invoice_id IS NULL;

-- Reversal arrives from Stripe knowing only which invoice was refunded.
CREATE INDEX idx_referral_credits_earning_invoice
  ON referral_credits (earning_invoice_id)
  WHERE earning_invoice_id IS NOT NULL;

-- RLS, in migration 023's four-policy shape rather than migration 002's single
-- strict one.
--
-- The reason is the same one that crashed the card-expiring job: a strict
-- policy reads current_setting(..., false), which THROWS on a connection that
-- never bound the GUC, and the vesting and expiry sweeps are cross-tenant by
-- nature — "every credit whose hold has run out" is not a question any one
-- tenant's scope can ask. So reads are permitted with no context bound, and
-- every WRITE still requires one: the sweeps select cross-tenant and then
-- perform each update under withBillingTenant, which is how
-- card-expiring-reminders already works.
--
-- Note the earning INSERT is written under the REFERRER's context, not the
-- referred workspace's, even though it is the referred workspace's invoice that
-- triggered it. The credit belongs to the referrer, and the strict INSERT
-- policy is what forces that to be said out loud rather than inherited from
-- whichever tenant the webhook happened to be about.

ALTER TABLE referral_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY referral_credits_tenant_write ON referral_credits
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', false)::uuid);

CREATE POLICY referral_credits_tenant_update ON referral_credits
  FOR UPDATE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY referral_credits_tenant_select ON referral_credits
  FOR SELECT
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY referral_credits_background_select ON referral_credits
  FOR SELECT
  USING (current_setting('app.current_tenant_id', true) IS NULL);

COMMENT ON TABLE referral_credits IS
  'One grant per earning referral, held by the REFERRER. Per-grant expiry because the timer ages each one separately; spent nearest-expiry-first. No negative balance and no clawback: spent credit that is reversed is absorbed.';
