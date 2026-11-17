// What a delegated session may not do. It is a very short list on purpose.
//
// The product decision: a platform admin stepping into a workspace can do
// almost everything its owner or admin can. Anything narrower cannot finish
// setting an account up on somebody's behalf, which is the reason the feature
// exists. So agent runs, connector changes, billing setup, team edits, chat,
// HR data and credential issuance are all ALLOWED.
//
// The two exceptions are 2FA and password. Both are already impossible, and
// enforced by architecture rather than by this list:
//
//   - password change and MFA/TOTP enrolment never reach this service. They are
//     Firebase client SDK calls against `auth.currentUser`, which stays the
//     OPERATOR for the whole session because the operator's credential is never
//     swapped. Changing a password during a support session changes the
//     OPERATOR'S OWN password
//   - passkey registration mounts BEFORE authMiddleware (index.ts:263), so the
//     delegation middleware never sees it and it can only ever act on the
//     operator's own account
//
// That is worth stating rather than leaving implicit, because the natural
// instinct on reading this file is that the protection is missing.
//
// PATHS ARE POST-MOUNT. This predicate is consulted from a middleware mounted
// at app.use('/api', ...), and Express strips the mount path, so `req.path` is
// `/accounts/me/email`, not `/api/accounts/me/email`.

export interface DenyRule {
  methods: readonly string[];
  pattern: RegExp;
  why: string;
}

export const DENY_RULES: readonly DenyRule[] = [
  // Platform administration is not something a workspace owner or admin can do,
  // so it falls outside the rule above rather than being an exception to it.
  //
  // Largely self-protecting already: adminAuthMiddleware checks
  // is_platform_admin on the EFFECTIVE identity, which during a session is the
  // customer, so these routes 403 on their own. Stated explicitly so the
  // property is guaranteed rather than emergent from another module's
  // behaviour, and so granting a session can never be done from inside one.
  {
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: /^\/admin(\/|$)/,
    why: 'platform administration is never performed through a customer identity',
  },
];

/** Returns the reason this call is denied under delegation, or null to allow. */
export function denialReason(method: string, path: string): string | null {
  const upper = method.toUpperCase();
  for (const rule of DENY_RULES) {
    if (rule.methods.includes(upper) && rule.pattern.test(path)) return rule.why;
  }
  return null;
}
