// Endpoint tests for the admin signup-preapproval routes (the guest list).
//
// Same shape as signup-approvals.test.ts — supertest through the mounted
// router, leaf deps module-mocked, service/repository classes spied on their
// prototypes, admin auth bypassed with an injected platform admin.
//
// The branch worth the most here is the one that is easy to get wrong: adding
// an address that ALREADY has an account. A pre-approval row is only ever read
// at account-creation time, so for an existing account it would sit unspent
// forever while the operator believed they had let someone in.

const mockAdminAuth = jest.fn((req: { adminAccount?: unknown }, _res: unknown, next: () => void) => {
  req.adminAccount = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.com', isPlatformAdmin: true };
  next();
});
const mockLogAdminAction = jest.fn();
const mockSendWelcome = jest.fn();

jest.mock('./middleware', () => ({
  adminAuthMiddleware: (req: unknown, res: unknown, next: () => void) =>
    (mockAdminAuth as unknown as (...a: unknown[]) => void)(req, res, next),
  logAdminAction: (...a: unknown[]) => mockLogAdminAction(...a),
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
import { SignupPreapprovalRepository } from '../accounts/signup-preapprovals';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

const ENTRY = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'person@example.com',
  note: 'prospect',
  addedBy: ADMIN_ID,
  createdAt: new Date('2026-08-08T00:00:00Z'),
  consumedAt: null,
  consumedAccountId: null,
};

const ACCOUNT = {
  id: 'acc-1',
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'person@example.com',
  accessStatus: 'pending' as const,
};

let getByEmail: jest.SpyInstance;
let computeAccess: jest.SpyInstance;
let setAccessStatus: jest.SpyInstance;
let add: jest.SpyInstance;
let listAll: jest.SpyInstance;
let revoke: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockLogAdminAction.mockResolvedValue({ actionId: 'audit-1' });
  mockSendWelcome.mockResolvedValue('email-id');
  getByEmail = jest.spyOn(AccountService.prototype, 'getByEmail').mockResolvedValue(null);
  computeAccess = jest
    .spyOn(AccountService.prototype, 'computeAccess')
    .mockResolvedValue({ accessGranted: false, accessReason: null });
  setAccessStatus = jest
    .spyOn(AccountRepository.prototype, 'setAccessStatus')
    .mockResolvedValue(ACCOUNT as never);
  add = jest
    .spyOn(SignupPreapprovalRepository.prototype, 'add')
    .mockResolvedValue({ entry: ENTRY, created: true });
  listAll = jest.spyOn(SignupPreapprovalRepository.prototype, 'listAll').mockResolvedValue([ENTRY]);
  revoke = jest.spyOn(SignupPreapprovalRepository.prototype, 'revoke').mockResolvedValue(ENTRY);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/admin/signup-preapprovals', () => {
  it('adds an address nobody has signed up with yet', async () => {
    const res = await request(makeApp())
      .post('/api/admin/signup-preapprovals')
      .send({ email: 'person@example.com', note: 'prospect' });

    expect(res.status).toBe(201);
    expect(res.body.data.mode).toBe('preapproved');
    expect(res.body.data.created).toBe(true);
    expect(add).toHaveBeenCalledWith('person@example.com', ADMIN_ID, 'prospect');
    expect(res.body.audit).toEqual({ actionId: 'audit-1' });
    // Nobody's access changed — there is no account to change yet.
    expect(setAccessStatus).not.toHaveBeenCalled();
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it('normalizes the address before storing it', async () => {
    await request(makeApp())
      .post('/api/admin/signup-preapprovals')
      .send({ email: '  person@example.com  ' });

    // Both the account lookup and the insert see the normalized form, or a
    // mixed-case entry would sit in the list looking live and never match.
    expect(getByEmail).toHaveBeenCalledWith('person@example.com');
    expect(add).toHaveBeenCalledWith('person@example.com', ADMIN_ID, null);
  });

  it('is idempotent when a live entry already exists', async () => {
    add.mockResolvedValue({ entry: ENTRY, created: false });

    const res = await request(makeApp())
      .post('/api/admin/signup-preapprovals')
      .send({ email: 'person@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    // No second audit row: the decision was already recorded the first time.
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it('approves outright when the person has already signed up and is blocked', async () => {
    getByEmail.mockResolvedValue(ACCOUNT);

    const res = await request(makeApp())
      .post('/api/admin/signup-preapprovals')
      .send({ email: 'person@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('approved_existing');
    expect(setAccessStatus).toHaveBeenCalledWith('acc-1', 'approved', ADMIN_ID);
    expect(mockSendWelcome).toHaveBeenCalledWith('person@example.com', 'Jane');
    // Crucially: no dead row left behind for an account that already exists.
    expect(add).not.toHaveBeenCalled();
  });

  it('does nothing when the existing account is already granted', async () => {
    getByEmail.mockResolvedValue(ACCOUNT);
    computeAccess.mockResolvedValue({ accessGranted: true, accessReason: 'domain' });

    const res = await request(makeApp())
      .post('/api/admin/signup-preapprovals')
      .send({ email: 'person@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('already_granted');
    expect(res.body.data.accessReason).toBe('domain');
    expect(setAccessStatus).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it('rejects a malformed address', async () => {
    const res = await request(makeApp())
      .post('/api/admin/signup-preapprovals')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/signup-preapprovals', () => {
  it('returns the list in the { data } envelope', async () => {
    const res = await request(makeApp()).get('/api/admin/signup-preapprovals');

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0].email).toBe('person@example.com');
    expect(listAll).toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/signup-preapprovals/:id', () => {
  it('revokes a live entry and audits it', async () => {
    const res = await request(makeApp()).delete(`/api/admin/signup-preapprovals/${ENTRY.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true, email: 'person@example.com' });
    expect(revoke).toHaveBeenCalledWith(ENTRY.id);
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      ADMIN_ID,
      'account.signup_preapproval.revoke',
      'account',
      null,
      { email: 'person@example.com' },
      expect.anything(),
    );
  });

  it('404s when the entry is missing or already spent', async () => {
    revoke.mockResolvedValue(null);
    const res = await request(makeApp()).delete(`/api/admin/signup-preapprovals/${ENTRY.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('preapproval_not_found');
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
