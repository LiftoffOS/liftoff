import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { TotpMultiFactorGenerator, getMultiFactorResolver, getRedirectResult, type MultiFactorResolver, type MultiFactorInfo } from 'firebase/auth'
import { auth } from '../config/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { isEmailDomainAllowed, domainNotAllowedMessage, DOMAIN_NOT_ALLOWED_CODE } from '../config/emailDomains'
import { getInvitationByToken, acceptInvitation } from '../services/tenants'
import { checkEmailExists, ApiError } from '../services/api'
import { getAccount } from '../services/account'
import Button from '../components/Button'
import ArrowLeftIcon from '../assets/icons/arrow-left.svg?react'
import LiftoffLogo from '../assets/logo.svg?react'
import { track } from '../lib/analytics'
import './LoginPage.css'
import { useAutoFocus } from '../hooks/useAutoFocus'

type AuthMode = 'signin' | 'signup' | 'reset'
type AuthStep = 'email' | 'password' | 'totp'

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

// Signup password policy: at least 8 characters, plus an uppercase letter, a
// lowercase letter, a number, and a special character. Enforced only on submit
// — describeMissingPassword builds a toast naming exactly what is missing.
interface PasswordChecks {
  length: boolean
  upper: boolean
  lower: boolean
  number: boolean
  special: boolean
}

const PASSWORD_REQUIREMENTS: { key: keyof PasswordChecks; missing: string }[] = [
  { key: 'length', missing: 'at least 8 characters' },
  { key: 'upper', missing: 'a capital letter' },
  { key: 'lower', missing: 'a lowercase letter' },
  { key: 'number', missing: 'a number' },
  { key: 'special', missing: 'a special character' },
]

function getPasswordChecks(password: string): PasswordChecks {
  return {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  }
}

// Returns a toast message naming everything the password is still missing, or
// null when it satisfies the full policy.
function describeMissingPassword(password: string): string | null {
  const checks = getPasswordChecks(password)
  const missing = PASSWORD_REQUIREMENTS.filter((r) => !checks[r.key]).map((r) => r.missing)
  if (missing.length === 0) return null
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(', ')}${missing.length > 2 ? ',' : ''} and ${missing[missing.length - 1]}`
  return `Password must have ${list}.`
}

export default function LoginPage() {
  const emailRef = useAutoFocus<HTMLInputElement>()
  const passwordRef = useAutoFocus<HTMLInputElement>()
  const totpRef = useAutoFocus<HTMLInputElement>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, account, loading, signInWithGoogle, signInWithEmail, signUpWithEmail, resetPassword, startConditionalPasskeyAuth, isConditionalUIAvailable, refreshAccount, refreshTenants, switchTenant } = useAuth()
  const { showToast } = useToast()
  const invitationToken = searchParams.get('invitation')
  const redirectParam = searchParams.get('redirect')

  // Build post-login destination, preserving extra query params (e.g., port for CLI auth)
  const getRedirectDestination = (syncedAccount: import('../services/account').Account | null): string => {
    if (syncedAccount?.accessGranted === false) return '/'
    if (redirectParam) {
      // Preserve other query params (e.g., ?redirect=/cli-auth&port=12345 → /cli-auth?port=12345)
      const extra = new URLSearchParams()
      searchParams.forEach((value, key) => {
        if (key !== 'redirect' && key !== 'invitation') extra.set(key, value)
      })
      const qs = extra.toString()
      return qs ? `${redirectParam}?${qs}` : redirectParam
    }
    return '/dashboard'
  }

  // Handle invitation after successful auth
  // syncedAccount is the fresh account from syncUserWithBackend (avoids stale closure)
  const handleInvitationAfterAuth = async (syncedAccount: import('../services/account').Account | null): Promise<void> => {
    if (!invitationToken) {
      navigate(getRedirectDestination(syncedAccount))
      return
    }

    try {
      const invitation = await getInvitationByToken(invitationToken)

      if (invitation.status === 'expired') {
        showToast(`This invitation to ${invitation.tenantName || 'the workspace'} has expired. Ask the admin to send a new one.`, 'error')
        navigate(syncedAccount?.accessGranted === false ? '/' : '/dashboard')
        return
      }

      if (invitation.status === 'revoked') {
        showToast('This invitation has been canceled.', 'error')
        navigate(syncedAccount?.accessGranted === false ? '/' : '/dashboard')
        return
      }

      if (invitation.status === 'accepted') {
        showToast(`You're already a member of ${invitation.tenantName}.`, 'error')
        navigate('/dashboard')
        return
      }

      // Accept the invitation, then refresh account so accessGranted reflects new membership (plan 2e)
      const result = await acceptInvitation(invitationToken)
      track('invitation_accepted', { tenant_id: result.tenantId })
      await refreshAccount()
      await refreshTenants()
      switchTenant(result.tenantId)
      showToast(`Welcome to ${invitation.tenantName}!`, 'success')
      navigate('/dashboard')
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showToast('This invitation link is not valid.', 'error')
      } else {
        showToast('Failed to process invitation. Please try again.', 'error')
      }
      navigate(syncedAccount?.accessGranted === false ? '/' : '/dashboard')
    }
  }

