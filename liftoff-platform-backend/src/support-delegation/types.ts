// Support delegation: shared types and the request augmentation.
//
// Delegation, not impersonation (RFC 8693 section 1.1). Impersonation issues a
// credential that says the caller IS the subject, collapsing the two identities
// so nothing downstream can tell them apart. Delegation keeps both parties: the
// subject stays the subject and the actor is named alongside. `req.delegation`
// is where the actor survives the identity rewrite.
//
// See docs/support-delegation-plan.md in liftoff-react for the full design.

/** Request header carrying the opaque delegation ticket. */
export const DELEGATION_HEADER = 'x-act-as';

/** Response header echoing the session a response was produced under, so a
 *  response is self-identifying in a browser's network panel and in any
 *  captured trace. */
export const DELEGATION_RESPONSE_HEADER = 'x-delegated';

/** Machine-readable rejection codes. The frontend branches on these: INVALID
 *  means drop the stored session and return the operator to their own account,
 *  FORBIDDEN means the session is fine but this particular call is not allowed
 *  under delegation. Conflating them would have an expired session look like a
 *  permission error and never self-clear. */
export const DELEGATION_INVALID = 'DELEGATION_INVALID';
export const DELEGATION_FORBIDDEN = 'DELEGATION_FORBIDDEN';

/** Who is really acting, carried alongside the rewritten identity. */
export interface DelegationContext {
  sessionId: string;
  actorAccountId: string;
  actorEmail: string | null;
  targetAccountId: string;
}

/** One row of support_delegation_sessions joined to both accounts, which is
 *  everything the middleware needs to decide in a single query. */
export interface DelegationSessionRow {
  id: string;
  actor_account_id: string;
  target_account_id: string;
  ended_at: Date | null;
  actor_firebase_uid: string;
  actor_email: string | null;
  actor_is_platform_admin: boolean;
  target_firebase_uid: string;
  target_email: string | null;
  target_is_platform_admin: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set only when the request is running under a valid delegation session.
     *  Absent on every ordinary request, so `if (req.delegation)` is the test
     *  for "somebody is acting on behalf of this account right now". */
    delegation?: DelegationContext;
  }
}
