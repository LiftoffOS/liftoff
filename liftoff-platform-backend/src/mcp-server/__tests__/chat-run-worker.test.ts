// MCP chat-run worker — unit tests.
// Claim WITHOUT reclaim (queued-only), duplicate-delivery no-op, terminal
// mapping with hitl_required-WINS precedence, and channelHint 'web'.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';

const mockPoolQuery = jest.fn();
const mockDefaultPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockPoolQuery }) => unknown) => {
    return fn({ query: mockPoolQuery });
  }),
  pool: { query: (...args: unknown[]) => mockDefaultPoolQuery(...args) },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

const mockGetMembership = jest.fn();
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: (...args: unknown[]) => mockGetMembership(...args) },
}));

type ChatEvent =
  | { type: 'thinking' }
  | { type: 'hitl_required'; approvalId: string; reason: string; action?: string | null; why?: string | null; detail?: string | null }
  | { type: 'complete'; message: { id: string } }
  | { type: 'error'; code: string; message: string };

let scriptedEvents: ChatEvent[] = [];
jest.mock('../../agent-chat/chat-service', () => ({
  runAgentChatTurn: jest.fn(async function* () {
    for (const e of scriptedEvents) yield e;
  }),
}));

// Assistant-run collaborators, scripted the same way the team generator is.
let liftoffScriptedEvents: Array<Record<string, unknown>> = [];
const mockRunLiftoffChatTurn = jest.fn(async function* () {
  for (const e of liftoffScriptedEvents) yield e;
});
jest.mock('../../liftoff/chat-service', () => ({
  runLiftoffChatTurn: (...args: unknown[]) => mockRunLiftoffChatTurn(...args),
}));

const mockTryAcquireLiftoffLock = jest.fn();
const mockReleaseLiftoffLock = jest.fn();
jest.mock('../../liftoff/turn-control', () => ({
  newTurnId: () => 'turn-test-1',
  tryAcquireTurnLock: (...args: unknown[]) => mockTryAcquireLiftoffLock(...args),
  releaseTurnLock: (...args: unknown[]) => mockReleaseLiftoffLock(...args),
}));

let delegateScriptedEvents: Array<Record<string, unknown>> = [];
const mockDelegateRunTurn = jest.fn();
const mockCreateDelegateRuntime = jest.fn(() => ({
  runTurn: async function* (args: unknown) {
    mockDelegateRunTurn(args);
    for (const e of delegateScriptedEvents) yield e;
  },
}));
jest.mock('../../liftoff/delegation-runtimes', () => ({
  createDelegateRuntime: (...args: unknown[]) => mockCreateDelegateRuntime(...args),
}));

import { runAgentChatTurn } from '../../agent-chat/chat-service';
import { mcpChatRunWorkerRouter } from '../chat-run-worker';

const RUN_ROW = {
  thread_id: '66666666-6666-6666-6666-666666666666',
  agent_id: '55555555-5555-5555-5555-555555555555',
  anchor_token_id: '33333333-3333-3333-3333-333333333333',
  user_message: 'hello team',
  target_kind: 'agent',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/mcp-chat-runs', mcpChatRunWorkerRouter);
  return app;
}

async function post(app: express.Express, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/mcp-chat-runs/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': 'test-secret' },
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

const BODY = { chatRunId: '77777777-7777-7777-7777-777777777777', tenantId: '11111111-1111-1111-1111-111111111111' };

beforeEach(() => {
  jest.clearAllMocks();
  scriptedEvents = [];
  liftoffScriptedEvents = [];
  delegateScriptedEvents = [];
  mockTryAcquireLiftoffLock.mockResolvedValue({ turnId: 'turn-test-1', abortController: new AbortController() });
  mockReleaseLiftoffLock.mockResolvedValue(undefined);
  process.env.INTERNAL_SERVICE_SECRET = 'test-secret';
  // Caller resolution defaults: anchor+account row (scripted per test), then
  // membership; tenants.name via default pool.
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockDefaultPoolQuery.mockResolvedValue({ rows: [{ name: 'Acme' }] });
});

function scriptClaim(rows: unknown[]): void {
  mockPoolQuery.mockResolvedValueOnce({ rows });                       // claim
  mockPoolQuery.mockResolvedValueOnce({                                 // anchor/account
    rows: [{ account_id: '44444444-4444-4444-4444-444444444444', first_name: 'A', last_name: 'B', email: 'a@b.c' }],
  });
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });          // terminal update + anything else
}

