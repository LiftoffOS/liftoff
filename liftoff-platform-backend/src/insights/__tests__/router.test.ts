// Insights Router Tests
//
// Covers the chat thread + message CRUD endpoints added in Phase 3 commit #2.
// The /report endpoint already has its own snapshot test in report-service.test.ts.

import { Request, Response } from 'express';

// Stub repository before importing the router so the router picks up our mocks.
const mockListThreads = jest.fn();
const mockCreateThread = jest.fn();
const mockGetThread = jest.fn();
const mockDeleteThread = jest.fn();
const mockListMessages = jest.fn();
const mockAppendMessage = jest.fn();
const mockGetCallerRole = jest.fn();
const mockMarkThreadRead = jest.fn();
const mockMarkAllThreadsRead = jest.fn();
const mockGetUnreadThreadCount = jest.fn();

jest.mock('../chat-repository', () => ({
  listThreads: (...args: unknown[]) => mockListThreads(...args),
  createThread: (...args: unknown[]) => mockCreateThread(...args),
  getThread: (...args: unknown[]) => mockGetThread(...args),
  deleteThread: (...args: unknown[]) => mockDeleteThread(...args),
  listMessages: (...args: unknown[]) => mockListMessages(...args),
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
  getCallerRole: (...args: unknown[]) => mockGetCallerRole(...args),
  markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
  markAllThreadsRead: (...args: unknown[]) => mockMarkAllThreadsRead(...args),
  getUnreadThreadCount: (...args: unknown[]) => mockGetUnreadThreadCount(...args),
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../rate-limiter', () => ({
  checkAndIncrementInsightsRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock('../report-service', () => ({
  generateReport: jest.fn(),
}));

const mockGetInsightsCounts = jest.fn();
jest.mock('../counts-service', () => ({
  getInsightsCounts: (...args: unknown[]) => mockGetInsightsCounts(...args),
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn() }),
  pool: { query: jest.fn() },
}));

const mockTryInsertAbortSignal = jest.fn();
jest.mock('../turn-control', () => ({
  newTurnId: () => '00000000-0000-4000-8000-0000000turnid',
  tryInsertAbortSignal: (...args: unknown[]) => mockTryInsertAbortSignal(...args),
}));

// Presence is served by the repository shared with the Liftoff chat, which is
// why the surface discriminator is the first argument and worth asserting.
const mockHeartbeatPresence = jest.fn();
const mockClearPresence = jest.fn();
jest.mock('../../common/chat-presence-repository', () => ({
  heartbeatAndListPresence: (...args: unknown[]) => mockHeartbeatPresence(...args),
  clearPresence: (...args: unknown[]) => mockClearPresence(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { router as insightsRouter } from '../router';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_OWNER = '00000000-0000-0000-0000-000000000010';
const ACCOUNT_MEMBER = '00000000-0000-0000-0000-000000000020';
const FIREBASE_UID = 'firebase-uid-abc';
const THREAD_ID = '00000000-0000-0000-0000-000000000100';
const MESSAGE_ID = '00000000-0000-0000-0000-000000000200';

function getRouteHandler(method: string, path: string): (req: Request, res: Response) => Promise<void> {
   
  const stack = (insightsRouter as any).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path) {
      const routeMethod = method.toLowerCase();
       
      const handlers = layer.route.stack.filter((l: any) => l.method === routeMethod);
      if (handlers.length > 0) return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

function createReqRes(overrides: {
  method?: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  firebaseUid?: string | null;
}) {
  const req = {
    method: overrides.method || 'GET',
    query: overrides.query || {},
    params: overrides.params || {},
    body: overrides.body || {},
    ctx: {
      tenantId: TENANT_A,
      userId: overrides.firebaseUid !== undefined ? overrides.firebaseUid ?? undefined : FIREBASE_UID,
    },
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;

  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: caller is a member of TENANT_A with member role.
  mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_MEMBER });
  mockGetCallerRole.mockResolvedValue('member');
  // Default: rate limit allows the request through.
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: { minute: 5, hour: 30, day: 100 },
  });
});

describe('GET /counts', () => {
  it('returns the count payload from getInsightsCounts', async () => {
    mockGetInsightsCounts.mockResolvedValueOnce({
      agentCount: 2,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: false,
    });
    const handler = getRouteHandler('GET', '/counts');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(mockGetInsightsCounts).toHaveBeenCalledWith(TENANT_A);
    expect(res.json).toHaveBeenCalledWith({
      agentCount: 2,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: false,
    });
  });

  it('returns isEmpty=true for a brand-new tenant', async () => {
    mockGetInsightsCounts.mockResolvedValueOnce({
      agentCount: 0,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: true,
    });
    const handler = getRouteHandler('GET', '/counts');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ isEmpty: true }));
  });

  it('rejects requests without a tenantId', async () => {
    const handler = getRouteHandler('GET', '/counts');
    const { req, res } = createReqRes({ query: {} });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetInsightsCounts).not.toHaveBeenCalled();
  });

  it('rejects requests with a non-UUID tenantId', async () => {
    const handler = getRouteHandler('GET', '/counts');
    const { req, res } = createReqRes({ query: { tenantId: 'not-a-uuid' } });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetInsightsCounts).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws', async () => {
    mockGetInsightsCounts.mockRejectedValueOnce(new Error('boom'));
    const handler = getRouteHandler('GET', '/counts');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /threads', () => {
  it('returns 400 when tenantId is missing', async () => {
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({ query: {} });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when tenantId is not a UUID', async () => {
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({ query: { tenantId: 'not-a-uuid' } });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 when no firebase uid on request', async () => {
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({
      query: { tenantId: TENANT_A },
      firebaseUid: null,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when account does not exist for firebase uid', async () => {
    mockGetByFirebaseUid.mockResolvedValueOnce(null);
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when caller is not a member of the tenant', async () => {
    mockGetCallerRole.mockResolvedValueOnce(null);
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    // 404 not 403 — never confirm tenant existence to non-members.
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns threads visible to a member', async () => {
    mockListThreads.mockResolvedValueOnce({
      threads: [{ id: THREAD_ID, title: 'My thread' }],
      nextCursor: null,
      hasMore: false,
    });
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    // The caller reaches the repository as the READER (whose read markers the
    // unread flag consults, migration 434), never as a visibility filter: the
    // list is the workspace's, not the caller's (migration 351).
    expect(mockListThreads).toHaveBeenCalledWith(TENANT_A, ACCOUNT_MEMBER, {
      cursor: undefined,
      limit: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      threads: [{ id: THREAD_ID, title: 'My thread' }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('passes cursor and limit through to the repository', async () => {
    mockListThreads.mockResolvedValueOnce({ threads: [], nextCursor: null, hasMore: false });
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({
      query: { tenantId: TENANT_A, cursor: '2026-04-05T00:00:00Z', limit: '10' },
    });

    await handler(req, res);

    expect(mockListThreads).toHaveBeenCalledWith(TENANT_A, ACCOUNT_MEMBER, {
      cursor: '2026-04-05T00:00:00Z',
      limit: 10,
    });
  });
});

describe('POST /threads', () => {
  it('creates a thread with no title', async () => {
    mockCreateThread.mockResolvedValueOnce({
      id: THREAD_ID,
      tenantId: TENANT_A,
      accountId: ACCOUNT_MEMBER,
      title: null,
      createdAt: '2026-04-07T00:00:00Z',
      updatedAt: '2026-04-07T00:00:00Z',
    });
    const handler = getRouteHandler('POST', '/threads');
    const { req, res } = createReqRes({
      method: 'POST',
      body: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockCreateThread).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      accountId: ACCOUNT_MEMBER,
      title: null,
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('sanitizes the title before persisting', async () => {
    mockCreateThread.mockResolvedValueOnce({ id: THREAD_ID });
    const handler = getRouteHandler('POST', '/threads');
    const { req, res } = createReqRes({
      method: 'POST',
      body: { tenantId: TENANT_A, title: '<script>alert(1)</script>' },
    });

    await handler(req, res);

    expect(mockCreateThread).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      accountId: ACCOUNT_MEMBER,
      // Stored verbatim; the thread list renders it as a text node.
      title: '<script>alert(1)</script>',
    });
  });

  it('returns 400 for missing tenantId', async () => {
    const handler = getRouteHandler('POST', '/threads');
    const { req, res } = createReqRes({ method: 'POST', body: {} });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /threads/:threadId', () => {
  it('returns the thread when caller can see it', async () => {
    mockGetThread.mockResolvedValueOnce({ id: THREAD_ID, title: 'Q4 spend' });
    const handler = getRouteHandler('GET', '/threads/:threadId');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    // `continuation` names the work queued to continue an earlier turn on
    // the thread; null when none.
    expect(res.json).toHaveBeenCalledWith({ thread: { id: THREAD_ID, title: 'Q4 spend' }, continuation: null });
  });

  it('returns 404 when caller cannot see the thread', async () => {
    mockGetThread.mockResolvedValueOnce(null);
    const handler = getRouteHandler('GET', '/threads/:threadId');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('DELETE /threads/:threadId', () => {
  it('returns 204 on successful delete', async () => {
    mockDeleteThread.mockResolvedValueOnce(true);
    const handler = getRouteHandler('DELETE', '/threads/:threadId');
    const { req, res } = createReqRes({
      method: 'DELETE',
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });

  it('returns 404 when thread is not visible to caller', async () => {
    mockDeleteThread.mockResolvedValueOnce(false);
    const handler = getRouteHandler('DELETE', '/threads/:threadId');
    const { req, res } = createReqRes({
      method: 'DELETE',
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('GET /threads/:threadId/messages', () => {
  it('returns messages after thread visibility check passes', async () => {
    mockGetThread.mockResolvedValueOnce({ id: THREAD_ID });
    mockListMessages.mockResolvedValueOnce({
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'hi' }],
      nextCursor: null,
      hasMore: false,
    });
    const handler = getRouteHandler('GET', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockGetThread).toHaveBeenCalled();
    expect(mockListMessages).toHaveBeenCalledWith(THREAD_ID, {
      cursor: undefined,
      limit: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'hi' }],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('returns 404 when thread is not visible (does NOT call listMessages)', async () => {
    mockGetThread.mockResolvedValueOnce(null);
    const handler = getRouteHandler('GET', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockListMessages).not.toHaveBeenCalled();
  });
});

describe('POST /threads/:threadId/messages', () => {
  beforeEach(() => {
    mockGetThread.mockResolvedValue({ id: THREAD_ID });
  });

  it('appends a sanitized user message', async () => {
    mockAppendMessage.mockResolvedValueOnce({
      id: MESSAGE_ID,
      role: 'user',
      content: 'How much did agents cost?',
    });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: 'How much did agents cost?' },
    });

    await handler(req, res);

    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      role: 'user',
      // The caller the request authenticated as (migration 492).
      senderAccountId: ACCOUNT_MEMBER,
      content: 'How much did agents cost?',
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('strips control characters before persisting', async () => {
    mockAppendMessage.mockResolvedValueOnce({ id: MESSAGE_ID });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: {
        tenantId: TENANT_A,
        // Includes a null byte, a vertical tab, and a DEL char
        content: 'hello\u0000\u000B\u007Fworld',
      },
    });

    await handler(req, res);

    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      role: 'user',
      // The caller the request authenticated as (migration 492).
      senderAccountId: ACCOUNT_MEMBER,
      content: 'helloworld',
    });
  });

  it('html-escapes angle brackets and quotes', async () => {
    mockAppendMessage.mockResolvedValueOnce({ id: MESSAGE_ID });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: {
        tenantId: TENANT_A,
        content: '<img src="x" onerror="alert(\'xss\')"/>',
      },
    });

    await handler(req, res);

    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      role: 'user',
      // The caller the request authenticated as (migration 492).
      senderAccountId: ACCOUNT_MEMBER,
      content: '<img src="x" onerror="alert(\'xss\')"/>',
    });
  });

  it('stores an apostrophe as an apostrophe', async () => {
    mockAppendMessage.mockResolvedValueOnce({ id: MESSAGE_ID });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: "What's our burn rate" },
    });

    await handler(req, res);

    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      role: 'user',
      // The caller the request authenticated as (migration 492).
      senderAccountId: ACCOUNT_MEMBER,
      content: "What's our burn rate",
    });
  });

  it('preserves newlines and tabs (legitimate multi-line input)', async () => {
    mockAppendMessage.mockResolvedValueOnce({ id: MESSAGE_ID });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: 'line1\nline2\tcolumn' },
    });

    await handler(req, res);

    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      role: 'user',
      // The caller the request authenticated as (migration 492).
      senderAccountId: ACCOUNT_MEMBER,
      content: 'line1\nline2\tcolumn',
    });
  });

  it('rejects content over 4000 characters', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: 'a'.repeat(4001) },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('rejects empty content', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: '' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects content that is empty after sanitization (only control chars)', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: '\u0000\u0001\u0002' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('returns 404 when thread is not visible (does NOT append)', async () => {
    mockGetThread.mockReset();
    mockGetThread.mockResolvedValueOnce(null);
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: 'sneaky' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('returns 429 when rate-limited and sets Retry-After header', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      retryAfter: 42,
      remaining: { minute: 0, hour: 10, day: 50 },
    });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const setHeader = jest.fn();
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: 'too fast' },
    });
    (res as unknown as { setHeader: jest.Mock }).setHeader = setHeader;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(res.json).toHaveBeenCalledWith({
      error: 'Rate limit exceeded',
      retryAfter: 42,
      remaining: { minute: 0, hour: 10, day: 50 },
    });
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('still appends when rate limit returns allowed but with low remaining', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: true,
      remaining: { minute: 1, hour: 1, day: 1 },
    });
    mockAppendMessage.mockResolvedValueOnce({ id: MESSAGE_ID });
    const handler = getRouteHandler('POST', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, content: 'just under the limit' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockAppendMessage).toHaveBeenCalled();
  });
});

