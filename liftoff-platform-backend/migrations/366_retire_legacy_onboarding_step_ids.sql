-- 366: narrow onboarding_step_id to the steps that actually exist.
--
-- WHY THIS EXISTS. ADR-050 removed 'hire_gallery', 'hire_confirm' and
-- 'provisioning' from both onboarding paths. Migrations 363 and 364 kept them
-- ACCEPTED, deliberately: rows written before that deploy still held them, and
-- the dashboard gate's rescue -- restarting such a tenant at 'welcome' -- is
-- itself a PATCH on that row, so the old value had to stay writable long enough
-- to be overwritten.
--
-- Migration 365 then rewrote every such row. No tenant holds one now, in any
-- environment. The reason to keep accepting them is gone, and a constraint that
-- still admits three values nothing can produce is a constraint that documents
-- a flow which no longer exists.
--
-- SHIPPED WITH the matching narrowing of OnboardingStepId and of the tenants
-- PATCH zod enum, in the same commit. That pairing is what makes this safe. A
-- request naming a retired id is now rejected by zod with a 400 before it ever
-- reaches the database, so the CHECK is a backstop rather than the thing users
-- meet. Tightening the constraint WITHOUT narrowing zod would have turned such
-- a request into a 23514 and a 500 -- same rejection, worse failure mode.
--
-- Deploy-window safety: Cloud Build applies migrations before deploying the new
-- revision, so the revision serving during this window is the current one. It
-- writes 'welcome' from the gate's defensive branch and step ids drawn from the
-- live path arrays -- never a retired value.
--
-- A browser still holding a pre-ADR-050 bundle could send one. That bundle is
-- already non-functional -- it calls three endpoints deleted in the ADR-050
-- release -- so its user must reload regardless; a clean 400 on one PATCH does
-- not change that outcome.
--
-- Idempotent: drop-if-exists then re-add, so this applies to an existing
-- database and to a from-scratch rebuild alike.

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_onboarding_step_id_chk;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_step_id_chk
    CHECK (onboarding_step_id IS NULL OR onboarding_step_id IN (
      'welcome','workspace_name','persona','plan','payment','invite','all_set'
    ));

COMMENT ON COLUMN tenants.onboarding_step_id IS
  'Current onboarding wizard step. The live path is welcome -> workspace_name -> persona -> plan -> payment -> invite -> all_set (ADR-050); skipping at plan jumps to invite. NULL on tenants provisioned before the step machine existed.';