describe('mcp chat-run worker', () => {
  it('401s without valid auth', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'other';
    const res = await post(buildApp(), BODY);
    expect(res.status).toBe(401);
  });

  it('200-no-ops when the run is not claimable (duplicate delivery / already terminal)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // claim misses
    const res = await post(buildApp(), BODY);
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true);
    expect(runAgentChatTurn).not.toHaveBeenCalled();
  });

  it('claims queued-only (NO reclaim of running rows)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await post(buildApp(), BODY);
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain("status = 'queued'");
    expect(String(mockPoolQuery.mock.calls[0][0])).not.toContain('lease_expires_at <');
  });

  it('maps complete → completed with the assistant message id', async () => {
    scriptClaim([RUN_ROW]);
    scriptedEvents = [{ type: 'thinking' }, { type: 'complete', message: { id: 'msg-1' } }];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('completed');
    const terminal = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes("status = 'running'") && String(c[0]).includes('assistant_message_id'));
    expect(terminal![1]).toEqual([BODY.chatRunId, 'completed', 'msg-1', null, null, null, null, null, null, null]);
  });

  it('hitl_required WINS over a later complete (message id still persisted)', async () => {
    scriptClaim([RUN_ROW]);
    scriptedEvents = [
      { type: 'hitl_required', approvalId: 'appr-1', reason: 'sensitive' },
      { type: 'complete', message: { id: 'msg-2' } },
    ];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('waiting_on_human');
    const terminal = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('assistant_message_id'));
    expect(terminal![1]).toEqual([BODY.chatRunId, 'waiting_on_human', 'msg-2', 'appr-1', null, null, null, null, null, null]);
  });

  it('persists the generic HITL card summary from the hitl_required frame (wire contract)', async () => {
    scriptClaim([RUN_ROW]);
    scriptedEvents = [
      {
        type: 'hitl_required', approvalId: 'appr-9', reason: 'sensitive',
        action: 'Merge pull request #123 in acme/website',
        why: 'Both reviews approved',
        detail: 'github · merge_pull_request — repo acme/website',
      },
    ];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('waiting_on_human');
    const terminal = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('action_summary'));
    expect(terminal![1]).toEqual([
      BODY.chatRunId, 'waiting_on_human', null, 'appr-9', null,
      'Merge pull request #123 in acme/website', 'Both reviews approved',
      'github · merge_pull_request — repo acme/website', null, null,
    ]);
  });

  it('maps a first error event → failed with its code', async () => {
    scriptClaim([RUN_ROW]);
    scriptedEvents = [{ type: 'error', code: 'PROVIDER_ERROR', message: 'boom' }];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
  });

  it('a generator that ends without a terminal event → failed(no_terminal)', async () => {
    scriptClaim([RUN_ROW]);
    scriptedEvents = [{ type: 'thinking' }];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
    const terminal = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('assistant_message_id'));
    expect(terminal![1][4]).toBe('no_terminal');
  });

  it("runs the turn with channelHint 'web' (PB/TR enums exclude 'mcp')", async () => {
    scriptClaim([RUN_ROW]);
    scriptedEvents = [{ type: 'complete', message: { id: 'msg-3' } }];
    await post(buildApp(), BODY);
    expect(runAgentChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelHint: 'web',
      content: 'hello team',
      threadId: RUN_ROW.thread_id,
    }));
  });
});

// ── Assistant runs (target_kind 'liftoff' / 'insights' / 'caio') ────────

const LIFTOFF_RUN_ROW = { ...RUN_ROW, agent_id: null, target_kind: 'liftoff' };
const INSIGHTS_RUN_ROW = { ...RUN_ROW, agent_id: null, target_kind: 'insights' };
const CAIO_RUN_ROW = { ...RUN_ROW, agent_id: null, target_kind: 'caio' };

