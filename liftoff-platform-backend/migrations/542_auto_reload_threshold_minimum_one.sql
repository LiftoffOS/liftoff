-- Auto-reload may fire from a balance as low as $1.
--
-- The threshold had a $10 minimum here and in the settings route, while the
-- settings page offered $0, so a threshold under $10 meant a failed save
-- and no reason. The minimum is now $1 for the threshold and $5
-- for the reload amount, the same in the page, the billing service and this
-- service. The amount has no constraint of its own; the route enforces it.
--
-- A $1 threshold sits under the $2 prepaid floor, so the floor for an account
-- with auto-reload on is now the lower of the two (billing/prepaid-floor.ts
-- accountFloorUsd). Without that the workspace would stop at $2 and never
-- reach the balance that fires its reload.

ALTER TABLE billing_controls DROP CONSTRAINT IF EXISTS billing_controls_auto_reload_threshold_usd_check;

ALTER TABLE billing_controls ADD CONSTRAINT billing_controls_auto_reload_threshold_usd_check
  CHECK (auto_reload_threshold_usd IS NULL OR auto_reload_threshold_usd >= 1);
