// One test per security invariant in docs/support-delegation-plan.md section 5.
// These are the tests that stop this feature becoming a way into every
// customer's workspace, so they are written as claims about what CANNOT happen.

import type { Request, Response, NextFunction } from 'express';

jest.mock('../repository', () => ({ findByTicketHash: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  logAudit: jest.fn(),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { findByTicketHash } from '../repository';
import { logAudit } from '../../infrastructure/logging';
import { supportDelegationMiddleware } from '../middleware';
import { hashTicket } from '../ticket';
import { DELEGATION_HEADER } from '../types';

const findMock = findByTicketHash as jest.MockedFunction<typeof findByTicketHash>;
const auditMock = logAudit as jest.MockedFunction<typeof logAudit>;

const ACTOR_UID = 'firebase-uid-admin';
const TARGET_UID = 'firebase-uid-paul';
const TICKET = 'ticket-abc';

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    actor_account_id: 'acct-admin',
    target_account_id: 'acct-paul',
    ended_at: null,
    actor_firebase_uid: ACTOR_UID,
    actor_email: 'person@example.com',
    actor_is_platform_admin: true,
    target_firebase_uid: TARGET_UID,
    target_email: 'paul.drummond@northwind.com',
    target_is_platform_admin: false,
    ...overrides,
  };
}

function buildReq(opts: { ticket?: string; uid?: string; method?: string; path?: string } = {}) {
  return {
    headers: opts.ticket ? { [DELEGATION_HEADER]: opts.ticket } : {},
    method: opts.method ?? 'GET',
    path: opts.path ?? '/tenants',
    user: opts.uid ? { uid: opts.uid, emailVerified: true } : undefined,
    ctx: { requestId: 'req-1', userId: opts.uid },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as unknown as Request;
}

function buildRes() {
  const finishHandlers: Array<() => void> = [];
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn(),
    // Captured rather than ignored: the per-request audit row is written on
    // 'finish', so a test that cannot fire it cannot see the row at all.
    on(event: string, cb: () => void) {
      if (event === 'finish') finishHandlers.push(cb);
      return this;
    },
    finish() {
      finishHandlers.forEach((cb) => cb());
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: { code?: string };
    finish: () => void;
  };
}

describe('supportDelegationMiddleware', () => {
  beforeEach(() => {
    findMock.mockReset();
    auditMock.mockReset();
  });

  it('is a no-op when no ticket is present (invariant 10)', async () => {
    const req = buildReq({ uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user?.uid).toBe(ACTOR_UID);
    expect(req.delegation).toBeUndefined();
    expect(findMock).not.toHaveBeenCalled();
  });

  it('rejects a ticket presented without authentication (invariant 1)', async () => {
    const req = buildReq({ ticket: TICKET });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('DELEGATION_INVALID');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an unknown ticket', async () => {
    findMock.mockResolvedValueOnce(null);
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(findMock).toHaveBeenCalledWith(hashTicket(TICKET));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a revoked session on the very next request (invariant 3)', async () => {
    findMock.mockResolvedValueOnce(validRow({ ended_at: new Date() }));
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('has no expiry: a session runs until it is ended', async () => {
    // Sessions are bounded by revocation and by the tab closing, not by a
    // clock. A support session that dies mid-repair is worse than one that
    // outlives its usefulness.
    findMock.mockResolvedValueOnce(validRow({ created_at: new Date('2020-01-01') }));
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user?.uid).toBe(TARGET_UID);
  });

  it('rejects a ticket presented by anyone but the admin it was issued to (invariant 2)', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: 'firebase-uid-someone-else' });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects once the granting admin is no longer a platform admin (invariant 4)', async () => {
    findMock.mockResolvedValueOnce(validRow({ actor_is_platform_admin: false }));
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses to act as another platform admin (invariant 6)', async () => {
    findMock.mockResolvedValueOnce(validRow({ target_is_platform_admin: true }));
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('DELEGATION_FORBIDDEN');
    expect(next).not.toHaveBeenCalled();
  });

  it('cannot reach platform administration through a customer identity (invariant 5)', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID, method: 'POST', path: '/admin/kill-switch/tenant/x/disable' });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('audits a denied attempt rather than failing silently (invariant 7)', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID, method: 'POST', path: '/admin/support-delegation' });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      'support_delegation.denied',
      expect.anything(),
      expect.objectContaining({ attempted: 'POST /admin/support-delegation' }),
    );
  });

  it('lets a support session dispatch agent runs and issue workspace credentials', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID, method: 'POST', path: '/claude-code-proxy/mcp-tokens' });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user?.uid).toBe(TARGET_UID);
  });

  it('fails closed when the session lookup throws', async () => {
    findMock.mockRejectedValueOnce(new Error('db down'));
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rewrites the effective identity and keeps the actor for audit', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await supportDelegationMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);

    // Answered as Paul: this is what all ~214 downstream call sites read.
    expect(req.user?.uid).toBe(TARGET_UID);
    expect(req.user?.email).toBe('paul.drummond@northwind.com');
    expect(req.ctx.userId).toBe(TARGET_UID);

    // The operator survives the rewrite. Losing this is the whole failure mode
    // delegation exists to prevent.
    expect(req.delegation).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        actorAccountId: 'acct-admin',
        targetAccountId: 'acct-paul',
      }),
    );
    expect(req.ctx.actorUserId).toBe(ACTOR_UID);
    expect(req.ctx.delegationSessionId).toBe('session-1');
    expect(res.setHeader).toHaveBeenCalledWith('x-delegated', 'session-1');
  });

  it('records the operator account for audit_log.impersonated_by', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    const res = buildRes();

    await supportDelegationMiddleware(req, res, jest.fn());

    // The FK column is accounts(id), so the Firebase uid would be the wrong
    // identifier here even though it names the same person.
    expect(req.ctx.impersonatedBy).toBe('acct-admin');
  });

  it('writes an audit row for every mutating request, not just the session boundaries', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID, method: 'POST', path: '/internal-agents' });
    const res = buildRes();

    await supportDelegationMiddleware(req, res, jest.fn());
    expect(auditMock).not.toHaveBeenCalled(); // nothing until the response lands

    res.statusCode = 201;
    res.finish();

    expect(auditMock).toHaveBeenCalledWith(
      'support_delegation.request',
      expect.anything(),
      expect.objectContaining({
        method: 'POST',
        path: '/internal-agents',
        status: 201,
        actorAccountId: 'acct-admin',
        targetAccountId: 'acct-paul',
      }),
    );
  });

  it('records a rejected write too, because an attempt is still an action taken', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID, method: 'DELETE', path: '/connections/x' });
    const res = buildRes();

    await supportDelegationMiddleware(req, res, jest.fn());
    res.statusCode = 409;
    res.finish();

    expect(auditMock).toHaveBeenCalledWith(
      'support_delegation.request',
      expect.anything(),
      expect.objectContaining({ status: 409 }),
    );
  });

  it('does not audit reads, which would bury the writes under noise', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID, method: 'GET', path: '/tenants' });
    const res = buildRes();

    await supportDelegationMiddleware(req, res, jest.fn());
    res.statusCode = 200;
    res.finish();

    expect(auditMock).not.toHaveBeenCalled();
  });

  it('does not carry the operator\'s own token properties onto the target', async () => {
    findMock.mockResolvedValueOnce(validRow());
    const req = buildReq({ ticket: TICKET, uid: ACTOR_UID });
    (req.user as { displayName?: string }).displayName = 'Alex Rivera';
    const res = buildRes();

    await supportDelegationMiddleware(req, res, jest.fn());

    expect(req.user?.displayName).toBeUndefined();
  });
});