function terminalUpdateCall(): unknown[] | undefined {
  return mockPoolQuery.mock.calls.find(
    (c) => String(c[0]).includes("status = 'running'") && String(c[0]).includes('reply_content'),
  ) as unknown[] | undefined;
}

describe('mcp chat-run worker: assistant runs', () => {
  it('liftoff: complete → completed with the reply denormalized onto the run', async () => {
    scriptClaim([LIFTOFF_RUN_ROW]);
    liftoffScriptedEvents = [
      { type: 'thinking' },
      { type: 'complete', message: { id: 'lm-1', content: 'Here is the answer.' } },
    ];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('completed');
    expect(runAgentChatTurn).not.toHaveBeenCalled();
    expect(mockRunLiftoffChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: RUN_ROW.thread_id,
      accountId: '44444444-4444-4444-4444-444444444444',
      role: 'member',
      userMessage: 'hello team',
      turnId: 'turn-test-1',
    }));
    expect(mockReleaseLiftoffLock).toHaveBeenCalled();
    const terminal = terminalUpdateCall();
    // reply_content is the ninth parameter; assistant_message_id stays null.
    expect(terminal![1]).toEqual([BODY.chatRunId, 'completed', null, null, null, null, null, null, 'Here is the answer.', null]);
  });

  it('liftoff: a delegated reply carries answered_by from the persisted author label', async () => {
    scriptClaim([LIFTOFF_RUN_ROW]);
    liftoffScriptedEvents = [
      { type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' },
      {
        type: 'complete',
        message: { id: 'lm-3', content: 'Cost was 12 OUs.', author: 'insights', authorLabel: 'Insights Manager' },
      },
    ];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('completed');
    const terminal = terminalUpdateCall()![1] as unknown[];
    expect(terminal[8]).toBe('Cost was 12 OUs.');
    expect(terminal[9]).toBe('Insights Manager');
  });

  it('liftoff: a held dashboard lock → failed(busy) without running the turn', async () => {
    scriptClaim([LIFTOFF_RUN_ROW]);
    mockTryAcquireLiftoffLock.mockResolvedValue(null);
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
    expect((terminalUpdateCall()![1] as unknown[])[4]).toBe('busy');
  });

  it('liftoff: delegation_paused is terminal success with the pause sentence as the reply', async () => {
    scriptClaim([LIFTOFF_RUN_ROW]);
    liftoffScriptedEvents = [
      {
        type: 'delegation_paused', author: 'a-1', authorLabel: 'Marketing Team',
        delegateThreadId: 'dt-1', reason: 'waiting',
        message: { id: 'lm-2', content: 'Marketing Team is waiting on an approval before it can continue.' },
      },
    ];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('completed');
    expect((terminalUpdateCall()![1] as unknown[])[8]).toBe('Marketing Team is waiting on an approval before it can continue.');
  });

  it('insights: runs through the delegate runtime with the anchor caller', async () => {
    scriptClaim([INSIGHTS_RUN_ROW]);
    delegateScriptedEvents = [
      { type: 'text_delta', text: 'partial' },
      { type: 'complete', text: 'Cost was 12 OUs this week.', blocks: null, inputTokens: 1, outputTokens: 2 },
    ];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('completed');
    expect(mockCreateDelegateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'insights' }),
      expect.objectContaining({
        tenantId: BODY.tenantId,
        accountId: '44444444-4444-4444-4444-444444444444',
        role: 'member',
      }),
    );
    expect((terminalUpdateCall()![1] as unknown[])[8]).toBe('Cost was 12 OUs this week.');
  });

  it('caio: busy → failed(busy)', async () => {
    scriptClaim([CAIO_RUN_ROW]);
    delegateScriptedEvents = [{ type: 'busy' }];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
    expect(mockCreateDelegateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'caio' }),
      expect.anything(),
    );
    expect((terminalUpdateCall()![1] as unknown[])[4]).toBe('busy');
  });

  it('no membership → failed(caller_unresolved), no turn started, no defaulted role', async () => {
    scriptClaim([RUN_ROW]);
    mockGetMembership.mockResolvedValue(null);
    scriptedEvents = [{ type: 'complete', message: { id: 'msg-1' } }];
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
    expect(runAgentChatTurn).not.toHaveBeenCalled();
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
    expect(mockCreateDelegateRuntime).not.toHaveBeenCalled();
    expect(mockGetMembership).toHaveBeenCalledWith(BODY.tenantId, '44444444-4444-4444-4444-444444444444');
    expect((terminalUpdateCall()![1] as unknown[])[4]).toBe('caller_unresolved');
  });

  it('a membership lookup that throws → failed(caller_unresolved), never a default role', async () => {
    scriptClaim([LIFTOFF_RUN_ROW]);
    mockGetMembership.mockRejectedValue(new Error('db down'));
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
    expect((terminalUpdateCall()![1] as unknown[])[4]).toBe('caller_unresolved');
  });

  it('runs the turn with the role the membership holds now', async () => {
    scriptClaim([LIFTOFF_RUN_ROW]);
    mockGetMembership.mockResolvedValue({ role: 'viewer' });
    liftoffScriptedEvents = [{ type: 'complete', message: { id: 'lm-1', content: 'ok' } }];
    await post(buildApp(), BODY);
    expect(mockRunLiftoffChatTurn).toHaveBeenCalledWith(expect.objectContaining({ role: 'viewer', callerName: 'A B' }));
  });

  it('an unresolvable anchor account → failed(caller_unresolved), no turn started', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [INSIGHTS_RUN_ROW] }); // claim
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });                 // anchor lookup misses
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });        // terminal update
    const res = await post(buildApp(), BODY);
    expect(res.body.status).toBe('failed');
    expect(mockCreateDelegateRuntime).not.toHaveBeenCalled();
    expect((terminalUpdateCall()![1] as unknown[])[4]).toBe('caller_unresolved');
  });
});

