// The review-queue list route reports the size of the queue, not the size of
// the page it just fetched.
//
// `total` used to be `result.items.length`, which every client read as the
// queue's size: a tenant with 141 items and a 20-item page was told "20". The
// route now takes both the page and the counts from the runtime, which derives
// them from one shared SQL predicate.

import { Request, Response } from 'express';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  logAudit: jest.fn(),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockListPendingApprovals = jest.fn();
const mockGetPendingApprovalCount = jest.fn();

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    listPendingApprovals: (...args: unknown[]) => mockListPendingApprovals(...args),
    getPendingApprovalCount: (...args: unknown[]) => mockGetPendingApprovalCount(...args),
  },
  HitlError: class HitlError extends Error {},
}));

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue({ id: 'user_123' }),
  })),
}));

jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: { getMembership: jest.fn().mockResolvedValue({ role: 'admin' }) },
}));

const TENANT = 'tenant_123';
const AGENT = '22222222-2222-2222-2222-222222222222';

const counts = (overrides: Record<string, number> = {}) => ({
  total: 141,
  approvalsStandard: 0,
  approvalsCritical: 0,
  approvalsOther: 0,
  clarifications: 0,
  ...overrides,
});

function createMockResponse(): Partial<Response> & { json: jest.Mock; status: jest.Mock } {
  const res: Partial<Response> & { json: jest.Mock; status: jest.Mock } = {
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

/** Invokes the list route's own handler, past the membership middleware. */
async function callListRoute(query: Record<string, string> = {}) {
  const { oversightRouter } = await import('../router');
  const layer = (oversightRouter.stack as any[]).find(
    (l) => l.route?.path === '/hitl-approvals' && l.route?.methods?.get,
  );
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const req = {
    params: {},
    query: { tenantId: TENANT, ...query },
    body: {},
    ctx: { userId: 'firebase_user_123' },
    tenantId: TENANT,
  } as unknown as Request;
  const res = createMockResponse();

  await handler(req, res as Response, jest.fn());
  return res.json.mock.calls[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListPendingApprovals.mockResolvedValue({ items: [], nextCursor: null });
  mockGetPendingApprovalCount.mockResolvedValue(counts());
});

describe('GET /hitl-approvals', () => {
  it('reports the queue total, not the page length', async () => {
    mockListPendingApprovals.mockResolvedValue({
      items: [{ kind: 'approval', id: 'a1' }, { kind: 'clarification', id: 'c1' }],
      nextCursor: 'cursor-2',
    });

    const body = await callListRoute();

    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(141);
  });

  it('passes the breakdown through so the client stops computing its own', async () => {
    const body = await callListRoute();

    expect(body.counts).toEqual(counts());
  });

  it('reports an unknown total as null rather than inventing one', async () => {
    mockGetPendingApprovalCount.mockResolvedValue(null);
    mockListPendingApprovals.mockResolvedValue({ items: [{ kind: 'approval', id: 'a1' }], nextCursor: null });

    const body = await callListRoute();

    expect(body.total).toBeNull();
    expect(body.counts).toBeNull();
    expect(body.items).toHaveLength(1);
  });

  it('scopes the page and the counts to the same agent', async () => {
    await callListRoute({ agentId: AGENT });

    expect(mockListPendingApprovals).toHaveBeenCalledWith(TENANT, expect.objectContaining({ agentId: AGENT }));
    expect(mockGetPendingApprovalCount).toHaveBeenCalledWith(TENANT, { agentId: AGENT });
  });

  it('carries the runtime cursor and its hasMore', async () => {
    mockListPendingApprovals.mockResolvedValue({ items: [], nextCursor: 'opaque-cursor' });

    const body = await callListRoute();

    expect(body.cursor).toBe('opaque-cursor');
    expect(body.hasMore).toBe(true);
  });
});
