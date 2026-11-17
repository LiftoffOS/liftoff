// The approval blocking one chat thread is asked for by thread.
//
// The in-chat banner used to list the tenant's queue and scan the first hundred
// items for a thread match. For the tenant that prompted this work — 141
// pending escalations — the approval blocking the very conversation on screen
// sat past that page, and the person whose turn was stalled saw no banner.

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
import { tenantRuntimeBreaker } from '../tenant-runtime-circuit-breaker';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const AGENT = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  tenantRuntimeBreaker.reset();
});

describe('getApprovalForThread', () => {
  it('asks the runtime for the thread, not for the queue', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ approval: { id: 'apr_1' } }) });

    const approval = await tenantRuntimeClient.getApprovalForThread(TENANT, THREAD, AGENT);

    expect(approval).toEqual({ id: 'apr_1' });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`/api/hitl-enforcement/approvals/for-thread/${THREAD}`);
    expect(url).toContain(`agentId=${AGENT}`);
    expect(url).not.toContain('limit=');
  });

  it('returns null when the thread has nothing waiting', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ approval: null }) });

    expect(await tenantRuntimeClient.getApprovalForThread(TENANT, THREAD)).toBeNull();
  });

  it('returns null when the runtime cannot be reached, so the banner stays quiet', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await tenantRuntimeClient.getApprovalForThread(TENANT, THREAD)).toBeNull();
  });

  it('returns null on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    expect(await tenantRuntimeClient.getApprovalForThread(TENANT, THREAD)).toBeNull();
  });
});
