// getPendingApprovalCount asks the tenant runtime for the count, and reports
// the absence of an answer as an absence.
//
// It used to ask over the RPC, which returns only approvals and clarifications,
// so pending escalations were dropped and a tenant with a full review queue read
// "0 items awaiting decision". It also re-derived expiry here, in a second copy
// of a rule the runtime already owns. Both are gone: the runtime's SQL predicate
// is the single definition of what is actionable, shared with the queue listing.
//
// The transport is REST, so these tests stub fetch rather than the RPC client,
// and they run the real circuit breaker so the fallback is exercised for real.

// Mock fetch before importing the client
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Prevent real OIDC token requests (buildRuntimeHeaders calls into this).
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockRejectedValue(new Error('no metadata server')),
  })),
}));

// resolveRuntimeBaseUrl queries the control-plane DB for the tenant's
// runtime_url. findById → null routes to the localhost fallback URL, so the
// unit suite needs no pg connection.
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

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  // The breaker is a process singleton keyed by tenant+method; without this a
  // failure case would leave the circuit open for the cases after it.
  tenantRuntimeBreaker.reset();
});

const EMPTY = {
  total: 0,
  approvalsStandard: 0,
  approvalsCritical: 0,
  approvalsOther: 0,
  clarifications: 0,
};

describe('getPendingApprovalCount', () => {
  it('returns the breakdown the runtime reports', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        count: 141,
        total: 141,
        approvalsStandard: 120,
        approvalsCritical: 0,
        approvalsOther: 0,
        clarifications: 21,
      }),
    });

    expect(await tenantRuntimeClient.getPendingApprovalCount(TENANT)).toEqual({
      ...EMPTY,
      total: 141,
      approvalsStandard: 120,
      clarifications: 21,
    });
  });

  it('reads a runtime that predates the breakdown without producing NaNs', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 7 }) });

    expect(await tenantRuntimeClient.getPendingApprovalCount(TENANT)).toEqual({
      ...EMPTY,
      total: 7,
    });
  });

  it('scopes the count to an agent when asked', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });

    await tenantRuntimeClient.getPendingApprovalCount(TENANT, {
      agentId: '22222222-2222-2222-2222-222222222222',
    });

    expect(mockFetch.mock.calls[0][0]).toContain('agentId=22222222-2222-2222-2222-222222222222');
  });

  it('asks the runtime pending-count endpoint, scoped to the tenant', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });

    await tenantRuntimeClient.getPendingApprovalCount(TENANT);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/hitl-enforcement/pending-count');
    expect(options.method).toBe('GET');
    expect(options.headers['x-tenant-id']).toBe(TENANT);
  });

  it('reports zero as zero when the runtime says the queue is empty', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ count: 0, ...EMPTY }),
    });

    expect(await tenantRuntimeClient.getPendingApprovalCount(TENANT)).toEqual(EMPTY);
  });

  it('returns null, not 0, when the runtime cannot be reached', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await tenantRuntimeClient.getPendingApprovalCount(TENANT)).toBeNull();
  });

  it('returns null, not 0, on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    expect(await tenantRuntimeClient.getPendingApprovalCount(TENANT)).toBeNull();
  });
});
