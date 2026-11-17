// Agent Chat Service — SDK delegation path tests.
//
// Verifies the SDK-backed interactive chat execution path. These tests
// exercise event translation, session persistence, fallback error behavior,
// and audit logging for the SDK path.
//
// Mocks: database pool, chat repository, tenant runtime client, logging,
// and conversation summarization.



// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  getPool: jest.fn(),
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../common/injection-guard', () => ({
  guardMessage: jest.fn().mockResolvedValue({ safe: true }),
}));

// Title generation calls llmClient.complete (a REAL small-tier LLM request)
// when unmocked. It is fire-and-forget in the service, so it never failed an
// assertion — but it left live network calls running past test completion
// (the "Force exiting Jest" warning) and added load-sensitive latency.
// Mirror of chat-service.test.ts.
jest.mock('../../shared/thread-title-generation', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../chat-repository', () => ({
  appendMessage: jest.fn(),
  createTurnWithUserMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  updateThreadRollingSummary: jest.fn(),
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  TenantRuntimeClient: jest.fn().mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn(),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../insights/conversation-summarization', () => ({
  shouldSummarize: jest.fn().mockReturnValue(false),
  generateRollingSummary: jest.fn(),
  formatSummaryForPrompt: jest.fn().mockReturnValue('formatted summary'),
}));

jest.mock('../../internal-agent-oversight/service', () => ({
  oversightService: {
    getOrCreateOversightSettings: jest.fn().mockResolvedValue({ autonomy: 'full' }),
  },
}));

import { getPool } from '../../infrastructure/database';
import * as chatRepo from '../chat-repository';
import { logAudit } from '../../infrastructure/logging';
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import {
  runAgentChatTurn,
  type AgentChatEvent,
  type AgentChatTurnInput,
} from '../chat-service';

// ── Typed mock references ─────────────────────────────────────────────

const mockGetPool = getPool as jest.Mock;
const mockAppendMessage = chatRepo.appendMessage as jest.Mock;
const mockListMessages = chatRepo.listMessages as jest.Mock;
const mockGetSummary = chatRepo.getThreadRollingSummary as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

// ── Standard fixtures ─────────────────────────────────────────────────

const INPUT: AgentChatTurnInput = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  threadId: 'thread-1',
  userId: 'user-1',
  userDisplayName: 'Test User',
  userRole: 'member',
  tenantName: 'TestCo',
  content: 'Hello agent',
  channelHint: 'web',
};

const AGENT_ROW = {
  id: 'agent-1',
  role: 'Test Agent',
  messaging_nickname: 'Testy',
  system_prompt: 'You are a test agent.',
  user_instructions: null,
  additional_context: null,
  status: 'active',
};

const SAVED_USER_MESSAGE = {
  id: 'msg-user-1',
  tenantId: 'tenant-1',
  threadId: 'thread-1',
  agentId: null,
  role: 'user' as const,
  content: 'Hello agent',
  toolCalls: null,
  inputTokens: 0,
  outputTokens: 0,
  createdAt: '2024-01-01T00:00:00Z',
};

