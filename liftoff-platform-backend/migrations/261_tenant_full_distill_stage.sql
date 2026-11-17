-- Migration 261: persist the current DistillStage during the fused-onboarding
-- post-payment full distill, so the FE provisioning loader can render real
-- progress (streamed via the existing polling /full-distill-status endpoint)
-- instead of guessing phase transitions with FE-side timers.
--
-- Stage values match DistillStage in internal-agents/distill-service.ts:
--   'connected' | 'validating' | 'analyzing' | 'fetching_tools' |
--   'generating' | 'finalizing'
-- NULL means no distill has run yet (idle status) or the worker hasn't yet
-- emitted its first progress event.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS onboarding_full_distill_stage TEXT;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_onboarding_full_distill_stage_chk
    CHECK (onboarding_full_distill_stage IS NULL
        OR onboarding_full_distill_stage IN (
          'connected','validating','analyzing','fetching_tools',
          'generating','finalizing'
        ));

COMMIT;
