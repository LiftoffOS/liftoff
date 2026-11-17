// MCP chat-run settle-by-approval endpoint — unit tests (durable HITL Option 1).
//
// The TR resume/expiry path calls POST /api/internal/mcp-chat-runs/settle-by-approval
// to (a) deliver the resumed continuation to the chat thread (EVERY origin) and
// (b) settle any durable MCP run that paused on the approval. Tests cover: auth,
// validation, the MCP completed/failed/empty paths, the web-origin path (no run,
// posts to the thread), and the non-chat guard.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (_tenantId: string, fn: (client: { query: typeof mockPoolQuery }) => unknown) => fn({ query: mockPoolQuery }),
  ),
  pool: { query: jest.fn() },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

jest.mock('../../agent-chat/chat-service', () => ({ runAgentChatTurn: jest.fn() }));
// The same resolver every writer of a team's speech uses; here it maps a
// runtime id straight to a named contributor so the route's own behaviour is
// what is under test.
const mockResolveContributors = jest.fn(async (_tenantId: string, ids: string[]) =>
  ids.map((id) => ({ id: `internal-${id}`, label: `Team ${id}` })),
);
jest.mock('../../agent-chat/contributors', () => ({
  resolveContributors: (...a: unknown[]) => mockResolveContributors(...(a as [string, string[]])),
}));
jest.mock('../../tenant-members', () => ({ tenantMembersService: { getMembership: jest.fn() } }));

// The team's thread is the system of record and is written above; this carries a
// copy into the Liftoff conversation that asked for the work, when there is one.
// Mocked at its own seam: what it does with a pairing is its own suite.
const mockMirror = jest.fn();
jest.mock('../../liftoff/delegated-continuation', () => ({
  mirrorDelegatedReplyToLiftoff: (...args: unknown[]) => mockMirror(...args),
}));

import { mcpChatRunWorkerRouter } from '../chat-run-worker';

const TOKEN = 'callback-secret';
const TENANT = '11111111-1111-1111-1111-111111111111';
const APPROVAL = 'appr-123';
const THREAD = '66666666-6666-6666-6666-666666666666';
const RUN = {
  id: '77777777-7777-7777-7777-777777777777',
  thread_id: THREAD,
  agent_id: '55555555-5555-5555-5555-555555555555',
};
const THREAD_EXISTS = { rows: [{ exists: 1 }] };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/mcp-chat-runs', mcpChatRunWorkerRouter);
  return app;
}

async function post(
  app: express.Express,
  body: unknown,
  auth?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/mcp-chat-runs/settle-by-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-service-auth': auth } : {}) },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const sqls = () => mockPoolQuery.mock.calls.map((c) => String(c[0]));
const call = (needle: string) => mockPoolQuery.mock.calls.find((c) => String(c[0]).includes(needle));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  mockMirror.mockResolvedValue(null);
});

describe('hitl settle-by-approval', () => {
  it('401s without the platform-callback token', async () => {
    const res = await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, replyText: 'hi' }, 'wrong');
    expect(res.status).toBe(401);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('400s when tenantId or approvalId is missing', async () => {
    const res = await post(buildApp(), { tenantId: TENANT }, TOKEN);
    expect(res.status).toBe(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('MCP completed: posts the continuation (run agent) and flips the run to completed', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RUN] })            // SELECT FOR UPDATE run
      .mockResolvedValueOnce(THREAD_EXISTS)              // SELECT agent_chat_threads exists
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }] })// INSERT agent_chat_messages
      .mockResolvedValueOnce({ rowCount: 1 })            // UPDATE thread touch
      .mockResolvedValueOnce({ rowCount: 1 });           // UPDATE mcp_chat_runs completed
    const res = await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed', replyText: 'All done.' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: true, posted: true, chatRunId: RUN.id, status: 'completed' });
    // No participant lookup needed — the run supplies the agent.
    expect(sqls().some((s) => s.includes('agent_chat_thread_participants'))).toBe(false);
    const insert = call('INSERT INTO agent_chat_messages');
    // Nobody else had a hand in it: the column gets the empty list, never NULL.
    expect(insert![1]).toEqual([TENANT, THREAD, RUN.agent_id, 'All done.', '[]']);
    const upd = call('UPDATE mcp_chat_runs');
    expect(String(upd![0])).toContain("status = 'completed'");
    expect(upd![1]).toEqual([RUN.id, 'msg-1']);
  });

  it('MCP failed: flips the run to failed with error_code, posts nothing', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RUN] })  // SELECT FOR UPDATE run
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE mcp_chat_runs failed
    const res = await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'failed', errorCode: 'approval_expired' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: true, posted: false, chatRunId: RUN.id, status: 'failed' });
    expect(sqls().some((s) => s.includes('INSERT INTO agent_chat_messages'))).toBe(false);
    const upd = call('UPDATE mcp_chat_runs');
    expect(String(upd![0])).toContain("status = 'failed'");
    expect(upd![1]).toEqual([RUN.id, 'approval_expired']);
  });

  it('MCP completed with blank text: completes the run with no message (never hangs)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RUN] })  // SELECT FOR UPDATE run
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE mcp_chat_runs completed (no insert)
    const res = await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, replyText: '   ' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: true, posted: false, status: 'completed' });
    expect(sqls().some((s) => s.includes('INSERT INTO agent_chat_messages'))).toBe(false);
    expect(call('UPDATE mcp_chat_runs')![1]).toEqual([RUN.id, null]);
  });

  it('web-origin (no run): posts the continuation to the thread using the participant agent', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                          // SELECT FOR UPDATE run -> none
      .mockResolvedValueOnce(THREAD_EXISTS)                         // SELECT agent_chat_threads exists
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-web' }] })// SELECT participant agent
      .mockResolvedValueOnce({ rows: [{ id: 'msg-2' }] })          // INSERT agent_chat_messages
      .mockResolvedValueOnce({ rowCount: 1 });                     // UPDATE thread touch
    const res = await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed', replyText: 'Continued.' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: true, posted: true });
    expect(res.body.chatRunId).toBeUndefined();
    const insert = call('INSERT INTO agent_chat_messages');
    expect(insert![1]).toEqual([TENANT, THREAD, 'agent-web', 'Continued.', '[]']);
    expect(sqls().some((s) => s.includes('UPDATE mcp_chat_runs'))).toBe(false);
  });

  it('non-chat thread (autonomous/workflow resume): posts nothing, settled:false', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })  // SELECT FOR UPDATE run -> none
      .mockResolvedValueOnce({ rows: [] }); // SELECT agent_chat_threads -> not a chat thread
    const res = await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed', replyText: 'x' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: false, posted: false });
    expect(sqls().some((s) => s.includes('INSERT INTO agent_chat_messages'))).toBe(false);
  });
});

