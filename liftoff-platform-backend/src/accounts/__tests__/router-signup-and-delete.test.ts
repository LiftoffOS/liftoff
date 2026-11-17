// POST /api/accounts and DELETE /api/accounts/:id.
//
// Signup while open (the `*` allow-list entry): a
// brand-new account is granted by the gate with nobody pressing Approve, so
// the welcome email that the Approve button would have sent is sent here.
// A preexisting account returned by the idempotency fallback is not a signup.

import express from 'express';

const mockCreate = jest.fn();
const mockGetByEmail = jest.fn();
const mockGetByFirebaseUid = jest.fn();
const mockGetById = jest.fn();
const mockDelete = jest.fn();
const mockToResponse = jest.fn();
const mockSendWelcome = jest.fn();
const mockSendSignupNotification = jest.fn();

jest.mock('../service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    create: (...a: unknown[]) => mockCreate(...a),
    getByEmail: (...a: unknown[]) => mockGetByEmail(...a),
    getByFirebaseUid: (...a: unknown[]) => mockGetByFirebaseUid(...a),
    getById: (...a: unknown[]) => mockGetById(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
    toResponse: (...a: unknown[]) => mockToResponse(...a),
  })),
}));
jest.mock('../../auth/requireVerifiedEmail', () => ({
  requireVerifiedEmail: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../infrastructure/email', () => ({
  sendSignupVerification: jest.fn(),
  sendSignupNotification: (...a: unknown[]) => mockSendSignupNotification(...a),
  sendWelcomeEmail: (...a: unknown[]) => mockSendWelcome(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../signup-approval-tokens', () => ({
  buildSignupApprovalToken: () => 'tok',
}));
jest.mock('../../referrals/service', () => ({
  ReferralService: jest.fn().mockImplementation(() => ({ bindOnAccountCreation: jest.fn() })),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: () => ({}) }));
jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn() },
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));

import { accountsRouter } from '../router';
import { _setCachedDomains, _stopRefreshTimer } from '../../config/allowedDomains';

const NEW_ACCOUNT = { id: 'acc-1', email: 'new@example.org', firstName: 'New', lastName: 'Person', accessStatus: null };
// The verified token the middleware would have put on the request.
const TOKEN_USER = { uid: 'fb-uid-1', email: 'new@example.org', emailVerified: true, signInProvider: 'google.com' };

async function call(
  method: 'POST' | 'DELETE',
  path: string,
  opts: { body?: Record<string, unknown>; user?: Record<string, unknown> | null; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.user !== null) (req as unknown as { user: unknown }).user = opts.user ?? TOKEN_USER;
    next();
  });
  app.use('/api/accounts', accountsRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      })
        .then(async (res) => {
          const json = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: json as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

async function signup(body: Record<string, unknown>): Promise<number> {
  return (await call('POST', '/api/accounts', { body })).status;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue(NEW_ACCOUNT);
  mockToResponse.mockResolvedValue({ ...NEW_ACCOUNT, accessGranted: true, accessReason: 'domain' });
});
afterAll(() => _stopRefreshTimer());

describe('POST /api/accounts with signup open', () => {
  it('welcomes a brand-new account that the open gate granted', async () => {
    _setCachedDomains(['*', 'example.com']);
    const status = await signup({ email: NEW_ACCOUNT.email, firstName: 'New' });
    expect(status).toBe(201);
    expect(mockSendWelcome).toHaveBeenCalledWith(NEW_ACCOUNT.email, 'New');
    // Granted signups get the button-less FYI, never Approve/Waitlist links.
    expect(mockSendSignupNotification).toHaveBeenCalledWith(expect.anything(), { pageUrl: undefined, alreadyGranted: true });
  });

  it('sends no welcome when signup is not open and nobody has approved', async () => {
    _setCachedDomains(['example.com']);
    mockToResponse.mockResolvedValue({ ...NEW_ACCOUNT, accessGranted: false, accessReason: null });
    await signup({ email: NEW_ACCOUNT.email, firstName: 'New' });
    expect(mockSendWelcome).not.toHaveBeenCalled();
    expect(mockSendSignupNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ alreadyGranted: false }));
  });

  it('sends no second welcome to a preexisting account returned by the idempotency fallback', async () => {
    _setCachedDomains(['*']);
    mockCreate.mockRejectedValue(new Error('duplicate key value violates unique constraint "accounts_email_key"'));
    mockGetByEmail.mockResolvedValue(NEW_ACCOUNT);
    const status = await signup({ email: NEW_ACCOUNT.email, firstName: 'New' });
    expect(status).toBe(201);
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounts binds the account to the verified token', () => {
  it('takes the uid from the token, whatever the body says', async () => {
    _setCachedDomains(['*']);
    await signup({ email: NEW_ACCOUNT.email, firstName: 'New', firebaseUid: 'someone-elses-uid' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ firebaseUid: 'fb-uid-1', email: NEW_ACCOUNT.email }));
  });

  it('refuses an address that is not the signed-in one', async () => {
    _setCachedDomains(['*']);
    const res = await call('POST', '/api/accounts', { body: { email: 'victim@example.com', firstName: 'New' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email_mismatch');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps the address the token carries, in the token\'s form', async () => {
    _setCachedDomains(['*']);
    await signup({ email: 'NEW@Example.org', firstName: 'New' });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ email: NEW_ACCOUNT.email }));
  });
});

describe('DELETE /api/accounts/:id', () => {
  const OWNER = { id: 'acc-1', email: NEW_ACCOUNT.email, isPlatformAdmin: false };
  const OTHER = { id: 'acc-2', email: 'other@example.org', isPlatformAdmin: false };
  const ADMIN = { id: 'acc-admin', email: 'admin@example.com', isPlatformAdmin: true };

  beforeEach(() => {
    mockDelete.mockResolvedValue(true);
  });

  it('lets the owner delete their own account, recording their account id', async () => {
    mockGetByFirebaseUid.mockResolvedValue(OWNER);
    mockGetById.mockResolvedValue(OWNER);
    const res = await call('DELETE', '/api/accounts/acc-1');
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith('acc-1', 'acc-1');
  });

  it('ignores a client header claiming admin: another person\'s account is forbidden', async () => {
    mockGetByFirebaseUid.mockResolvedValue(OWNER);
    mockGetById.mockResolvedValue(OTHER);
    const res = await call('DELETE', '/api/accounts/acc-2', { headers: { 'x-admin-role': 'true' } });
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('lets a platform admin (by their account row) delete another account', async () => {
    mockGetByFirebaseUid.mockResolvedValue(ADMIN);
    mockGetById.mockResolvedValue(OTHER);
    const res = await call('DELETE', '/api/accounts/acc-2');
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith('acc-2', 'acc-admin');
  });

  it('answers 401 when the token has no account', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    const res = await call('DELETE', '/api/accounts/acc-1');
    expect(res.status).toBe(401);
  });
});
