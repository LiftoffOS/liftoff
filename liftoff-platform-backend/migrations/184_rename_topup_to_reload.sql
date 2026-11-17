-- Rename topup → reload in billing_controls columns and constraints
BEGIN;

-- Drop inline CHECK constraints (auto-named by Postgres)
ALTER TABLE billing_controls DROP CONSTRAINT IF EXISTS billing_controls_auto_topup_threshold_usd_check;
ALTER TABLE billing_controls DROP CONSTRAINT IF EXISTS billing_controls_suspended_reason_check;

-- Rename columns
ALTER TABLE billing_controls RENAME COLUMN topup_balance_usd TO reload_balance_usd;
ALTER TABLE billing_controls RENAME COLUMN auto_topup_enabled TO auto_reload_enabled;
ALTER TABLE billing_controls RENAME COLUMN auto_topup_threshold_usd TO auto_reload_threshold_usd;
ALTER TABLE billing_controls RENAME COLUMN auto_topup_amount_usd TO auto_reload_amount_usd;
ALTER TABLE billing_controls RENAME COLUMN last_auto_topup_triggered_at TO last_auto_reload_triggered_at;

-- Migrate existing suspended_reason values
UPDATE billing_controls SET suspended_reason = 'auto_reload_failed' WHERE suspended_reason = 'auto_topup_failed';

-- Recreate CHECK constraints with new names
ALTER TABLE billing_controls ADD CONSTRAINT billing_controls_auto_reload_threshold_usd_check
  CHECK (auto_reload_threshold_usd IS NULL OR auto_reload_threshold_usd >= 10);

ALTER TABLE billing_controls ADD CONSTRAINT billing_controls_suspended_reason_check
  CHECK (suspended_reason IN ('auto_reload_failed', 'payment_failed', 'subscription_cancelled',
                               'no_payment_method', 'zero_prepaid_balance'));

COMMIT;
