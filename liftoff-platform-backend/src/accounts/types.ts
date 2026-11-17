// Account Types

export interface NotificationTypes {
  taskUpdates?: boolean;
  teamActivity?: boolean;
  escalations?: boolean;
  weeklyDigest?: boolean;
}

/** Where notifications are sent, as opposed to which ones you get.
 *
 *  Email defaults ON, matching every account that predates the field. Browser
 *  defaults OFF and must be turned on explicitly: it cannot work without an OS
 *  permission the person grants in their own browser, so defaulting it on would
 *  claim a capability the account does not have. */
export interface NotificationDelivery {
  email?: boolean;
  browser?: boolean;
}

export interface AccountPreferences {
  gettingStartedHidden?: boolean;
  notificationTypes?: NotificationTypes;
  notificationFrequency?: 'realtime' | 'daily' | 'weekly' | 'none';
  notificationDelivery?: NotificationDelivery;
  newsletter?: boolean;
}

// Per-user platform access approval state. 'pending' by default; the signup
// Approve/Waitlist admin flow sets 'approved' (grants access) or 'waitlisted'.
export type AccessStatus = 'pending' | 'approved' | 'waitlisted';

export interface Account {
  id: string;
  firebaseUid: string;
  firstName: string;
  lastName: string;
  email: string;
  timezone: string;
  avatarUrl: string | null;
  stripeCustomerId: string | null;
  // Email verification fields
  pendingEmail: string | null;
  emailVerificationToken: string | null;
  emailVerificationExpiry: Date | null;
  // User preferences
  preferences: AccountPreferences;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  // Soft-delete marker. findById() filters at the SQL layer so a populated
  // Account will normally have deletedAt = null; the field is exposed so
  // defensive checks (e.g. enqueueNotification) can guard against a stale
  // cache hit ever surfacing a soft-deleted row.
  deletedAt: Date | null;
  // True for Liftoff staff (auto-derived from email at write time via
  // INTERNAL_EMAIL_DOMAINS in ./internal-domains; overridable by manual
  // UPDATE). Surfaced on GET /api/accounts/me so the frontend can mark
  // them as $internal_or_test_user in PostHog.
  isInternal: boolean;
  // Platform admin (migration 037). Surfaced on GET /api/accounts/me so the
  // frontend knows whether to offer the support-delegation affordances. It says
  // nothing about what the caller may DO: every admin route re-checks the
  // column server-side, and this flag is read-only to the client.
  isPlatformAdmin: boolean;
  // Per-user access approval state (email-level whitelisting). Domain-whitelisted
  // and invitation-based accounts are granted regardless; this only gates
  // non-domain signups. Set by the signup Approve/Waitlist flow (migration 304).
  accessStatus: AccessStatus;
}

export interface CreateAccountInput {
  firebaseUid: string;
  firstName: string;
  lastName: string;
  email: string;
  timezone?: string;
  /**
   * The referral code the browser was carrying, if any.
   *
   * Attribution has no frontend surface of its own: the code lands on `/` or
   * `/login`, is persisted for 30 days with last touch winning, and rides in
   * here. Binding it at ACCOUNT CREATION rather than holding a cookie until
   * payment is what makes the window survive a signup on a different device
   * from the click, and what lets a subscription months later still earn the
   * referrer credit.
   *
   * Never load-bearing for the signup itself. Anything wrong with it — unknown
   * code, stale click, self-referral — is recorded or dropped, never raised.
   */
  referralCode?: string;
  /** When the link was followed, ISO. The 30 day attribution window is checked
   *  against it; a click older than that buys only stale attribution. */
  referralClickedAt?: string;
}

export interface UpdateAccountInput {
  firstName?: string;
  lastName?: string;
  timezone?: string;
  preferences?: AccountPreferences;
  avatarUrl?: string | null;
}

export interface AccountResponse extends Account {
  accessGranted: boolean;
  accessReason: 'domain' | 'approved' | 'invitation' | null;
}

export interface InitiateEmailChangeInput {
  newEmail: string;
}
