import { useEffect, lazy, Suspense, Component, type ErrorInfo, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router'
import { ProtectedRoute } from './components'
import { AuthProvider } from './contexts/AuthProvider'
import { ToastProvider } from './contexts/ToastProvider'
import { FeatureFlagsProvider } from './contexts/FeatureFlagsProvider'
import { QueryProvider } from './providers/QueryProvider'
import { trackPageView } from './lib/analytics'
import { isChunkLoadError, reloadForStaleChunk } from './lib/chunkReload'
import LoginPage from './pages/LoginPage'
import VerifyEmailPage from './pages/VerifyEmailPage'
import AuthActionPage from './pages/AuthActionPage'
import OAuthCallbackPage from './pages/OAuthCallbackPage'
import AccountDeletedPage from './pages/AccountDeletedPage'
const ActAsPage = lazy(() => import('./pages/ActAsPage'))
import ErrorState from './components/ErrorState'
import FullScreenLoader from './components/FullScreenLoader'
import { GlobalUnsubscribeHandler } from './components/GlobalUnsubscribeHandler'
import DelegationBanner from './components/DelegationBanner'
import { Navigate, useParams } from 'react-router'

// Lazy-loaded pages
const CLIAuthPage = lazy(() => import('./pages/CLIAuthPage'))
const OAuthConsentPage = lazy(() => import('./pages/OAuthConsentPage'))
const ActivatePage = lazy(() => import('./pages/ActivatePage'))
const CustomApiCapturePage = lazy(() => import('./pages/CustomApiCapturePage'))
const SignupApprovalPage = lazy(() => import('./pages/SignupApprovalPage'))
const SharePage = lazy(() => import('./pages/SharePage'))
const NotificationPage = lazy(() => import('./pages/NotificationPage'))
const AgentMcpPage = lazy(() => import('./pages/Dashboard/AgentMcpPage'))


// Simple redirect for invitation links - passes token to login page
function InvitationRedirect() {
  const { token } = useParams<{ token: string }>()
  return <Navigate to={`/login?invitation=${encodeURIComponent(token || '')}`} replace />
}

// Dashboard v2 (new experience) — lazy-loaded
const DashboardLayout = lazy(() => import('./pages/Dashboard/DashboardLayout'))
const DashboardOnboardingGate = lazy(() => import('./components/Dashboard/DashboardOnboardingGate'))
const DashboardHome = lazy(() => import('./pages/Dashboard/HomePage'))
const AgentsPage = lazy(() => import('./pages/Dashboard/AgentsPage'))
const AgentBuildPage = lazy(() => import('./pages/Dashboard/AgentBuildPage'))
const AgentExplorePage = lazy(() => import('./pages/Dashboard/AgentExplorePage'))
const AgentConnectPage = lazy(() => import('./pages/Dashboard/AgentConnectPage'))
const AgentClaudeCodePage = lazy(() => import('./pages/Dashboard/AgentClaudeCodePage'))
// Liftoff Switch — import an existing OpenClaw or Hermes setup.
const SwitchPage = lazy(() => import('./pages/Dashboard/SwitchPage'))
const SwitchLanding = lazy(() => import('./pages/Dashboard/SwitchWizard/SwitchLanding'))
const AgentCodexPage = lazy(() => import('./pages/Dashboard/AgentCodexPage'))
const ConnectorSuccess = lazy(() => import('./pages/Dashboard/AgentConnector/ConnectorSuccess'))
const AgentUpdateRoutePage = lazy(() => import('./pages/Dashboard/AgentUpdateRoutePage'))
const OversightPage = lazy(() => import('./pages/Dashboard/OversightPage'))
const ReviewQueuePage = lazy(() => import('./pages/Dashboard/ReviewQueuePage'))
const InsightsPage = lazy(() => import('./pages/Dashboard/InsightsPage'))
const ConnectionsPage = lazy(() => import('./pages/Dashboard/ConnectionsPage'))
const KnowledgePage = lazy(() => import('./pages/Dashboard/KnowledgePage'))
const SettingsPage = lazy(() => import('./pages/Dashboard/SettingsPage'))
const PricingPage = lazy(() => import('./pages/Dashboard/PricingPage'))
const ActivityPage = lazy(() => import('./pages/Dashboard/ActivityPage'))
const ReferPage = lazy(() => import('./pages/Dashboard/ReferPage'))
const TeamPlanPage = lazy(() => import('./pages/Dashboard/TeamPlanPage'))
const AgentWebhookPage = lazy(() => import('./pages/Dashboard/AgentWebhookPage'))
const AgentChatPage = lazy(() => import('./pages/Dashboard/AgentChatPage'))
const LiftoffPage = lazy(() => import('./pages/Dashboard/LiftoffPage'))
const OnboardingPage = lazy(() => import('./pages/Dashboard/OnboardingPage'))

// Dev-only routes — `lazy()` is constructed ONLY when `import.meta.env.DEV`
// is true, so Rollup's tree-shake eliminates the chunk entirely from prod
// builds. The conditional `{… && <Route …/>}` further guarantees the route
// is never registered in production.
const OnboardingPreviewRoute = import.meta.env.DEV
  ? lazy(() => import('./dev/OnboardingPreviewRoute'))
  : null
const PlanGatePreviewRoute = import.meta.env.DEV
  ? lazy(() => import('./dev/PlanGatePreviewRoute'))
  : null
const DistillLoadingPreviewRoute = import.meta.env.DEV
  ? lazy(() => import('./dev/DistillLoadingPreviewRoute'))
  : null
const TemplateDetailPreviewRoute = import.meta.env.DEV
  ? lazy(() => import('./dev/TemplateDetailPreviewRoute'))
  : null


// Runtime safety net: if a route component throws during render (e.g. a lazy
// chunk that fails to load, or a page that hits an unexpected runtime error),
// catch it here and render the shared ErrorState instead of blanking #root.
//
// Two behaviours beyond a plain boundary:
//   1. A failed lazy import (almost always a stale chunk after a deploy — this
//      tab outlived the build) triggers a one-shot reload to pull the fresh
//      manifest, rather than stranding the user on an error they can't clear.
//      Belt-and-suspenders with the `vite:preloadError` listener in main.tsx:
//      whichever fires first reloads; the shared guard stops the other from
//      reloading again.
//   2. On navigation to another route the error is cleared, so one broken page
//      no longer wedges every subsequent client-side navigation.
type BoundaryProps = { children: ReactNode; locationKey: string }
type BoundaryState = { hasError: boolean; reloading: boolean }

class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false, reloading: false }

  static getDerivedStateFromError(): Partial<BoundaryState> { return { hasError: true } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error)) {
      // Reload to fetch the current index.html + chunk map. The guard makes
      // this one-shot; if it returns false we've already tried, so fall through
      // to the visible error state instead of a blank, reloading page.
      if (reloadForStaleChunk()) {
        this.setState({ reloading: true })
        return
      }
    }
    console.error('Route render error:', error, info)
  }

  componentDidUpdate(prevProps: BoundaryProps) {
    if (this.state.hasError && prevProps.locationKey !== this.props.locationKey) {
      this.setState({ hasError: false, reloading: false })
    }
  }

  reset = () => this.setState({ hasError: false, reloading: false })

  render() {
    if (this.state.reloading) return null
    if (this.state.hasError) return <ErrorState variant="error" onRetry={this.reset} />
    return this.props.children
  }
}

