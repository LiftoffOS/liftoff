// Unread routes — POST /:agentId/threads/:threadId/read, POST
// /:agentId/threads/read-all and GET /unread-counts.
//
// Two things worth pinning beyond the happy path. First, the read marker is set
// for whoever the request authenticated as and for nobody else: the account id
// never comes off the body, so one person cannot mark another's threads read.
// Second, a thread in another tenant answers 404 exactly like one that does not
// exist, which is the rule every route in this file follows.

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();
const mockGetThread = jest.fn();
const mockMarkThreadRead = jest.fn();
const mockMarkAllThreadsRead = jest.fn();
const mockGetUnreadCounts = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: mockGetMembership },
}));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  TenantRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../chat-repository', () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
  markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
  markAllThreadsRead: (...args: unknown[]) => mockMarkAllThreadsRead(...args),
  getUnreadCountsByAgent: (...args: unknown[]) => mockGetUnreadCounts(...args),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: jest.fn() })),
}));

import { agentChatRouter } from '../router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_AGENT_ID = '44444444-4444-4444-4444-444444444444';

function makeApp(firebaseUid: string | null = 'uid-1'): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { ctx?: { userId?: string } }).ctx = firebaseUid ? { userId: firebaseUid } : {};
    next();
  });
  app.use('/api/agent-chat', agentChatRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: 'Ada', lastName: 'L' });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID });
  mockMarkThreadRead.mockResolvedValue(undefined);
  mockMarkAllThreadsRead.mockResolvedValue(0);
  mockGetUnreadCounts.mockResolvedValue({});
});

describe('POST /api/agent-chat/:agentId/threads/:threadId/read', () => {
  it('marks the thread read for the authenticated caller and answers 204', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/${THREAD_ID}/read`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(204);
    expect(mockMarkThreadRead).toHaveBeenCalledWith(TENANT_ID, 'acc-1', THREAD_ID);
  });

  it('answers 404 for a thread outside the tenant, without writing a marker', async () => {
    mockGetThread.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/${THREAD_ID}/read`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(404);
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(makeApp(null))
      .post(`/api/agent-chat/${AGENT_ID}/threads/${THREAD_ID}/read`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(401);
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('answers 404 for a non-member without confirming the tenant exists', async () => {
    mockGetMembership.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/${THREAD_ID}/read`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(404);
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('rejects an invalid body', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/${THREAD_ID}/read`)
      .send({ tenantId: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });
});

describe('GET /api/agent-chat/unread-counts', () => {
  it('returns the map for the caller', async () => {
    mockGetUnreadCounts.mockResolvedValue({ [AGENT_ID]: 2, [OTHER_AGENT_ID]: 1 });

    const res = await request(makeApp()).get(
      `/api/agent-chat/unread-counts?tenantId=${TENANT_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counts: { [AGENT_ID]: 2, [OTHER_AGENT_ID]: 1 } });
    expect(mockGetUnreadCounts).toHaveBeenCalledWith(TENANT_ID, 'acc-1');
  });

  it('answers with an empty map rather than an error when nothing is unread', async () => {
    const res = await request(makeApp()).get(
      `/api/agent-chat/unread-counts?tenantId=${TENANT_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counts: {} });
  });

  it('is not shadowed by the :agentId routes', async () => {
    // The path is a single segment, so it would be swallowed whole by a
    // `GET /:agentId` registered above it. This is the assertion that fails if
    // somebody adds one.
    const res = await request(makeApp()).get(
      `/api/agent-chat/unread-counts?tenantId=${TENANT_ID}`,
    );

    expect(res.status).toBe(200);
    expect(mockGetUnreadCounts).toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(makeApp(null)).get(
      `/api/agent-chat/unread-counts?tenantId=${TENANT_ID}`,
    );

    expect(res.status).toBe(401);
    expect(mockGetUnreadCounts).not.toHaveBeenCalled();
  });

  it('rejects a missing tenantId', async () => {
    const res = await request(makeApp()).get('/api/agent-chat/unread-counts');

    expect(res.status).toBe(400);
    expect(mockGetUnreadCounts).not.toHaveBeenCalled();
  });
});

describe('POST /api/agent-chat/:agentId/threads/read-all', () => {
  it("marks this team's unread threads read for the authenticated caller and answers 204", async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/read-all`)
      .send({ tenantId: TENANT_ID, accountId: 'someone-else' });

    expect(res.status).toBe(204);
    expect(mockMarkAllThreadsRead).toHaveBeenCalledWith(TENANT_ID, 'acc-1', AGENT_ID);
    // Not mistaken for a thread id by the per-thread read route.
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(makeApp(null))
      .post(`/api/agent-chat/${AGENT_ID}/threads/read-all`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(401);
    expect(mockMarkAllThreadsRead).not.toHaveBeenCalled();
  });

  it('answers 404 for a non-member', async () => {
    mockGetMembership.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/read-all`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(404);
    expect(mockMarkAllThreadsRead).not.toHaveBeenCalled();
  });

  it('rejects an invalid tenantId or agentId', async () => {
    const badBody = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/threads/read-all`)
      .send({ tenantId: 'not-a-uuid' });
    const badAgent = await request(makeApp())
      .post('/api/agent-chat/not-a-uuid/threads/read-all')
      .send({ tenantId: TENANT_ID });

    expect(badBody.status).toBe(400);
    expect(badAgent.status).toBe(400);
    expect(mockMarkAllThreadsRead).not.toHaveBeenCalled();
  });
});
