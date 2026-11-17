import { useState, useEffect, useRef, Suspense } from 'react'
import { Outlet, useNavigate } from 'react-router'
import { Sidebar } from '../../components'
import { useBillingOverview } from '../../hooks/useBilling'
import HamburgerIcon from '../../assets/icons/hamburger.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import { track } from '../../lib/analytics'
import { PlanGateProvider } from '../../components/Dashboard/PlanGate'
import { usePushTokenSync } from '../../hooks/usePushTokenSync'
import { DashboardBanner } from '../../components/Dashboard/DashboardBanner'
import { NotificationPermissionBanner } from '../../components/Dashboard/NotificationPermissionBanner'
import './DashboardLayout.css'

function PaymentBlockedBanner() {
  const navigate = useNavigate()
  const { data: billing } = useBillingOverview()
  const shownRef = useRef(false)

  useEffect(() => {
    if (!billing?.executionBlocked || shownRef.current) return
    shownRef.current = true
    track('payment_blocked_banner_shown', { outstanding_balance_usd: billing.outstandingBalanceUsd ?? 0 })
  }, [billing?.executionBlocked, billing?.outstandingBalanceUsd])

  if (!billing?.executionBlocked) return null

  const balancePart = billing.outstandingBalanceUsd > 0
    ? ` your $${billing.outstandingBalanceUsd.toFixed(2)} balance is`
    : ` your balance is`

  // Deliberately no dismiss control. Hiding this does not make the workspace
  // start running again, and `critical` is the tone that says so.
  return (
    <DashboardBanner
      tone="critical"
      message={`Your agents are unable to run until${balancePart} resolved.`}
      ctaLabel="Update Payment Method"
      onCta={() => {
        track('payment_blocked_cta_clicked', {})
        navigate('/dashboard/settings/billing?openPaymentModal=true')
      }}
    />
  )
}

/**
 * The same stop, a different cause, and therefore a different way out.
 *
 * PaymentBlockedBanner offers to update the payment method, which is the remedy
 * when a charge failed and no remedy at all when the card is fine and the
 * workspace has simply used everything it bought. That workspace has two ways
 * forward — a larger plan, or more credit — so the button goes to the page
 * carrying both rather than picking one.
 */
function OutOfOperatingUnitsBanner() {
  const navigate = useNavigate()
  const shownRef = useRef(false)

  useEffect(() => {
    if (shownRef.current) return
    shownRef.current = true
    track('out_of_operating_units_banner_shown', {})
  }, [])

  // No dismiss control, for the same reason its sibling has none: hiding this
  // does not make the workspace start running again.
  return (
    <DashboardBanner
      tone="critical"
      message="Your agents are unable to run due to insufficient Operating Units for your workspace."
      ctaLabel="Go to Billing"
      onCta={() => {
        track('out_of_operating_units_cta_clicked', {})
        navigate('/dashboard/settings/billing')
      }}
    />
  )
}

/**
 * One notice, priority ordered.
 *
 * Two stacked banners read as a broken page, and the blocking problem has to
 * win: a workspace that cannot run outranks an offer to turn notifications on.
 * useBillingOverview is already cached by the query client, so asking here and
 * again inside PaymentBlockedBanner costs one request, not two.
 *
 * `zero_prepaid_balance` is matched specifically rather than "suspended and
 * pre-pay". The other pre-pay reason, `auto_reload_failed`, means a declined
 * card and not an empty wallet, so it keeps the banner whose button fixes the
 * card.
 */
function DashboardNoticeSlot() {
  const { data: billing } = useBillingOverview()
  if (billing?.executionBlocked) {
    return billing.suspendedReason === 'zero_prepaid_balance'
      ? <OutOfOperatingUnitsBanner />
      : <PaymentBlockedBanner />
  }
  return <NotificationPermissionBanner />
}

export default function DashboardLayout() {
  // Repairs a rotated FCM token once per session for anyone who already has
  // browser notifications on. Never prompts.
  usePushTokenSync()

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const closeMobileMenu = () => {
    setMobileMenuOpen(false)
  }

  // PlanGateProvider wraps the whole dashboard so any page can raise the
  // launch-time payment gate off a server 402 — the gallery's Launch Now, the
  // builder's, and Start Team on the teams list all need it.
  return (
    <PlanGateProvider>
    <div className={`dashboard-layout ${sidebarCollapsed ? 'dashboard-layout--collapsed' : ''}`}>
      {/* Mobile header */}
      <header className="dashboard-mobile-header">
        <button
          className="dashboard-mobile-header__toggle"
          onClick={() => {
            const next = !mobileMenuOpen
            if (next) track('sidebar_mobile_menu_opened', {})
            setMobileMenuOpen(next)
          }}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? (
            <XIcon width="24" height="24" />
          ) : (
            <HamburgerIcon width="24" height="24" />
          )}
        </button>
      </header>

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          className="dashboard-mobile-overlay"
          role="presentation"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <Sidebar
        isCollapsed={sidebarCollapsed}
        onToggle={() => {
          const next = !sidebarCollapsed
          track('sidebar_collapsed_toggled', { collapsed: next })
          setSidebarCollapsed(next)
        }}
        isMobileOpen={mobileMenuOpen}
        onNavigate={closeMobileMenu}
      />
      <main className="dashboard-main">
        <DashboardNoticeSlot />
        <Suspense fallback={<div className="dashboard-content-loading"><div className="loading-spinner" /></div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
    </PlanGateProvider>
  )
}
