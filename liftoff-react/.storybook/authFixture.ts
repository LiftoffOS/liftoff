// A complete, typed AuthContextType for stories that need to render something
// living under useAuth without a live Firebase or backend connection.
//
// Typed rather than cast to `any`: the point of a fixture is that it goes stale
// loudly. A new member on the context is a compile error here, which is the
// only warning a story gets before it renders against a shape the app no longer
// has.
import type { User } from 'firebase/auth'
import type { AuthContextType } from '../src/contexts/AuthContext'
import type { Account } from '../src/services/account'
import type { TenantWithRole } from '../src/services/tenants'

// The two SDK objects are the exception. A Firebase User carries twenty-odd
// members and a TotpSecret is an SDK class; stories read three fields between
// them, so these stand in for the SDK objects rather than reimplementing them.
const storyUser = {
  uid: 'uid-jane',
  email: 'jane@acme.com',
  displayName: 'Jane Smith',
  photoURL: null,
  emailVerified: true,
} as unknown as User

export const storyAccount: Account = {
  id: 'acct-1',
  firebaseUid: 'uid-jane',
  firstName: 'Jane',
  lastName: 'Smith',
  email: 'jane@acme.com',
  timezone: 'America/Los_Angeles',
  avatarUrl: null,
  stripeCustomerId: null,
  pendingEmail: null,
  preferences: {},
  persona: null,
  accessGranted: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function storyTenant(id: string, name: string, role: TenantWithRole['role']): TenantWithRole {
  return {
    id,
    accountId: 'acct-1',
    name,
    status: 'active',
    gcpProjectId: null,
    databaseName: null,
    migrationStatus: 'complete',
    hasCreatedInternalAgent: true,
    onboardingStep: 8,
    onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    onboardingPath: null,
    onboardingStepId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    role,
  }
}

export const storyTenants: TenantWithRole[] = [
  storyTenant('tenant-1', 'Acme Corp', 'owner'),
  storyTenant('tenant-2', 'Beta Org', 'member'),
]

export const mockAuthValue: AuthContextType = {
  user: storyUser,
  account: storyAccount,
  loading: false,
  backendConnected: true,

  tenants: storyTenants,
  currentTenant: storyTenants[0],
  currentRole: 'owner',
  tenantLoading: false,

  switchTenant: () => {},
  refreshTenants: async () => {},

  canManageMembers: () => true,
  canInviteMembers: () => true,
  canManageSettings: () => true,
  isOwner: () => true,

  signInWithGoogle: async () => storyAccount,
  signInWithEmail: async () => storyAccount,
  signUpWithEmail: async () => storyAccount,
  resetPassword: async () => {},
  changePassword: async () => {},
  signOut: async () => {},
  getIdToken: async () => 'story-token',
  sendVerificationEmail: async () => {},
  reloadUser: async () => true,

  registerPasskey: async () => ({
    id: 'pk-1',
    credentialId: 'cred-1',
    deviceName: 'Story device',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
  }),
  removePasskey: async () => {},
  getPasskeys: async () => [],
  isPasskeySupported: () => false,
  isPlatformAuthenticatorAvailable: async () => false,
  signInWithPasskey: async () => {},
  startConditionalPasskeyAuth: async () => null,
  isConditionalUIAvailable: async () => false,

  refreshAccount: async () => {},
  updateAccountData: () => {},

  setupTotpMfa: async () => ({ secretKey: 'STORYSECRET' }) as unknown as Awaited<ReturnType<AuthContextType['setupTotpMfa']>>,
  completeTotpEnrollment: async () => {},
  disableTotpMfa: async () => {},
  getTotpEnrollmentStatus: () => false,
}
