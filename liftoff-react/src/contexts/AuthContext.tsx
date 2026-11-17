import { createContext, useContext } from 'react'
import { type User, type TotpSecret, type MultiFactorResolver } from 'firebase/auth'
import { type StoredPasskey } from '../services/passkey'
import { type Account } from '../services/account'
import { type Tenant, type TenantWithRole, type TenantRole } from '../services/tenants'

export type { StoredPasskey }
export type { Tenant, TenantWithRole, TenantRole }
export type { TotpSecret, MultiFactorResolver }

// Persist selected tenant to localStorage.
//
// Read through selectedTenantKey() rather than a constant: localStorage is
// shared by every tab, so a support delegation session switching workspaces
// would otherwise overwrite the operator's own saved selection and drop them
// into a workspace they never chose when they return to their own account.
// The key is namespaced by target for the life of a session.

export interface AuthContextType {
  user: User | null
  account: Account | null
  loading: boolean
  backendConnected: boolean

  // [FE-003] Multi-tenant state
  tenants: TenantWithRole[]           // All tenants user is member of
  currentTenant: TenantWithRole | null // Selected tenant
  currentRole: TenantRole | null       // User's role in current tenant
  tenantLoading: boolean

  // Tenant methods
  switchTenant: (tenantId: string) => void
  refreshTenants: () => Promise<void>

  // Permission helpers using ROLE_HIERARCHY
  canManageMembers: () => boolean   // owner or admin
  canInviteMembers: () => boolean   // owner or admin
  canManageSettings: () => boolean  // owner or admin
  isOwner: () => boolean

  // Auth methods
  signInWithGoogle: () => Promise<Account | null>
  signInWithEmail: (email: string, password: string) => Promise<Account | null>
  signUpWithEmail: (email: string, password: string) => Promise<Account | null>
  resetPassword: (email: string) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  signOut: () => Promise<void>
  getIdToken: () => Promise<string | null>
  // Email verification (signup gate)
  sendVerificationEmail: () => Promise<void>
  reloadUser: () => Promise<boolean>
  // Passkey methods
  registerPasskey: () => Promise<StoredPasskey>
  removePasskey: (passkeyId: string) => Promise<void>
  getPasskeys: () => Promise<StoredPasskey[]>
  isPasskeySupported: () => boolean
  isPlatformAuthenticatorAvailable: () => Promise<boolean>
  signInWithPasskey: () => Promise<void>
  // Conditional UI passkey (autofill)
  startConditionalPasskeyAuth: (onSuccess: (syncedAccount: Account | null) => void, onError?: (error: Error) => void) => Promise<AbortController | null>
  isConditionalUIAvailable: () => Promise<boolean>
  // Account refresh
  refreshAccount: () => Promise<void>
  // Direct account update (for use with mutation results)
  updateAccountData: (account: Account) => void
  // TOTP 2FA methods
  setupTotpMfa: () => Promise<TotpSecret>
  completeTotpEnrollment: (secret: TotpSecret, code: string) => Promise<void>
  disableTotpMfa: () => Promise<void>
  getTotpEnrollmentStatus: () => boolean
}

export const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

/**
 * Auth for components that also render outside the provider, such as shared
 * chrome mounted standalone in tests, where there is no session to read.
 * Returns null there; callers treat that as signed out.
 */
export function useOptionalAuth(): AuthContextType | null {
  return useContext(AuthContext)
}