const SAVED_ASSISTANT_MESSAGE = {
  id: 'msg-assistant-1',
  tenantId: 'tenant-1',
  threadId: 'thread-1',
  agentId: 'agent-1',
  role: 'assistant' as const,
  content: 'Hello from SDK!',
  toolCalls: null,
  inputTokens: 200,
  outputTokens: 80,
  createdAt: '2024-01-01T00:01:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a mock SDK stream from a list of ChatTurnStreamEvents. */
function sdkStreamFrom(events: ChatTurnStreamEvent[]): AsyncGenerator<ChatTurnStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** Collect all events from an async iterable into an array. */
async function collectEvents(
  gen: AsyncIterable<AgentChatEvent>,
): Promise<AgentChatEvent[]> {
  const out: AgentChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Standard SDK complete stream: thinking + text_delta + complete. */
function sdkHappyPathStream(): AsyncGenerator<ChatTurnStreamEvent> {
  return sdkStreamFrom([
    { type: 'thinking' },
    { type: 'text_delta', text: 'Hello from SDK!' },
    {
      type: 'complete',
      outputText: 'Hello from SDK!',
      inputTokens: 200,
      outputTokens: 80,
      sessionId: 'session-abc-123',
    },
  ]);
}

/**
 * Set up the mock pool to handle both agent config queries
 * and tenant/session table queries.
 *
 * @param agentRows - rows to return for the agent config query
 * @param sessionRows - rows to return for getSessionId query
 */
function setupMockPool(
  agentRows: any[] = [AGENT_ROW],
  sessionRows: any[] = [],
) {
  const mockQuery = jest.fn().mockImplementation((sql: string, _params?: any[]) => {
    // Agent config query
    if (sql.includes('internal_agents')) {
      return Promise.resolve({ rows: agentRows });
    }
    // getSessionId query
    if (sql.includes('agent_chat_sessions') && sql.includes('SELECT')) {
      return Promise.resolve({ rows: sessionRows });
    }
    // upsertChatSession
    if (sql.includes('agent_chat_sessions') && sql.includes('INSERT')) {
      return Promise.resolve({ rowCount: 1 });
    }
    // Default fallback
    return Promise.resolve({ rows: [] });
  });
  mockGetPool.mockReturnValue({ query: mockQuery });
  return mockQuery;
}

/** Get the runChatTurnStream mock from the most recent TenantRuntimeClient instance. */
function getMockRunChatTurnStream(): jest.Mock {
  const instance = (TenantRuntimeClient as jest.Mock).mock.results[0]?.value;
  return instance?.runChatTurnStream as jest.Mock;
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAppendMessage.mockReset();

  // Default repo mocks
  mockAppendMessage
    .mockResolvedValueOnce(SAVED_ASSISTANT_MESSAGE); // assistant message persist
  (chatRepo.createTurnWithUserMessage as jest.Mock).mockResolvedValue(SAVED_USER_MESSAGE); // user message persists via the turn tx (plan v13)
  mockListMessages.mockResolvedValue({
    messages: [],
    hasMore: false,
    nextCursor: null,
  });
  mockGetSummary.mockResolvedValue(null);

  // Default pool — agent found, no special session setup
  setupMockPool();

  // Reset TenantRuntimeClient mock so each test gets fresh instances
  (TenantRuntimeClient as jest.Mock).mockClear();
  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn().mockReturnValue(sdkHappyPathStream()),
  }));
});

// ── Test cases ────────────────────────────────────────────────────────

