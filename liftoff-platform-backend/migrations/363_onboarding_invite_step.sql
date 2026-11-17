-- 363: add 'invite' to the allowed onboarding step ids.
--
-- WHY THIS EXISTS. The onboarding wizard is being reshaped so the first hire no
-- longer happens inside it (ADR-050, launch-time payment gate). The
-- new shape is:
--
--   welcome -> workspace_name -> persona -> plan -> payment -> invite -> all_set
--
-- 'invite' is a step the wizard had before the fused-onboarding rewrite and is
-- being restored. Migration 260 constrained onboarding_step_id to a fixed list,
-- so without this the tenants PATCH that persists the step raises 23514 and the
-- user cannot advance past payment -- a check constraint failing in exactly the
-- place a wizard writes its progress.
--
-- The hire step ids ('hire_gallery', 'hire_confirm') and 'provisioning' are
-- DELIBERATELY RETAINED even though the new paths no longer contain them. Rows
-- written before this deploy still hold those values, and narrowing the
-- constraint would make every subsequent UPDATE on such a tenant fail -- the
-- frontend gate restarts them at 'welcome' on next load, but that restart is
-- itself a PATCH, and it has to be allowed to happen. They can be dropped once
-- no row holds them.
--
-- Idempotent and forward-only: the constraint is dropped IF EXISTS and re-added,
-- so this applies cleanly to an existing database and to a from-scratch rebuild.
-- Migration 260 named the constraint explicitly, so no catalog lookup is needed.

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_onboarding_step_id_chk;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_step_id_chk
    CHECK (onboarding_step_id IS NULL OR onboarding_step_id IN (
      'welcome','workspace_name','persona','hire_gallery','hire_confirm',
      'plan','payment','provisioning','invite','all_set'
    ));

COMMENT ON COLUMN tenants.onboarding_step_id IS
  'Current onboarding wizard step. hire_gallery/hire_confirm/provisioning are legacy values retained so pre-ADR-050 rows remain updatable; the live paths are welcome -> workspace_name -> persona -> plan -> payment -> invite -> all_set.';
