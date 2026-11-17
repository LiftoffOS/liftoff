-- Migration 214: billing_controls.access_ends_at
--
-- Set when customer.subscription.updated fires with cancel_at_period_end=true
-- (subscription canceled, access continues until period end). Used by the
-- daily ending-reminder job. Cleared on resubscribe or when the period
-- actually ends.

ALTER TABLE billing_controls
  ADD COLUMN access_ends_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN billing_controls.access_ends_at IS
  'Set when customer.subscription.updated fires with cancel_at_period_end=true (subscription canceled, access continues until period end). Used by the daily ending-reminder job. Cleared on resubscribe or when the period actually ends.';