describe('runAgentChatTurn — SDK path', () => {
  // ── 1. SDK happy path ───────────────────────────────────────────────

  describe('SDK happy path', () => {
    it('yields thinking -> text_delta -> complete with persisted message', async () => {
      const events = await collectEvents(runAgentChatTurn(INPUT));

      const types = events.map((e) => e.type);
      expect(types[0]).toBe('thinking');
      expect(types).toContain('text_delta');
      expect(types[types.length - 1]).toBe('complete');

      // Verify text delta content
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas).toHaveLength(1);
      expect((deltas[0] as any).text).toBe('Hello from SDK!');

      // Verify complete event carries the persisted message
      const complete = events.find((e) => e.type === 'complete') as any;
      expect(complete.message).toEqual(SAVED_ASSISTANT_MESSAGE);
    });

    it('calls runChatTurnStream with correct parameters', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      const mockStream = getMockRunChatTurnStream();
      expect(mockStream).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          agentId: 'agent-1',
          threadId: 'thread-1',
          userMessage: 'Hello agent',
          channelHint: 'web',
          userId: 'user-1',
          userDisplayName: 'Test User',
          userRole: 'member',
        }),
      );
    });

    it('runs under the invocation id the caller supplied, and mints one otherwise', async () => {
      // The runtime records the run under this id. A caller that reads the
      // run back afterwards (the test harness fetching its trace) has to be
      // the one that names it; an id minted here and never surfaced is one
      // the caller cannot cite.
      await collectEvents(runAgentChatTurn({ ...INPUT, invocationId: '6ebe2b95-0000-4000-8000-000000000001' }));
      expect(getMockRunChatTurnStream()).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ invocationId: '6ebe2b95-0000-4000-8000-000000000001' }),
      );

      (TenantRuntimeClient as jest.Mock).mockClear();
      mockAppendMessage.mockResolvedValueOnce(SAVED_ASSISTANT_MESSAGE);
      await collectEvents(runAgentChatTurn(INPUT));
      const [, body] = getMockRunChatTurnStream().mock.calls[0];
      expect(body.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('persists the assistant message with token counts from complete event', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      // Only appendMessage call (the user message persists via
      // createTurnWithUserMessage): assistant message with SDK token counts.
      // Positional 12 is the turnId stamp (plan v13) — asserted by shape —
      // and the trailing arg is `contributors`, empty for a turn that handed
      // nothing over (migration 493).
      const assistantCall = mockAppendMessage.mock.calls[0];
      expect(assistantCall.slice(0, 8)).toEqual([
        'tenant-1',
        'thread-1',
        'assistant',
        'Hello from SDK!', // accumulated text
        'agent-1',
        undefined,
        200,  // inputTokens from complete event
        80,   // outputTokens from complete event
      ]);
      expect(assistantCall[11]).toMatch(/^[0-9a-f-]{36}$/); // turnId
      expect(assistantCall[assistantCall.length - 1]).toEqual([]); // contributors
    });
  });

  // ── 2. SDK tool_call event ──────────────────────────────────────────

  describe('SDK tool_call event', () => {
    it('yields tool_call to caller when received from TR', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'tool_call', tool: 'memory_save' },
          { type: 'text_delta', text: 'Done saving.' },
          {
            type: 'complete',
            outputText: 'Done saving.',
            inputTokens: 150,
            outputTokens: 60,
            sessionId: 'session-xyz',
          },
        ])),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const toolCallEvents = events.filter((e) => e.type === 'tool_call');
      expect(toolCallEvents).toHaveLength(1);
      expect((toolCallEvents[0] as any).tool).toBe('memory_save');
    });
  });

  // ── 2b. Message boundaries survive into the stored reply ────────────
  //
  // The runtime says where one assistant message ends with a payload-free
  // text_break, because token deltas arrive as an undifferentiated stream and
  // a boundary is not always accompanied by a tool call. That break used to be
  // streamed and then dropped from the text that gets persisted, so the
  // paragraphs were correct on the live stream and run together in the row
  // ("...fetching now.Still failing..."). The row is what a reload, a /share
  // link, and every other participant on the thread read.

  describe('SDK text_break event', () => {
    /** Two assistant messages either side of a tool call, each closed by the
     *  break the runtime emits after every message, the last one included. */
    function twoMessageStream(first: string, second: string) {
      return () => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'text_delta', text: first },
          { type: 'text_break' },
          { type: 'tool_call', tool: 'web_research' },
          { type: 'text_delta', text: second },
          { type: 'text_break' },
          {
            type: 'complete',
            outputText: second,
            inputTokens: 150,
            outputTokens: 60,
            sessionId: 'session-xyz',
          },
        ])),
      });
    }

    it('persists the two messages as separate paragraphs', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(
        twoMessageStream('Retrying the fetch now.', 'Still failing.'),
      );

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockAppendMessage.mock.calls[0][3]).toBe(
        'Retrying the fetch now.\n\nStill failing.',
      );
    });

    it('does not leave the break the runtime writes after the last message', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(
        twoMessageStream('Retrying the fetch now.', 'Still failing.'),
      );

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockAppendMessage.mock.calls[0][3]).not.toMatch(/\s$/);
    });

    it('does not open a gap of four when the message ended on its own newline', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(
        twoMessageStream('- one\n- two\n', 'Done.'),
      );

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockAppendMessage.mock.calls[0][3]).toBe('- one\n- two\n\nDone.');
    });

    it('writes no separator when the break arrives before any text', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'text_break' },
          { type: 'text_delta', text: 'Only one message.' },
          { type: 'text_break' },
          {
            type: 'complete',
            outputText: 'Only one message.',
            inputTokens: 150,
            outputTokens: 60,
            sessionId: 'session-xyz',
          },
        ])),
      }));

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockAppendMessage.mock.calls[0][3]).toBe('Only one message.');
    });

    it('still relays the break to the live stream', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(
        twoMessageStream('First.', 'Second.'),
      );

      const events = await collectEvents(runAgentChatTurn(INPUT));

      expect(events.filter((e) => e.type === 'text_break')).toHaveLength(2);
    });
  });

  // ── 3. SDK hitl_required event ──────────────────────────────────────

  describe('SDK hitl_required event', () => {
    it('yields hitl_required to caller when received from TR', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'hitl_required', approvalId: 'approval-sdk-1', reason: 'Tool requires approval' },
        ])),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const hitlEvents = events.filter((e) => e.type === 'hitl_required');
      expect(hitlEvents).toHaveLength(1);
      expect((hitlEvents[0] as any).approvalId).toBe('approval-sdk-1');
      expect((hitlEvents[0] as any).reason).toBe('Tool requires approval');
    });

    // The insert that keeps a reply used to live only on the `complete` branch,
    // so a turn that wrote two paragraphs and then asked for an approval threw
    // both away: the person watched the text arrive, reloaded, and found their
    // question answered by a status line and nothing else. The resume does not
    // bring it back either, since the continuation the settle callback posts is
    // only what the team says AFTER the decision.
    it('keeps what the team said before the gate stopped it', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'text_delta', text: 'I have drafted the refund. ' },
          { type: 'text_delta', text: 'Sending it needs a sign-off.' },
          { type: 'hitl_required', approvalId: 'approval-sdk-2', reason: 'Tool requires approval' },
        ])),
      }));

      await collectEvents(runAgentChatTurn(INPUT));

      const contents = mockAppendMessage.mock.calls.map((c) => c[3]);
      expect(contents).toContain('I have drafted the refund. Sending it needs a sign-off.');
    });

    // Ordering matters to the reader: what was said, then the stall. And the
    // partial is an ordinary reply, so it carries no status marker and IS keyed
    // by the turn, which is what makes it idempotent against the runtime's
    // settle-turn backstop writing the same text.
    it('persists that partial as ordinary speech, before the status row', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'text_delta', text: 'Drafted.' },
          { type: 'hitl_required', approvalId: 'approval-sdk-3', reason: 'needs approval' },
        ])),
      }));

      await collectEvents(runAgentChatTurn({ ...INPUT, turnId: 'turn-xyz' }));

      const partial = mockAppendMessage.mock.calls.find((c) => c[3] === 'Drafted.');
      const status = mockAppendMessage.mock.calls.find((c) => c[8] === 'hitl_status');
      expect(partial).toBeDefined();
      expect(status).toBeDefined();
      // messageType absent, turnId present.
      expect(partial![8]).toBeUndefined();
      expect(partial![11]).toBe('turn-xyz');
      expect(mockAppendMessage.mock.calls.indexOf(partial!))
        .toBeLessThan(mockAppendMessage.mock.calls.indexOf(status!));
    });

    it('invents nothing when the gate fired before the team said a word', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'hitl_required', approvalId: 'approval-sdk-4', reason: 'needs approval' },
        ])),
      }));

      await collectEvents(runAgentChatTurn(INPUT));

      // Only the status row was written.
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      expect(mockAppendMessage.mock.calls[0][8]).toBe('hitl_status');
    });

    // TR writes exactly ONE frame for a pause and closes the stream. Treating
    // that frame as non-terminal let the loop run out of events and exit
    // through the "stream ended without complete event" branch, which put a
    // provider error on screen over a turn where nothing had failed.
    it('ends the turn on the gate rather than falling through to a provider error', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'hitl_required', approvalId: 'approval-sdk-5', reason: 'needs approval' },
        ])),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    });
  });

  // ── 3b. SDK awaiting_input event ────────────────────────────────────
  //
  // Stopping to ask the person a question is a SUCCESSFUL end to a turn. It
  // used to fall through the loop and out the "stream ended without complete
  // event" exit, which did two things wrong at once: it reported a provider
  // error over a turn where nothing failed, and — because persistence lived
  // only on the `complete` branch — it threw the question away, so the refetch
  // the error triggered wiped it off the screen for good.

  describe('SDK awaiting_input event', () => {
    const QUESTION = 'Which repositories should I look at?';

    function streamPausingOnQuestion(before: string[] = []) {
      return sdkStreamFrom([
        { type: 'thinking' },
        ...before.map((text) => ({ type: 'text_delta' as const, text })),
        { type: 'awaiting_input', question: QUESTION, sessionId: 'clarify-session-1' },
      ]);
    }

    it('ends the turn cleanly instead of reporting a provider error', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(streamPausingOnQuestion()),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
      const awaiting = events.filter((e) => e.type === 'awaiting_input');
      expect(awaiting).toHaveLength(1);
      expect((awaiting[0] as any).question).toBe(QUESTION);
      expect((awaiting[0] as any).sessionId).toBe('clarify-session-1');
    });

    // The whole point: the question has to outlive the stream. It is what the
    // person is being asked, and before this it existed only in the live bubble.
    it('persists the question as ordinary speech so it survives a refetch', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(streamPausingOnQuestion()),
      }));

      await collectEvents(runAgentChatTurn(INPUT));

      const asked = mockAppendMessage.mock.calls.find((c) => c[3] === QUESTION);
      expect(asked).toBeDefined();
      expect(asked![2]).toBe('assistant');
      // No status marker: it is the team talking, not a system status row, so
      // later turns read it back as history.
      expect(asked![8]).toBeUndefined();
      // NOT keyed by the turn — that key belongs to the partial, and losing the
      // race for it would silently drop the question all over again.
      expect(asked![11]).toBeUndefined();
    });

    it('keeps what the team said before the question, keyed by the turn', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(
          streamPausingOnQuestion(['Checking the repos. ', 'One thing first.']),
        ),
      }));

      await collectEvents(runAgentChatTurn({ ...INPUT, turnId: 'turn-await' }));

      const partial = mockAppendMessage.mock.calls.find(
        (c) => c[3] === 'Checking the repos. One thing first.',
      );
      const asked = mockAppendMessage.mock.calls.find((c) => c[3] === QUESTION);
      expect(partial).toBeDefined();
      expect(partial![11]).toBe('turn-await');
      // Reads in the order it happened: what was said, then what was asked.
      expect(mockAppendMessage.mock.calls.indexOf(partial!))
        .toBeLessThan(mockAppendMessage.mock.calls.indexOf(asked!));
    });

    it('invents nothing when the team asked before saying a word', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(streamPausingOnQuestion()),
      }));

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      expect(mockAppendMessage.mock.calls[0][3]).toBe(QUESTION);
    });

    // `sessionId` on this frame is the clarification session the answer routes
    // back to, NOT the SDK session the next turn resumes from. Writing it into
    // agent_chat_sessions would hand the next turn an id the engine has never
    // seen, which the runtime rejects as a stale session.
    it('does not write the clarification session over the SDK session', async () => {
      const mockQuery = setupMockPool();
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(streamPausingOnQuestion()),
      }));

      await collectEvents(runAgentChatTurn(INPUT));

      const upserts = mockQuery.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('agent_chat_sessions') &&
          call[0].includes('INSERT'),
      );
      expect(upserts).toHaveLength(0);
    });
  });

  // ── 4. SDK error event ──────────────────────────────────────────────

  describe('SDK error event', () => {
    it('yields PROVIDER_ERROR with a generic user-facing copy, not the raw TR/SDK message', async () => {
      // Vendor SDK internals ("Claude Code executable not found at
      // /app/node_modules/.../cli.js. Is options.pathToClaudeCodeExecutable
      // set?", ENOENT stacks, etc) are meaningless to a chat user and leak
      // implementation. PB logs the raw event.message for operators and
      // sends the user a generic copy.
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
          { type: 'thinking' },
          { type: 'text_delta', text: 'Starting...' },
          { type: 'error', code: 'EXEC_ERROR', message: 'Claude Code executable not found at /app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js. Is options.pathToClaudeCodeExecutable set?' },
        ])),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect((errorEvents[0] as any).code).toBe('PROVIDER_ERROR');
      expect((errorEvents[0] as any).message).toBe('Something went wrong on our end while running this turn. Please try again.');
      // Defense-in-depth: nothing about the SDK/cli.js/pathToClaudeCodeExecutable
      // leaks into what the user sees.
      expect((errorEvents[0] as any).message).not.toMatch(/cli\.js|pathToClaudeCode|executable not found|ENOENT/i);
    });
  });

  // ── 5. SDK session upsert on complete ───────────────────────────────

  describe('SDK session upsert on complete', () => {
    it('calls upsertChatSession with sessionId from complete event', async () => {
      const mockQuery = setupMockPool();

      await collectEvents(runAgentChatTurn(INPUT));

      // Find the upsert call (INSERT INTO agent_chat_sessions)
      const upsertCalls = mockQuery.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === 'string' &&
          call[0].includes('agent_chat_sessions') &&
          call[0].includes('INSERT'),
      );
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0][1]).toEqual(['thread-1', 'agent-1', 'session-abc-123']);
    });
  });

  // ── 6. SDK session resume ───────────────────────────────────────────

  describe('SDK session resume', () => {
    it('passes resumeSessionId to TR when session exists', async () => {
      setupMockPool(
        [AGENT_ROW],
        [{ session_id: 'existing-session-456' }], // session found
      );

      await collectEvents(runAgentChatTurn(INPUT));

      const mockStream = getMockRunChatTurnStream();
      expect(mockStream).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          resumeSessionId: 'existing-session-456',
        }),
      );
    });

    it('passes undefined resumeSessionId when no session exists', async () => {
      setupMockPool(
        [AGENT_ROW],
        [], // no session
      );

      await collectEvents(runAgentChatTurn(INPUT));

      const mockStream = getMockRunChatTurnStream();
      expect(mockStream).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          resumeSessionId: undefined,
        }),
      );
    });
  });

  // ── 7. Pre-stream failure → error event (no fallback) ───────────────

  describe('pre-stream failure', () => {
    it('yields PROVIDER_ERROR when runChatTurnStream throws immediately', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockImplementation(() => {
          // eslint-disable-next-line require-yield
          return (async function* () {
            throw new Error('Connection refused');
          })();
        }),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const types = events.map((e) => e.type);
      expect(types).toContain('error');

      const errorEvent = events.find((e) => e.type === 'error') as any;
      expect(errorEvent.code).toBe('PROVIDER_ERROR');
    });
  });

  // ── 8. Mid-stream failure — no fallback ────────────────────────────

  describe('mid-stream failure — no fallback', () => {
    it('reports the CONNECTION as lost, not the run as failed', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: jest.fn().mockImplementation(() => {
          return (async function* () {
            yield { type: 'thinking' } as ChatTurnStreamEvent;
            yield { type: 'text_delta', text: 'Starting...' } as ChatTurnStreamEvent;
            throw new Error('Stream disconnected');
          })();
        }),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const types = events.map((e) => e.type);
      // A STREAM ENDING IS NOT A RUN ENDING. The runtime does not stop when
      // this connection does (ADR-041), so a failed read says nothing about
      // the run. Reporting it as an error tells a person "This run stopped on
      // an error before it could answer. It reached step N of M" while the
      // run works on — and "Trying again is safe" invites a second run on
      // top of the first.
      expect(types).toContain('stream_lost');
      expect(types).not.toContain('error');

      const lost = events.find((e) => e.type === 'stream_lost') as { detail: string };
      // Says what is true: the connection went, the run did not.
      expect(lost.detail).toMatch(/connection/i);
      expect(lost.detail).toMatch(/still going/i);
      expect(lost.detail).not.toMatch(/stopped/i);
      // User-facing copy — must NOT leak internal terminology like
      // "chat turn", and must follow the product voice.
      expect(lost.detail).not.toMatch(/chat turn/i);
      expect(lost.detail).not.toMatch(/—/);
      expect(lost.detail.toLowerCase()).not.toMatch(/\bagent\b/);
      // The old copy promised the partial output was "preserved above" and
      // invited a retry "to get the rest". Both were wrong in the same
      // direction: the run was still producing the rest itself.
      expect(lost.detail).not.toMatch(/try again|cut off/i);
    });
  });

  // ── 9. Session ID NOT forwarded to client ───────────────────────────

  describe('session ID not forwarded to client', () => {
    it('complete event has message but no sessionId', async () => {
      const events = await collectEvents(runAgentChatTurn(INPUT));

      const complete = events.find((e) => e.type === 'complete') as any;
      expect(complete).toBeDefined();
      expect(complete.message).toBeDefined();
      // The sessionId should NOT be present on the yielded complete event
      expect(complete).not.toHaveProperty('sessionId');
      // Only 'type' and 'message' keys
      expect(Object.keys(complete)).toEqual(['type', 'message']);
    });
  });

  // ── 10. Audit log includes executionMode ────────────────────────────

  describe('audit log includes executionMode', () => {
    it('SDK path audit log has executionMode sdk', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockLogAudit).toHaveBeenCalledWith(
        'agent_chat.chat_turn',
        expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }),
        expect.objectContaining({
          executionMode: 'sdk',
          sdkFallback: false,
          sessionResumed: false,
        }),
      );
    });

    it('audit log includes token counts from SDK', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockLogAudit).toHaveBeenCalledWith(
        'agent_chat.chat_turn',
        expect.any(Object),
        expect.objectContaining({
          inputTokens: 200,
          outputTokens: 80,
        }),
      );
    });

    it('audit log has sessionResumed=true when resuming', async () => {
      setupMockPool(
        [AGENT_ROW],
        [{ session_id: 'existing-session-789' }],
      );

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockLogAudit).toHaveBeenCalledWith(
        'agent_chat.chat_turn',
        expect.any(Object),
        expect.objectContaining({
          sessionResumed: true,
        }),
      );
    });
  });

  // ── R5: explicit HITL resume contract + turnId propagation ────────────
  describe('R5 TE-R5-011: explicit resume contract', () => {
    it('propagates resume:true + approvalId to runChatTurnStream params', async () => {
      setupMockPool([AGENT_ROW], []);

      // Simulate a resume input with approvalId set
      const resumeInput = { ...INPUT, approvalId: '550e8400-e29b-41d4-a716-446655440000' } as typeof INPUT & {
        approvalId: string;
      };

      await collectEvents(runAgentChatTurn(resumeInput));

      const mockStream = getMockRunChatTurnStream();
      expect(mockStream).toHaveBeenCalledWith(
        INPUT.tenantId,
        expect.objectContaining({
          resume: true,
          approvalId: '550e8400-e29b-41d4-a716-446655440000',
        }),
      );
    });

    it('does NOT set resume when approvalId absent (normal new-message turn)', async () => {
      setupMockPool([AGENT_ROW], []);
      await collectEvents(runAgentChatTurn(INPUT));
      const mockStream = getMockRunChatTurnStream();
      const params = mockStream.mock.calls[0][1];
      expect((params as { resume?: boolean }).resume).toBeUndefined();
    });
  });

  describe('R5 Fix 12: turnId propagation', () => {
    it('generates a turnId and propagates it to runChatTurnStream', async () => {
      setupMockPool([AGENT_ROW], []);
      await collectEvents(runAgentChatTurn(INPUT));
      const mockStream = getMockRunChatTurnStream();
      const params = mockStream.mock.calls[0][1] as { turnId?: string };
      expect(params.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });
});

// ── Non-turn acknowledgments (interrupt / clarification / stop) ────────
//
// TR answers with these instead of a stream when the message did not start a
// turn. The service must forward them and RETURN — never fall into the
// "stream ended without complete event" error branch, and never persist an
// assistant message (there is none).

describe('SDK non-turn acknowledgment events', () => {
  it.each([
    ['interrupt_delivered'],
    ['clarification_accepted'],
    ['stop_acknowledged'],
  ] as const)('forwards %s and ends the turn without an error or persistence', async (ackType) => {
    (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
      retrieveAgentMemories: jest.fn().mockResolvedValue([]),
      runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
        { type: ackType } as ChatTurnStreamEvent,
      ])),
    }));

    const events = await collectEvents(runAgentChatTurn(INPUT));
    const types = events.map((e) => e.type);

    expect(types).toContain(ackType);
    expect(types).not.toContain('error');
    expect(types).not.toContain('complete');
    // The user message persists via createTurnWithUserMessage before the TR
    // call; no assistant message exists to persist for an acknowledged
    // non-turn.
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });
});