const [mode, setMode] = useState<AuthMode>('signin')
  const [step, setStep] = useState<AuthStep>('email')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)

  const [message, setMessage] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isCheckingEmail, setIsCheckingEmail] = useState(false)
  const [mfaResolver, setMfaResolver] = useState<MultiFactorResolver | null>(null)
  const [totpHint, setTotpHint] = useState<MultiFactorInfo | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [totpError, setTotpError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const hasNavigatedRef = useRef(false)
  const passkeyInitRef = useRef(false)

  // Navigate after auth — covers already-logged-in users, post-redirect sign-in,
  // and invitation token acceptance. signInWithRedirect lands back here and
  // onAuthStateChanged fires, setting user + account, which triggers this.
  useEffect(() => {
    if (!loading && user && account && !hasNavigatedRef.current) {
      hasNavigatedRef.current = true
      handleInvitationAfterAuth(account)
    }
  }, [loading, user, account]) // eslint-disable-line react-hooks/exhaustive-deps

  // Catch errors from the Google redirect (e.g. user cancelled, network error)
  useEffect(() => {
    getRedirectResult(auth).catch((err: { code?: string }) => {
      if (err.code) {
        showToast('Failed to sign in with Google. Please try again.', 'error')
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill email from invitation token
  useEffect(() => {
    if (invitationToken) {
      getInvitationByToken(invitationToken)
        .then((invitation) => {
          // Only fills an empty box, checked at the moment the answer lands
          // rather than when the request went out.
          if (invitation.email) {
            setEmail(current => current || invitation.email)
          }
        })
        .catch(() => {
          // Silently fail - user can still enter email manually
        })
    }
  }, [invitationToken])

  useEffect(() => {
    // Start conditional passkey authentication once on mount.
    // Guard with a ref because startConditionalPasskeyAuth is not memoized in
    // AuthContext, so it gets a new reference on every render — without the guard
    // this effect would re-run and trigger "A request is already pending" errors.
    if (passkeyInitRef.current) return
    passkeyInitRef.current = true

    const initConditionalAuth = async () => {
      const available = await isConditionalUIAvailable()
      if (available) {
        abortControllerRef.current = await startConditionalPasskeyAuth(
          async (syncedAccount) => {
            track('sign_in_started', { method: 'passkey_conditional' })
            track('sign_in_completed', { method: 'passkey_conditional', mfa_required: false })
            await handleInvitationAfterAuth(syncedAccount)
          },
          (error) => {
            track('sign_in_failed', { method: 'passkey_conditional', reason: error.message })
            console.error('Passkey auth error:', error)
          }
        )
      }
    }

    initConditionalAuth()

    return () => {
      abortControllerRef.current?.abort()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConditionalUIAvailable, startConditionalPasskeyAuth, navigate])

  const handleGoogleSignIn = async () => {
    setEmailError(null)
    setIsLoading(true)
    // Abort any pending passkey auth
    abortControllerRef.current?.abort()
    track('sign_in_started', { method: 'google' })
    try {
      await signInWithGoogle()
      track('sign_in_completed', { method: 'google', mfa_required: false })
      // Page redirects to Google OAuth — execution stops here
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'unknown'
      track('sign_in_failed', { method: 'google', reason: code })
      console.error('Sign in error:', err)
      // AuthProvider has already signed the rejected session out; say why
      // rather than showing the generic Google failure, and leave the person on
      // the login page at the email step.
      if (code === DOMAIN_NOT_ALLOWED_CODE) {
        showToast(domainNotAllowedMessage(), 'error')
        setStep('email')
      } else {
        showToast('Failed to sign in with Google. Please try again.', 'error')
      }
      setIsLoading(false)
    }
  }

  const handleEmailContinue = async (e: React.FormEvent) => {
    e.preventDefault()
    setEmailError(null)

    if (!isValidEmail(email)) {
      setEmailError('enter a valid email address')
      return
    }

    // Refuse a disallowed domain here, before the password step and before
    // checkEmailExists, so a build with the restriction on never turns the
    // login page into an account-existence oracle for outside addresses.
    if (!isEmailDomainAllowed(email)) {
      track('sign_in_failed', { method: 'email', reason: DOMAIN_NOT_ALLOWED_CODE })
      showToast(domainNotAllowedMessage(), 'error')
      setEmailError('use a company email address')
      return
    }

    if (mode === 'reset') {
      handleResetPassword()
      return
    }

    // Abort passkey auth when moving to password step
    abortControllerRef.current?.abort()

    setIsCheckingEmail(true)

    try {
      const { exists } = await checkEmailExists(email)
      setMode(exists ? 'signin' : 'signup')
      setStep('password')
    } catch (err) {
      // Don't silently fallback - show error (FE-003, BE-005)
      if (err instanceof ApiError) {
        if (err.status === 429) {
          showToast('Too many requests. Please wait a moment and try again.', 'error')
          setEmailError('too many requests')
        } else if (err.status >= 500) {
          // Server error - show message but allow user to proceed with default signin
          showToast('Could not verify email. Please try signing in.', 'error')
          setMode('signin')
          setStep('password')
        } else {
          showToast('Something went wrong. Please try again.', 'error')
        }
      } else {
        // Network error
        showToast('Network error. Please check your connection and try again.', 'error')
      }
    } finally {
      setIsCheckingEmail(false)
    }
  }

  const handleResetPassword = async () => {
    setEmailError(null)
    setMessage(null)
    setIsLoading(true)
    try {
      await resetPassword(email)
      track('password_reset_requested', {})
      showToast('Password reset email sent. Check your inbox.', 'success')
      setMode('signin')
      setStep('email')
    } catch (err) {
      console.error('Reset error:', err)
      showToast('Failed to send reset email. Please try again.', 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      if (mode === 'signup') {
        const missingMessage = describeMissingPassword(password)
        if (missingMessage) {
          showToast(missingMessage, 'error')
          setIsLoading(false)
          return
        }
        track('sign_in_started', { method: 'email' })
        await signUpWithEmail(email, password)
        track('sign_up_completed', { method: 'email' })
        // New accounts must verify their email before entering. Route to the
        // verification interstitial, preserving any invitation/redirect params
        // so the original destination resumes after verification.
        const params = new URLSearchParams()
        if (invitationToken) params.set('invitation', invitationToken)
        if (redirectParam) params.set('redirect', redirectParam)
        const qs = params.toString()
        navigate(qs ? `/verify-email?${qs}` : '/verify-email')
        return
      }

      track('sign_in_started', { method: 'email' })
      const syncedAccount = await signInWithEmail(email, password)
      track('sign_in_completed', { method: 'email', mfa_required: false })
      await handleInvitationAfterAuth(syncedAccount)
    } catch (err: unknown) {
      console.error('Auth error:', err)
      const firebaseError = err as { code?: string }

      // Handle MFA required
      if (firebaseError.code === 'auth/multi-factor-auth-required') {
        const resolver = getMultiFactorResolver(auth, err as Parameters<typeof getMultiFactorResolver>[1])
        const totpFactor = resolver.hints.find(hint => hint.factorId === 'totp')
        if (totpFactor) {
          setMfaResolver(resolver)
          setTotpHint(totpFactor)
          setStep('totp')
          setIsLoading(false)
          return
        }
      }

      let errorMessage = 'Something went wrong. Please try again.'
      switch (firebaseError.code) {
        case 'auth/invalid-email':
          errorMessage = 'Invalid email address'
          break
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
          errorMessage = 'Invalid email or password'
          break
        case 'auth/email-already-in-use':
          errorMessage = 'An account with this email already exists'
          break
        case 'auth/weak-password':
          errorMessage = 'Password must be at least 6 characters'
          break
        case DOMAIN_NOT_ALLOWED_CODE:
          // Reached when the address was allowed at the email step but the
          // build's allow-list no longer accepts it (a stale tab). Return to
          // the email step so the password field is not left waiting.
          errorMessage = domainNotAllowedMessage()
          setStep('email')
          break
      }
      track('sign_in_failed', { method: 'email', reason: firebaseError.code ?? errorMessage })
      showToast(errorMessage, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!mfaResolver || !totpHint) return
    setTotpError(null)
    setIsLoading(true)

    try {
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, totpCode)
      await mfaResolver.resolveSignIn(assertion)
      track('mfa_challenge_submitted', { success: true })
      track('sign_in_completed', { method: 'email', mfa_required: true })
      // TOTP resolves MFA — onAuthStateChanged fires async but account state
      // won't be updated in this closure yet. Fetch fresh account directly.
      const freshAccount = await getAccount()
      await handleInvitationAfterAuth(freshAccount)
    } catch (err) {
      track('mfa_challenge_submitted', { success: false })
      console.error('TOTP verification error:', err)
      setTotpError('Invalid code. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleBack = () => {
    if (step === 'totp') {
      setStep('password')
      setTotpCode('')
      setTotpError(null)
      setMfaResolver(null)
      setTotpHint(null)
      return
    }
    setStep('email')
    setPassword('')
  }

  const switchMode = (newMode: AuthMode) => {
    setMode(newMode)
    setStep('email')
    setEmailError(null)
    setMessage(null)
    setPassword('')
  }

  const getTitle = () => {
    if (step === 'totp') {
      return 'Two-factor authentication'
    }
    if (step === 'password') {
      return mode === 'signup' ? 'Create your account' : 'Welcome back'
    }
    switch (mode) {
      case 'signup': return 'Create your account'
      case 'reset': return 'Reset your password'
      default: return 'Welcome back'
    }
  }

  const getSubtitle = () => {
    if (step === 'totp') {
      return email
    }
    if (step === 'password') {
      return email
    }
    switch (mode) {
      case 'signup': return 'Sign up to get started'
      case 'reset': return 'Enter your email to receive a reset link'
      default: return 'Sign in to your account to continue'
    }
  }

  return (
    <div className="login-page">
      <Link to="/" className="login-back" aria-label="Back to home">
        <ArrowLeftIcon width={24} height={24} />
      </Link>
      <div className="login-container">
        <Link to="/" className="login-logo">
          <LiftoffLogo />
        </Link>

        <h1 className="login-title">{getTitle()}</h1>
        <p className="login-subtitle">{getSubtitle()}</p>

        {message && (
          <div className="login-success">
            {message}
          </div>
        )}

        {step === 'email' ? (
          <>
            {mode !== 'reset' && (
              <>
                <button
                  className="login-social"
                  onClick={handleGoogleSignIn}
                  disabled={isLoading || isCheckingEmail}
                >
                  <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
                    <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                  </svg>
                  {isLoading ? 'Please wait...' : 'Continue with Google'}
                </button>

                <div className="login-divider">
                  <span>or</span>
                </div>
              </>
            )}

            <form className="login-form" onSubmit={handleEmailContinue} noValidate>
              <div className="login-field">
                <label htmlFor="email">
                  Email
                  {emailError && <span className="login-field__error" id="email-error" role="alert"> ({emailError})</span>}
                </label>
                <input
                  type="email"
                  id="email"
                  className={emailError ? 'login-field__input--error' : ''}
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setEmailError(null); }}
                  placeholder="you@example.com"
                  required
                  disabled={isLoading || isCheckingEmail}
                  ref={emailRef}
                  autoComplete="username webauthn"
                  aria-invalid={!!emailError}
                  aria-describedby={emailError ? 'email-error' : undefined}
                />
              </div>

              <Button
                type="submit"
                variant="secondary"
                className="login-submit"
                disabled={isLoading || !isValidEmail(email)}
                loading={isCheckingEmail}
              >
                {isLoading ? 'Please wait...' : mode === 'reset' ? 'Send reset link' : 'Continue'}
              </Button>
            </form>

            {/* Only show links on email step for reset mode */}
            {mode === 'reset' && (
              <div className="login-links">
                <button type="button" onClick={() => switchMode('signin')}>
                  Back to sign in
                </button>
              </div>
            )}
          </>
        ) : step === 'password' ? (
          <>
            <form className="login-form" onSubmit={handlePasswordSubmit} noValidate>
              <div className="login-field">
                <label htmlFor="password">Password</label>
                <input
                  type="password"
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'Create a password' : 'Enter your password'}
                  required
                  disabled={isLoading}
                  minLength={6}
                  ref={passwordRef}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                />
              </div>

              <Button
                type="submit"
                variant="secondary"
                className="login-submit"
                disabled={!password}
                loading={isLoading}
              >
                {mode === 'signup' ? 'Create account' : 'Sign in'}
              </Button>
            </form>

            <div className="login-links">
              <button type="button" onClick={handleBack} aria-label="Change email">
                ←
              </button>
              {mode === 'signin' && (
                <>
                  <span className="login-links-divider">·</span>
                  <button type="button" onClick={() => { switchMode('reset'); }}>
                    Forgot password?
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <form className="login-form" onSubmit={handleTotpSubmit} noValidate>
              <div className="login-field">
                <label htmlFor="totp-code">
                  Enter the 6-digit code from your authenticator app
                  {totpError && <span className="login-field__error" id="totp-error" role="alert"> ({totpError})</span>}
                </label>
                <input
                  type="text"
                  id="totp-code"
                  className={totpError ? 'login-field__input--error' : ''}
                  value={totpCode}
                  onChange={(e) => { setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setTotpError(null); }}
                  placeholder="000000"
                  required
                  disabled={isLoading}
                  maxLength={6}
                  ref={totpRef}
                  autoComplete="one-time-code"
                  aria-invalid={!!totpError}
                  aria-describedby={totpError ? 'totp-error' : undefined}
                />
              </div>

              <Button
                type="submit"
                variant="secondary"
                className="login-submit"
                disabled={totpCode.length !== 6}
                loading={isLoading}
              >
                Verify
              </Button>
            </form>

            <div className="login-links">
              <button type="button" onClick={handleBack} aria-label="Go back">
                ←
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
