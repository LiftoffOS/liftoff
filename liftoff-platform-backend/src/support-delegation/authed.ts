// The pair that must never be separated.
//
// `authMiddleware` answers "who is calling". `supportDelegationMiddleware`
// answers "who is this request ANSWERED as". Any route that runs the first
// without the second establishes an identity a support session cannot swap,
// and the result is not a clean failure: the request succeeds as the OPERATOR
// while the rest of the app is answering as the customer.
//
// That is not hypothetical. It shipped twice. /api/tenant-members resolved the
// operator's workspaces so the dashboard drove off the wrong tenant and every
// other call 403'd, and /api/agent-audit-logs applied authMiddleware per-route
// (it mounts before the global gate to serve service-auth POSTs) so the
// Activity page 403'd on the customer's own tenant.
//
// Both were routes that legitimately could not use the global mount. So the fix
// is not "remember to add it" but a handler pair that cannot be taken apart,
// plus mount-order.test.ts, which fails the build on a bare authMiddleware.

import type { RequestHandler } from 'express';
import { authMiddleware } from '../infrastructure/middleware';
import { supportDelegationMiddleware } from './middleware';

/** Use in place of a bare `authMiddleware` on any route or router.
 *
 *  Spread it: `router.get('/', ...authedWithDelegation, handler)`. */
export const authedWithDelegation: RequestHandler[] = [
  authMiddleware,
  supportDelegationMiddleware as RequestHandler,
];
