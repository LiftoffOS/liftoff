// The in-chat banner asks for the approval blocking THIS thread.
//
// It used to list the tenant's review queue, take the first hundred items and
// look for a thread match. For the tenant that prompted this work — 141 pending
// escalations ahead of it — the approval blocking the conversation on screen sat
// past that page, so the person whose turn was stalled saw nothing to act on and
// no reason for the silence.

const mockGetApprovalForThread = jest.fn();
const mockListPendingApprovals = jest.fn();

jest.mock('../../connectors/tenant-runtime-client', () => ({
  TenantRuntimeClient: jest.fn().mockImplementation(() => ({
    getApprovalForThread: (...args: unknown[]) => mockGetApprovalForThread(...args),
    listPendingApprovals: (...args: unknown[]) => mockListPendingApprovals(...args),
  })),
  tenantRuntimeClient: {},
  HitlError: class HitlError extends Error {},
}));

const mockGetThread = jest.fn();
jest.mock('../chat-repository', () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
}));

const mockDescribeApprovalRoute = jest.fn();
jest.mock('../approval-route-description', () => ({
  describeApprovalRoute: (...args: unknown[]) => mockDescribeApprovalRoute(...args),
}));

const mockCanApproveHitl = jest.fn();
jest.mock('../../tenant-members/permissions', () => ({
  canApproveHitl: (...args: unknown[]) => mockCanApproveHitl(...args),
}));

jest.mock('../../accounts/service', () => ({
  accountService: {
    getByFirebaseUid: jest.fn().mockResolvedValue({
      id: 'account_1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.com',
    }),
  },
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue({ id: 'account_1' }),
  })),
}));

jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn().mockResolvedValue({ role: 'admin', accountId: 'account_1' }),
  },
}));

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import type { Request, Response } from 'express';

const TENANT = '00000000-0000-0000-0000-000000000001';
const AGENT = '00000000-0000-0000-0000-000000000002';
const THREAD = '00000000-0000-0000-0000-000000000003';
const ACCOUNT = 'account_1';

function createMockResponse(): Partial<Response> & { json: jest.Mock; status: jest.Mock } {
  const res: Partial<Response> & { json: jest.Mock; status: jest.Mock } = {
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

/** Invoke the banner route's own handler, past its middleware. */
async function callBannerRoute() {
  const { agentChatRouter } = await import('../router');
  const layer = (agentChatRouter.stack as any[]).find(
    (l) => l.route?.path === '/:agentId/threads/:threadId/pending-approval' && l.route?.methods?.get,
  );
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const req = {
    params: { agentId: AGENT, threadId: THREAD },
    query: { tenantId: TENANT },
    body: {},
    ctx: { userId: 'firebase_user_1', tenantId: TENANT },
  } as unknown as Request;
  const res = createMockResponse();

  await handler(req, res as Response, jest.fn());
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetThread.mockResolvedValue({ id: THREAD, tenantId: TENANT });
  mockDescribeApprovalRoute.mockResolvedValue({
    accountIds: [ACCOUNT], names: ['Ada'], toAdmins: false, unassigned: false,
  });
  mockCanApproveHitl.mockReturnValue(true);
  mockGetApprovalForThread.mockResolvedValue(null);
});

describe('GET /:agentId/threads/:threadId/pending-approval', () => {
  it('asks the runtime for this thread rather than scanning the queue', async () => {
    mockGetApprovalForThread.mockResolvedValue({ id: 'apr_1', hitlLevel: 2 });

    await callBannerRoute();

    expect(mockGetApprovalForThread).toHaveBeenCalledWith(TENANT, THREAD, AGENT);
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });

  it('surfaces the approval blocking the thread however long the queue is', async () => {
    mockGetApprovalForThread.mockResolvedValue({ id: 'apr_1', hitlLevel: 2 });

    const res = await callBannerRoute();
    const body = res.json.mock.calls[0][0];

    expect(body.approval).toMatchObject({ approvalId: 'apr_1', hitlLevel: 2 });
  });

  it('reports no banner when the thread has nothing waiting', async () => {
    mockGetApprovalForThread.mockResolvedValue(null);

    const res = await callBannerRoute();

    // Asserted alongside the answer: this handler answers `{approval: null}`
    // from its catch as well, so the null on its own would also be what a test
    // that never reached the lookup would see.
    expect(mockGetApprovalForThread).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ approval: null });
  });
});