describe('POST /threads/:threadId/stop', () => {
  // ADR-041: the signal is durable, so Stop does not race the SSE stream. The
  // loop claims it at its next boundary and keeps whatever it had written.
  beforeEach(() => {
    mockGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_A, accountId: ACCOUNT_MEMBER });
    mockTryInsertAbortSignal.mockResolvedValue(true);
  });

  it('reports deliveredAs abort when a turn was running', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/stop');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockTryInsertAbortSignal).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      senderAccountId: ACCOUNT_MEMBER,
      senderDisplayName: null,
    });
    expect(res.json).toHaveBeenCalledWith({ acknowledged: true, deliveredAs: 'abort' });
  });

  it('reports deliveredAs noop when the turn had already finished', async () => {
    mockTryInsertAbortSignal.mockResolvedValueOnce(false);
    const handler = getRouteHandler('POST', '/threads/:threadId/stop');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ acknowledged: true, deliveredAs: 'noop' });
  });

  it('will not stop a turn on a thread the caller cannot see', async () => {
    mockGetThread.mockResolvedValueOnce(null);
    const handler = getRouteHandler('POST', '/threads/:threadId/stop');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockTryInsertAbortSignal).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/stop');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A },
      firebaseUid: null,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockTryInsertAbortSignal).not.toHaveBeenCalled();
  });

  it('rejects a malformed thread id', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/stop');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: 'not-a-uuid' },
      body: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTryInsertAbortSignal).not.toHaveBeenCalled();
  });
});

