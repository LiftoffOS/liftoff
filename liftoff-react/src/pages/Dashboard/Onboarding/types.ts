/**
 * sessionStorage key used to bridge the hero → /login → AuthContext
 * callback chain. LoginPage writes 'A' or 'B' on URL `?path=` parse;
 * AuthContext reads it to choose between firstName-based and neutral
 * 'Personal Workspace' seeding for the auto-provisioned tenant.
 * OnboardingPage clears it when onboarding completes so it doesn't
 * leak into subsequent sessions or other tenants.
 */
export const PENDING_ONBOARDING_PATH_KEY = 'liftoff.pending_onboarding_path'

/**
 * sessionStorage key holding the id of an OAuth consent request an owner was
 * sent to onboarding from. The consent page stores it when the backend answers
 * 409 setup_required; OnboardingPage clears it on completion and returns to
 * /oauth/consent for that request instead of the usual destination, so one
 * sign-in from the coding tool carries through the whole set-up.
 */
export const PENDING_OAUTH_CONSENT_KEY = 'liftoff.pending_oauth_consent'

/** The device-flow twin: the user code an owner left /activate with to finish
 *  setup; completion returns them to /activate for that code. */
export const PENDING_DEVICE_ACTIVATION_KEY = 'liftoff.pending_device_activation'

/**
 * sessionStorage key holding the role the user arrived with (`?role=`), so
 * the end of onboarding can hand it to /dashboard/agents/explore?role=… once
 * the wizard finishes.
 *
 * sessionStorage rather than tenant state on purpose: it survives a reload
 * within the tab, which is all this needs, and it does not depend on
 * `onboarding_hire_input` — a column being dropped now that the hire has left
 * onboarding. Written at hydration from `?role=`, cleared when consumed.
 *
 * Losing it (new tab, cleared storage) degrades to the plain gallery rather
 * than stranding anyone.
 */
export const PENDING_HERO_ROLE_KEY = 'liftoff.pending_hero_role'

/**
 * Fused-onboarding shared types.
 *
 * These types pair with the migration 260 columns on the `tenants` table.
 * They are NOT a state-machine reducer — OnboardingPage uses plain useState
 * with these as the persisted-shape contract.
 */

/** Which fused-onboarding path the tenant is on. NULL until first decision. */
export type OnboardingPath = 'A' | 'B'

/**
 * Stable step identifiers shared by frontend and backend persistence.
 * NEVER renumbered: they are persisted on tenants.onboarding_step_id and
 * compared by the resume gate. Adding a step is additive only.
 */
export type OnboardingStepId =
  | 'welcome'
  | 'workspace_name'
  | 'persona'
  | 'plan'
  | 'payment'
  | 'invite'

/**
 * The wizard shape (ADR-050). Both paths run the same six steps.
 *
 * The first hire used to live at `hire_gallery` / `hire_confirm`, before the
 * card, which is why `provisioning` existed to hold the user while a deferred
 * distill ran. It now happens after onboarding at /dashboard/agents/explore,
 * where payment has already cleared and the ordinary distill runs directly.
 *
 * `hire_gallery`, `hire_confirm` and `provisioning` are gone entirely. They were
 * retained through the transition so the gate could recognise a tenant parked on
 * one and restart it at `welcome`; migration 365 rewrote every such row and
 * migration 366 removed them from the CHECK constraint and the API. The gate's
 * defensive branch still catches any unrecognised value, which is what would
 * handle genuinely corrupt data.
 *
 * `onboarding_path` survives even though the arrays are identical — it decides
 * where completion lands (path B goes to the gallery with the hero role
 * prefilled) and keeps `pathOrdinal` funnel analytics comparable across this
 * change.
 */
const SHARED_STEPS: readonly OnboardingStepId[] = [
  'welcome',
  'workspace_name',
  'persona',
  'plan',
  'payment',
  'invite',
] as const

export const PATH_A_STEPS: readonly OnboardingStepId[] = SHARED_STEPS

export const PATH_B_STEPS: readonly OnboardingStepId[] = SHARED_STEPS

/** Lookup: given a path + current step id, what comes next? */
export function nextStepId(path: OnboardingPath, current: OnboardingStepId): OnboardingStepId {
  const arr = path === 'A' ? PATH_A_STEPS : PATH_B_STEPS
  const i = arr.indexOf(current)
  if (i < 0 || i === arr.length - 1) return current
  return arr[i + 1]
}

export function prevStepId(path: OnboardingPath, current: OnboardingStepId): OnboardingStepId {
  const arr = path === 'A' ? PATH_A_STEPS : PATH_B_STEPS
  const i = arr.indexOf(current)
  if (i <= 0) return current
  return arr[i - 1]
}

/** True if the step id is valid for the given path. Used by the gate. */
export function isStepInPath(path: OnboardingPath, step: OnboardingStepId): boolean {
  return (path === 'A' ? PATH_A_STEPS : PATH_B_STEPS).includes(step)
}

/** 1-based ordinal position of `step` within `path`. Used by analytics
 *  funnel events so dashboards can chart drop-off without needing to
 *  enumerate the step ids client-side. Returns 0 for unknown step ids
 *  — caller may filter these out. */
export function pathOrdinal(path: OnboardingPath, step: OnboardingStepId): number {
  const arr = path === 'A' ? PATH_A_STEPS : PATH_B_STEPS
  const i = arr.indexOf(step)
  return i < 0 ? 0 : i + 1
}

// HireSubStep, HireInput and HirePreview lived here. They described the first
// hire being assembled inside onboarding and carried across the payment
// boundary on tenants.onboarding_hire_input. The hire now happens after
// onboarding, in AgentExplorePage, which owns that state internally and never
// persists it — so there is no shared shape left to declare (ADR-050).

/**
 * Where the end of onboarding sends the user.
 *
 * Reached from BOTH exits of the terminal `invite` step -- Continue, and the
 * skip modal's "Skip Invite". It was previously the `all_set` screen's
 * "Start Liftoff" button, which was the only way out; the screen is gone and
 * this is now the shared tail of `completeOnboarding`.
 *
 * Path A lands on `/dashboard` — the chat surface, which is the product's front
 * door and reads correctly with nothing built yet.
 *
 * It pointed at `/dashboard/agents` between commit 9de114f and ADR-050. That was
 * right for exactly as long as onboarding created an agent: the teams list
 * showed you the thing you had just made. The hire has left onboarding, so a
 * Path A user now finishes having created nothing, and the teams list would
 * greet them with its empty state. Restoring `/dashboard` restores the
 * behaviour that predates the reason for changing it.
 *
 * Path B arrived with a role in mind (`?role=`), so it skips ahead
 * to the gallery with that role prefilled rather than making them find it.
 */
export function completionDestination(path: OnboardingPath, heroRole: string | null): string {
  if (path !== 'B') return '/dashboard'
  return heroRole
    ? `/dashboard/agents/explore?role=${encodeURIComponent(heroRole)}`
    : '/dashboard/agents/explore'
}
