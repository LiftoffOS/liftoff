-- 364: drop the in-onboarding hire columns.
--
-- WHY THIS EXISTS. These five carried the first hire across the payment
-- boundary during fused onboarding. The wizard assembled a hire BEFORE the
-- card, so the real distillation was far too expensive to run on credit: the
-- inputs were parked on the tenant row, a summary-only preview stood in on the
-- confirm screen, and a Stripe webhook resumed the real work after the first
-- invoice.
--
-- ADR-050 moved the hire out of onboarding entirely. It now happens at
-- /dashboard/teams/explore, after payment has cleared, where the ordinary
-- distill runs inline with its own progress stream. Nothing produces, reads or
-- resumes this state any more.
--
-- WHY THIS IS A SEPARATE RELEASE, and not part of the change that orphaned
-- these columns. Cloud Build applies migrations at step 4 and deploys the new
-- revision at step 5, so during THIS release's own window the revision serving
-- is the PREVIOUS one. That revision must therefore already name none of these
-- columns. The ADR-050 release is what made that true — it removed every reader
-- and writer across platform-backend (repository set-clauses, updateFullDistillStatus,
-- the zod PATCH fields, the Tenant type, /full-distill-status,
-- /restart-full-distill, /distill-preview-lite, runFullDistillFromTenant),
-- liftoff-react (the tenant types, the service functions, the MSW handlers) and
-- liftoff-billing (the webhook consumer's kick-off call). That release must be
-- serving before this one is applied.
--
-- DATA DISCARDED: onboarding_hire_input on any tenant that still holds one, and
-- onboarding_full_distill_status on any tenant left mid-flight on the old
-- deferred distill (<> 'idle'). That work is unresumable either way — the
-- runner it needed was deleted with the flow — so the column is recording a
-- state nothing can act on. Such tenants re-enter the new flow through the
-- dashboard gate, which restarts any tenant whose step id is no longer in its
-- path.
--
-- The CHECK constraints on these columns drop automatically with them, because
-- each constrains only the column it names:
--     tenants_onboarding_hire_chosen_status_chk    (migration 260)
--     tenants_onboarding_full_distill_status_chk   (migration 260)
--     tenants_onboarding_full_distill_stage_chk    (migration 261, replaced by 318)
--
-- SURVIVING, deliberately: onboarding_path and onboarding_step_id still drive
-- the live wizard. So do the legacy step-id values 'hire_gallery',
-- 'hire_confirm' and 'provisioning' in migration 363's CHECK — rows written
-- before ADR-050 still hold them, and the gate has to be able to PATCH such a
-- tenant back to 'welcome'. Those retire separately, once no row holds one.
--
-- Idempotent: IF EXISTS on every drop, so this applies cleanly to a database
-- that has these columns and to a from-scratch rebuild that never created them.

ALTER TABLE tenants
  DROP COLUMN IF EXISTS onboarding_hire_input,
  DROP COLUMN IF EXISTS onboarding_hire_chosen_status,
  DROP COLUMN IF EXISTS onboarding_full_distill_status,
  DROP COLUMN IF EXISTS onboarding_full_distill_error,
  DROP COLUMN IF EXISTS onboarding_full_distill_stage;