// Liftoff can hand a turn to an agent, and when it does, the conversation the
// person is reading is the LIFTOFF one. The continuation above reaches the
// team's thread, which is right and stays the system of record, but delivered
// only there it lands somewhere they never opened.
// A continuation the person reads after an approval is attributed exactly
// like a streamed reply: the resumed run says who it handed work to, the
// same resolver names them, and the row carries them.
describe('attributing the continuation', () => {
  it('writes the teammates the resumed run brought in as the continuation\'s contributors', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RUN] })
      .mockResolvedValueOnce(THREAD_EXISTS)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-3' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const res = await post(buildApp(), {
      tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed',
      replyText: 'Rotated the keys with Security Review.', delegatedTo: ['rt-7', 7, null],
    }, TOKEN);
    expect(res.status).toBe(200);
    // Only the strings reach the resolver.
    expect(mockResolveContributors).toHaveBeenCalledWith(TENANT, ['rt-7']);
    const insert = call('INSERT INTO agent_chat_messages');
    expect(String(insert![0])).toMatch(/role, content, contributors\)/);
    expect(insert![1][4]).toBe(JSON.stringify([{ id: 'internal-rt-7', label: 'Team rt-7' }]));
  });

  it('reads an older runtime that sends no delegatedTo as nobody', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RUN] })
      .mockResolvedValueOnce(THREAD_EXISTS)
      .mockResolvedValueOnce({ rows: [{ id: 'msg-4' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed', replyText: 'Done.' }, TOKEN);
    expect(mockResolveContributors).toHaveBeenCalledWith(TENANT, []);
    expect(call('INSERT INTO agent_chat_messages')![1][4]).toBe('[]');
  });
});

describe('carrying the continuation to the conversation that asked for it', () => {
  it('mirrors the reply for the thread it was actually posted to', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                          // no MCP run
      .mockResolvedValueOnce(THREAD_EXISTS)                         // a real chat thread
      .mockResolvedValueOnce({ rows: [{ agent_id: 'agent-web' }] }) // participant agent
      .mockResolvedValueOnce({ rows: [{ id: 'msg-3' }] })           // INSERT
      .mockResolvedValueOnce({ rowCount: 1 });                      // touch

    await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed', replyText: 'Refund issued.' }, TOKEN);

    expect(mockMirror).toHaveBeenCalledWith({
      tenantId: TENANT,
      delegateThreadId: THREAD,
      replyText: 'Refund issued.',
    });
  });

  it('does not mirror a continuation that was never posted anywhere', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })  // no MCP run
      .mockResolvedValueOnce({ rows: [] }); // not a chat thread at all

    await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'completed', replyText: 'x' }, TOKEN);

    expect(mockMirror).not.toHaveBeenCalled();
  });

  it('does not mirror an expiry, which has no reply to carry', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [RUN] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await post(buildApp(), { tenantId: TENANT, approvalId: APPROVAL, threadId: THREAD, outcome: 'failed', errorCode: 'approval_expired' }, TOKEN);

    expect(mockMirror).not.toHaveBeenCalled();
  });
});
