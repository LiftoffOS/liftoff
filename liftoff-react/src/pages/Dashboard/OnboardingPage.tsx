import { useState, useEffect, useRef } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { BackButton } from '../../components'
import ErrorState from '../../components/ErrorState'
import OnboardingUserMenu from '../../components/Dashboard/OnboardingUserMenu'
import { useTenant, useUpdateTenant } from '../../hooks/useTenant'
import { useUpdateAccount } from '../../hooks/useAccount'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import { track, trackOnboarding } from '../../lib/analytics'   // trackOnboarding is the v2 wrapper, adds schema_version: 2
import type { AccountPersona } from '../../services/account'
import {
  type OnboardingPath,
  type OnboardingStepId,
  nextStepId,
  prevStepId,
  pathOrdinal,
  completionDestination,
  PENDING_OAUTH_CONSENT_KEY,
  PENDING_DEVICE_ACTIVATION_KEY,
  PENDING_ONBOARDING_PATH_KEY,
  PENDING_HERO_ROLE_KEY,
} from './Onboarding/types'
import WelcomeStep from './Onboarding/WelcomeStep'
import WorkspaceNameStep from './Onboarding/WorkspaceNameStep'
import PersonaStep from './Onboarding/PersonaStep'
import PlanStep from './Onboarding/PlanStep'
import PaymentStep from './Onboarding/PaymentStep'
import InviteStep from './Onboarding/InviteStep'
import type { BillingPeriod } from './Pricing/data'
import './PricingPage.css'
import './OnboardingPage.css'

interface OnboardingPageProps {
  // Dev-only preview switch — set true by src/dev/OnboardingPreviewRoute
  // (which is itself only mounted under `import.meta.env.DEV`). Bypasses
  // the inverse-completed gate so already-onboarded owners can view the
  // wizard, and short-circuits every mutation site (tenant PATCH, account
  // PATCH, invite POST) so iterating on the experience can't pollute the
  // real tenant. Stripe still renders against dev test mode. Defaults to
  // false; production routes never pass this prop.
  previewMode?: boolean
}

/**
 * Onboarding orchestrator (ADR-050).
 *
 * Seven steps, identical for both paths:
 *   welcome → workspace_name → persona → plan → payment → invite
 *
 * Skip on `plan` jumps to `invite`, so `payment` is only reached by a user who
 * actually chose a plan. Paying is not required to finish onboarding; it is
 * required to LAUNCH a team, which the server enforces with a 402 and the
 * dashboard surfaces as the plan-gate modal.
 *
 * The first hire is deliberately NOT here. It used to be, split across this
 * component and AgentExplorePage, and the split is what stranded users: this
 * component persisted a substep while never learning which template had been
 * picked, so every resume dropped them back at the top of the gallery. The
 * hire now happens after onboarding at /dashboard/agents/explore, where
 * AgentExplorePage owns all of its own state.
 *
 * Plain useState — no reducer — with PATCH persistence in a useEffect watching
 * the step.
 */
