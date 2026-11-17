// Routes the owner of a not-yet-onboarded tenant to /onboarding before the
// dashboard ever renders. Wrapped around DashboardLayout in App.tsx so any
// /dashboard/* URL is gated.
//
// Gate logic is delegated to the pure `decideGate` function in
// `./onboardingGateDecision` so it can be unit-tested with no provider /
// hook fixture. This component is a thin shell that wires
// useAuth / useLocation into decideGate and acts on the returned
// GateDecision.
//
// Zero-flicker contract: while tenant data is hydrating, render a neutral
// loading screen — never the dashboard chrome. The dashboard only renders
// once we know the active tenant is fully onboarded (or the user is not the
// owner — members and admins inherit an already-onboarded workspace).
//
// Degraded-state contract: if tenant loading has settled but there is no
// active tenant, surface an error state — never render DashboardLayout
// without a tenant context.

import { Navigate, useLocation } from 'react-router'
import { useEffect, useRef, useMemo } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useUpdateTenant } from '../../hooks/useTenant'
import ErrorState from '../ErrorState'
import FullScreenLoader from '../FullScreenLoader'
import { decideGate } from './onboardingGateDecision'

interface Props {
  children: React.ReactNode
}

export default function DashboardOnboardingGate({ children }: Props) {
  const { currentTenant, currentRole, tenantLoading, refreshTenants } = useAuth()
  const location = useLocation()
  const { mutateAsync: doUpdateTenant } = useUpdateTenant()

  // Dev-only escape hatch: `npm run dev` sets VITE_DEV_BYPASS_ONBOARDING_GATE=true
  // so localhost iteration on the dashboard never gets routed through the
  // wizard. Run `npm run dev:onboarding` (which omits the env var) when you
  // actually want to test the onboarding flow itself. The `import.meta.env.DEV`
  // guard tree-shakes the whole branch out of production bundles.
  const devBypassOnboarding =
    import.meta.env.DEV &&
    import.meta.env.VITE_DEV_BYPASS_ONBOARDING_GATE === 'true'

  // Memoized because the effect below is keyed on it: decideGate returns a
  // fresh object every call, which would re-run the PATCH guard every render.
  const decision = useMemo(
    () => devBypassOnboarding
      ? ({ kind: 'render_children' } as const)
      : decideGate({
          tenantLoading,
          currentTenant,
          currentRole,
          pathname: location.pathname,
        }),
    [devBypassOnboarding, tenantLoading, currentTenant, currentRole, location.pathname],
  )

  // Idempotency-guarded PATCH for the mark_path_and_go_onboarding branch.
  // Keyed by tenant.id + path + stepId so the PATCH fires at most once per
  // (tenant, decision) pair — even if refreshTenants is slow to propagate.
  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (decision.kind !== 'mark_path_and_go_onboarding') return
    if (!currentTenant?.id) return
    const key = `${currentTenant.id}:${decision.path}:${decision.stepId}`
    if (markedRef.current === key) return
    markedRef.current = key
    // Writes path + step only. This used to seed onboarding_hire_input.role
    // from the hero's ?role= too; the hire left onboarding (ADR-050) and that
    // column is being dropped, so a writer here would 42703 in the window
    // between the drop migration and the new revision. The hero role now
    // travels in sessionStorage and is consumed when onboarding completes.
    void doUpdateTenant({
      tenantId: currentTenant.id,
      onboardingPath: decision.path,
      onboardingStepId: decision.stepId,
    }).then(() => refreshTenants())
  }, [decision, currentTenant?.id, doUpdateTenant, refreshTenants])

  switch (decision.kind) {
    case 'show_loading':
      return <FullScreenLoader />
    case 'show_error':
      return <ErrorState variant="error" onRetry={refreshTenants} />
    case 'go_dashboard':
      return <Navigate to="/dashboard" replace />
    case 'go_onboarding':
      return <Navigate to="/onboarding" replace />
    case 'mark_path_and_go_onboarding':
      return <Navigate to="/onboarding" replace />
    case 'render_children':
      return <>{children}</>
  }
}
