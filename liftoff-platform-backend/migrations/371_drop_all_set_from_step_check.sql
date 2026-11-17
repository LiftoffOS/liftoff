-- 371: narrow onboarding_step_id to the six steps that exist.
--
-- WHY THIS IS SAFE NOW AND WAS NOT IN MIGRATION 370. Cloud Build applies
-- migrations at step 4 and deploys the new revision at step 5, so the revision
-- SERVING during a migration window is the previous one. When 370 shipped, that
-- previous revision still wrote 'all_set' as the final act of onboarding, and
-- narrowing the constraint would have turned a completion landing in that
-- window into a 23514 and a 500 on the last click of the wizard.
--
-- Apply this only once the revision serving ends onboarding at `invite` and has
-- no code path that produces 'all_set'. Then the revision serving during THIS
-- window cannot violate the constraint this migration installs -- which is the
-- exact property migration 366 relied on for the retired hire steps.
--
-- The UPDATE stays as a belt-and-braces sweep. 370 already normalized the
-- stored rows, but a row could in principle have been written during 370's own
-- deploy window by the then-current revision. Adding the constraint without
-- clearing such a row would abort the migration and take the whole deploy with
-- it, so the sweep runs first and costs nothing when there is nothing to sweep.
--
-- SHIPPED WITH the matching narrowing of OnboardingStepId and the tenants PATCH
-- zod enum, in the same commit. That pairing is what keeps the failure mode
-- good: a request naming the retired id is rejected by zod with a 400 before it
-- reaches the database, so the CHECK is a backstop rather than the thing a
-- caller meets. Tightening the constraint without narrowing zod would turn the
-- same rejection into a 23514 and a 500 -- same outcome, worse diagnosis.
--
-- Idempotent: drop-if-exists then re-add, so this applies to an existing
-- database and to a from-scratch rebuild alike.

UPDATE tenants
   SET onboarding_step_id = 'invite'
 WHERE onboarding_step_id = 'all_set';

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_onboarding_step_id_chk;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_step_id_chk
    CHECK (onboarding_step_id IS NULL OR onboarding_step_id IN (
      'welcome','workspace_name','persona','plan','payment','invite'
    ));

COMMENT ON COLUMN tenants.onboarding_step_id IS
  'Current onboarding wizard step. The live path is welcome -> workspace_name -> persona -> plan -> payment -> invite (ADR-050); skipping at plan jumps straight to invite, which is the terminal step and ends the wizard from either of its two exits. NULL on tenants provisioned before the step machine existed.';
