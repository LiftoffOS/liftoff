-- Migration 202: onboarding state on tenants
--
-- Lets the frontend resume an in-progress onboarding flow at the step the
-- user left off, persist the step-2 persona answer, and gate the dashboard
-- on whether onboarding is complete for the active tenant.
--
-- Columns:
--   onboarding_step          — last step reached (0=cover, 6=done).
--   onboarding_persona       — step-2 answer (generalist, customer,
--                              operations, talent, engineering, other).
--   onboarding_completed_at  — set by step-6 "Start Liftoff"; nullable so
--                              an unset value is the natural "still
--                              onboarding" signal.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_step         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarding_persona      TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Existing tenants pre-date onboarding; mark them complete so users with
-- already-set-up workspaces aren't dumped back into the flow.
UPDATE tenants
   SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
       onboarding_step         = GREATEST(onboarding_step, 6)
 WHERE onboarding_completed_at IS NULL;

COMMIT;
