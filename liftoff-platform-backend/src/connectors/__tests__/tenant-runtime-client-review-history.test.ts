// The two review history feeds: REST, throwing on failure, body validated.
//
// Not wrapped in the circuit breaker and never falling back to an empty page,
// because the caller is the workspace export and "no approvals" from a dead
// runtime would be a false record; the export turns the throw into a 503
// naming the source.

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockRejectedValue(new Error('no metadata server')),
  })),
}));
jest.mock('../../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue(null),
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { tenantRuntimeClient } from '../tenant-runtime-client';

const TENANT = '11111111-1111-1111-1111-111111111111';
const AS_OF = new Date('2026-09-18T21:04:11.318Z');

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
});

describe('listReviewHistoryApprovals / listReviewHistoryClarifications', () => {
  it('GETs the feed with asOf, cursor and limit, and returns the page', async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ items: [{ id: 'a-1', status: 'pending' }], nextCursor: 'c2' }));
    const page = await tenantRuntimeClient.listReviewHistoryApprovals(TENANT, { asOf: AS_OF, cursor: 'c1', limit: 50 });
    expect(page).toEqual({ items: [{ id: 'a-1', status: 'pending' }], nextCursor: 'c2' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/hitl-enforcement/review-history/approvals?');
    expect(url).toContain(`asOf=${encodeURIComponent(AS_OF.toISOString())}`);
    expect(url).toContain('cursor=c1');
    expect(url).toContain('limit=50');
    expect(init.method).toBe('GET');
    expect(init.headers['x-tenant-id']).toBe(TENANT);

    mockFetch.mockResolvedValueOnce(okResponse({ items: [], nextCursor: null }));
    await tenantRuntimeClient.listReviewHistoryClarifications(TENANT, { asOf: AS_OF });
    expect(mockFetch.mock.calls[1][0]).toContain('/api/hitl-enforcement/review-history/clarifications?');
    expect(mockFetch.mock.calls[1][0]).not.toContain('cursor=');
  });

  it('throws on a non-2xx, never an empty page', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(tenantRuntimeClient.listReviewHistoryApprovals(TENANT, { asOf: AS_OF })).rejects.toThrow(/HTTP 503/);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(tenantRuntimeClient.listReviewHistoryClarifications(TENANT, { asOf: AS_OF })).rejects.toThrow('ECONNREFUSED');
  });

  it('refuses a body that is not a page: a runtime that predates the feed answers something else here', async () => {
    for (const body of [{ error: 'not found' }, { items: 'nope', nextCursor: null }, { items: [{}], nextCursor: null }, { items: [], nextCursor: 7 }]) {
      mockFetch.mockResolvedValueOnce(okResponse(body));
      await expect(tenantRuntimeClient.listReviewHistoryApprovals(TENANT, { asOf: AS_OF })).rejects.toThrow(/Malformed review history page/);
    }
  });
});
