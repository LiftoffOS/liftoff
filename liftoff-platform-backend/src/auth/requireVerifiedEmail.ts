// Require-Verified-Email Middleware
//
// Blocks account creation / writes for password-provider users whose email is
// not yet verified. Federated providers (google.com) assert the email address,
// and passkey custom-token sign-ins only exist for already-provisioned
// accounts, so only the email/password signup path can carry an unverified
// (and therefore unvalidated, possibly junk) address.
//
// Source of truth is the Firebase ID token: authMiddleware attaches
// `emailVerified` (the email_verified claim) and `signInProvider`
// (firebase.sign_in_provider) to req.user. Clicking the Firebase email
// verification link flips email_verified to true on the next token refresh,
// after which this guard passes and the account can be created.
//
// This closes the raw-API hole that accessGateMiddleware deliberately leaves
// open: POST /api/accounts is ungated for access-grant purposes so new users
// can self-provision, but without this guard an unverified password user could
// create an account row directly via the API.

import { Request, Response, NextFunction } from 'express';
import { log } from '../infrastructure/logging';

export function requireVerifiedEmail(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Only the password provider can present an unverified email. Federated
  // providers (google.com) and passkey custom tokens are already verified.
  if (user.signInProvider === 'password' && !user.emailVerified) {
    log.info(
      {
        event: 'email_verification_required',
        uid: user.uid,
        email: user.email,
        path: req.originalUrl,
        method: req.method,
      },
      'Blocked unverified password user',
    );

    res.status(403).json({ error: 'email_not_verified' });
    return;
  }

  next();
}
