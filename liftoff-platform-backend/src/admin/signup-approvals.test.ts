// Endpoint tests for the admin signup-approval routes — exercises the real
// handler logic through the mounted router (supertest, fully mocked deps — no
// DB, so this is a regular *.test.ts, not a DB-backed *.integration.test.ts):
// token→status mapping (410/400/404), the { data, audit } envelope, idempotent
// approve (+ welcome re-send), and the waitlist-never-revokes guard.
//
// Leaf deps are module-mocked; AccountService/AccountRepository are spied on
// their prototypes (real classes, so no missing-export risk), and the router's
// admin auth is bypassed with an injected platform-admin account.

const mockAdminAuth = jest.fn((req: { adminAccount?: unknown }, _res: unknown, next: () => void) => {
  req.adminAccount = { id: 'admin-1', email: 'admin@example.com', isPlatformAdmin: true };
  next();
});
const mockLogAdminAction = jest.fn();
const mockVerify = jest.fn();
const mockSendWelcome = jest.fn();

jest.mock('./middleware', () => ({
  adminAuthMiddleware: (req: unknown, res: unknown, next: () => void) =>
    (mockAdminAuth as unknown as (...a: unknown[]) => void)(req, res, next),
  logAdminAction: (...a: unknown[]) => mockLogAdminAction(...a),
}));
jest.mock('../accounts/signup-approval-tokens', () => ({
  verifySignupApprovalToken: (...a: unknown[]) => mockVerify(...a),
  buildSignupApprovalToken: jest.fn(),
}));
jest.mock('../infrastructure/email', () => ({
  ...jest.requireActual('../infrastructure/email'),
  sendWelcomeEmail: (...a: unknown[]) => mockSendWelcome(...a),
}));
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
  withAdminScope: jest.fn(),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('./service', () => ({ AdminService: jest.fn().mockImplementation(() => ({})) }));

import express from 'express';
import request from 'supertest';
import { adminRouter } from './router';
import { AccountService } from '../accounts/service';
import { AccountRepository } from '../accounts/repository';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const ACCOUNT = {
  id: 'acc-1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@acme.com',
  accessStatus: 'pending' as const,
};

let getById: jest.SpyInstance;
let computeAccess: jest.SpyInstance;
let setAccessStatus: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockLogAdminAction.mockResolvedValue({ actionId: 'audit-1' });
  mockSendWelcome.mockResolvedValue('email-id');
  getById = jest.spyOn(AccountService.prototype, 'getById').mockResolvedValue(ACCOUNT as never);
  computeAccess = jest
    .spyOn(AccountService.prototype, 'computeAccess')
    .mockResolvedValue({ accessGranted: false, accessReason: null });
  setAccessStatus = jest
    .spyOn(AccountRepository.prototype, 'setAccessStatus')
    .mockResolvedValue(ACCOUNT as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GET /api/admin/signup-approvals/:token', () => {
  it('returns the signup metadata in the { data } envelope for a valid token', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'acc-1' });

    const res = await request(makeApp()).get('/api/admin/signup-approvals/tok');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@acme.com',
      accessGranted: false,
    });
    expect(getById).toHaveBeenCalledWith('acc-1');
    expect(computeAccess).toHaveBeenCalled();
  });

  it('returns 410 for an expired token', async () => {
    mockVerify.mockReturnValue({ ok: false, reason: 'expired' });
    const res = await request(makeApp()).get('/api/admin/signup-approvals/tok');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('token_expired');
  });

  it('returns 400 for an invalid token', async () => {
    mockVerify.mockReturnValue({ ok: false, reason: 'invalid' });
    const res = await request(makeApp()).get('/api/admin/signup-approvals/tok');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('token_invalid');
  });

  it('returns 404 when the account no longer exists', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'gone' });
    getById.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/admin/signup-approvals/tok');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account_not_found');
  });
});

describe('POST /api/admin/signup-approvals/approve', () => {
  it('grants access, sends the welcome, and audits — for a pending account', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'acc-1' });

    const res = await request(makeApp())
      .post('/api/admin/signup-approvals/approve')
      .send({ token: 'tok' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ approved: true, alreadyApproved: false });
    expect(setAccessStatus).toHaveBeenCalledWith('acc-1', 'approved', 'admin-1');
    expect(mockSendWelcome).toHaveBeenCalledWith('jane@acme.com', 'Jane');
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      'admin-1',
      'account.signup_approval.approve',
      'account',
      'acc-1',
      { email: 'jane@acme.com' },
      expect.anything(),
    );
  });

  it('is idempotent: an already-approved account skips the grant + audit but STILL re-sends the welcome', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'acc-1' });
    getById.mockResolvedValue({ ...ACCOUNT, accessStatus: 'approved' } as never);

    const res = await request(makeApp())
      .post('/api/admin/signup-approvals/approve')
      .send({ token: 'tok' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ approved: true, alreadyApproved: true });
    expect(setAccessStatus).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
    expect(mockSendWelcome).toHaveBeenCalledWith('jane@acme.com', 'Jane');
  });

  it('propagates a welcome-email failure as 500 (grant already committed → retryable)', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'acc-1' });
    mockSendWelcome.mockRejectedValue(new Error('resend down'));

    const res = await request(makeApp())
      .post('/api/admin/signup-approvals/approve')
      .send({ token: 'tok' });

    expect(res.status).toBe(500);
    expect(setAccessStatus).toHaveBeenCalledWith('acc-1', 'approved', 'admin-1');
  });

  it('rejects a missing token body with 400 (zod validation)', async () => {
    const res = await request(makeApp())
      .post('/api/admin/signup-approvals/approve')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/signup-approvals/waitlist', () => {
  it('waitlists + audits a pending account', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'acc-1' });

    const res = await request(makeApp())
      .post('/api/admin/signup-approvals/waitlist')
      .send({ token: 'tok' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ waitlisted: true });
    expect(setAccessStatus).toHaveBeenCalledWith('acc-1', 'waitlisted', 'admin-1');
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      'admin-1',
      'account.signup_approval.waitlist',
      'account',
      'acc-1',
      { email: 'jane@acme.com' },
      expect.anything(),
    );
  });

  it('never revokes an already-approved account (no-op)', async () => {
    mockVerify.mockReturnValue({ ok: true, accountId: 'acc-1' });
    getById.mockResolvedValue({ ...ACCOUNT, accessStatus: 'approved' } as never);

    const res = await request(makeApp())
      .post('/api/admin/signup-approvals/waitlist')
      .send({ token: 'tok' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ waitlisted: false, alreadyApproved: true });
    expect(setAccessStatus).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
