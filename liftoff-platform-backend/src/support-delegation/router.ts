// Grant, list and revoke support delegation sessions.
//
// Mounted on adminRouter, so adminAuthMiddleware has already established that
// the caller is a platform admin and left `req.adminAccount` on the request.
// Follows the PR 0 admin conventions: { data, audit } on success,
// { error, detail?, field? } on failure, zod for shape, handlers for
// business invariants.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool } from '../infrastructure/database';
import { frontendUrl } from '../infrastructure/frontend-url';
import { logAudit } from '../infrastructure/logging';
import { logAdminAction } from '../admin/middleware';
import { adminError, wrapAdminResponse } from '../admin/conventions';
import { validateRequest, type ValidatedRequest } from '../admin/validate-request';
import { createSession, endSession, listForActor } from './repository';
import { mintTicket } from './ticket';

export const supportDelegationRouter = Router();

/** How stale the operator's last real sign-in may be when opening a session.
 *
 *  A standing admin session must not be enough on its own: an unattended laptop
 *  or a stolen refresh token would otherwise open any customer's workspace.
 *  auth_time only moves when a person actually authenticates, so this forces a
 *  deliberate act at the moment access is granted.
 *
 *  Thirty minutes rather than five: five still ruled out the unattended-laptop
 *  case but made the operator sign out and back in for almost every session,
 *  which is the kind of friction that gets a control removed altogether. This
 *  window is the only checkpoint on the whole feature, because a granted
 *  session has no expiry, so it is worth keeping tolerable. */
const STEP_UP_MAX_AGE_SECONDS = 30 * 60;

const createSchema = {
  body: z.object({
    targetEmail: z.string().email(),
    // Free text, but required and non-trivial. "why were you in my workspace"
    // is the question this answers months later.
    reason: z.string().trim().min(10).max(500),
  }),
};

type CreateRequest = ValidatedRequest<typeof createSchema>;

function adminAccountOf(req: Request): { id: string; email: string } | undefined {
  return (req as Request & { adminAccount?: { id: string; email: string } }).adminAccount;
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

supportDelegationRouter.post('/', validateRequest(createSchema), async (req: Request, res: Response) => {
  const admin = adminAccountOf(req);
  if (!admin) {
    res.status(401).json(adminError('UNAUTHORIZED', 'Admin identity missing'));
    return;
  }

  const { targetEmail, reason } = (req as CreateRequest).validated.body;

  // Step-up. Checked before anything else so a stale session cannot even probe
  // which email addresses exist.
  const authTime = req.user?.authTime;
  if (typeof authTime !== 'number' || Date.now() / 1000 - authTime > STEP_UP_MAX_AGE_SECONDS) {
    logAudit('support_delegation.step_up_required', req.ctx, {
      adminAccountId: admin.id,
      targetEmail,
    });
    res.status(401).json(
      adminError(
        'REAUTHENTICATION_REQUIRED',
        'Sign in again before opening a support session. A recent sign-in is required.',
      ),
    );
    return;
  }

  const targetResult = await getPool().query<{ id: string; is_platform_admin: boolean }>(
    `SELECT id, is_platform_admin FROM accounts WHERE LOWER(email) = LOWER($1)`,
    [targetEmail],
  );
  const target = targetResult.rows[0];
  if (!target) {
    res.status(404).json(adminError('ACCOUNT_NOT_FOUND', 'No account with that email', 'targetEmail'));
    return;
  }
  if (target.id === admin.id) {
    res.status(400).json(adminError('SELF_DELEGATION', 'You cannot act as yourself', 'targetEmail'));
    return;
  }
  // Enforced here as well as per-request so the operator is told at the moment
  // they ask, rather than getting a session that 403s on everything.
  if (target.is_platform_admin === true) {
    res.status(403).json(
      adminError('TARGET_IS_ADMIN', 'Cannot act as another platform admin', 'targetEmail'),
    );
    return;
  }

  const { ticket, ticketHash } = mintTicket();
  const session = await createSession({
    ticketHash,
    actorAccountId: admin.id,
    targetAccountId: target.id,
    reason,
    ipAddress: clientIp(req),
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  });

  const audit = await logAdminAction(
    admin.id,
    'support_delegation.session.granted',
    'account',
    target.id,
    { sessionId: session.id, targetEmail, reason },
    req,
  );

  // The ticket is returned exactly once and never stored in recoverable form.
  // Losing it means granting a new session, which is the correct cost.
  res.status(201).json(
    wrapAdminResponse(
      {
        sessionId: session.id,
        ticket,
        actUrl: `${frontendUrl()}/act-as?ticket=${encodeURIComponent(ticket)}`,
        targetEmail,
      },
      audit,
    ),
  );
});

const idSchema = { params: z.object({ id: z.string().uuid() }) };

supportDelegationRouter.delete('/:id', validateRequest(idSchema), async (req: Request, res: Response) => {
  const admin = adminAccountOf(req);
  if (!admin) {
    res.status(401).json(adminError('UNAUTHORIZED', 'Admin identity missing'));
    return;
  }
  const { id } = (req as ValidatedRequest<typeof idSchema>).validated.params;

  const ended = await endSession(id, admin.id);
  // Idempotent: an already-ended session is the state the caller asked for.
  const audit = await logAdminAction(
    admin.id,
    'support_delegation.session.ended',
    'support_delegation_session',
    id,
    { alreadyEnded: !ended },
    req,
  );
  res.json(wrapAdminResponse({ sessionId: id, ended: true }, audit));
});

supportDelegationRouter.get('/', async (req: Request, res: Response) => {
  const admin = adminAccountOf(req);
  if (!admin) {
    res.status(401).json(adminError('UNAUTHORIZED', 'Admin identity missing'));
    return;
  }
  const rows = await listForActor(admin.id);
  res.json(
    wrapAdminResponse(
      rows.map((r) => ({
        sessionId: r.id,
        targetEmail: r.target_email,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
        endedAt: r.ended_at ? r.ended_at.toISOString() : null,
        active: r.ended_at === null,
      })),
      null,
    ),
  );
});
