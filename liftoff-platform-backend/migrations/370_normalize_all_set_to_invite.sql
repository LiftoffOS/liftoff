-- 370: rewrite the retired `all_set` step id to `invite`.
--
-- WHY THIS EXISTS. `invite` is now the terminal onboarding step. Both of its
-- exits -- Continue, and the skip modal's "Skip Invite" -- end the wizard, so
-- the `all_set` screen that used to follow it is gone and no code writes that
-- value any more.
--
-- Every row still holding it belongs to a tenant that FINISHED onboarding, so
-- the value is a historical marker rather than a position anyone is parked at.
-- Rewriting it to `invite` makes the column mean the same thing for a tenant
-- who completed last month as for one who completes tomorrow.
--
-- WHY THE CHECK CONSTRAINT IS NOT NARROWED HERE. Cloud Build applies migrations
-- at step 4 and deploys the new revision at step 5, so the revision SERVING
-- during this window is the previous one -- and unlike the retired hire steps,
-- that revision actively writes 'all_set' as the last thing it does at the end
-- of onboarding. Dropping the value from the constraint in this release would
-- turn any completion landing in that window into a 23514 and a 500, on the
-- final click of the wizard.
--
-- So this release only normalizes, and deliberately leaves both the constraint
-- (migration 366) and the zod enum accepting 'all_set'. A FOLLOW-UP release
-- narrows both, once the only serving revision is one that never writes it.
-- That is the same two-step shape migrations 365 and 366 used for the hire
-- steps, for the same reason.
--
-- A row written as 'all_set' during the deploy window survives this migration.
-- It is harmless -- the constraint still accepts it, and the frontend treats an
-- unrecognised step id defensively -- and the follow-up release re-runs this
-- normalization before narrowing, which is what sweeps it up.
--
-- Idempotent: a second run matches nothing.

UPDATE tenants
   SET onboarding_step_id = 'invite'
 WHERE onboarding_step_id = 'all_set';

COMMENT ON COLUMN tenants.onboarding_step_id IS
  'Current onboarding wizard step. The live path is welcome -> workspace_name -> persona -> plan -> payment -> invite (ADR-050); skipping at plan jumps straight to invite, which is the terminal step and ends the wizard from either of its two exits. NULL on tenants provisioned before the step machine existed.';
