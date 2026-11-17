// The identity rewrite. This is the whole feature.
//
// Mounted immediately after authMiddleware and before accessGateMiddleware
// (index.ts). authMiddleware has already verified the OPERATOR's Firebase
// token; this middleware decides whether the request should be answered as
// somebody else, and if so swaps the effective identity while keeping the
// operator on the request as `req.delegation`.
//
// Why one middleware is enough: roughly 214 downstream call sites resolve the
// caller the same way, `getByFirebaseUid(req.ctx.userId)` to an account and
// then a tenant_members check. None of them can tell, and none of them change.
// tenant-runtime never verifies user tokens at all, so this service is the only
// place the swap has to happen.
//
// Before accessGateMiddleware on purpose: the gate then evaluates the TARGET's
// access state, so a customer stuck behind it is reproducible instead of being
// something the operator sails straight past.

import type { Request, Response, NextFunction } from 'express';
import { logAudit } from '../infrastructure/logging';
import { findByTicketHash } from './repository';
import { hashTicket } from './ticket';
import { denialReason } from './deny-list';
import {
  DELEGATION_HEADER,
  DELEGATION_RESPONSE_HEADER,
  DELEGATION_INVALID,
  DELEGATION_FORBIDDEN,
} from './types';

/** Anything that can change state. GET/HEAD/OPTIONS are excluded: a support
 *  session reads constantly, and a row per read would bury the writes that
 *  actually matter under noise. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function reject(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  logDetail: Record<string, unknown>,
): void {
  req.log?.warn({ event: 'delegation_rejected', code, ...logDetail }, 'Support delegation rejected');
  res.status(status).json({
    error: status === 401 ? 'Unauthorized' : 'Forbidden',
    message,
    code,
    requestId: req.ctx?.requestId,
  });
}

export async function supportDelegationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers[DELEGATION_HEADER];
  const ticket = typeof header === 'string' ? header.trim() : '';

  // No header is the overwhelmingly common case: behaviour must be identical to
  // not having this middleware at all.
  if (!ticket) return next();

  const callerUid = req.user?.uid;
  if (!callerUid) {
    return reject(req, res, 401, DELEGATION_INVALID, 'Authentication required', {});
  }

  let session;
  try {
    session = await findByTicketHash(hashTicket(ticket));
  } catch (err) {
    // Fail CLOSED. A lookup failure means we cannot prove this request is
    // allowed to act as somebody else, and continuing would answer it as the
    // operator against a UI that believes it is showing the customer.
    req.log?.error({ err: (err as Error).message }, 'Delegation lookup failed');
    return reject(req, res, 401, DELEGATION_INVALID, 'Support session unavailable', {});
  }

  if (!session) {
    return reject(req, res, 401, DELEGATION_INVALID, 'Support session not found', {});
  }
  if (session.ended_at !== null) {
    return reject(req, res, 401, DELEGATION_INVALID, 'Support session has ended', {
      sessionId: session.id,
    });
  }
  // The ticket is a bearer secret, so it is only half of the credential. This
  // is the other half: it must be presented by the token it was issued to. A
  // ticket leaked out of a URL bar, a screen share or a log is useless to
  // anybody else.
  if (session.actor_firebase_uid !== callerUid) {
    return reject(req, res, 401, DELEGATION_INVALID, 'Support session not valid for this account', {
      sessionId: session.id,
    });
  }

  // Re-checked per request, not just at grant time, so revoking someone's
  // platform-admin status kills their open sessions on the next call.
  if (session.actor_is_platform_admin !== true) {
    return reject(req, res, 401, DELEGATION_INVALID, 'Support session not valid for this account', {
      sessionId: session.id,
    });
  }

  // No admin may act as another admin. Delegation exists to reach a customer's
  // view, and admin-to-admin would only ever muddy who did what.
  if (session.target_is_platform_admin === true) {
    return reject(req, res, 403, DELEGATION_FORBIDDEN, 'Cannot act as another platform admin', {
      sessionId: session.id,
    });
  }

  const denied = denialReason(req.method, req.path);
  if (denied) {
    logAudit('support_delegation.denied', req.ctx, {
      sessionId: session.id,
      actorAccountId: session.actor_account_id,
      targetAccountId: session.target_account_id,
      attempted: `${req.method} ${req.path}`,
      why: denied,
    });
    return reject(req, res, 403, DELEGATION_FORBIDDEN, `Not permitted while acting as another person: ${denied}`, {
      sessionId: session.id,
    });
  }

  // ── The rewrite ───────────────────────────────────────────────────────────
  // Everything downstream reads req.user.uid or req.ctx.userId. Both move to
  // the target; the operator survives on req.delegation and in ctx.actorUserId
  // so no log line or audit row loses them.
  req.delegation = {
    sessionId: session.id,
    actorAccountId: session.actor_account_id,
    actorEmail: session.actor_email,
    targetAccountId: session.target_account_id,
  };

  // Rebuilt rather than spread, because the fields that do NOT belong to the
  // target must not survive from the operator's token.
  //
  // emailVerified/signInProvider are a deliberate, stated compromise. They are
  // Firebase token properties, and we hold no copy of the target's: `accounts`
  // has no email_verified column. Reflecting them faithfully would mean a
  // getUser() round trip to Firebase on every delegated request, and a hard
  // dependency on Firebase being up for delegation to work at all.
  //
  // The blast radius of getting this wrong is small and known.
  // requireVerifiedEmail (auth/requireVerifiedEmail.ts) blocks only when
  // signInProvider === 'password' AND !emailVerified, and it guards exactly two
  // routes: POST /accounts (the target already exists, so it cannot apply) and
  // PUT /accounts/me. So the effect is that a support session may edit the
  // profile of a target whose password email is unverified, which is a thing
  // support should be able to do.
  //
  // The frontend has the same blind spot in ProtectedRoute, and there it
  // matters more; see section 4.5 of docs/support-delegation-plan.md.
  req.user = {
    uid: session.target_firebase_uid,
    email: session.target_email ?? undefined,
    emailVerified: true,
    signInProvider: undefined,
  };

  if (req.ctx) {
    req.ctx.userId = session.target_firebase_uid;
    req.ctx.actorUserId = session.actor_firebase_uid;
    req.ctx.delegationSessionId = session.id;
    // Rides into audit_log.impersonated_by on every row this request produces,
    // so the customer's own audit export can distinguish what support did from
    // what they did. See migration 407.
    req.ctx.impersonatedBy = session.actor_account_id;
  }

  // Makes a response self-identifying in a network panel or a captured trace.
  res.setHeader(DELEGATION_RESPONSE_HEADER, session.id);

  req.log?.info(
    {
      event: 'delegation_active',
      sessionId: session.id,
      actorAccountId: session.actor_account_id,
      targetAccountId: session.target_account_id,
    },
    'Request answered under support delegation',
  );

  // Every write gets its own audit row, not just the session boundaries.
  //
  // Knowing a session was open for an hour says nothing about what happened
  // inside it. Individual handlers do emit their own audit rows, but only where
  // somebody remembered to, and those rows describe the change rather than the
  // fact that support made it. This is the independent record: one row per
  // mutating request, whatever the handler did or did not log.
  //
  // On 'finish' so the status is known. A rejected write is still an action
  // taken and is recorded as one.
  if (MUTATING_METHODS.has(req.method.toUpperCase())) {
    const delegation = req.delegation;
    res.on('finish', () => {
      logAudit('support_delegation.request', req.ctx, {
        sessionId: delegation.sessionId,
        actorAccountId: delegation.actorAccountId,
        targetAccountId: delegation.targetAccountId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    });
  }

  next();
}
