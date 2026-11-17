// Account profiles internal router tests.
//
// The interesting properties are all about access: only the workforce token
// gets in, and the lookup is always scoped to a tenant so it cannot be used to
// read the accounts table.

import express from 'express';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindProfilesByIds = jest.fn();
jest.mock('../accounts/repository', () => ({
  AccountRepository: jest.fn().mockImplementation(() => ({
    findProfilesByIds: mockFindProfilesByIds,
  })),
}));

import { accountProfilesInternalRouter } from './account-profiles-router';

const TOKEN = 'workforce-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';

const PROFILE = {
  accountId: ACCOUNT_ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/account-profiles', accountProfilesInternalRouter);
  return app;
}

function post(
  app: express.Express,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/account-profiles/profiles`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-service-auth': token } : {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const VALID_BODY = { tenantId: TENANT_ID, accountIds: [ACCOUNT_ID] };

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
  mockFindProfilesByIds.mockResolvedValue([PROFILE]);
});

afterEach(() => {
  delete process.env['WORKFORCE_SERVICE_TOKEN'];
});

describe('POST /api/internal/account-profiles/profiles', () => {
  it('401s without a service token, without touching the repository', async () => {
    const res = await post(buildApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockFindProfilesByIds).not.toHaveBeenCalled();
  });

  it('401s on a wrong service token', async () => {
    const res = await post(buildApp(), VALID_BODY, 'not-the-token');
    expect(res.status).toBe(401);
    expect(mockFindProfilesByIds).not.toHaveBeenCalled();
  });

  it('503s when no token is configured, rather than letting everything through', async () => {
    delete process.env['WORKFORCE_SERVICE_TOKEN'];
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(503);
    expect(mockFindProfilesByIds).not.toHaveBeenCalled();
  });

  it('400s without a tenant id — the tenant scope IS the access control', async () => {
    const res = await post(buildApp(), { accountIds: [ACCOUNT_ID] }, TOKEN);
    expect(res.status).toBe(400);
    expect(mockFindProfilesByIds).not.toHaveBeenCalled();
  });

  it('400s on an unbounded request', async () => {
    const tooMany = Array.from({ length: 101 }, () => ACCOUNT_ID);
    const res = await post(buildApp(), { tenantId: TENANT_ID, accountIds: tooMany }, TOKEN);
    expect(res.status).toBe(400);
    expect(mockFindProfilesByIds).not.toHaveBeenCalled();
  });

  it('returns the profiles, scoped to the requested tenant', async () => {
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ profiles: [PROFILE] });
    expect(mockFindProfilesByIds).toHaveBeenCalledWith(TENANT_ID, [ACCOUNT_ID]);
  });
});
