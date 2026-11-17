import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { DashboardBanner } from './DashboardBanner'
import { useEnableBrowserNotifications } from '../../hooks/useBrowserNotifications'
import { useInternalAgents } from '../../hooks/useInternalAgents'
import {
  getPushPermissionState,
  type PushPermissionState,
} from '../../lib/pushNotifications'
import { dismissPrompt, isPromptDismissed } from '../../lib/notificationPrompt'
import { track } from '../../lib/analytics'

// The ask itself, whenever this browser has not granted permission. That
// includes somebody who has never opted in: browser notifications cannot be
// turned on from the server, so a notice that waits for the preference can
// never be the thing that gets them enabled.
//
// Scoped to the surfaces where being notified is the point, rather than every
// dashboard route, and held back until the workspace has at least one ACTIVE
// agent.
//
// Before that there is nothing that could ever send a notification, so the ask
// is an interruption attached to nothing, arriving while somebody is still
// trying to get set up. It is also the worst moment to spend the one permission
// prompt a browser will give us: three dismissals and Chrome embargoes the
// origin, and a denial cannot be re-asked from inside the page at all.
//
// Chat asks for itself, in its own words, naming the agent, so it is not
// listed here.

const HELP_ARTICLE = '/dashboard/support/settings/unblock-browser-notifications'

/** Prefixes where the ask earns its interruption. An allowlist rather than
 *  "everywhere except", so adding a surface is a decision somebody makes on
 *  purpose. The home page is matched exactly, separately below: as a prefix it
 *  would swallow every route in the dashboard.
 *
 *  Settings > Communication is here even though its Notification Delivery
 *  section can already turn this on. The section's toggle is the control; this
 *  is the thing that says the control is not currently doing anything, which is
 *  otherwise invisible on the one page somebody goes to specifically to check.
 *
 *  Chat is absent: NotificationPromptBar asks there, in its own words, naming
 *  the agent. */
const ASK_ON_ROUTE_PREFIXES = ['/dashboard/review', '/dashboard/settings/communication']

export function NotificationPermissionBanner() {
  const navigate = useNavigate()
  const location = useLocation()
  const enableNotifications = useEnableBrowserNotifications()
  // The same query the dashboard home already runs, so on that page this is a
  // cache read rather than a second request.
  const activeTeams = useInternalAgents({ status: 'active' })
  const [permission, setPermission] = useState<PushPermissionState>(() =>
    getPushPermissionState(),
  )
  const [dismissed, setDismissed] = useState(() => isPromptDismissed('dashboard'))
  // A ref, not state: this only guards a fire-once analytics call, and setting
  // state in the effect below would trigger a cascading render for nothing.
  // Same guard PaymentBlockedBanner uses.
  const shownRef = useRef(false)

  // Re-read BOTH on focus, not just permission.
  //
  // Each was read once at mount, which left this unable to notice its own
  // preconditions changing. Permission is owned by the browser and can be reset
  // from browser settings; the dismissal lives in sessionStorage and can be
  // cleared. Either one happening stranded the component in the decision it
  // made on first render: nothing shown, every underlying condition saying it
  // should show, and no way back except a full reload.
  useEffect(() => {
    const refresh = () => {
      setPermission(getPushPermissionState())
      setDismissed(isPromptDismissed('dashboard'))
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const path = location.pathname.replace(/\/$/, '')
  const onAskableSurface =
    path === '/dashboard' || ASK_ON_ROUTE_PREFIXES.some((r) => path.startsWith(r))

  // False while the query is still in flight, so the banner appears once the
  // answer is known rather than flashing in and then vanishing.
  const hasActiveTeam =
    (activeTeams.data?.pages?.flatMap((p) => p.internalAgents).length ?? 0) > 0

  const visible =
    onAskableSurface &&
    hasActiveTeam &&
    !dismissed &&
    (permission === 'default' || permission === 'denied')

  useEffect(() => {
    if (!visible || shownRef.current) return
    shownRef.current = true
    track('notification_permission_banner_shown', { permission })
  }, [visible, permission])

  const handleEnable = useCallback(async () => {
    track('notification_permission_enable_clicked', {})
    // Called straight from the click. Safari requires the permission request to
    // come from direct user interaction, so nothing may await before it.
    // Enabling is permission AND the delivery preference: the backend gates push
    // on the second, so granting alone would leave this looking on and sending
    // nothing.
    setPermission(await enableNotifications())
  }, [enableNotifications])

  const handleFix = useCallback(() => {
    track('notification_permission_help_clicked', {})
    navigate(HELP_ARTICLE)
  }, [navigate])

  const handleDismiss = useCallback(() => {
    track('notification_permission_banner_dismissed', { permission })
    dismissPrompt('dashboard')
    setDismissed(true)
  }, [permission])

  if (!visible) return null

  // Denied is unrecoverable in-page: nothing can re-prompt once the browser has
  // stored a block, so the CTA stops offering and starts explaining.
  if (permission === 'denied') {
    return (
      <DashboardBanner
        tone="quiet"
        message="Your browser is blocking notifications from Liftoff."
        ctaLabel="How To Fix"
        onCta={handleFix}
        onDismiss={handleDismiss}
      />
    )
  }

  return (
    <DashboardBanner
      tone="quiet"
      message="Liftoff needs your permission to send you updates from your agents."
      ctaLabel="Enable"
      onCta={() => void handleEnable()}
      onDismiss={handleDismiss}
    />
  )
}

export default NotificationPermissionBanner
