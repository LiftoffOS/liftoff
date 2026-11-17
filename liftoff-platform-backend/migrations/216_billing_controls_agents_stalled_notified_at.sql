-- Migration 216: billing_controls.agents_stalled_notified_at
--
-- Set once per credit-depletion cycle when reload_balance_usd hits <=0 and
-- auto_reload_enabled=false. Cleared on top-up, auto-reload-enable, period
-- reset, and resubscribe so the next depletion can re-notify.

ALTER TABLE billing_controls
  ADD COLUMN agents_stalled_notified_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN billing_controls.agents_stalled_notified_at IS
  'Set once per credit-depletion cycle when reload_balance_usd hits <=0 and auto_reload_enabled=false. Cleared on top-up or auto-reload enable to allow re-notification on the next depletion.';
