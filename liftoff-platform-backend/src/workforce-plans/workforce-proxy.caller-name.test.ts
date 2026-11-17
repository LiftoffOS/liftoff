// The dashboard's route to the Chief AI Officer carries the person's name.
//
// What matters here: the name comes from the authenticated account, in the
// one spelling every surface uses (accountDisplayName), URL-encoded on the
// wire; a client cannot supply one of its own; and an account with nothing
// but an email is named by it.

const mockGetByFirebaseUid = jest.fn();
jest.mock('../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...a: unknown[]) => mockGetByFirebaseUid(...a),
  })),
}));
jest.mock('../tenant-members/service', () => ({
  tenantMembersService: { getMembership: jest.fn().mockResolvedValue({ role: 'member' }) },
}));
jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({ Authorization: 'Bearer oidc' }),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import type { AddressInfo } from 'net';
import { createWorkforceProxyRouter } from './workforce-proxy';
import { accountDisplayName } from '../accounts/display-name';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const mockFetch = jest.fn();
// The proxy's outbound fetch is the mock; the test's own request to the local
// server has to use the real one.
const realFetch = globalThis.fetch;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware: the proxy reads req.user.uid.
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { uid: string } }).user = { uid: 'firebase-uid-1' };
    next();
  });
  app.use('/api/team-plan', createWorkforceProxyRouter({ targetBaseUrl: 'https://workforce.internal' }));
  return app;
}

async function post(headers: Record<string, string> = {}): Promise<Record<string, string>> {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await realFetch(`http://127.0.0.1:${port}/api/team-plan/chat-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ tenantId: TENANT_ID, threadId: '11111111-1111-4111-8111-111111111111', content: 'hi' }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
}

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as { fetch: unknown }).fetch = mockFetch;
  mockFetch.mockResolvedValue({
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    text: async () => '{}',
  });
});

describe('the caller name the proxy forwards', () => {
  it('is the account\'s name, URL-encoded, beside the three trusted headers', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: 'Zoë', lastName: '李', email: 'zoe@example.com' });

    const headers = await post();

    expect(headers['x-account-id']).toBe('acc-1');
    expect(headers['x-tenant-id']).toBe(TENANT_ID);
    expect(headers['x-tenant-role']).toBe('member');
    expect(headers['x-caller-name']).toBe(encodeURIComponent('Zoë 李'));
  });

  it('never comes from the client', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: 'Dana', lastName: 'Reyes', email: 'dana@example.com' });

    const headers = await post({ 'x-caller-name': encodeURIComponent('Somebody Else') });

    expect(headers['x-caller-name']).toBe(encodeURIComponent('Dana Reyes'));
  });

  it('falls back to the email for an account with no name, and sends nothing for an unresolved account', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: '', lastName: '', email: 'dana@example.com' });
    expect((await post())['x-caller-name']).toBe(encodeURIComponent('dana@example.com'));
    expect(accountDisplayName({ firstName: '', lastName: '', email: 'dana@example.com' })).toBe('dana@example.com');

    jest.clearAllMocks();
    mockGetByFirebaseUid.mockResolvedValue(null);
    expect(await post({ 'x-caller-name': 'spoofed' })).not.toHaveProperty('x-caller-name');
  });
});
