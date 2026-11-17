import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTenant } from '../hooks/useTenant'
import { resolveNotificationLink, type NotificationLinkResolution } from '../services/notificationLinks'
import { track } from '../lib/analytics'
import ErrorState from '../components/ErrorState'
import FullScreenLoader from '../components/FullScreenLoader'

// /notification/:notificationId — resolves an opaque link from an email or a
// browser notification to its destination and forwards there, switching the
// active workspace first when needed.
//
// The same two-phase shape as SharePage, for the same reasons: switchTenant is
// a silent no-op when the target workspace is missing from the loaded list, so
// phase 1 resolves the link and phase 2 activates the workspace (refreshing the
// tenant list once when the membership is newer than this session) and
// navigates ONLY after currentTenant actually equals the target.
//
// The backend returns the same 404 for unknown ids, non-members, and links
// whose destination has since gone, so the only failure state is "could not
// open".
// Where each platform chat surface lives. Agent chat is not here: it is the
// one destination that also needs an agent id in router state.
const PLATFORM_CHAT_ROUTES: Record<'liftoff' | 'insights' | 'team_plan', string> = {
  liftoff: '/dashboard/liftoff',
  insights: '/dashboard/insights',
  team_plan: '/dashboard/agents/plan',
}

export default function NotificationPage() {
  const { notificationId } = useParams<{ notificationId: string }>()
  const navigate = useNavigate()
  const { currentTenant, tenants, tenantLoading, switchTenant, refreshTenants } = useTenant()
  const [target, setTarget] = useState<NotificationLinkResolution | null>(null)
  const [failed, setFailed] = useState(false)
  // Local completion flag for the one-shot tenant refresh: refreshTenants
  // swallows errors and can finish without any context state change, so the
  // effect below must have its own state to re-run on.
  const [refreshDone, setRefreshDone] = useState(false)
  const resolvingRef = useRef(false)
  const refreshTriedRef = useRef(false)
  const switchRequestedRef = useRef(false)

  // Phase 1: resolve the link id. Waits for the tenant list so phase 2 can
  // trust it; the ref guards StrictMode double-fire.
  useEffect(() => {
    if (tenantLoading || resolvingRef.current || !notificationId) return
    resolvingRef.current = true
    void (async () => {
      try {
        const link = await resolveNotificationLink(notificationId)
        track('notification_link_opened', {
          destination: link.destination,
          surface: link.destination === 'chat' ? link.surface : undefined,
        })
        setTarget(link)
      } catch {
        setFailed(true)
      }
    })()
  }, [tenantLoading, notificationId])

  // Phase 2: make the link's workspace active, then navigate.
  useEffect(() => {
    if (!target || failed) return
    if (currentTenant?.id === target.tenantId) {
      // Internal agent/thread ids stay out of the address bar and browser
      // history: the notification URL is the only public artifact. The chat page
      // reads both from router state, exactly as it does for a share link.
      if (target.destination === 'chat') {
        // Each chat surface is its own page. Only agent chat needs the AI
        // team's id alongside the thread; the three platform chats have no
        // agent at all, which is why they are a separate branch rather than a
        // route lookup on one shape.
        if (target.surface === 'agent') {
          navigate('/dashboard/agents/chat', {
            state: { agentId: target.agentId, threadId: target.threadId },
            replace: true,
          })
          return
        }
        navigate(PLATFORM_CHAT_ROUTES[target.surface], {
          state: { threadId: target.threadId },
          replace: true,
        })
        return
      }
      navigate('/dashboard/review', { replace: true })
      return
    }
    if (tenants.some((t) => t.id === target.tenantId)) {
      if (!switchRequestedRef.current) {
        switchRequestedRef.current = true
        switchTenant(target.tenantId)
        // currentTenant updates → this effect re-runs → navigate above.
      }
      return
    }
    // Membership is confirmed by the backend but missing from this session's
    // list (invited after login): refresh once, then re-evaluate. refreshDone
    // is set in finally so this effect re-runs even when refreshTenants
    // failed or completed without changing any context state.
    if (!refreshTriedRef.current) {
      refreshTriedRef.current = true
      void refreshTenants().finally(() => setRefreshDone(true))
      return
    }
    if (!refreshDone) return // refresh still in flight
    // Failure is only knowable once the refresh has come back, so this cannot
    // be decided during a render: every earlier branch either navigates,
    // switches workspace or waits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFailed(true)
  }, [target, failed, refreshDone, currentTenant, tenants, switchTenant, refreshTenants, navigate])

  if (failed) {
    return (
      <ErrorState
        variant="error"
        title="This notification could not be opened"
        subtitle="It may have been removed, or it belongs to a workspace you are not a member of."
        buttonLabel="Go to Dashboard"
        onRetry={() => navigate('/dashboard')}
      />
    )
  }
  return <FullScreenLoader />
}
