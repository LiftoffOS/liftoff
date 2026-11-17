// The service-only driver-presence read the control plane's stale-driver
// sweep calls: the token is checked first, timing safe, and a caller without
// it learns nothing; the thread is read under the named tenant; a present
// and a stale row answer true and false over the roster's 45-second window,
// through the query written for this read and not the notification one.

import Fastify, { type FastifyInstance } from 'fastify';
import { resetConfigForTests, loadConfig } from '../infrastructure/config.js';

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const getThread = jest.fn();
jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  getThread: (...a: unknown[]) => getThread(...a),
}));
jest.mock('../workforce-plans/caller-context.js', () => ({
  resolveCallerFromHeaders: jest.fn(() => ({ ok: false, status: 401, error: 'no' })),
}));
jest.mock('../workforce-plans/account-profiles.js', () => ({ getAccountProfiles: jest.fn(async () => new Map()) }));
jest.mock('../workforce-plans/turn-events-repository.js', () => ({ listTurnEventsAfter: jest.fn() }));
jest.mock('../workforce-plans/active-turn-repository.js', () => ({ requestStop: jest.fn() }));

const isAccountRecentlyPresent = jest.fn();
const isAccountPresent = jest.fn();
jest.mock('../workforce-plans/presence-repository.js', () => ({
  clearPresence: jest.fn(),
  heartbeatAndListPresence: jest.fn(),
  isAccountRecentlyPresent: (...a: unknown[]) => isAccountRecentlyPresent(...a),
  isAccountPresent: (...a: unknown[]) => isAccountPresent(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { registerPresenceRoutes } = require('../workforce-plans/presence-router.js');

const TOKEN = 'workforce-token-under-test';
const TENANT = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';
const THREAD = '33333333-3333-3333-3333-333333333333';
const ACCOUNT = '44444444-4444-4444-4444-444444444444';
const url = (thread = THREAD, account = ACCOUNT, tenant = TENANT) =>
  `/internal/team-plan/threads/${thread}/presence/${account}?tenantId=${tenant}`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerPresenceRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.local';
  process.env['GCP_PROJECT_ID'] = 'test-project';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:region:instance';
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
  getThread.mockReset();
  isAccountRecentlyPresent.mockReset();
  isAccountPresent.mockReset();
  getThread.mockImplementation(async (threadId: string, tenantId: string) =>
    (tenantId === TENANT && threadId === THREAD ? { id: THREAD, tenantId: TENANT } : null));
});

afterAll(() => { delete process.env['WORKFORCE_SERVICE_TOKEN']; });

describe('GET /internal/team-plan/threads/:threadId/presence/:accountId', () => {
  it('answers present true for a recent row, through the 45-second query', async () => {
    isAccountRecentlyPresent.mockResolvedValueOnce(true);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-service-auth': TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ present: true });
    expect(isAccountRecentlyPresent).toHaveBeenCalledWith(TENANT, THREAD, ACCOUNT);
    // Not the eight-second notification window.
    expect(isAccountPresent).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers present false for a stale row', async () => {
    isAccountRecentlyPresent.mockResolvedValueOnce(false);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-service-auth': TOKEN } });
    expect(res.json()).toEqual({ present: false });
    await app.close();
  });

  it('refuses a missing or wrong token before reading anything, and trusts no caller header', async () => {
    const app = await buildApp();
    const missing = await app.inject({ method: 'GET', url: url(), headers: { 'x-tenant-id': TENANT, 'x-account-id': ACCOUNT, 'x-tenant-role': 'owner' } });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: url(), headers: { 'x-service-auth': 'not-the-token' } });
    expect(wrong.statusCode).toBe(401);
    const longer = await app.inject({ method: 'GET', url: url(), headers: { 'x-service-auth': TOKEN + 'x' } });
    expect(longer.statusCode).toBe(401);
    expect(getThread).not.toHaveBeenCalled();
    expect(isAccountRecentlyPresent).not.toHaveBeenCalled();
    await app.close();
  });

  it('fails closed when the server has no token configured', async () => {
    process.env['WORKFORCE_SERVICE_TOKEN'] = '';
    resetConfigForTests();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: url(), headers: { 'x-service-auth': '' } });
    expect(res.statusCode).toBe(401);
    expect(getThread).not.toHaveBeenCalled();
    await app.close();
  });

  it('reads the thread under the named tenant: another tenant is a 404, and nothing is read for it', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: url(THREAD, ACCOUNT, OTHER), headers: { 'x-service-auth': TOKEN } });
    expect(res.statusCode).toBe(404);
    expect(getThread).toHaveBeenCalledWith(THREAD, OTHER);
    expect(isAccountRecentlyPresent).not.toHaveBeenCalled();
    await app.close();
  });

  it('validates the ids and the tenant', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/internal/team-plan/threads/nope/presence/${ACCOUNT}?tenantId=${TENANT}`, headers: { 'x-service-auth': TOKEN } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/internal/team-plan/threads/${THREAD}/presence/${ACCOUNT}`, headers: { 'x-service-auth': TOKEN } })).statusCode).toBe(400);
    await app.close();
  });
});

describe('config', () => {
  it('requires the token in prod and tolerates its absence in dev', () => {
    process.env['ENVIRONMENT'] = 'prod';
    process.env['WORKFORCE_SERVICE_TOKEN'] = '';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/WORKFORCE_SERVICE_TOKEN is required in prod/);
    process.env['ENVIRONMENT'] = 'dev';
    resetConfigForTests();
    expect(loadConfig().WORKFORCE_SERVICE_TOKEN).toBe('');
    delete process.env['ENVIRONMENT'];
    resetConfigForTests();
  });
});
