// DELETE /api/accounts/me + GET /api/accounts/me/deletion-preflight unit tests.
// Mocks AccountService, TenantMembersRepository, and getBillingAdminClient.

const mockGetByFirebaseUid = jest.fn();
const mockCascadeDelete = jest.fn();
const mockFindOwnedTenantIds = jest.fn();
const mockFindTenantsForAccount = jest.fn();
const mockFindAllByTenant = jest.fn();
const mockPreflightDeletion = jest.fn();

jest.mock('./service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
    cascadeDelete: mockCascadeDelete,
  })),
}));

jest.mock('../tenant-members/repository', () => ({
  TenantMembersRepository: jest.fn().mockImplementation(() => ({
    findOwnedTenantIds: mockFindOwnedTenantIds,
    findTenantsForAccount: mockFindTenantsForAccount,
    findAllByTenant: mockFindAllByTenant,
  })),
}));

jest.mock('../billing/billing-admin-client', () => ({
  getBillingAdminClient: jest.fn(() => ({
    preflightDeletion: mockPreflightDeletion,
  })),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { selfDeleteRouter } from './self-delete-router';

const FAKE_UID = 'firebase-uid-1';
const ACCOUNT = { id: 'acc-1', firebaseUid: FAKE_UID, email: 'a@b.com' };

function buildApp(uid?: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (uid) (req as Request & { user?: { uid: string } }).user = { uid };
    (req as Request & { ctx?: object }).ctx = {};
    next();
  });
  app.use('/api/accounts', selfDeleteRouter);
  return app;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('DELETE /api/accounts/me', () => {
  it('returns 401 if unauthenticated', async () => {
    const app = buildApp(undefined);
    const res = await (await import('supertest')).default(app).delete('/api/accounts/me');
    expect(res.status).toBe(401);
  });

  it('returns 409 has_active_subscription when preflight reports active sub', async () => {
    mockGetByFirebaseUid.mockResolvedValueOnce(ACCOUNT);
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: true, hasOutstandingInvoice: false });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).delete('/api/accounts/me');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('has_active_subscription');
    expect(mockCascadeDelete).not.toHaveBeenCalled();
  });

  it('returns 409 has_outstanding_invoice when preflight reports unpaid invoice', async () => {
    mockGetByFirebaseUid.mockResolvedValueOnce(ACCOUNT);
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: false, hasOutstandingInvoice: true });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).delete('/api/accounts/me');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('has_outstanding_invoice');
    expect(mockCascadeDelete).not.toHaveBeenCalled();
  });

  it('returns 200 and delegates to cascadeDelete with scrubMode: soft when preflight is clean', async () => {
    mockGetByFirebaseUid.mockResolvedValueOnce(ACCOUNT);
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: false, hasOutstandingInvoice: false });
    mockCascadeDelete.mockResolvedValueOnce({
      tenantsAffected: 1, stripeCustomerScrubbed: true, deletionLedgerRowId: 'led-1', connectorsRevoked: 0,
    });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).delete('/api/accounts/me');
    expect(res.status).toBe(200);
    expect(mockCascadeDelete).toHaveBeenCalledWith('acc-1', 'acc-1', expect.objectContaining({
      dryRun: false, scrubMode: 'soft', actorIsAccount: true,
    }));
  });
});

describe('GET /api/accounts/me/deletion-preflight', () => {
  beforeEach(() => {
    mockGetByFirebaseUid.mockResolvedValue(ACCOUNT);
  });

  it('returns 401 if unauthenticated', async () => {
    const app = buildApp(undefined);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.status).toBe(401);
  });

  it('sole user with no other workspaces returns all-zeros', async () => {
    mockFindOwnedTenantIds.mockResolvedValueOnce([]);
    mockFindTenantsForAccount.mockResolvedValueOnce([]);
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasActiveSubscription: false,
      hasOutstandingInvoice: false,
      orphanWorkspaceCount: 0,
      lostAccessCount: 0,
      memberOfWorkspaceCount: 0,
    });
  });

  it('owned workspace with 3 other members and no other owner returns orphan=1, lost=3', async () => {
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockFindTenantsForAccount.mockResolvedValueOnce([{ tenant_id: 't-1', role: 'owner' }]);
    mockFindAllByTenant.mockResolvedValueOnce([
      { account_id: ACCOUNT.id, role: 'owner' },
      { account_id: 'other-1', role: 'member' },
      { account_id: 'other-2', role: 'member' },
      { account_id: 'other-3', role: 'member' },
    ]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: false, hasOutstandingInvoice: false });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.body.orphanWorkspaceCount).toBe(1);
    expect(res.body.lostAccessCount).toBe(3);
  });

  it('owned workspace with another owner returns orphan=0 (workspace continues)', async () => {
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockFindTenantsForAccount.mockResolvedValueOnce([{ tenant_id: 't-1', role: 'owner' }]);
    mockFindAllByTenant.mockResolvedValueOnce([
      { account_id: ACCOUNT.id, role: 'owner' },
      { account_id: 'co-owner', role: 'owner' },
      { account_id: 'mem-1', role: 'member' },
    ]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: false, hasOutstandingInvoice: false });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.body.orphanWorkspaceCount).toBe(0);
    expect(res.body.lostAccessCount).toBe(0);
  });

  it('owned workspace with 0 other members returns orphan=0 (silent cascade)', async () => {
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockFindTenantsForAccount.mockResolvedValueOnce([{ tenant_id: 't-1', role: 'owner' }]);
    mockFindAllByTenant.mockResolvedValueOnce([
      { account_id: ACCOUNT.id, role: 'owner' },
    ]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: false, hasOutstandingInvoice: false });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.body.orphanWorkspaceCount).toBe(0);
  });

  it('memberOfWorkspaceCount counts tenants the user is in but does not own', async () => {
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-owner' }]);
    mockFindTenantsForAccount.mockResolvedValueOnce([
      { tenant_id: 't-owner', role: 'owner' },
      { tenant_id: 't-mem-1', role: 'member' },
      { tenant_id: 't-mem-2', role: 'admin' },
    ]);
    mockFindAllByTenant.mockResolvedValueOnce([{ account_id: ACCOUNT.id, role: 'owner' }]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: false, hasOutstandingInvoice: false });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.body.memberOfWorkspaceCount).toBe(2);
  });

  it('forwards hasActiveSubscription/hasOutstandingInvoice from the billing preflight', async () => {
    mockFindOwnedTenantIds.mockResolvedValueOnce([{ id: 't-1' }]);
    mockFindTenantsForAccount.mockResolvedValueOnce([{ tenant_id: 't-1', role: 'owner' }]);
    mockFindAllByTenant.mockResolvedValueOnce([{ account_id: ACCOUNT.id, role: 'owner' }]);
    mockPreflightDeletion.mockResolvedValueOnce({ hasActiveSubscription: true, hasOutstandingInvoice: true });
    const app = buildApp(FAKE_UID);
    const res = await (await import('supertest')).default(app).get('/api/accounts/me/deletion-preflight');
    expect(res.body.hasActiveSubscription).toBe(true);
    expect(res.body.hasOutstandingInvoice).toBe(true);
  });
});
