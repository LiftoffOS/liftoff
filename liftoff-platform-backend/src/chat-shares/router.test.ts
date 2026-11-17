// Chat Shares Router tests.
//
// The router's repository is mocked here, so these tests assert on
// upsertShare/findShareById arguments only — tenant/admin scoping lives
// inside the real repository and is covered by repository.test.ts.
//
// GET leak-resistance: unknown id, non-member, and soft-deleted thread must
// produce byte-identical 404s so nothing about a share's existence leaks.

import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockResolveCaller = jest.fn();
jest.mock('../auth/resolve-caller', () => ({
  resolveCaller: (...args: unknown[]) => mockResolveCaller(...args),
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));

const mockGetMembership = jest.fn();
jest.mock('../tenant-members', () => ({
  tenantMembersService: { getMembership: mockGetMembership },
}));

const mockGetThread = jest.fn();
const mockGetParticipants = jest.fn();
jest.mock('../agent-chat/chat-repository', () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
  getParticipants: (...args: unknown[]) => mockGetParticipants(...args),
}));

const mockUpsertShare = jest.fn();
const mockFindShareById = jest.fn();
jest.mock('./repository', () => ({
  upsertShare: (...args: unknown[]) => mockUpsertShare(...args),
  findShareById: (...args: unknown[]) => mockFindShareById(...args),
}));

const mockTeamPlanThreadExists = jest.fn();
jest.mock('../workforce-plans/team-plan-thread-client', () => ({
  teamPlanThreadExists: (...args: unknown[]) => mockTeamPlanThreadExists(...args),
}));

// The insights and liftoff repositories enforce their own visibility matrix
// (owner/admin see every thread in the tenant, member/viewer only their own) and
// return null for anything outside it. Mocking them here is mocking that answer,
// not reimplementing the rule.
const mockInsightsGetThread = jest.fn();
jest.mock('../insights/chat-repository', () => ({
  getThread: (...args: unknown[]) => mockInsightsGetThread(...args),
}));

const mockLiftoffGetThread = jest.fn();
jest.mock('../liftoff/chat-repository', () => ({
  getThread: (...args: unknown[]) => mockLiftoffGetThread(...args),
}));

import { chatSharesRouter } from './router';

// ── Test app ───────────────────────────────────────────────────────────────

function buildApp(userId?: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { ctx?: { userId: string } }).ctx = userId
      ? { userId }
      : undefined;
    next();
  });
  app.use('/api/chat-shares', chatSharesRouter);
  return app;
}

function makeRequest(
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const THREAD_ID = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';
const SHARE_ID = '66666666-6666-6666-6666-666666666666';
const FIREBASE_UID = 'firebase-uid-test';

const VALID_BODY = { tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID };

// The two surfaces with no agent: their bodies and resolutions carry a thread id
// and nothing else. Paired with the repository whose visibility answer decides
// whether the caller may share or open the thread.
const AGENTLESS_KINDS: ReadonlyArray<['insights' | 'liftoff', () => jest.Mock]> = [
  ['insights', () => mockInsightsGetThread],
  ['liftoff', () => mockLiftoffGetThread],
];

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveCaller.mockResolvedValue({
    ok: true,
    caller: { accountId: ACCOUNT_ID, tenantId: TENANT_ID, role: 'member' },
  });
  mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID });
  mockGetParticipants.mockResolvedValue([
    { agentId: AGENT_ID, addedBy: ACCOUNT_ID, role: 'lead', addedAt: 'now' },
  ]);
  mockUpsertShare.mockResolvedValue(SHARE_ID);
  mockTeamPlanThreadExists.mockResolvedValue(true);
  mockInsightsGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID, accountId: ACCOUNT_ID });
  mockLiftoffGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID, accountId: ACCOUNT_ID });
  mockFindShareById.mockResolvedValue({
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    threadKind: 'agent',
  });
});

// ── POST / ─────────────────────────────────────────────────────────────────

