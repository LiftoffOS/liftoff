-- A card the issuer has flagged holds the workspace until an operator looks.
--
-- Distinct from `suspended`, which is a money fact and is cleared by money
-- arriving: /prepaid-topped-up lifts it the moment the balance goes positive.
-- A hold placed because a payment was reported as fraud must survive exactly
-- that event, because the next card is as likely to be the next stolen one.
-- Only the admin clear route writes NULL back.
--
-- Read by prepaid-floor.billingStoppedSql, which is joined into the entitlement
-- snapshot the tenant runtime's admission gates read, and checked directly by
-- this service's execution guard. Setting it therefore stops new work
-- everywhere without touching agent_execution_allowed, which stays the "this
-- workspace is cleared to run" fact that a top-up and a subscription set.
--
-- The wallet is untouched by a hold: credit leaves when money leaves
-- (charge.refunded / charge.dispute.created), not when a warning arrives.
-- About 40% of early fraud warnings become disputes, so debiting here would
-- take the credit twice on those and once too often on the rest.

ALTER TABLE billing_controls
  ADD COLUMN IF NOT EXISTS fraud_hold_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS fraud_hold_ref TEXT        NULL;

COMMENT ON COLUMN billing_controls.fraud_hold_at IS
  'Set by liftoff-billing on radar.early_fraud_warning.created; read by prepaid-floor.billingStoppedSql and the execution guard; cleared only by POST /api/admin/accounts/:accountId/fraud-hold/clear.';

COMMENT ON COLUMN billing_controls.fraud_hold_ref IS
  'Stripe early fraud warning id (issfr_...) that placed the hold.';
