// The "decision window passed" view, and the edge validation around it.
//
// Three things are pinned here. A bad filter is a 400, not the empty queue the
// circuit breaker would otherwise produce from the runtime's own 400. The
// passed view says which approvals already carry feedback, so it does not offer
// a form for an item that was answered. And the window travels to the runtime,
// which owns what "passed" means.

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

const mockFindApprovalIdsWithFeedback = jest.fn();

jest.mock('../../hitl-late-feedback', () => ({
  lateFeedbackService: {
    findApprovalIdsWithFeedback: (...args: unknown[]) => mockFindApprovalIdsWithFeedback(...args),
    getByApprovalId: jest.fn(),
    submitLateFeedback: jest.fn(),
  },
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

const emptyCounts = {
  total: 0,
  approvalsStandard: 0,
  approvalsCritical: 0,
  approvalsOther: 0,
  clarifications: 0,
};

function createMockResponse(): Partial<Response> & { json: jest.Mock; status: jest.Mock } {
  const res: Partial<Response> & { json: jest.Mock; status: jest.Mock } = {
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

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
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListPendingApprovals.mockResolvedValue({ items: [], nextCursor: null });
  mockGetPendingApprovalCount.mockResolvedValue(emptyCounts);
  mockFindApprovalIdsWithFeedback.mockResolvedValue(new Set<string>());
});

describe('queue filter validation', () => {
  it('rejects an agentId that is not a UUID instead of showing an empty queue', async () => {
    const res = await callListRoute({ agentId: 'not-a-uuid' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });

  it('rejects an unknown window rather than quietly serving a different view', async () => {
    const res = await callListRoute({ window: 'everything' });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });

  it('accepts a well-formed agentId', async () => {
    const agentId = '22222222-2222-2222-2222-222222222222';

    const res = await callListRoute({ agentId });

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(mockListPendingApprovals).toHaveBeenCalledWith(TENANT, expect.objectContaining({ agentId }));
  });
});

describe('the passed window', () => {
  const lapsed = {
    kind: 'approval' as const,
    id: '33333333-3333-3333-3333-333333333333',
    agentId: 'agent_1',
    status: 'expired',
  };
  const alsoLapsed = { ...lapsed, id: '44444444-4444-4444-4444-444444444444' };

  it('asks the runtime for the passed view', async () => {
    await callListRoute({ window: 'passed' });

    expect(mockListPendingApprovals).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ window: 'passed' }),
    );
  });

  it('marks the approvals that already carry feedback', async () => {
    mockListPendingApprovals.mockResolvedValue({ items: [lapsed, alsoLapsed], nextCursor: null });
    mockFindApprovalIdsWithFeedback.mockResolvedValue(new Set([lapsed.id]));

    const res = await callListRoute({ window: 'passed' });
    const body = res.json.mock.calls[0][0];

    expect(body.items[0].lateFeedbackSubmitted).toBe(true);
    expect(body.items[1].lateFeedbackSubmitted).toBe(false);
    // One lookup for the page, not one per card.
    expect(mockFindApprovalIdsWithFeedback).toHaveBeenCalledTimes(1);
    expect(mockFindApprovalIdsWithFeedback).toHaveBeenCalledWith(TENANT, [lapsed.id, alsoLapsed.id]);
  });

  it('does not pay for the feedback lookup on the actionable view', async () => {
    mockListPendingApprovals.mockResolvedValue({ items: [lapsed], nextCursor: null });

    await callListRoute();

    expect(mockFindApprovalIdsWithFeedback).not.toHaveBeenCalled();
  });

  it('skips the lookup when the passed page is empty', async () => {
    await callListRoute({ window: 'passed' });

    expect(mockFindApprovalIdsWithFeedback).not.toHaveBeenCalled();
  });
});