describe('POST /api/chat-shares', () => {
  it('400s on an invalid body without touching the repos', async () => {
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
      tenantId: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockGetThread).not.toHaveBeenCalled();
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('passes resolveCaller failures through (401 unauthenticated)', async () => {
    mockResolveCaller.mockResolvedValue({
      ok: false,
      status: 401,
      error: 'Authentication required',
    });
    const res = await makeRequest(buildApp(), 'POST', '/api/chat-shares', VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('404s for non-members with the resolveCaller body (Tenant not found)', async () => {
    mockResolveCaller.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'Tenant not found',
    });
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Tenant not found' });
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('404s when the thread is missing, soft-deleted, or cross-tenant', async () => {
    mockGetThread.mockResolvedValue(null);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_ID);
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('400s when the agent is not a participant in the thread', async () => {
    mockGetParticipants.mockResolvedValue([
      { agentId: '77777777-7777-7777-7777-777777777777', addedBy: ACCOUNT_ID, role: 'lead', addedAt: 'now' },
    ]);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'That agent is not part of this conversation' });
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('200s with the share id, upserting with the resolved account id', async () => {
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: SHARE_ID });
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'agent');
  });

  it('checks a team-plan thread over HTTP, not against agent_chat_threads', async () => {
    // Team-plan threads live in the `workforce` database, so getThread would
    // find nothing and every CAIO share would 404 if the kind were ignored.
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
      ...VALID_BODY,
      threadKind: 'team_plan',
    });
    expect(res.status).toBe(200);
    expect(mockTeamPlanThreadExists).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      role: 'member',
    });
    expect(mockGetThread).not.toHaveBeenCalled();
    // A team-plan thread has one participant, the CAIO, so the agent-chat
    // participant check does not apply.
    expect(mockGetParticipants).not.toHaveBeenCalled();
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'team_plan');
  });

  it('404s when the team-plan thread is gone', async () => {
    mockTeamPlanThreadExists.mockResolvedValue(false);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
      ...VALID_BODY,
      threadKind: 'team_plan',
    });
    expect(res.status).toBe(404);
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it.each(AGENTLESS_KINDS)(
    'mints a share for the %s surface through its own visibility rule',
    async (threadKind, getMock) => {
      const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        threadKind,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: SHARE_ID });
      // Thread id and tenant only. Since migration 351 these two surfaces read
      // like team chat, so there is no account or role for the repository to
      // apply and the check is existence within the workspace.
      expect(getMock()).toHaveBeenCalledWith(THREAD_ID, TENANT_ID);
      expect(mockGetThread).not.toHaveBeenCalled();
      expect(mockTeamPlanThreadExists).not.toHaveBeenCalled();
      // No agent, so nothing to check against a participant list.
      expect(mockGetParticipants).not.toHaveBeenCalled();
      expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, null, THREAD_ID, ACCOUNT_ID, threadKind);
    },
  );

  it.each(AGENTLESS_KINDS)(
    'refuses a thread on the %s surface the caller cannot see, the way agent chat refuses one',
    async (threadKind, getMock) => {
      mockGetThread.mockResolvedValue(null);
      const agentRefusal = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', VALID_BODY);

      getMock().mockResolvedValue(null);
      const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        threadKind,
      });

      // Byte-identical to the agent-kind refusal: someone else's thread and no
      // such thread must be indistinguishable.
      expect(res.status).toBe(agentRefusal.status);
      expect(res.body).toEqual(agentRefusal.body);
      expect(mockUpsertShare).not.toHaveBeenCalled();
    },
  );

  it('400s on an unknown thread kind without touching any thread store', async () => {
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
      ...VALID_BODY,
      threadKind: 'workflow',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockGetThread).not.toHaveBeenCalled();
    expect(mockTeamPlanThreadExists).not.toHaveBeenCalled();
    expect(mockInsightsGetThread).not.toHaveBeenCalled();
    expect(mockLiftoffGetThread).not.toHaveBeenCalled();
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it.each(AGENTLESS_KINDS)('400s when an agent id is sent with a share of the %s surface', async (threadKind) => {
    // Rejected rather than ignored: the row cannot hold one for these kinds
    // (migration 350), so accepting it would mean silently dropping caller data.
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
      ...VALID_BODY,
      threadKind,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('400s when an agent-chat share omits the agent id', async () => {
    const res = await makeRequest(buildApp(FIREBASE_UID), 'POST', '/api/chat-shares', {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });

  it('returns the same id on repeated shares of the same thread', async () => {
    const app = buildApp(FIREBASE_UID);
    const first = await makeRequest(app, 'POST', '/api/chat-shares', VALID_BODY);
    const second = await makeRequest(app, 'POST', '/api/chat-shares', VALID_BODY);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockUpsertShare).toHaveBeenCalledTimes(2);
  });
});

// ── GET /:shareId ──────────────────────────────────────────────────────────

describe('GET /api/chat-shares/:shareId', () => {
  it('404s on a non-UUID share id with zero repo calls', async () => {
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', '/api/chat-shares/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Share link not found' });
    expect(mockFindShareById).not.toHaveBeenCalled();
    expect(mockGetByFirebaseUid).not.toHaveBeenCalled();
  });

  it('401s with no auth context', async () => {
    const res = await makeRequest(buildApp(), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(mockFindShareById).not.toHaveBeenCalled();
  });

  it('401s for an unknown account', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Account not found' });
    expect(mockFindShareById).not.toHaveBeenCalled();
  });

  it('404s on an unknown share id', async () => {
    mockFindShareById.mockResolvedValue(null);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Share link not found' });
  });

  it('404s for non-members with a response byte-identical to unknown id', async () => {
    mockFindShareById.mockResolvedValue(null);
    const unknown = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);

    mockFindShareById.mockResolvedValue({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      threadKind: 'agent',
    });
    mockGetMembership.mockResolvedValue(null);
    const nonMember = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);

    expect(nonMember.status).toBe(unknown.status);
    expect(nonMember.body).toEqual(unknown.body);
    expect(mockGetMembership).toHaveBeenCalledWith(TENANT_ID, ACCOUNT_ID);
  });

  it('404s when the thread has been soft-deleted since sharing', async () => {
    mockGetThread.mockResolvedValue(null);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Share link not found' });
    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_ID);
  });

  it('200s with the share resolution for a member', async () => {
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      // The frontend routes on this: 'agent' goes to the agent chat page,
      // 'team_plan' to /dashboard/agents/plan.
      threadKind: 'agent',
    });
    expect(mockFindShareById).toHaveBeenCalledWith(SHARE_ID);
  });

  it('resolves a team-plan share against workforce-service', async () => {
    mockFindShareById.mockResolvedValue({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      threadKind: 'team_plan',
    });
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(200);
    expect((res.body as { threadKind?: string }).threadKind).toBe('team_plan');
    expect(mockTeamPlanThreadExists).toHaveBeenCalled();
    expect(mockGetThread).not.toHaveBeenCalled();
  });

  it('404s a team-plan share whose thread was deleted since sharing', async () => {
    mockFindShareById.mockResolvedValue({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      threadKind: 'team_plan',
    });
    mockTeamPlanThreadExists.mockResolvedValue(false);
    const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Share link not found' });
  });

  it.each(AGENTLESS_KINDS)(
    'resolves a share of the %s surface to a payload with no agentId key',
    async (threadKind, getMock) => {
      mockFindShareById.mockResolvedValue({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        threadKind,
      });

      const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tenantId: TENANT_ID, threadId: THREAD_ID, threadKind });
      // Neither surface has an agent in its URLs, so the frontend gets a shape
      // where the key is absent rather than a placeholder it might route on.
      expect(res.body).not.toHaveProperty('agentId');
      // Still re-checked on every read, because the thread may have been
      // soft-deleted since the link was minted. What it no longer checks is who
      // is reading: that mismatch is exactly why a shared link used to 404 for
      // the colleague it was sent to.
      expect(getMock()).toHaveBeenCalledWith(THREAD_ID, TENANT_ID);
      expect(mockGetThread).not.toHaveBeenCalled();
    },
  );

  it.each(AGENTLESS_KINDS)(
    '404s a share of the %s surface whose thread this reader cannot see',
    async (threadKind, getMock) => {
      mockFindShareById.mockResolvedValue({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        threadKind,
      });
      getMock().mockResolvedValue(null);

      const res = await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Share link not found' });
    },
  );

  it('never writes on GET', async () => {
    await makeRequest(buildApp(FIREBASE_UID), 'GET', `/api/chat-shares/${SHARE_ID}`);
    expect(mockUpsertShare).not.toHaveBeenCalled();
  });
});
