import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

// Capture the onAuthStateChanged callback so the test can fire a verified user.
let authCallback: ((user: unknown) => void) | null = null

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    authCallback = cb
    return () => {}
  },
  GoogleAuthProvider: class {
    addScope() {}
    setCustomParameters() {}
  },
  signInWithPopup: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signOut: vi.fn(),
  signInWithCustomToken: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() },
  updatePassword: vi.fn(),
  multiFactor: vi.fn(),
  TotpMultiFactorGenerator: {},
}))

const syncAccount = vi.fn()
const getMyTenants = vi.fn()

vi.mock('../services/account', () => ({
  syncAccount: (...args: unknown[]) => syncAccount(...args),
  getAccount: vi.fn(),
  sendSignupVerification: vi.fn(),
}))

vi.mock('../services/tenants', () => ({
  getMyTenants: (...args: unknown[]) => getMyTenants(...args),
  provisionTenant: vi.fn(),
}))

// Keep analytics side-effect-free during the sync.
vi.mock('../lib/analytics', () => ({
  identifyUser: vi.fn(),
  updateTenantContext: vi.fn(),
  resetAnalytics: vi.fn(),
  track: vi.fn(),
}))

// Import AFTER the mocks are registered.
import { AuthProvider } from './AuthProvider'

describe('AuthContext account/tenant load ordering', () => {
  beforeEach(() => {
    syncAccount.mockReset()
    getMyTenants.mockReset()
    authCallback = null
  })

  // Regression guard for the brand-new-signup sign-out bug: the backend's
  // GET /api/tenant-members/my-memberships returns 401 when no account row
  // exists yet, and api.ts signs the user out on 401. So getMyTenants() must
  // NOT be dispatched until syncAccount() has resolved (account created).
  // Parallelising the two bounced first-time signups back to /login.
  it('does not call getMyTenants until syncAccount has resolved', async () => {
    let resolveSync: (account: unknown) => void = () => {}
    syncAccount.mockImplementation(
      () => new Promise((resolve) => { resolveSync = resolve }),
    )
    getMyTenants.mockImplementation(() => new Promise(() => {})) // never resolves

    render(
      <AuthProvider>
        <div />
      </AuthProvider>,
    )
    expect(typeof authCallback).toBe('function')

    // Fire a verified user. doSync awaits syncAccount before anything else.
    await act(async () => {
      authCallback!({ uid: 'u1', email: 'a@b.com', emailVerified: true, displayName: 'A B' })
    })

    // Account sync is in flight; the tenant call must not have fired yet —
    // otherwise it races account creation and 401s for a brand-new user.
    expect(syncAccount).toHaveBeenCalledTimes(1)
    expect(getMyTenants).not.toHaveBeenCalled()

    // Once the account exists, loadTenantsAsync runs and fetches tenants.
    await act(async () => {
      resolveSync({ id: 'acc1', email: 'a@b.com', firstName: 'A', lastName: 'B' })
    })
    expect(getMyTenants).toHaveBeenCalledTimes(1)
  })
})