// ── A stopped turn writes no reply the agent never gave ─────────────────

describe('runAgentChatTurn — stopped before any output', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupMockPool();
    mockAppendMessage.mockResolvedValue({ id: 'msg-1', role: 'assistant', content: '' });
  });

  it('persists nothing and completes with no message', async () => {
    // Tenant-runtime used to send the literal string "(stopped)" as the turn's
    // output, purely so the caller could tell a deliberate end from a dead
    // stream. That string then showed up in the person's transcript as
    // something the agent had said. The fact now travels as `stopped`.
    (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
      retrieveAgentMemories: jest.fn().mockResolvedValue([]),
      runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
        { type: 'thinking' },
        {
          type: 'complete',
          outputText: '',
          inputTokens: 120,
          outputTokens: 0,
          sessionId: 'session-abc-123',
          stopped: true,
        } as ChatTurnStreamEvent,
      ])),
    }));

    const events = await collectEvents(runAgentChatTurn(INPUT));

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    // Terminal all the same, so the composer stops streaming.
    expect(events[events.length - 1]).toEqual({ type: 'complete', message: null });
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('still persists whatever the agent had said before the stop', async () => {
    (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
      retrieveAgentMemories: jest.fn().mockResolvedValue([]),
      runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
        { type: 'text_delta', text: 'here is what I found so far' },
        {
          type: 'complete',
          outputText: 'here is what I found so far',
          inputTokens: 120,
          outputTokens: 20,
          sessionId: 'session-abc-123',
          stopped: true,
        } as ChatTurnStreamEvent,
      ])),
    }));

    await collectEvents(runAgentChatTurn(INPUT));

    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'assistant',
      'here is what I found so far',
      expect.anything(),
      undefined,
      120,
      20,
      undefined,
      undefined,
      undefined,
      expect.anything(),
      undefined,
      undefined,
      [], // contributors: a stopped turn handed nothing over
    );
  });
});
