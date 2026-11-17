-- Allow the 'absorbing' full-distill stage (P1.1 — absorption).
--
-- The distiller now emits an 'absorbing' progress stage while it sorts a
-- build's imported files into skills, memories, and knowledge-library
-- proposals. The onboarding full-distill persists every stage the distiller
-- reports (migration 261), and that column's CHECK predates this stage — so
-- without this migration the first onboarding build that carries attachments
-- would fail its status write on a constraint violation.
--
-- Additive only: every previously accepted value stays accepted.

BEGIN;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_onboarding_full_distill_stage_chk;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_full_distill_stage_chk
    CHECK (onboarding_full_distill_stage IS NULL
        OR onboarding_full_distill_stage IN (
          'connected','validating','absorbing','analyzing','fetching_tools',
          'generating','finalizing'
        ));

COMMIT;