// Feeds the current path in as a prop so the class boundary can reset itself
// when the user navigates away from an errored route.
function RouteErrorBoundaryWithReset({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <RouteErrorBoundary locationKey={pathname}>{children}</RouteErrorBoundary>
}

function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo(0, 0)
    trackPageView(pathname)
  }, [pathname])

  return null
}

function App() {
  useEffect(() => {
    const handleLoad = () => {
      requestAnimationFrame(() => {
        document.body.classList.add('page-loaded')
      })
    }

    if (document.readyState === 'complete') {
      handleLoad()
    } else {
      window.addEventListener('load', handleLoad)
    }

    const fallbackTimer = setTimeout(() => {
      document.body.classList.add('page-loaded')
    }, 3000)

    return () => {
      window.removeEventListener('load', handleLoad)
      clearTimeout(fallbackTimer)
    }
  }, [])

  return (
    <BrowserRouter>
      <FeatureFlagsProvider>
      <AuthProvider>
        <QueryProvider>
        <ToastProvider>
          <GlobalUnsubscribeHandler />
          <ScrollToTop />
          {/* Above the route tree on purpose: a support session can write, so
              the reminder of whose account this is must survive every
              navigation rather than belonging to any one page. */}
          <DelegationBanner />
          <Suspense fallback={null}>
          <RouteErrorBoundaryWithReset>
          <Routes>
          {/* The app has no public landing page: the first thing a
              visitor needs is a session. */}
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/action" element={<AuthActionPage />} />
          <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
          <Route path="/invitation/:token" element={<InvitationRedirect />} />
          <Route path="/account-deleted" element={<AccountDeletedPage />} />
          <Route path="/cli-auth" element={<ProtectedRoute><Suspense fallback={null}><CLIAuthPage /></Suspense></ProtectedRoute>} />
          {/* Support delegation entry. Protected because the ticket is only
              honoured for the platform admin it was issued to, so the operator
              has to be signed in as themselves for it to work at all. */}
          <Route path="/act-as" element={<ProtectedRoute><Suspense fallback={<FullScreenLoader />}><ActAsPage /></Suspense></ProtectedRoute>} />
          <Route path="/oauth/consent" element={<ProtectedRoute><Suspense fallback={null}><OAuthConsentPage /></Suspense></ProtectedRoute>} />
          <Route path="/activate" element={<ProtectedRoute><Suspense fallback={null}><ActivatePage /></Suspense></ProtectedRoute>} />
          {/* The capture link behind a custom API connection. Protected: the
              token is scoped to a workspace, every request carries it, and the
              permission is re-checked server-side at submit. ProtectedRoute
              also preserves the path as ?redirect= so a link opened while
              signed out still lands here afterwards. */}
          <Route path="/connections/capture/:token" element={<ProtectedRoute><Suspense fallback={<FullScreenLoader />}><CustomApiCapturePage /></Suspense></ProtectedRoute>} />
          <Route path="/signup-approval" element={<ProtectedRoute><Suspense fallback={null}><SignupApprovalPage /></Suspense></ProtectedRoute>} />
          <Route path="/share/:shareId" element={<ProtectedRoute><Suspense fallback={<FullScreenLoader />}><SharePage /></Suspense></ProtectedRoute>} />
          {/* Opaque destination for email and browser notifications. Protected
              like /share: ProtectedRoute preserves the path as ?redirect= so a
              notification clicked while signed out still lands on its thread
              after login. */}
          <Route path="/notification/:notificationId" element={<ProtectedRoute><Suspense fallback={<FullScreenLoader />}><NotificationPage /></Suspense></ProtectedRoute>} />
          {/* Onboarding — full-screen, top-level (not nested under /dashboard
              because it has no dashboard chrome and runs before the dashboard
              experience is unlocked). */}
          <Route path="/onboarding" element={
            <ProtectedRoute>
              <Suspense fallback={<FullScreenLoader />}>
                <OnboardingPage />
              </Suspense>
            </ProtectedRoute>
          } />
          {/* Dev-only preview at /dev/onboarding — renders OnboardingPage in
              previewMode so we can iterate on the wizard without resetting
              tenant state, sending real invites, or hitting Stripe. The
              conditional below tree-shakes to `false &&` in production. */}
          {OnboardingPreviewRoute && (
            <Route path="/dev/onboarding" element={
              <ProtectedRoute>
                <Suspense fallback={null}>
                  <OnboardingPreviewRoute />
                </Suspense>
              </ProtectedRoute>
            } />
          )}
          {/* Dev-only preview at /dev/plan-gate — drives the real PlanGate
              provider with a real 402 so the launch-time payment modal can be
              seen without an unentitled tenant. Tree-shakes to `false &&` in
              production, exactly as the route above does.

              ProtectedRoute is required, not decorative: choosing a plan swaps
              the picker for SubscribePaymentPanel, which the gate renders only
              when useTenant() has a tenant. Signed out there is no tenant, so
              the payment half silently renders nothing and the modal goes blank
              at exactly the step you opened this route to look at. Requiring a
              session makes the harness show both halves. */}
          {PlanGatePreviewRoute && (
            <Route path="/dev/plan-gate" element={
              <ProtectedRoute>
                <Suspense fallback={null}>
                  <PlanGatePreviewRoute />
                </Suspense>
              </ProtectedRoute>
            } />
          )}
          {/* Dev-only preview at /dev/distill-loading. Mounts the real
              LoadingStep and drives it with the real DistillStage union on a
              scripted timeline, so the distillation progress screen can be
              tuned without walking the builder to step 4 and running a real
              backend distillation for every look. Deliberately NOT wrapped in
              ProtectedRoute: LoadingStep is presentational and reads no tenant,
              so requiring a session would only add a login round trip.
              Tree-shakes to `false &&` in production like the routes above. */}
          {DistillLoadingPreviewRoute && (
            <Route path="/dev/distill-loading" element={
              <Suspense fallback={null}>
                <DistillLoadingPreviewRoute />
              </Suspense>
            } />
          )}
          {/* Dev-only preview at /dev/template-detail. Mounts the real
              DetailStep on a real catalog template so the inline editing on
              "What they do" can be exercised without a login and four clicks
              into the hire wizard. Not wrapped in ProtectedRoute for the same
              reason as the route above: DetailStep reads no tenant, and its one
              query is already gated on an auth session, so requiring one would
              buy nothing but a round trip. Tree-shakes to `false &&` in
              production. */}
          {TemplateDetailPreviewRoute && (
            <Route path="/dev/template-detail" element={
              <Suspense fallback={null}>
                <TemplateDetailPreviewRoute />
              </Suspense>
            } />
          )}
          {/* Dashboard v2 routes (new experience) - Protected.
              DashboardOnboardingGate routes the owner of a not-yet-onboarded
              tenant to /onboarding before any dashboard chrome renders. */}
          <Route path="/dashboard" element={
            <ProtectedRoute>
              <Suspense fallback={<FullScreenLoader />}>
                <DashboardOnboardingGate>
                  <DashboardLayout />
                </DashboardOnboardingGate>
              </Suspense>
            </ProtectedRoute>
          }>
            <Route index element={<DashboardHome />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/build" element={<AgentBuildPage />} />
            <Route path="agents/explore" element={<AgentExplorePage />} />
            <Route path="agents/connect" element={<AgentConnectPage />} />
            <Route path="agents/claudecode" element={<AgentClaudeCodePage />} />
            {/* Liftoff Switch. The stage segment is optional: the wizard
                resumes from the migration record and rewrites the URL to
                match, so a bare /switch/openclaw lands on the right step. */}
            <Route path="switch" element={<Suspense fallback={null}><SwitchLanding /></Suspense>} />
            <Route path="switch/:source" element={<Suspense fallback={null}><SwitchPage /></Suspense>} />
            <Route path="switch/:source/:stage" element={<Suspense fallback={null}><SwitchPage /></Suspense>} />
            <Route path="agents/claudecode/success" element={<ConnectorSuccess client="claude" />} />
            <Route path="agents/codex" element={<AgentCodexPage />} />
            <Route path="agents/codex/success" element={<ConnectorSuccess client="codex" />} />
            <Route path="agents/update" element={<AgentUpdateRoutePage />} />
            <Route path="agents/update/webhook" element={<AgentWebhookPage />} />
            <Route path="agents/plan" element={<TeamPlanPage />} />
            <Route path="agents/mcp" element={<Suspense fallback={null}><AgentMcpPage /></Suspense>} />
            <Route path="agents/chat" element={<AgentChatPage />} />
            <Route path="liftoff" element={<Suspense fallback={null}><LiftoffPage /></Suspense>} />
            <Route path="oversight" element={<OversightPage />} />
            <Route path="review" element={<ReviewQueuePage />} />
            <Route path="insights" element={<InsightsPage />} />
            <Route path="connections" element={<ConnectionsPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="settings">
              <Route index element={<Navigate to="profile" replace />} />
              <Route path=":tab" element={<SettingsPage />} />
            </Route>
            <Route path="pricing" element={<PricingPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="refer" element={<Suspense fallback={null}><ReferPage /></Suspense>} />
          </Route>

          {/* 404 catch-all */}
          <Route path="*" element={<ErrorState variant="notFound" />} />
        </Routes>
          </RouteErrorBoundaryWithReset>
        </Suspense>
        </ToastProvider>
        </QueryProvider>
      </AuthProvider>
      </FeatureFlagsProvider>
    </BrowserRouter>
  )
}

export default App


