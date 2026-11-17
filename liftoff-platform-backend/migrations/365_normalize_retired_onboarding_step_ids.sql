-- 365: normalize onboarding_step_id values that no live path contains.
--
-- WHY THIS EXISTS. ADR-050 removed 'hire_gallery', 'hire_confirm' and
-- 'provisioning' from both onboarding paths. Rows written before that deploy
-- still hold them, and the dashboard gate already handles it: isStepInPath()
-- returns false, the defensive branch fires, and the tenant is restarted at
-- 'welcome'.
--
-- But that rewrite is LAZY. It only happens when the tenant next loads the
-- dashboard. A workspace that never returns keeps a step id pointing at a
-- screen the wizard cannot render, indefinitely — which is exactly the kind of
-- value that reads as live state to the next person to query this table, and
-- exactly the kind that blocks tightening the constraint later.
--
-- This does eagerly what the gate does lazily. It changes no behaviour: a
-- tenant that would have been restarted at 'welcome' on next load simply
-- already is.
--
-- Two populations are affected:
--     incomplete tenants on a retired step  (-> 'welcome')
--     completed tenants on a retired step   (-> 'all_set')
-- Both arms are written even if one is empty somewhere, because environments
-- differ, and a migration that only handles the shape one database happens
-- to have is a migration that silently does nothing somewhere else.
--
-- Two arms, because the truthful destination differs:
--
--   NOT completed -> 'welcome'. They are mid-flow on a step that no longer
--     exists; the new flow starts at the beginning. Same thing the gate does.
--
--   completed -> 'all_set'. They finished, under the old flow, on a step that
--     happened to be its terminal-ish state. Sending them to 'welcome' would
--     assert they had not finished, which is false, and onboarding_completed_at
--     already short-circuits the gate before it ever reads the step id. 'all_set'
--     is the terminal step of the live path, so this makes the column honest
--     rather than resetting anyone.
--
-- AFTER THIS, no row holds a retired value. That is the precondition migration
-- 364 named for retiring those three ids from tenants_onboarding_step_id_chk,
-- from OnboardingStepId, and from the tenants PATCH zod enum. Deliberately NOT
-- done here: the enum still ACCEPTS them, so a browser holding a pre-ADR-050
-- bundle could still PATCH one, and tightening the CHECK in the same breath
-- would turn that into a 23514 and a 500 rather than a harmless write. Tighten
-- once stale bundles have aged out.
--
-- Idempotent: the WHERE clause matches nothing on a second run, and nothing at
-- all on a from-scratch rebuild.

UPDATE tenants
   SET onboarding_step_id = 'welcome',
       updated_at         = NOW()
 WHERE onboarding_step_id IN ('hire_gallery', 'hire_confirm', 'provisioning')
   AND onboarding_completed_at IS NULL;

UPDATE tenants
   SET onboarding_step_id = 'all_set',
       updated_at         = NOW()
 WHERE onboarding_step_id IN ('hire_gallery', 'hire_confirm', 'provisioning')
   AND onboarding_completed_at IS NOT NULL;
