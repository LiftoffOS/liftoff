import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import Button from '../components/Button'
import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react'
import LiftoffLogo from '../assets/logo.svg?react'
import { track } from '../lib/analytics'
import './LoginPage.css'

const RESEND_COOLDOWN_SECONDS = 45

// Interstitial shown to a logged-in but not-yet-verified email/password user.
// ProtectedRoute redirects unverified users here; LoginPage routes new signups
// here directly. Verification happens only by clicking the link in the email —
// this page polls in the background and advances automatically once Firebase
// reports the address as verified. Google / passkey / already-verified users
// never land here (their emailVerified is already true); if one does, we
// forward them straight on.
export default function VerifyEmailPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, loading, reloadUser, sendVerificationEmail, signOut } = useAuth()
  const { showToast } = useToast()

  const invitation = searchParams.get('invitation')
  const redirect = searchParams.get('redirect')

  const [cooldown, setCooldown] = useState(0)

  // reloadUser is recreated each render; hold the latest in a ref so the poll
  // interval always calls the current one without resetting on every render.
  const reloadRef = useRef(reloadUser)
  useEffect(() => {
    reloadRef.current = reloadUser
  }, [reloadUser])

  // Where to send the user once verified. Preserve an invitation by routing
  // back through /login (its effect accepts the invitation now that the user
  // is verified and synced); otherwise honour ?redirect or go to /dashboard.
  const goToDestination = useCallback(() => {
    if (invitation) {
      const params = new URLSearchParams({ invitation })
      if (redirect) params.set('redirect', redirect)
      navigate(`/login?${params.toString()}`, { replace: true })
    } else {
      navigate(redirect || '/dashboard', { replace: true })
    }
  }, [invitation, redirect, navigate])

  const checkVerified = useCallback(async (): Promise<boolean> => {
    const verified = await reloadRef.current()
    if (verified) {
      track('email_verification_completed', {})
      goToDestination()
    }
    return verified
  }, [goToDestination])

  // No user (signed out, or arrived without a session) -> login. Already
  // verified (e.g. navigated here by hand) -> straight to the destination.
  useEffect(() => {
    if (loading) return
    if (!user) {
      navigate('/login', { replace: true })
      return
    }
    if (user.emailVerified) {
      goToDestination()
    }
  }, [loading, user, goToDestination, navigate])

  // Poll for verification (the user clicks the link in another tab/device) and
  // re-check whenever the window regains focus.
  useEffect(() => {
    if (!user || user.emailVerified) return
    const id = setInterval(() => {
      void checkVerified()
    }, 4000)
    const onFocus = () => {
      void checkVerified()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [user, checkVerified])

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const handleResend = async () => {
    if (cooldown > 0) return
    try {
      await sendVerificationEmail()
      track('email_verification_resent', {})
      showToast('Verification email sent. Please check your inbox.', 'success')
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch {
      showToast('Could not send the email. Please try again in a moment.', 'error')
    }
  }

  const handleUseDifferent = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="login-page">
      <Link to="/" className="login-back" aria-label="Back to home">
        <ArrowLeftIcon />
      </Link>
      <div className="login-container">
        <Link to="/" className="login-logo">
          <LiftoffLogo />
        </Link>
        <h1 className="login-title">Confirm Your Email</h1>
        {/* Cap the width so the line wraps right after "email." on desktop,
            putting "Click it to continue." on its own line. The card is a
            centered flex column, so the narrower paragraph stays centered. */}
        <p className="login-subtitle" style={{ maxWidth: '270px' }}>
          We&apos;ve sent a verification link to your email. Click it to continue.
        </p>

        <div className="login-form">
          <Button
            variant="primary"
            className="login-submit"
            onClick={handleResend}
            disabled={cooldown > 0}
            type="button"
          >
            {cooldown > 0 ? `Resend email (${cooldown}s)` : 'Resend email'}
          </Button>
        </div>

        <div className="login-links">
          <button type="button" onClick={handleUseDifferent}>
            Use a different account
          </button>
        </div>
      </div>
    </div>
  )
}
