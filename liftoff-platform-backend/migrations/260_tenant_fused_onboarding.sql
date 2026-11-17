-- Migration 260: fused onboarding columns on tenants
--
-- Adds the columns required by the Path A / Path B fused onboarding
-- redesign. The legacy onboarding_step + onboarding_completed_at columns
-- stay for one release while the FE migrates; a follow-up migration drops
-- onboarding_step after backfill verification.
--
-- KEY DESIGN: all hire-related in-flight state lives ON the tenant as
-- JSONB / TEXT columns. NO new internal_agents row is created during the
-- hire sub-flow; the agent row is created by the Stripe-webhook handler
-- after payment, with status = onboarding_hire_chosen_status. This avoids
-- a "preview_lite" agent-row lifecycle entirely.
--
-- NOTE: the preview-lite OUTPUT is intentionally NOT persisted on the
-- tenant. On resume from refresh, the FE re-calls /distill-preview-lite,
-- which short-circuits for template paths and pays one small-tier call
-- for Custom Hire — cheaper than persisting + reasoning about resume
-- consistency on a column write.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_path                   TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_step_id                TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_hire_input             JSONB,
  ADD COLUMN IF NOT EXISTS onboarding_hire_chosen_status     TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_full_distill_status    TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS onboarding_full_distill_error     TEXT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_path_chk
    CHECK (onboarding_path IS NULL OR onboarding_path IN ('A','B'));

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_step_id_chk
    CHECK (onboarding_step_id IS NULL OR onboarding_step_id IN (
      'welcome','workspace_name','persona','hire_gallery','hire_confirm',
      'plan','payment','provisioning','all_set'
    ));

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_hire_chosen_status_chk
    CHECK (onboarding_hire_chosen_status IS NULL
        OR onboarding_hire_chosen_status IN ('active','draft'));

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_full_distill_status_chk
    CHECK (onboarding_full_distill_status IN
           ('idle','queued','running','succeeded','failed'));

-- Backfill: existing completed tenants stay completed; in-progress tenants
-- already onboarded under the legacy (0-6) flow get mapped to path A so the
-- gate doesn't yank them sideways mid-flow. Step number → step id mapping:
--   0 welcome | 1 workspace_name | 2 persona (was role) | 3 plan | 4 payment
--   | 5 invites (deprecated) | 6 all_set
--
-- IMPORTANT: legacy step 4 (payment) rewinds to 'plan' because the existing
-- code at OnboardingPage.tsx:212 already does this — Stripe state isn't
-- restorable mid-flow, so a resume at payment lands on a broken widget.
-- We preserve that user-visible behavior for any in-progress legacy tenants.
-- Legacy step 5 (invites) is deprecated in the fused flow; bounce to 'plan'
-- so the user re-picks before billing setup.
UPDATE tenants
   SET onboarding_path = 'A',
       onboarding_step_id = CASE onboarding_step
         WHEN 0 THEN 'welcome'
         WHEN 1 THEN 'workspace_name'
         WHEN 2 THEN 'persona'
         WHEN 3 THEN 'plan'
         WHEN 4 THEN 'plan'      -- rewind payment → plan; Stripe state lost on resume
         WHEN 5 THEN 'plan'      -- defunct invite step → bounce to plan re-pick
         WHEN 6 THEN 'all_set'
         ELSE 'welcome'
       END
 WHERE onboarding_path IS NULL
   AND onboarding_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_onboarding_resume
  ON tenants (onboarding_path, onboarding_step_id)
  WHERE onboarding_completed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tenants_full_distill_in_flight
  ON tenants (onboarding_full_distill_status)
  WHERE onboarding_full_distill_status IN ('queued','running');

COMMIT;