// Migration 351: the surface reads like team chat now. A member opening a
// thread somebody else started is the whole point, so it is asserted end to end
// through the routes rather than only in the repository.
describe('a member can read another account thread', () => {
  const OTHER_PERSONS_THREAD = { id: THREAD_ID, accountId: ACCOUNT_OWNER, title: "Someone else's" };

  beforeEach(() => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_MEMBER });
    mockGetCallerRole.mockResolvedValue('member');
  });

  it('serves the thread without asking who the caller is', async () => {
    mockGetThread.mockResolvedValueOnce(OTHER_PERSONS_THREAD);
    const handler = getRouteHandler('GET', '/threads/:threadId');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_A);
    expect(res.json).toHaveBeenCalledWith({ thread: OTHER_PERSONS_THREAD, continuation: null });
  });

  it('serves its messages too', async () => {
    mockGetThread.mockResolvedValueOnce(OTHER_PERSONS_THREAD);
    mockListMessages.mockResolvedValueOnce({ messages: [], nextCursor: null, hasMore: false });
    const handler = getRouteHandler('GET', '/threads/:threadId/messages');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_A);
    expect(res.json).toHaveBeenCalledWith({ messages: [], nextCursor: null, hasMore: false });
  });

  it('lists it in the chat history, since the list no longer takes an account', async () => {
    mockListThreads.mockResolvedValueOnce({
      threads: [OTHER_PERSONS_THREAD],
      nextCursor: null,
      hasMore: false,
    });
    const handler = getRouteHandler('GET', '/threads');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(mockListThreads).toHaveBeenCalledWith(TENANT_A, ACCOUNT_MEMBER, expect.any(Object));
    expect(res.json).toHaveBeenCalledWith({
      threads: [OTHER_PERSONS_THREAD],
      nextCursor: null,
      hasMore: false,
    });
  });

  // The half that did NOT widen. The router still hands the repository the
  // caller's identity here, because deleting somebody else's thread is still
  // refused, and the refusal is a 404 so it leaks nothing.
  it('still passes the caller identity to deleteThread, and 404s on refusal', async () => {
    mockDeleteThread.mockResolvedValueOnce(false);
    const handler = getRouteHandler('DELETE', '/threads/:threadId');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockDeleteThread).toHaveBeenCalledWith(THREAD_ID, TENANT_A, ACCOUNT_MEMBER, 'member');
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ── Presence ───────────────────────────────────────────────────────────
//
// The other half of making this surface a team chat. Worth testing at the route
// rather than only in the repository, because the thread gate and the "you are
// whoever you authenticated as" rule both live here: a heartbeat that took an
// account id from the body would let anyone plant themselves in a roster.
describe('POST /threads/:threadId/presence', () => {
  const ROSTER = {
    viewers: [
      {
        accountId: ACCOUNT_OWNER,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
        avatarUrl: null,
        typing: true,
      },
    ],
    liveTurnId: null,
    latestMessageAt: '2026-04-05T10:00:00.000Z',
  };

  it('heartbeats on the insights surface and returns the roster', async () => {
    mockGetThread.mockResolvedValueOnce({ id: THREAD_ID });
    mockHeartbeatPresence.mockResolvedValueOnce(ROSTER);
    const handler = getRouteHandler('POST', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, state: 'typing' },
    });

    await handler(req, res);

    expect(mockHeartbeatPresence).toHaveBeenCalledWith(
      'insights',
      TENANT_A,
      THREAD_ID,
      ACCOUNT_MEMBER,
      'typing',
    );
    expect(res.json).toHaveBeenCalledWith(ROSTER);
  });

  // A member polling a thread they did not start is the normal case now, not an
  // edge one: it is what puts two people in the same roster.
  it("lets a member join the roster on somebody else's thread", async () => {
    mockGetThread.mockResolvedValueOnce({ id: THREAD_ID, accountId: ACCOUNT_OWNER });
    mockHeartbeatPresence.mockResolvedValueOnce(ROSTER);
    const handler = getRouteHandler('POST', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, state: 'viewing' },
    });

    await handler(req, res);

    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_A);
    expect(res.json).toHaveBeenCalledWith(ROSTER);
  });

  it('404s without heartbeating when the thread is not in this workspace', async () => {
    mockGetThread.mockResolvedValueOnce(null);
    const handler = getRouteHandler('POST', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, state: 'viewing' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockHeartbeatPresence).not.toHaveBeenCalled();
  });

  it('rejects a state outside the two the table allows', async () => {
    const handler = getRouteHandler('POST', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, state: 'lurking' },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockHeartbeatPresence).not.toHaveBeenCalled();
  });

  it('records the authenticated caller, never an account id from the body', async () => {
    mockGetThread.mockResolvedValueOnce({ id: THREAD_ID });
    mockHeartbeatPresence.mockResolvedValueOnce(ROSTER);
    const handler = getRouteHandler('POST', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A, state: 'viewing', accountId: ACCOUNT_OWNER },
    });

    await handler(req, res);

    expect(mockHeartbeatPresence).toHaveBeenCalledWith(
      'insights',
      TENANT_A,
      THREAD_ID,
      ACCOUNT_MEMBER,
      'viewing',
    );
  });
});

