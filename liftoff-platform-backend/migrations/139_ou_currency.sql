-- Phase 2: Currency enforcement on billing_controls.
--
-- All ou_spend_usd values are computed in USD. Stripe invoicing must also be
-- in USD until FX handling is built. This column lets the billing controls
-- initialisation endpoint reject non-USD subscriptions at creation time.

ALTER TABLE billing_controls
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'
    CHECK (currency = 'usd');