export default function OnboardingPage({ previewMode = false }: OnboardingPageProps = {}) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { currentTenant, currentRole, tenantLoading, refreshTenants } = useTenant()
  const { account } = useAuth()
  const { mutateAsync: doUpdateTenant } = useUpdateTenant()
  const { mutateAsync: doUpdateAccount } = useUpdateAccount()
  const { showToast } = useToast()

  /* ── Accumulated state — plain useState, no reducer ─────────────── */

  // Initial step is computed once on mount from the tenant's persisted state.
  // Subsequent navigation uses setStepId directly.
  const [stepId, setStepId] = useState<OnboardingStepId>('welcome')
  const [path, setPath] = useState<OnboardingPath>('A')
  const [workspaceName, setWorkspaceName] = useState('')
  const [persona, setPersona] = useState<AccountPersona | null>(null)
  const [plan, setPlan] = useState<string | null>(null)
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly')
  const [planOuValues, setPlanOuValues] = useState<Record<string, number>>({})
  const [inviteEmailsRaw, setInviteEmailsRaw] = useState('')

  const stepEnteredAtRef = useRef<number>(0)
  useEffect(() => {
    stepEnteredAtRef.current = Date.now()
  }, [])
  // True ONLY for the first step_entered event after hydration when the
  // tenant came back to a non-welcome step (i.e., they're picking up where
  // they left off). Flips to false after the first emit so subsequent
  // step transitions don't all get tagged resumed=true.
  const firstStepEmitRef = useRef(true)

  // State, not refs. Both of these are read and written DURING render, which a
  // ref may not be: React's documented way to adjust state when a prop changes
  // is a state comparison in the render body, and that is exactly what these
  // two are doing.
  const [hydratedTenantId, setHydratedTenantId] = useState<string | null>(null)
  const [completedOnMount, setCompletedOnMount] = useState<boolean | null>(null)
  // Still a ref: it is read and written only inside the persistence effect
  // below, which is where refs belong.
  const lastPersistedStepRef = useRef<OnboardingStepId | null>(null)

  if (completedOnMount === null && !tenantLoading && currentTenant) {
    setCompletedOnMount(!!currentTenant.onboardingCompletedAt)
  }

  /* ── Hydration from tenant on first ready render ────────────────── */

  if (hydratedTenantId !== (currentTenant?.id ?? null) && currentTenant?.id) {
    setHydratedTenantId(currentTenant.id)

    // Role hand-off: a person who arrives with a role in mind has
    // sessionStorage('liftoff.pending_onboarding_path') set to 'B' and a URL
    // that carries ?role=.
    //
    // Path B no longer jumps anywhere — both paths run the same steps. All the
    // path decides now is where completion lands, so the flip is a
    // relabel rather than a navigation. We do it here, not before the
    // navigation, because doing it earlier races against AuthContext's tenant
    // fetch and can skip the PATCH silently.
    let pendingPath: 'A' | 'B' | null = null
    try {
      const p = sessionStorage.getItem(PENDING_ONBOARDING_PATH_KEY)
      if (p === 'A' || p === 'B') pendingPath = p
    } catch { /* private-mode fallback */ }
    const urlRole = searchParams.get('role')

    const tenantPath = currentTenant.onboardingPath ?? 'A'
    const tenantStepId = currentTenant.onboardingStepId ?? 'welcome'

    setPath(pendingPath === 'B' && !currentTenant.onboardingCompletedAt ? 'B' : tenantPath)
    setStepId(tenantStepId)

    // Stash the role so completion can hand it to the gallery. Kept
    // in sessionStorage rather than on the tenant so it survives a reload
    // without depending on onboarding_hire_input, which is being dropped.
    if (urlRole) {
      try { sessionStorage.setItem(PENDING_HERO_ROLE_KEY, urlRole) } catch { /* private-mode fallback */ }
    }

    setWorkspaceName(currentTenant.name)
    setPersona(account?.persona ?? null)

    // Clear the path signal — single-use.
    try { sessionStorage.removeItem(PENDING_ONBOARDING_PATH_KEY) } catch { /* private-mode fallback */ }
  }

  /* ── PATCH persistence (debounced via the queryClient mutation) ─── */

  useEffect(() => {
    if (previewMode || !currentTenant?.id) return
    // Nothing persisted yet this session means the tenant's own step IS the
    // baseline, so hydrating from it does not immediately PATCH it back. That
    // used to be arranged by seeding this ref during render, which a ref may
    // not be written in.
    if (stepId === (lastPersistedStepRef.current ?? currentTenant.onboardingStepId ?? 'welcome')) return
    lastPersistedStepRef.current = stepId
    void doUpdateTenant({
      tenantId: currentTenant.id,
      onboardingStepId: stepId,
      onboardingPath: path,
    })
    // onboardingStepId is a dependency because the guard above reads it. The
    // effect re-running when the server's value changes is correct and cheap:
    // the guard returns early when the two already agree.
  }, [stepId, path, currentTenant?.id, currentTenant?.onboardingStepId, previewMode, doUpdateTenant])

  /* ── Step-entry analytics (v2 schema) ───────────────────────────── */
  // Fires `onboarding_step_entered` on every transition into a new stepId,
  // including the very first render. `resumed` is true if the tenant
  // already had a non-default step_id persisted (i.e., user is returning
  // mid-flow). Path ordinal supports funnel analysis across both paths.
  useEffect(() => {
    if (!currentTenant?.id) return
    // `resumed` is true ONLY for the very first step_entered event after a
    // tenant hydration that landed on a non-welcome step — i.e., the user
    // is picking up where they left off. After the first emit the flag is
    // permanently false because subsequent step transitions are user-driven
    // navigation, not resume.
    const resumed = firstStepEmitRef.current && stepId !== 'welcome'
    firstStepEmitRef.current = false
    trackOnboarding('onboarding_step_entered', {
      path,
      step_id: stepId,
      step_ordinal: pathOrdinal(path, stepId),
      tenant_id: currentTenant.id,
      resumed,
    })
    stepEnteredAtRef.current = Date.now()
  }, [stepId, path, currentTenant?.id])

  /* ── Gates (post-hooks) ─────────────────────────────────────────── */

  if (tenantLoading) {
    return <div className="loading-screen"><div className="loading-spinner" /></div>
  }
  if (!currentTenant) return <ErrorState variant="error" onRetry={refreshTenants} />
  if (currentRole !== 'owner') return <Navigate to="/dashboard" replace />
  if (!previewMode && completedOnMount === true) {
    // Same destination a finishing Path A user gets — the two must agree, or
    // revisiting /onboarding after completing it lands somewhere the CTA never
    // would.
    return <Navigate to="/dashboard" replace />
  }

  /* ── Navigation helpers ─────────────────────────────────────────── */

  const emitStepExit = (toStep: OnboardingStepId | null, direction: 'forward' | 'back') => {
    if (!currentTenant?.id) return
    trackOnboarding('onboarding_step_exited', {
      path,
      step_id: stepId,
      next_step_id: toStep,
      direction,
      dwell_ms: Date.now() - stepEnteredAtRef.current,
      tenant_id: currentTenant.id,
    })
  }

  const goToStep = (next: OnboardingStepId) => {
    emitStepExit(next, 'forward')
    setStepId(next)
  }
  const goNext = () => {
    const next = nextStepId(path, stepId)
    emitStepExit(next, 'forward')
    setStepId(next)
  }
  const goBack = () => {
    const prev = prevStepId(path, stepId)
    emitStepExit(prev, 'back')
    setStepId(prev)
  }

  /* ── Step handlers ──────────────────────────────────────────────── */

  const handleWelcomeBegin = () => { goNext() }

  const handleWorkspaceNameContinue = async () => {
    const trimmed = workspaceName.trim()
    goNext()
    if (previewMode || !currentTenant?.id) return
    try {
      await doUpdateTenant({ tenantId: currentTenant.id, name: trimmed })
    } catch {
      showToast('Could not save workspace name. You can update it later in Settings.', 'error')
    }
  }

  const handlePersonaContinue = async () => {
    if (!persona) return
    goNext()
    if (previewMode) return
    try { await doUpdateAccount({ persona }) }
    catch { showToast('Could not save your selection. Please try again.', 'error') }
  }

  const handlePlanContinue = () => { goNext() }

  // Skip jumps the payment step outright rather than advancing one step, so a
  // user who declined to choose a plan is never shown a card form for a plan
  // they do not have. They reach the product unpaid; the paywall moves to the
  // moment they try to launch a team.
  const handlePlanSkip = () => {
    trackOnboarding('onboarding_plan_skipped', {
      path,
      tenant_id: currentTenant?.id ?? '',
    })
    // Clear any plan picked before backing out. Skipping is an explicit "not
    // now", and leaving a stale selection would send the back button from
    // `invite` to a payment form for a plan the user just declined.
    setPlan(null)
    goToStep('invite')
  }

  const handlePaymentComplete = () => { goNext() }

  /**
   * Ends onboarding. `invite` is the terminal step, so BOTH of its exits land
   * here: Continue (after the invites are sent) and the skip modal's
   * "Skip Invite". There is no screen after this one.
   *
   * This is the logic that used to sit behind the `all_set` "Start Liftoff"
   * button. Sharing one function between the two exits is the point — when it
   * lived on its own screen there was exactly one way to reach it, and now
   * there are two. Duplicating it would let one path complete onboarding while
   * the other only navigated, and a tenant that lands on /dashboard with
   * `onboarding_completed = false` is sent straight back into the wizard by the
   * dashboard gate.
   *
   * Async, and awaited by both callers, so the PATCH and the tenant refresh
   * finish before the navigation — the gate reads that refreshed state on
   * arrival.
   */
  const completeOnboarding = async () => {
    trackOnboarding('fused_onboarding_completed', {
      path,
      total_duration_ms: Date.now() - stepEnteredAtRef.current,
      tenant_id: currentTenant?.id ?? '',
    })
    if (currentTenant?.id && !previewMode) {
      await doUpdateTenant({
        tenantId: currentTenant.id,
        onboardingCompleted: true,
        onboardingStepId: 'invite',
      })
      await refreshTenants()
    }

    let heroRole: string | null = null
    try {
      heroRole = sessionStorage.getItem(PENDING_HERO_ROLE_KEY)
      sessionStorage.removeItem(PENDING_HERO_ROLE_KEY)
    } catch { /* private-mode fallback */ }

    // An owner who arrived from a coding tool's consent request goes back to
    // that request, not to the dashboard: the request was parked for them
    // and approves now that the workspace is set up.
    let pendingConsentRequestId: string | null = null
    try {
      pendingConsentRequestId = sessionStorage.getItem(PENDING_OAUTH_CONSENT_KEY)
      sessionStorage.removeItem(PENDING_OAUTH_CONSENT_KEY)
    } catch { /* private-mode fallback */ }
    if (pendingConsentRequestId) {
      navigate(`/oauth/consent?request_id=${encodeURIComponent(pendingConsentRequestId)}`)
      return
    }
    // The device-flow twin: the same code is offered again, and approves if
    // it is still inside its ten minutes (a code is never parked).
    let pendingDeviceCode: string | null = null
    try {
      pendingDeviceCode = sessionStorage.getItem(PENDING_DEVICE_ACTIVATION_KEY)
      sessionStorage.removeItem(PENDING_DEVICE_ACTIVATION_KEY)
    } catch { /* private-mode fallback */ }
    if (pendingDeviceCode) {
      navigate(`/activate?code=${encodeURIComponent(pendingDeviceCode)}`)
      return
    }

    navigate(completionDestination(path, heroRole))
  }

  const handleInviteFinish = () => { void completeOnboarding() }

  // Emits the pre-existing v1 `onboarding_invites_skipped` rather than a v2
  // twin: this is the same step the v1 wizard had, recovered, so the existing
  // event keeps its historical series continuous.
  //
  // Skipping still completes onboarding — the modal's CTA is a way out of the
  // step, not out of the wizard.
  const handleInviteSkip = () => {
    track('onboarding_invites_skipped', {})
    void completeOnboarding()
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  // Show the onboarding-level BackButton everywhere EXCEPT the cover (welcome).
  //
  // It used to be hidden on the terminal step too, because `all_set` was a
  // congratulations screen with nothing behind it worth returning to. `invite`
  // is terminal now but it is a real step the user may want to back out of --
  // to change a plan, say -- so the exception dies with the screen it was
  // written for.
  const showBackButton = stepId !== 'welcome'

  // Back from `invite` normally lands on `payment` — but a user who skipped at
  // the plan step never saw a payment screen and has no plan to pay for, so
  // stepping them onto it would be a dead end asking for a card for nothing.
  // Send them to `plan` instead, which is where they actually came from.
  const handleBackClick = () => {
    if (stepId === 'invite' && !plan) {
      emitStepExit('plan', 'back')
      setStepId('plan')
      return
    }
    goBack()
  }

  return (
    <div
      className={`onboarding onboarding--step-${stepId}${stepId === 'welcome' ? ' onboarding--cover' : ''}`}
      role="dialog"
      aria-modal="true"
    >
      {showBackButton && <BackButton onClick={handleBackClick} />}
      <OnboardingUserMenu />
      <div className="onboarding__body">
        {stepId === 'welcome' && (
          <WelcomeStep path={path} onBegin={handleWelcomeBegin} />
        )}
        {stepId === 'workspace_name' && (
          <WorkspaceNameStep
            value={workspaceName}
            onChange={setWorkspaceName}
            onContinue={handleWorkspaceNameContinue}
            canContinue={workspaceName.trim().length > 0}
          />
        )}
        {stepId === 'persona' && (
          <PersonaStep
            value={persona}
            onChange={setPersona}
            onContinue={handlePersonaContinue}
            canContinue={!!persona}
          />
        )}
        {stepId === 'plan' && (
          <PlanStep
            value={plan}
            onChange={setPlan}
            billingPeriod={billingPeriod}
            onBillingPeriodChange={setBillingPeriod}
            planOuValues={planOuValues}
            onPlanOuChange={(planId, value) =>
              setPlanOuValues((m) => ({ ...m, [planId]: value }))
            }
            onContinue={handlePlanContinue}
            canContinue={!!plan}
            onSkip={handlePlanSkip}
          />
        )}
        {stepId === 'payment' && (
          <PaymentStep
            selectedPlanId={plan}
            billingPeriod={billingPeriod}
            planOuValues={planOuValues}
            onContinue={handlePaymentComplete}
            previewMode={previewMode}
          />
        )}
        {stepId === 'invite' && (
          <InviteStep
            workspaceName={workspaceName}
            emailsRaw={inviteEmailsRaw}
            onEmailsChange={setInviteEmailsRaw}
            onFinish={handleInviteFinish}
            onSkip={handleInviteSkip}
            previewMode={previewMode}
          />
        )}
      </div>
    </div>
  )
}
