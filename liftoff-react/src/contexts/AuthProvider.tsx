import { useEffect, useState, useRef, type ReactNode } from 'react'
import {
  type User,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  signInWithCustomToken,
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
  multiFactor,
  TotpMultiFactorGenerator,
  type TotpSecret,
} from 'firebase/auth'
import { auth, googleProvider } from '../config/firebase'
import { isEmailDomainAllowed, DomainNotAllowedError } from '../config/emailDomains'
import {
  registerPasskey as registerPasskeyService,
  removePasskey as removePasskeyService,
  getStoredPasskeys,
  isPasskeySupported as checkPasskeySupport,
  isPlatformAuthenticatorAvailable as checkPlatformAuthenticator,
  authenticateWithPasskey as authenticateWithPasskeyService,
  startConditionalAuthentication,
  isConditionalUIAvailable,
} from '../services/passkey'
import { syncAccount, getAccount, sendSignupVerification, type Account } from '../services/account'
import { reportSecurityEvent } from '../services/auditEvents'
import { getMyTenants, provisionTenant, type TenantWithRole } from '../services/tenants'
import { identifyUser, updateTenantContext, resetAnalytics, track } from '../lib/analytics'
import { PENDING_ONBOARDING_PATH_KEY } from '../pages/Dashboard/Onboarding/types'
import { selectedTenantKey } from '../lib/supportDelegation'
import { AuthContext, type AuthContextType } from './AuthContext'

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [tenants, setTenants] = useState<TenantWithRole[]>([])
  const [currentTenant, setCurrentTenant] = useState<TenantWithRole | null>(null)
  const [loading, setLoading] = useState(true)
  const [tenantLoading, setTenantLoading] = useState(false)
  const [backendConnected, setBackendConnected] = useState(true)

  // Guard against duplicate provisioning calls
  const provisioningInProgress = useRef(false)

  // Deduplicate concurrent syncUserWithBackend calls (e.g. onAuthStateChanged + signUpWithEmail
  // both fire immediately after createUserWithEmailAndPassword, causing a race where both try
  // to POST /api/accounts and the second one fails, setting backendConnected: false).
  const syncInProgress = useRef<Promise<Account | null> | null>(null)

  // Derived state: current user's role in current tenant
  const currentRole = currentTenant?.role ?? null

  // Permission helpers
  const canManageMembers = () =>
    currentRole === 'owner' || currentRole === 'admin'
  const canInviteMembers = () =>
    currentRole === 'owner' || currentRole === 'admin'
  const canManageSettings = () =>
    currentRole === 'owner' || currentRole === 'admin'
  const isOwner = () => currentRole === 'owner'

  // Switch to a different tenant
  const switchTenant = (tenantId: string) => {
    const tenant = tenants.find(t => t.id === tenantId)
    if (tenant) {
      track('tenant_switched', {
        from_tenant_id: currentTenant?.id ?? null,
        to_tenant_id: tenant.id,
      })
      setCurrentTenant(tenant)
      localStorage.setItem(selectedTenantKey(), tenantId)
      updateTenantContext({
        tenantId: tenant.id,
        tenantName: tenant.name,
        tenantRole: tenant.role,
      })
    }
  }

  // Load tenants asynchronously - does not block auth loading.
  //
  // getMyTenants() MUST run after syncAccount has created/confirmed the account:
  // the backend's GET /api/tenant-members/my-memberships returns 401 when no
  // account row exists for the Firebase uid, and api.ts signs the user out on
  // 401. Dispatching this in parallel with syncAccount therefore bounced
  // brand-new signups straight back to /login (the account does not exist yet
  // at that instant). Keep it sequential — the data dependency is real.
  const loadTenantsAsync = async (accountId: string, syncedAccount?: Account) => {
    setTenantLoading(true)
    try {
      let allTenants = await getMyTenants()

      // Check if user owns any workspace (their personal workspace)
      const hasOwnedWorkspace = allTenants.some(t => t.role === 'owner')

      // Skip auto-provisioning for invitation-only users (plan 2f)
      if (!hasOwnedWorkspace && syncedAccount?.accessReason !== 'invitation' && !provisioningInProgress.current) {
        // Auto-provision personal workspace for users who don't own one
        // This handles users who joined via invitation but don't have their own workspace
        // Append at end so invited workspace remains selected first
        // Use "Personal Workspace" if user has no first name
        // Guard against duplicate calls with ref
        provisioningInProgress.current = true
        try {
          // Hero stashes the onboarding path in sessionStorage as a transient
          // bridge. We forward it to the backend, which persists it on
          // tenants.onboarding_path and derives the default workspace name
          // (Path B → 'Personal Workspace'; Path A → '{firstName}'s Workspace').
          // The column is the source of truth from t=0 of tenant existence —
          // OnboardingPage reads tenant.onboardingPath, not sessionStorage.
          let pendingPath: 'A' | 'B' | null = null
          try {
            const p = sessionStorage.getItem(PENDING_ONBOARDING_PATH_KEY)
            if (p === 'A' || p === 'B') pendingPath = p
          } catch { /* private-mode fallback */ }
          const newTenant = await provisionTenant(accountId, {
            onboardingPath: pendingPath ?? 'A',
          })
          // Single-use: clear now that the column carries the path.
          try { sessionStorage.removeItem(PENDING_ONBOARDING_PATH_KEY) } catch { /* private-mode fallback */ }
          track('tenant_auto_provisioned', { tenant_id: newTenant.id })
          const tenantWithRole: TenantWithRole = { ...newTenant, role: 'owner' }
          allTenants = [...allTenants, tenantWithRole]
        } finally {
          provisioningInProgress.current = false
        }
      }

      setTenants(allTenants)

      if (allTenants.length > 0) {
        // Restore selection from localStorage or use first
        const savedId = localStorage.getItem(selectedTenantKey())
        const selected = allTenants.find(t => t.id === savedId) || allTenants[0]
        setCurrentTenant(selected)
        updateTenantContext({
          tenantId: selected.id,
          tenantName: selected.name,
          tenantRole: selected.role,
        })
      }
    } catch (error) {
      // [FE-014] Surface errors to user
      console.error('Failed to load tenants:', error)
      // Don't block - user can still use the app, just without tenant features
      setTenants([])
      setCurrentTenant(null)
    } finally {
      setTenantLoading(false)
    }
  }

  // Refresh tenants (e.g., after accepting an invitation, after a tenant
  // PATCH like onboarding-progress, after rename, or after a user-triggered
  // retry on ErrorState). Three branches:
  //
  //   1. currentTenant matches a freshly-fetched tenant → update in-place
  //      so consumers see fresh fields (name, onboardingStep,
  //      onboardingCompletedAt). Without this, mutations that flip
  //      onboardingCompletedAt would land in `tenants` but leave
  //      `currentTenant` pointing at the stale object — which races with
  //      DashboardOnboardingGate immediately after wizard completion.
  //   2. currentTenant exists but is no longer in the list (e.g., it was
  //      deleted) → pick the first available, or null if empty.
  //   3. currentTenant is null (recovery path from loadTenantsAsync's catch
  //      branch — network error left us without a tenant) → auto-select the
  //      localStorage-saved tenant if it's in the new list, otherwise the
  //      first. Without this branch, an ErrorState user clicking "Try
  //      Again" would refresh `tenants` but stay stuck with no selection.
  const refreshTenants = async () => {
    if (!account) return
    try {
      const allTenants = await getMyTenants()
      setTenants(allTenants)
      let resolved: TenantWithRole | null = null
      if (currentTenant) {
        resolved = allTenants.find(t => t.id === currentTenant.id) ?? allTenants[0] ?? null
        setCurrentTenant(resolved)
      } else if (allTenants.length > 0) {
        const savedId = localStorage.getItem(selectedTenantKey())
        resolved = allTenants.find(t => t.id === savedId) ?? allTenants[0]
        setCurrentTenant(resolved)
      }
      if (resolved) {
        updateTenantContext({
          tenantId: resolved.id,
          tenantName: resolved.name,
          tenantRole: resolved.role,
        })
      }
    } catch (error) {
      console.error('Failed to refresh tenants:', error)
    }
  }

  // Sync user with backend when Firebase auth state changes
  // Returns the synced Account so callers (auth methods) can use it immediately
  // without waiting for React state updates
  const syncUserWithBackend = async (firebaseUser: User | null): Promise<Account | null> => {
    if (!firebaseUser) {
      setAccount(null)
      setTenants([])
      setCurrentTenant(null)
      setTenantLoading(false)
      setBackendConnected(true)
      return null
    }

    // Email/password signups must verify their email before any backend
    // account is created. The backend rejects POST /api/accounts for unverified
    // password users, so skip the sync entirely here and let ProtectedRoute
    // route them to /verify-email. Google and other federated providers come
    // back with emailVerified === true, so they sync normally; the same is true
    // for existing (already-verified) accounts and passkey sign-ins.
    if (!firebaseUser.emailVerified) {
      setAccount(null)
      setTenants([])
      setCurrentTenant(null)
      setTenantLoading(false)
      setBackendConnected(true)
      return null
    }

    // Domain allow-list (dev builds only; see config/emailDomains.ts). The
    // per-method checks below reject before Firebase is ever called, so this
    // catches the paths that do not go through them: a session restored by
    // onAuthStateChanged from before the gate existed, and passkey sign-in,
    // which mints a Firebase custom token of its own. Signing out here rather
    // than merely skipping the sync is what stops a disallowed session sitting
    // authenticated-but-inert; it re-enters as syncUserWithBackend(null), which
    // returns above without recursing. Crucially this runs BEFORE the
    // syncAccount call below, so no backend account row is ever created for a
    // disallowed address.
    if (!isEmailDomainAllowed(firebaseUser.email || '')) {
      setAccount(null)
      setTenants([])
      setCurrentTenant(null)
      setTenantLoading(false)
      setBackendConnected(true)
      await firebaseSignOut(auth)
      return null
    }

    // If a sync is already in flight for this user, reuse the same promise so concurrent
    // callers (onAuthStateChanged + signUpWithEmail) don't both attempt POST /api/accounts.
    if (syncInProgress.current) {
      return syncInProgress.current
    }

    const doSync = async (): Promise<Account | null> => {
      try {
        const displayName = firebaseUser.displayName || ''
        const nameParts = displayName.trim().split(/\s+/)
        const firstName = nameParts[0] || ''
        const lastName = nameParts.slice(1).join(' ') || ''

        const syncedAccount = await syncAccount({
          firebaseUid: firebaseUser.uid,
          firstName,
          lastName,
          email: firebaseUser.email || '',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
        setAccount(syncedAccount)
        identifyUser({
          accountId: syncedAccount.id,
          email: syncedAccount.email,
          firstName: syncedAccount.firstName,
          lastName: syncedAccount.lastName,
          persona: syncedAccount.persona ?? null,
          timezone: syncedAccount.timezone,
          isInternal: syncedAccount.isInternal,
        })
        // Access-gate funnel: if the backend denied this account, fire
        // once per session start. Signup is open, so this is not expected
        // to fire; it stays so a closed list is visible, per domain.
        if (syncedAccount.accessGranted === false) {
          const domain = syncedAccount.email.split('@')[1] ?? 'unknown'
          track('access_gate_blocked', { email_domain: domain.toLowerCase() })
        }
        setBackendConnected(true)
        loadTenantsAsync(syncedAccount.id, syncedAccount)
        return syncedAccount
      } catch (error) {
        console.warn('Failed to sync with backend:', error)
        setBackendConnected(false)
        setAccount(null)
        setTenants([])
        setCurrentTenant(null)
        return null
      }
    }

    syncInProgress.current = doSync()
    try {
      return await syncInProgress.current
    } finally {
      syncInProgress.current = null
    }
  }

  // One subscription for the life of the provider, calling whichever sync is
  // current when Firebase reports a change. Depending on the function directly
  // would tear down and re-subscribe on every render.
  const syncUserRef = useRef(syncUserWithBackend)
  useEffect(() => {
    syncUserRef.current = syncUserWithBackend
  })

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setUser(user)
      await syncUserRef.current(user)
      setLoading(false)
    })

    return unsubscribe
  }, [])

  const signInWithGoogle = async (): Promise<Account | null> => {
    const result = await signInWithPopup(auth, googleProvider)
    // Google is the one provider whose address cannot be checked up front: the
    // person chooses the account inside Google's popup. The `hd` parameter on
    // googleProvider filters the chooser, but Google treats it as a hint, so the
    // real check is here against the profile that came back. Sign the session
    // out before throwing, otherwise a rejected person stays authenticated to
    // Firebase while the page tells them they were refused.
    if (!isEmailDomainAllowed(result.user.email || '')) {
      await firebaseSignOut(auth)
      throw new DomainNotAllowedError()
    }
    return await syncUserWithBackend(result.user)
  }

  const signInWithEmail = async (email: string, password: string): Promise<Account | null> => {
    // Checked before the Firebase call: a refused address should not consume a
    // sign-in attempt or reveal whether the password was right.
    if (!isEmailDomainAllowed(email)) {
      throw new DomainNotAllowedError()
    }
    const result = await signInWithEmailAndPassword(auth, email, password)
    return await syncUserWithBackend(result.user)
  }

  const signUpWithEmail = async (email: string, password: string): Promise<Account | null> => {
    // Checked before the Firebase call, so a refused address never becomes a
    // Firebase user that someone then has to clean up.
    if (!isEmailDomainAllowed(email)) {
      throw new DomainNotAllowedError()
    }
    await createUserWithEmailAndPassword(auth, email, password)
    // Send our own verification email (a Firebase verification link delivered
    // via Resend with our template). Best-effort: if it fails, the user can
    // resend from the /verify-email page. No backend account is created until
    // the email is verified, so we return null and the caller routes the user
    // to the verification interstitial.
    try {
      await sendSignupVerification()
    } catch (err) {
      console.warn('Failed to send signup verification email:', err)
    }
    return null
  }

  // Re-check the Firebase user's verification status. Called by the
  // /verify-email page (polling + manual "I have verified"). When the email has
  // become verified, force a fresh ID token (so the backend sees
  // email_verified=true) and create the backend account now. Returns the
  // latest emailVerified flag.
  const reloadUser = async (): Promise<boolean> => {
    const current = auth.currentUser
    if (!current) return false
    await current.reload()
    const refreshed = auth.currentUser
    if (!refreshed) return false
    setUser(refreshed)
    if (refreshed.emailVerified) {
      await refreshed.getIdToken(true)
      await syncUserWithBackend(refreshed)
    }
    return refreshed.emailVerified
  }

  // Resend the signup verification email (used by the /verify-email page).
  const sendVerificationEmail = async (): Promise<void> => {
    await sendSignupVerification()
  }

  const resetPassword = async (email: string) => {
    await sendPasswordResetEmail(auth, email)
  }

  const changePassword = async (currentPassword: string, newPassword: string) => {
    if (!user || !user.email) {
      throw new Error('No user logged in')
    }
    // Re-authenticate user before changing password (required by Firebase)
    const credential = EmailAuthProvider.credential(user.email, currentPassword)
    await reauthenticateWithCredential(user, credential)
    // Update password
    await updatePassword(user, newPassword)
    track('password_changed', {})
    // Phase 3: report to audit trail. Best-effort — never break the
    // password-changed UI on audit reporting failure.
    void reportSecurityEvent('account.password_changed')
  }

  const signOut = async () => {
    track('sign_out', {})
    await firebaseSignOut(auth)
    setAccount(null)
    setTenants([])
    setCurrentTenant(null)
    localStorage.removeItem(selectedTenantKey())
    resetAnalytics()
  }

  const getIdToken = async (): Promise<string | null> => {
    if (!user) return null
    return user.getIdToken()
  }

  const refreshAccount = async () => {
    if (!user) return
    const updatedAccount = await getAccount()
    if (updatedAccount) {
      setAccount(updatedAccount)
      // Re-identify so server-side flips of isInternal (e.g. email-change
      // confirmation moved the user to an internal domain, or a manual
      // override was applied) reach PostHog without requiring a sign-out.
      identifyUser({
        accountId: updatedAccount.id,
        email: updatedAccount.email,
        firstName: updatedAccount.firstName,
        lastName: updatedAccount.lastName,
        persona: updatedAccount.persona ?? null,
        timezone: updatedAccount.timezone,
        isInternal: updatedAccount.isInternal,
      })
    }
  }

  // Direct account update - used when we already have the updated data
  // (e.g., from a mutation result) to avoid an extra API call
  const updateAccountData = (updatedAccount: Account) => {
    setAccount(updatedAccount)
  }

  const signInWithPasskey = async (): Promise<void> => {
    // Authenticate with passkey and get custom token
    const result = await authenticateWithPasskeyService()
    // Sign in to Firebase with the custom token
    const credential = await signInWithCustomToken(auth, result.customToken)
    await syncUserWithBackend(credential.user)
  }

  const startConditionalPasskeyAuth = async (
    onSuccess: (syncedAccount: Account | null) => void,
    onError?: (error: Error) => void
  ): Promise<AbortController | null> => {
    return startConditionalAuthentication(
      async (result) => {
        try {
          const credential = await signInWithCustomToken(auth, result.customToken)
          const syncedAccount = await syncUserWithBackend(credential.user)
          onSuccess(syncedAccount)
        } catch (error) {
          onError?.(error instanceof Error ? error : new Error('Failed to sign in'))
        }
      },
      onError
    )
  }

  // TOTP 2FA methods
  const setupTotpMfa = async (): Promise<TotpSecret> => {
    if (!user) throw new Error('No user logged in')
    const session = await multiFactor(user).getSession()
    const secret = await TotpMultiFactorGenerator.generateSecret(session)
    return secret
  }

  const completeTotpEnrollment = async (secret: TotpSecret, code: string): Promise<void> => {
    if (!user) throw new Error('No user logged in')
    const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, code)
    await multiFactor(user).enroll(assertion, 'Authenticator App')
    void reportSecurityEvent('account.mfa_enrolled', { factor: 'totp' })
  }

  const disableTotpMfa = async (): Promise<void> => {
    if (!user) throw new Error('No user logged in')
    const enrolledFactors = multiFactor(user).enrolledFactors
    const totpFactor = enrolledFactors.find(f => f.factorId === 'totp')
    if (totpFactor) {
      await multiFactor(user).unenroll(totpFactor)
      void reportSecurityEvent('account.mfa_disabled', { factor: 'totp' })
    }
  }

  const getTotpEnrollmentStatus = (): boolean => {
    if (!user) return false
    const enrolledFactors = multiFactor(user).enrolledFactors
    return enrolledFactors.some(f => f.factorId === 'totp')
  }

  const value: AuthContextType = {
    user,
    account,
    loading,
    backendConnected,

    // Multi-tenant state
    tenants,
    currentTenant,
    currentRole,
    tenantLoading,

    // Tenant methods
    switchTenant,
    refreshTenants,

    // Permission helpers
    canManageMembers,
    canInviteMembers,
    canManageSettings,
    isOwner,

    // Auth methods
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    resetPassword,
    changePassword,
    signOut,
    getIdToken,
    // Email verification (signup gate)
    sendVerificationEmail,
    reloadUser,
    // Passkey methods
    registerPasskey: registerPasskeyService,
    removePasskey: removePasskeyService,
    getPasskeys: getStoredPasskeys,
    isPasskeySupported: checkPasskeySupport,
    isPlatformAuthenticatorAvailable: checkPlatformAuthenticator,
    signInWithPasskey,
    // Conditional UI passkey (autofill)
    startConditionalPasskeyAuth,
    isConditionalUIAvailable,
    // Account refresh
    refreshAccount,
    updateAccountData,
    // TOTP 2FA methods
    setupTotpMfa,
    completeTotpEnrollment,
    disableTotpMfa,
    getTotpEnrollmentStatus,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}
