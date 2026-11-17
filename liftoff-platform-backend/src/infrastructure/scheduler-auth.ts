// OIDC-verifying middleware for Cloud Scheduler endpoints.
//
// Cloud Run's invokers = ["allUsers"] on platform-backend (see
// terraform/projects/platform-control/main.tf) means the platform layer does
// not gate inbound requests by SA identity — application-level auth is
// required for any sensitive endpoint that does cross-tenant work.
//
// This middleware validates that the request carries a Google-issued OIDC
// id_token whose `email` claim is in `allowedEmails` and whose `aud` claim
// matches `expectedAudience`. Backed by google-auth-library's OAuth2Client
// which fetches Google's public certs and verifies the JWT signature.
//
// Used by reconciler endpoints (see plan §6.4) so an unauthenticated caller
// cannot trigger a global cross-tenant fan-out.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { log } from './logging';

const oauthClient = new OAuth2Client();

export interface RequireSchedulerOidcOptions {
  /** Audience that the OIDC token MUST match. Typically the Cloud Run URL. */
  expectedAudience: string | (() => string);
  /** SA emails permitted to invoke. The scheduler SA email goes here. */
  allowedEmails: string[] | (() => string[]);
}

export function requireSchedulerOidc(opts: RequireSchedulerOidcOptions): RequestHandler {
  const resolveAudience = () =>
    typeof opts.expectedAudience === 'function' ? opts.expectedAudience() : opts.expectedAudience;
  const resolveAllowed = () =>
    (typeof opts.allowedEmails === 'function' ? opts.allowedEmails() : opts.allowedEmails)
      .filter((e) => e && e.length > 0);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authz = req.headers['authorization'];
    if (typeof authz !== 'string' || !authz.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing OIDC bearer token' });
      return;
    }
    const token = authz.slice('Bearer '.length).trim();
    const audience = resolveAudience();
    const allowed = resolveAllowed();
    if (!audience || allowed.length === 0) {
      log.error(
        { hasAudience: !!audience, allowedCount: allowed.length },
        'scheduler-auth: OIDC configuration missing (audience or allowed-emails)',
      );
      res.status(500).json({ error: 'Service auth not configured' });
      return;
    }

    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
      const payload = ticket.getPayload();
      const email = payload?.email;
      const emailVerified = payload?.email_verified;
      if (!email || !emailVerified) {
        log.warn({ email, emailVerified }, 'scheduler-auth: OIDC token lacks verified email');
        res.status(401).json({ error: 'OIDC token email not verified' });
        return;
      }
      if (!allowed.includes(email)) {
        log.warn({ email, allowed }, 'scheduler-auth: OIDC caller not in allowlist');
        res.status(403).json({ error: 'Caller not allowed' });
        return;
      }
      next();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'scheduler-auth: OIDC verification failed');
      res.status(401).json({ error: 'Invalid OIDC token' });
    }
  };
}
