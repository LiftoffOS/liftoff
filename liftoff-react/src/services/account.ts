// Account Service
// Syncs Firebase user with backend account system

import { api, ApiError } from './api'
import { clearCapturedReferral, getCapturedReferral } from '../lib/referralCapture'

export interface NotificationTypes {
  taskUpdates?: boolean
  teamActivity?: boolean
  escalations?: boolean
  weeklyDigest?: boolean
}

/** Where notifications go, as opposed to which ones you get. Email defaults on,
 *  matching every account that predates the field. Browser defaults OFF and has
 *  to be turned on explicitly: it cannot work without an OS permission the
 *  person has to grant, and defaulting it on would put a permission prompt in
 *  front of the entire user base at once. */
export interface NotificationDelivery {
  email?: boolean
  browser?: boolean
}

export interface AccountPreferences {
  gettingStartedHidden?: boolean
  notificationTypes?: NotificationTypes
  notificationFrequency?: 'realtime' | 'daily' | 'weekly' | 'none'
  notificationDelivery?: NotificationDelivery
  newsletter?: boolean
}

// Step-2 answer in the /onboarding flow ("Which best describes your work?").
// Stored on the account because it's a per-user signal — the same person
// joining a second workspace shouldn't re-answer.
export const ACCOUNT_PERSONAS = [
  'generalist',
  'customer',
  'operations',
  'talent',
  'engineering',
  'other',
] as const
export type AccountPersona = typeof ACCOUNT_PERSONAS[number]

export interface Account {
  id: string
  firebaseUid: string
  firstName: string
  lastName: string
  email: string
  timezone: string
  avatarUrl: string | null
  stripeCustomerId: string | null
  pendingEmail: string | null
  preferences: AccountPreferences
  persona: AccountPersona | null
  accessGranted: boolean
  accessReason?: 'domain' | 'approved' | 'invitation' | null
  // Liftoff staff marker. Auto-derived backend-side from email at account
  // creation + email-change confirmation; overrideable manually. When true,
  // identifyUser() calls posthog.setInternalOrTestUser() so the account is
  // filtered from product analytics dashboards via PostHog's built-in
  // $internal_or_test_user filter.
  isInternal?: boolean
  /** Platform admin. Read-only to the client and never a permission by itself:
   *  every admin route re-checks the column server-side. It exists here so the
   *  app knows whether to offer the support delegation affordances. */
  isPlatformAdmin?: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreateAccountRequest {
  firebaseUid: string
  firstName: string
  lastName: string
  email: string
  timezone?: string
  /** The referral code this browser was carrying, if any. Attribution has no
   *  UI of its own: the code lands on `/` or `/login`, is held for 30 days with
   *  last touch winning, and rides in on the one call that creates the account.
   *  Binding it at account creation rather than holding a cookie until payment
   *  is what lets a subscription months later still earn the referrer credit. */
  referralCode?: string
  /** When the referral link was followed, ISO. Sent so the backend checks the
   *  30 day window against the click rather than the signup. */
  referralClickedAt?: string
}

export interface UpdateAccountRequest {
  firstName?: string
  lastName?: string
  timezone?: string
  preferences?: AccountPreferences
  avatarUrl?: string | null
  persona?: AccountPersona | null
}

// Sync or create account in backend after Firebase auth
// This ensures the user exists in our system
//
// The referral code, when one is held, is attached only to the CREATE call.
// Sending it on every sync would re-offer an already-spent attribution on every
// sign-in, and the backend's binding is keyed to account creation for exactly
// that reason.
export async function syncAccount(data: CreateAccountRequest): Promise<Account> {
  try {
    // Try to get existing account first
    const account = await api.get<Account>('/api/accounts/me')
    return account
  } catch (error) {
    // If account doesn't exist (404), create it
    if (error instanceof ApiError && error.status === 404) {
      const referral = getCapturedReferral()
      const created = await api.post<Account>('/api/accounts', {
        ...data,
        ...(referral ? { referralCode: referral.code, referralClickedAt: referral.clickedAt } : {}),
      })
      // Spent. The binding is durable on the backend from here, and leaving the
      // code in storage would let a second account created in the same browser
      // — a colleague signing up on a shared machine — claim it again.
      if (referral) clearCapturedReferral()
      return created
    }
    throw error
  }
}

// Get current user's account
export async function getAccount(): Promise<Account | null> {
  try {
    return await api.get<Account>('/api/accounts/me')
  } catch {
    return null
  }
}

// Update current user's account
export async function updateAccount(data: UpdateAccountRequest): Promise<Account> {
  return await api.put<Account>('/api/accounts/me', data)
}

// Trigger the backend to send (or resend) the signup email-verification link.
// The backend generates a Firebase email-verification action link and delivers
// it through Resend with our own template. Called for a logged-in but
// not-yet-verified user; a no-op (204) for Google / already-verified users.
export async function sendSignupVerification(): Promise<void> {
  await api.post('/api/accounts/me/send-verification')
}

// Initiate email change (sends verification email)
export async function initiateEmailChange(newEmail: string): Promise<void> {
  await api.post('/api/accounts/me/email', { newEmail })
}

// Cancel pending email change
export async function cancelEmailChange(): Promise<Account> {
  return await api.delete<Account>('/api/accounts/me/email')
}

// Revoke all Firebase refresh tokens for the current user.
// Backend stamps tokensValidAfterTime on the user record; every device's
// next request fails verifyIdToken with auth/id-token-revoked → 401.
export async function revokeAllSessions(): Promise<void> {
  await api.post('/api/accounts/me/sessions/revoke-all')
}

export interface DeletionPreflight {
  hasActiveSubscription: boolean
  hasOutstandingInvoice: boolean
  orphanWorkspaceCount: number
  lostAccessCount: number
  memberOfWorkspaceCount: number
}

export async function getDeletionPreflight(): Promise<DeletionPreflight> {
  return api.get<DeletionPreflight>('/api/accounts/me/deletion-preflight')
}

export async function deleteSelf(): Promise<void> {
  await api.delete('/api/accounts/me')
}
