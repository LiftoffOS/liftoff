/**
 * Pure decision function for DashboardOnboardingGate.
 *
 * Lifted out of the React component so it can be unit-tested with no
 * provider / hook fixture. The component is a thin shell that wires
 * useAuth/useLocation into decideGate and acts on the returned
 * GateDecision.
 *
 * Decision tree (precedence top-to-bottom):
 *   1. tenantLoading  → show_loading
 *   2. no currentTenant → show_error
 *   3. non-owner → render_children (members/admins inherit onboarded tenant)
 *   4. owner + onboardingCompletedAt set (legacy completion) → render_children
 *   5. owner + already on /onboarding → render_children (OnboardingPage owns it)
 *   6. owner + path null (legacy backfill miss) → seed Path A welcome
 *   7. owner + path set + step null → seed step from path
 *   8. owner + path+step valid for path → go_onboarding
 *   9. defensive fallback (corrupt step_id) → mark_path_and_go_onboarding (restart)
 *
 * The onboarding path is stored server-side on tenants.onboarding_path at
 * provision time, so it is authoritative here — we no longer need (or
 * read) a `?path=` URL param. The only URL-derived input that still
 * matters is the role hint the hero passed through, used to seed
 * tenants.onboarding_hire_input.role for Path B users.
 */

import type { TenantWithRole } from '../../services/tenants'
import type { OnboardingPath, OnboardingStepId } from '../../pages/Dashboard/Onboarding/types'
import { isStepInPath } from '../../pages/Dashboard/Onboarding/types'

export type GateDecision =
  | { kind: 'render_children' }
  | { kind: 'go_dashboard' }
  | { kind: 'go_onboarding' }
  | { kind: 'show_loading' }
  | { kind: 'show_error' }
  | {
      kind: 'mark_path_and_go_onboarding'
      path: OnboardingPath
      stepId: OnboardingStepId
    }

export interface GateInput {
  tenantLoading: boolean
  currentTenant: TenantWithRole | null
  currentRole: 'owner' | 'admin' | 'member' | 'viewer' | null
  /** Pathname we are being asked to gate. */
  pathname: string
}

export function decideGate(input: GateInput): GateDecision {
  if (input.tenantLoading) return { kind: 'show_loading' }
  if (!input.currentTenant) return { kind: 'show_error' }

  // Non-owners inherit an already-onboarded workspace.
  if (input.currentRole !== 'owner') return { kind: 'render_children' }

  const t = input.currentTenant

  // Legacy completed flow — gate fully open.
  if (t.onboardingCompletedAt) return { kind: 'render_children' }

  // Already inside /onboarding? Let OnboardingPage own the rendering.
  if (input.pathname.startsWith('/onboarding')) return { kind: 'render_children' }

  // Defensive: tenant.onboardingPath should always be set after provision
  // (AuthContext writes it via provisionTenant({ onboardingPath })). Anything
  // missing it is a legacy backfill row — default to Path A welcome.
  if (!t.onboardingPath) {
    return { kind: 'mark_path_and_go_onboarding', path: 'A', stepId: 'welcome' }
  }

  // Path set, step not yet — seed the first step. Both paths start at
  // `welcome` now: path B used to jump straight to hire_gallery, but the hire
  // left onboarding (ADR-050) and the path only decides where completion
  // destination. Seeding a retired step here would mark the tenant at a step
  // no path contains, and the very next load would bounce it through the
  // defensive branch below.
  if (!t.onboardingStepId) {
    return { kind: 'mark_path_and_go_onboarding', path: t.onboardingPath, stepId: 'welcome' }
  }

  // In-progress on path A or B.
  if (isStepInPath(t.onboardingPath, t.onboardingStepId)) return { kind: 'go_onboarding' }

  // Defensive fallback: a step id no path contains → restart at the first step.
  // This is also the migration path for a tenant parked on hire_gallery /
  // hire_confirm / provisioning when the hire left onboarding: those ids are
  // still valid values, just no longer in any path, so they land here and get
  // a clean restart rather than a screen the wizard cannot render.
  return {
    kind: 'mark_path_and_go_onboarding',
    path: t.onboardingPath,
    stepId: 'welcome',
  }
}
