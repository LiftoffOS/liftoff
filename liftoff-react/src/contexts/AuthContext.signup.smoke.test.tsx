/**
 * Signup smoke test — guards the whole "authed call races account creation"
 * class of bug at the api layer, not just one call's ordering.
 *
 * A brand-new signup has no account row yet. The backend 401s any authenticated
 * endpoint that requires an account (e.g. GET /api/tenant-members/my-memberships),
 * and api.ts signs the user out on ANY 401. So if the app fires an account-
 * dependent request before POST /api/accounts has created the row, the just-
 * verified user gets bounced to /login and onboarding never runs.
 *
 * Unlike the unit test in AuthContext.test.tsx (which mocks the services), this
 * mocks only firebase + fetch, so the REAL api.ts (incl. its 401 -> firebaseSignOut
 * behaviour) and the REAL tenant/account services run. It fails if any first-signup
 * request 401s.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

let authCallback: ((user: unknown) => void) | null = null
const firebaseSignOut = vi.fn((..._args: unknown[]) => Promise.resolve())

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    authCallback = cb
    return () => {}
  },
  signOut: (...args: unknown[]) => firebaseSignOut(...args),
  GoogleAuthProvider: class { addScope() {} setCustomParameters() {} },
  signInWithPopup: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signInWithCustomToken: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
  EmailAuthProvider: { credential: vi.fn() },
  updatePassword: vi.fn(),
  multiFactor: vi.fn(),
  TotpMultiFactorGenerator: {},
}))

// Fake Firebase auth object used by both AuthContext and the api client.
// Inlined in the factory — vi.mock is hoisted above module-scope consts.
vi.mock('../config/firebase', () => ({
  auth: {
    currentUser: { uid: 'u1', getIdToken: async () => 'fake-token' },
    authStateReady: async () => {},
  },
  googleProvider: {},
  app: {},
  remoteConfig: {},
}))

// Keep analytics inert.
vi.mock('../lib/analytics', () => ({
  identifyUser: vi.fn(),
  updateTenantContext: vi.fn(),
  resetAnalytics: vi.fn(),
  track: vi.fn(),
}))

import { AuthProvider } from './AuthProvider'

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('signup smoke test — new user is never signed out mid-signup', () => {
  let accountCreated = false
  let postTenantsCalled = false
  let membershipStatuses: number[]

  beforeEach(() => {
    authCallback = null
    accountCreated = false
    postTenantsCalled = false
    membershipStatuses = []
    firebaseSignOut.mockClear()

    const accountBody = {
      id: 'acc1', email: 'a@b.com', firstName: 'A', lastName: 'B',
      accessGranted: true, accessReason: 'domain', timezone: 'UTC',
    }

    // Backend model of a brand-new signup:
    //  - syncAccount() does GET /api/accounts/me (404 until created) then
    //    POST /api/accounts (creates it).
    //  - /my-memberships 401s until the account row exists.
    global.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.includes('/api/accounts/me') && method === 'GET') {
        return accountCreated ? jsonResponse(200, accountBody) : jsonResponse(404, { error: 'not found' })
      }
      if (url.includes('/api/accounts') && method === 'POST') {
        accountCreated = true
        return jsonResponse(200, accountBody)
      }
      if (url.includes('/api/tenant-members/my-memberships')) {
        const status = accountCreated ? 200 : 401
        membershipStatuses.push(status)
        return accountCreated
          ? jsonResponse(200, [])
          : jsonResponse(401, { error: 'Authentication required' })
      }
      if (url.includes('/api/tenants') && method === 'POST') {
        postTenantsCalled = true
        return jsonResponse(200, {
          id: 'tnt1', accountId: 'acc1', name: "A's Workspace", status: 'active',
          onboardingPath: 'A', onboardingStepId: null, onboardingStep: 0,
          onboardingCompletedAt: null, createdAt: '', updatedAt: '',
        })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not 401/sign-out, and auto-provisions the workspace', async () => {
    render(<AuthProvider><div /></AuthProvider>)
    expect(typeof authCallback).toBe('function')

    await act(async () => {
      authCallback!({ uid: 'u1', email: 'a@b.com', emailVerified: true, displayName: 'A B' })
    })

    // Let the fire-and-forget tenant load + auto-provision settle.
    await vi.waitFor(() => { expect(postTenantsCalled).toBe(true) })

    // The membership call must never have 401'd — if it did, api.ts would have
    // signed the user out mid-signup (the exact regression this guards).
    expect(membershipStatuses).not.toContain(401)
    expect(firebaseSignOut).not.toHaveBeenCalled()
    // And onboarding can proceed: a personal workspace was provisioned.
    expect(postTenantsCalled).toBe(true)
  })
})