// What the message handed over rides the run row and reaches whichever turn
// runs it, exactly as a dashboard composer's request body would.
describe('mcp chat-run worker: attachments', () => {
  const ATTACHMENTS = [
    { kind: 'upload', name: 'notes.md', content: '# notes', addedAt: '2026-09-16T10:00:00.000Z' },
    { kind: 'media', name: 'shot.png', media: { mediaId: '99999999-9999-9999-9999-999999999999', mimeType: 'image/png', filename: 'shot.png' }, addedAt: '2026-09-16T10:00:00.000Z' },
  ];

  it('team: forwarded to runAgentChatTurn', async () => {
    scriptClaim([{ ...RUN_ROW, attachments: ATTACHMENTS }]);
    scriptedEvents = [{ type: 'complete', message: { id: 'msg-1' } }];
    await post(buildApp(), BODY);
    expect(runAgentChatTurn).toHaveBeenCalledWith(expect.objectContaining({ attachments: ATTACHMENTS }));
  });

  it('liftoff: forwarded to runLiftoffChatTurn', async () => {
    scriptClaim([{ ...LIFTOFF_RUN_ROW, attachments: ATTACHMENTS }]);
    liftoffScriptedEvents = [{ type: 'complete', message: { id: 'm', content: 'ok', authorLabel: null } }];
    await post(buildApp(), BODY);
    expect(mockRunLiftoffChatTurn).toHaveBeenCalledWith(expect.objectContaining({ attachments: ATTACHMENTS }));
  });

  it('insights and caio: forwarded through the delegate runtime turn', async () => {
    for (const row of [INSIGHTS_RUN_ROW, CAIO_RUN_ROW]) {
      mockDelegateRunTurn.mockClear();
      scriptClaim([{ ...row, attachments: ATTACHMENTS }]);
      delegateScriptedEvents = [{ type: 'complete', text: 'done', blocks: null, inputTokens: 1, outputTokens: 1 }];
      await post(buildApp(), BODY);
      expect(mockDelegateRunTurn).toHaveBeenCalledWith(expect.objectContaining({ attachments: ATTACHMENTS }));
    }
  });

  it('a run without attachments forwards none', async () => {
    scriptClaim([{ ...RUN_ROW, attachments: null }]);
    scriptedEvents = [{ type: 'complete', message: { id: 'msg-1' } }];
    await post(buildApp(), BODY);
    expect((runAgentChatTurn as jest.Mock).mock.calls[0][0].attachments).toBeUndefined();
  });
});