describe('DELETE /threads/:threadId/presence', () => {
  it('clears the seat and answers 204', async () => {
    mockClearPresence.mockResolvedValueOnce(undefined);
    const handler = getRouteHandler('DELETE', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockClearPresence).toHaveBeenCalledWith('insights', TENANT_A, THREAD_ID, ACCOUNT_MEMBER);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  // Fired from a page that is going away, so it must not depend on a thread
  // lookup that could 404 the tab on its way out. The only row it can touch is
  // the caller's own.
  it('does not look the thread up first', async () => {
    mockClearPresence.mockResolvedValueOnce(undefined);
    const handler = getRouteHandler('DELETE', '/threads/:threadId/presence');
    const { req, res } = createReqRes({
      params: { threadId: THREAD_ID },
      query: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(mockGetThread).not.toHaveBeenCalled();
  });

  it('requires a tenantId on the query', async () => {
    const handler = getRouteHandler('DELETE', '/threads/:threadId/presence');
    const { req, res } = createReqRes({ params: { threadId: THREAD_ID }, query: {} });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockClearPresence).not.toHaveBeenCalled();
  });
});

// ── Unread state (migration 434) ────────────────────────────────────────

describe('GET /threads/unread-count', () => {
  // A single-segment value under /threads/, so the param route would swallow
  // it if it were registered later and answer 400 for "not a UUID". Express
  // matches in registration order; this pins the order.
  it('is registered before /threads/:threadId', () => {
    const stack = (insightsRouter as unknown as { stack: Array<{ route?: { path: string } }> }).stack;
    const paths = stack.filter((l) => l.route).map((l) => l.route!.path);
    expect(paths.indexOf('/threads/unread-count')).toBeGreaterThan(-1);
    expect(paths.indexOf('/threads/unread-count')).toBeLessThan(paths.indexOf('/threads/:threadId'));
  });

  it('returns the count for the resolved caller', async () => {
    mockGetUnreadThreadCount.mockResolvedValueOnce(3);
    const handler = getRouteHandler('GET', '/threads/unread-count');
    const { req, res } = createReqRes({ query: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(mockGetUnreadThreadCount).toHaveBeenCalledWith(TENANT_A, ACCOUNT_MEMBER);
    expect(res.json).toHaveBeenCalledWith({ count: 3 });
  });

  it('requires a tenantId on the query', async () => {
    const handler = getRouteHandler('GET', '/threads/unread-count');
    const { req, res } = createReqRes({ query: {} });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetUnreadThreadCount).not.toHaveBeenCalled();
  });
});

describe('POST /threads/:threadId/read', () => {
  it('marks the thread read for the CALLER, never for an account off the body', async () => {
    mockGetThread.mockResolvedValueOnce({ id: THREAD_ID, tenantId: TENANT_A });
    mockMarkThreadRead.mockResolvedValueOnce(undefined);
    const handler = getRouteHandler('POST', '/threads/:threadId/read');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      // A hostile body naming somebody else's account must change nothing:
      // the route reads only tenantId from it.
      body: { tenantId: TENANT_A, accountId: ACCOUNT_OWNER },
    });

    await handler(req, res);

    expect(mockMarkThreadRead).toHaveBeenCalledWith(TENANT_A, ACCOUNT_MEMBER, THREAD_ID);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('answers 404 for a thread in another workspace, same as one that does not exist', async () => {
    mockGetThread.mockResolvedValueOnce(null);
    const handler = getRouteHandler('POST', '/threads/:threadId/read');
    const { req, res } = createReqRes({
      method: 'POST',
      params: { threadId: THREAD_ID },
      body: { tenantId: TENANT_A },
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });
});

describe('POST /threads/read-all', () => {
  it('marks every unread thread read for the CALLER, never for an account off the body', async () => {
    mockMarkAllThreadsRead.mockResolvedValueOnce(3);
    const handler = getRouteHandler('POST', '/threads/read-all');
    const { req, res } = createReqRes({
      method: 'POST',
      body: { tenantId: TENANT_A, accountId: ACCOUNT_OWNER },
    });

    await handler(req, res);

    expect(mockMarkAllThreadsRead).toHaveBeenCalledWith(TENANT_A, ACCOUNT_MEMBER);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('answers 400 without a valid tenantId', async () => {
    const handler = getRouteHandler('POST', '/threads/read-all');
    const { req, res } = createReqRes({ method: 'POST', body: { tenantId: 'not-a-uuid' } });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockMarkAllThreadsRead).not.toHaveBeenCalled();
  });

  it('propagates a caller failure before touching the repository', async () => {
    mockGetByFirebaseUid.mockResolvedValueOnce(null);
    const handler = getRouteHandler('POST', '/threads/read-all');
    const { req, res } = createReqRes({ method: 'POST', body: { tenantId: TENANT_A } });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockMarkAllThreadsRead).not.toHaveBeenCalled();
  });
});
