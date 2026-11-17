import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { applyActionCode } from 'firebase/auth'
import { auth } from '../config/firebase'
import { useAuth } from '../contexts/AuthContext'
import Button from '../components/Button'
import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react'
import LiftoffLogo from '../assets/logo.svg?react'
import { track } from '../lib/analytics'
import './LoginPage.css'

type Status = 'working' | 'success' | 'error'

// Custom Firebase email-action handler, served on our own domain so the
// verification email never links to the project's *.firebaseapp.com handler.
// The backend rewrites Firebase's generated link to /auth/action?mode=...&
// oobCode=...; this page applies that single-use code with applyActionCode().
export default function AuthActionPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { reloadUser } = useAuth()

  const mode = searchParams.get('mode')
  const oobCode = searchParams.get('oobCode')

  const [status, setStatus] = useState<Status>('working')
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    async function run() {
      if (mode !== 'verifyEmail' || !oobCode) {
        setStatus('error')
        return
      }
      try {
        await applyActionCode(auth, oobCode)
        track('email_verification_completed', {})
        // If this device holds the session, refresh it (creates the backend
        // account now that the email is verified). On another device there is
        // no session — the original tab's polling detects the verification.
        await reloadUser()
        setStatus('success')
      } catch {
        setStatus('error')
      }
    }
    run()
  }, [mode, oobCode, reloadUser])

  // On success, auto-advance after a short pause so the user does not have to
  // tap Continue.
  useEffect(() => {
    if (status !== 'success') return
    const t = setTimeout(() => {
      navigate(auth.currentUser ? '/dashboard' : '/login', { replace: true })
    }, 5000)
    return () => clearTimeout(t)
  }, [status, navigate])

  return (
    <div className="login-page">
      <Link to="/" className="login-back" aria-label="Back to home">
        <ArrowLeftIcon width={24} height={24} />
      </Link>
      <div className="login-container">
        <Link to="/" className="login-logo">
          <LiftoffLogo />
        </Link>

        {status === 'working' && (
          <>
            <h1 className="login-title">Verifying Your Email</h1>
            <p className="login-subtitle">
              One moment while we confirm your email address.
            </p>
            <div className="loading-spinner" />
          </>
        )}

        {status === 'success' && (
          <>
            <h1 className="login-title">Email Verified</h1>
            <p className="login-subtitle">
              Your email address has been confirmed. You can continue to Liftoff.
            </p>
            <div className="login-form">
              <Button
                type="button"
                variant="secondary"
                className="login-submit"
                onClick={() => navigate(auth.currentUser ? '/dashboard' : '/login', { replace: true })}
              >
                Continue
              </Button>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <h1 className="login-title">Link Expired</h1>
            <p className="login-subtitle">
              This verification link is invalid or has already been used. Sign in to request a new one.
            </p>
            <div className="login-form">
              <Button
                type="button"
                variant="secondary"
                className="login-submit"
                onClick={() => navigate('/login', { replace: true })}
              >
                Sign In
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
