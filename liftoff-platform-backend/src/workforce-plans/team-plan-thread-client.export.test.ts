// The two export feeds over the Chief AI Officer's threads, and how they
// differ from listTeamPlanThreads beside them: they THROW on failure, they
// validate the body, and the caller's tenant travels in the headers only.

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockRejectedValue(new Error('no metadata server')),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { exportTeamPlanThreads, exportTeamPlanMessages, listTeamPlanThreadPage } from './team-plan-thread-client';

const fetchMock = jest.fn();
const CALLER = { tenantId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', role: 'owner' };
const AS_OF = new Date('2026-09-18T21:04:11.318Z');

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.WORKFORCE_SERVICE_URL = 'https://workforce.internal';
  process.env.WORKFORCE_SERVICE_TOKEN = 'svc-token';
});

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('exportTeamPlanThreads / exportTeamPlanMessages', () => {
  it('asks for the feed by kind with asOf, cursor and limit, tenant in the headers and NOT the query', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ threads: [{ id: 't-1', title: 'x' }], nextCursor: 'next' }));
    const page = await exportTeamPlanThreads(CALLER, { asOf: AS_OF, cursor: 'c1', limit: 100 });
    expect(page).toEqual({ items: [{ id: 't-1', title: 'x' }], nextCursor: 'next' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/workforce\.internal\/team-plan\/export\?/);
    expect(url).toContain('kind=threads');
    expect(url).toContain(`asOf=${encodeURIComponent(AS_OF.toISOString())}`);
    expect(url).toContain('cursor=c1');
    expect(url).toContain('limit=100');
    expect(url).not.toContain('tenantId');
    expect(init.headers['x-tenant-id']).toBe(CALLER.tenantId);
    expect(init.headers['x-account-id']).toBe(CALLER.accountId);
    expect(init.headers['x-tenant-role']).toBe('owner');
    expect(init.headers['X-Service-Auth']).toBe('svc-token');

    fetchMock.mockResolvedValueOnce(okResponse({ messages: [{ id: 'm-1' }], nextCursor: null }));
    const messages = await exportTeamPlanMessages(CALLER, { asOf: AS_OF });
    expect(messages).toEqual({ items: [{ id: 'm-1' }], nextCursor: null });
    expect(fetchMock.mock.calls[1][0]).toContain('kind=messages');
  });

  it('throws on failure and on a malformed body, unlike the MCP listing beside it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    await expect(exportTeamPlanThreads(CALLER, { asOf: AS_OF })).rejects.toThrow(/HTTP 502/);
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(exportTeamPlanMessages(CALLER, { asOf: AS_OF })).rejects.toThrow('ECONNRESET');
    fetchMock.mockResolvedValueOnce(okResponse({ threads: [{ id: 'x' }] }));
    await expect(exportTeamPlanThreads(CALLER, { asOf: AS_OF })).rejects.toThrow(/Malformed team-plan export page/);
    fetchMock.mockResolvedValueOnce(okResponse({ messages: [{ notId: 1 }], nextCursor: null }));
    await expect(exportTeamPlanMessages(CALLER, { asOf: AS_OF })).rejects.toThrow(/Malformed team-plan export page/);
  });

  it('throws rather than returning an empty page when the service is not configured', async () => {
    delete process.env.WORKFORCE_SERVICE_URL;
    await expect(exportTeamPlanThreads(CALLER, { asOf: AS_OF })).rejects.toThrow(/WORKFORCE_SERVICE_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listTeamPlanThreadPage', () => {
  it('pages with the cursor and keeps the unread flag and hasMore the service sends', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({
      threads: [{ id: 't-1', title: null, updatedAt: '2026-09-22T10:00:00.000Z', unread: true, workforcePlanId: 'p' }],
      nextCursor: '2026-09-22T10:00:00.000Z',
      hasMore: true,
    }));
    const page = await listTeamPlanThreadPage(CALLER, { cursor: 'c1', limit: 20 });
    expect(page).toEqual({
      threads: [{ id: 't-1', title: null, updatedAt: '2026-09-22T10:00:00.000Z', unread: true }],
      nextCursor: '2026-09-22T10:00:00.000Z',
      hasMore: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/workforce\.internal\/team-plan\/threads\?/);
    expect(url).toContain('cursor=c1');
    expect(url).toContain('limit=20');
    expect(init.headers['x-tenant-role']).toBe('owner');
  });

  it('throws on a refusal, unlike the MCP listing beside it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(listTeamPlanThreadPage(CALLER)).rejects.toThrow(/503/);
  });
});
