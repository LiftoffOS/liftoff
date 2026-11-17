// PUT /keys/:keyId — the name and description a person writes on a
// coding-tool connection. The route used to answer 200 and write nothing;
// it now writes a profile row (migration 478), and only for a connection the
// workspace owns.

import express from 'express';

const mockBelongs = jest.fn();
const mockUpsert = jest.fn();
let membership: { role: string } | null = { role: 'admin' };

jest.mock('../../infrastructure/middleware', () => ({
  tenantAuthMiddleware: () => (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { membership: unknown; actorAccountId: string }).membership = membership;
    (req as unknown as { membership: unknown; actorAccountId: string }).actorAccountId = 'acc-1';
    next();
  },
}));
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../accounts/service', () => ({ AccountService: jest.fn(() => ({})) }));
jest.mock('../service', () => ({
  connectionBelongsToTenant: (...args: unknown[]) => mockBelongs(...args),
}));
jest.mock('../developer-proxy-client', () => ({
  isDevProxyEnabled: () => true,
  DevProxyClientError: class extends Error {},
}));
jest.mock('../../workforce/connection-profiles', () => ({
  upsertConnectionProfile: (...args: unknown[]) => mockUpsert(...args),
}));

import { claudeCodeProxyRouter } from '../router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CONNECTION_ID = '22222222-2222-2222-2222-222222222222';

async function put(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use(claudeCodeProxyRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

beforeEach(() => {
  jest.clearAllMocks();
  membership = { role: 'admin' };
  mockBelongs.mockResolvedValue(true);
  mockUpsert.mockImplementation(async (opts: { name?: string | null; description?: string | null }) => ({
    name: opts.name ?? null,
    description: opts.description ?? null,
  }));
});

describe('PUT /keys/:keyId', () => {
  it('writes the profile for a connection the workspace owns and answers with it', async () => {
    const res = await put(`/keys/${CONNECTION_ID}`, { tenantId: TENANT_ID, name: '  Alex (Codex)  ', description: 'Reviews pull requests' });
    expect(res.status).toBe(200);
    expect(mockBelongs).toHaveBeenCalledWith(CONNECTION_ID, TENANT_ID, 'acc-1');
    expect(mockUpsert).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      connectionId: CONNECTION_ID,
      updatedBy: 'acc-1',
      name: 'Alex (Codex)',
      description: 'Reviews pull requests',
    });
    expect(res.body).toEqual({ id: CONNECTION_ID, tenantId: TENANT_ID, name: 'Alex (Codex)', description: 'Reviews pull requests' });
  });

  it('leaves a field alone when it is absent and clears it when it is null', async () => {
    await put(`/keys/${CONNECTION_ID}`, { tenantId: TENANT_ID, description: null });
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ name: undefined, description: null }));
  });

  it('answers 404 for a connection that is not the workspace\'s, writing nothing', async () => {
    mockBelongs.mockResolvedValue(false);
    const res = await put(`/keys/${CONNECTION_ID}`, { tenantId: TENANT_ID, name: 'x' });
    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('answers 404 for an id that is not a UUID, before any lookup', async () => {
    const res = await put('/keys/not-a-uuid', { tenantId: TENANT_ID, name: 'x' });
    expect(res.status).toBe(404);
    expect(mockBelongs).not.toHaveBeenCalled();
  });

  it('rejects an empty name', async () => {
    const res = await put(`/keys/${CONNECTION_ID}`, { tenantId: TENANT_ID, name: '   ' });
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
