import { Navigate, useLocation } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import { isDelegating } from '../lib/supportDelegation'
import ErrorState from './ErrorState'
import FullScreenLoader from './FullScreenLoader'

interface ProtectedRouteProps {
  children: React.ReactNode
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, account, loading, backendConnected } = useAuth()
  const location = useLocation()

  if (loading) {
    return <FullScreenLoader />
  }

  if (!user) {
    // Preserve where they were headed so login returns them there instead of
    // dropping them on the dashboard (LoginPage honors ?redirect=<path> plus any
    // extra query params). Matters most for deep links from outside the app —
    // e.g. a generated-file link opened from Slack/Teams.
    const isRoot = location.pathname === '/' || location.pathname === '/login'
    const to = isRoot
      ? '/login'
      : `/login?redirect=${encodeURIComponent(location.pathname)}` +
        (location.search ? `&${location.search.slice(1)}` : '')
    return <Navigate to={to} replace />
  }

  // Email must be verified before entering the app. Google, passkey, and all
  // existing accounts carry emailVerified === true; only an unverified
  // email/password signup is stopped and sent to the verification page.
  //
  // Skipped during a support delegation session. `user` is the Firebase user,
  // which stays the OPERATOR throughout: their credential is never swapped.
  // Applying their verification state to a tab showing somebody else's
  // workspace decides nothing useful and would strand an operator whose own
  // email happens to be unverified.
  //
  // Known limitation, not a fix: this does not reproduce the customer's own
  // verify-email wall either. Their state is a Firebase token property and we
  // hold no copy of it, so a support session cannot currently see that
  // particular screen. See docs/support-delegation-plan.md section 4.5.
  if (!user.emailVerified && !isDelegating()) {
    return <Navigate to="/verify-email" replace />
  }

  if (!backendConnected) {
    return <ErrorState variant="error" />
  }

  if (!account) {
    return <FullScreenLoader />
  }

  // Signup is open (the `*` entry on the backend's allow-list), so no account
  // is denied. Should the list ever close again, a denied person lands on the
  // home page rather than a dead route: the invite-request page is retired.
  if (account.accessGranted === false) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
