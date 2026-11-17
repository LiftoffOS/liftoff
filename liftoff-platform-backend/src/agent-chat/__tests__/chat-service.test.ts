// Agent Chat Service — regression tests for runAgentChatTurn().
//
// Tests agent-not-found, agent-deleted, and the SDK path happy path
// to ensure the outer control flow is correct. Legacy LLM loop tests
// were removed in Phase 4 (the loop itself was deleted).
//
// Mocks: database pool, chat repository, tenant runtime client,
// logging, and conversation summarization.



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

jest.mock('../../internal-agent-oversight/service', () => ({
  oversightService: {
    getOrCreateOversightSettings: jest.fn().mockResolvedValue({ autonomy: 'full_auto' }),
  },
}));

jest.mock('../chat-repository', () => ({
  appendMessage: jest.fn(),
  createTurnWithUserMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  updateThreadRollingSummary: jest.fn(),
  updateThreadTitleInternal: jest.fn(),
}));

jest.mock('../../shared/thread-title-generation', () => ({
  // Return a resolved promise — the production wrapper calls .catch() on the
  // result, which would throw if the mock returned undefined.
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

// The guard classifier calls llmClient.complete (a REAL medium-tier LLM
// request) when unmocked — every turn-level test here was silently making a
// live network call, which is nondeterministic, costs money, and blows the
// 10s jest timeout under load. Mirror of chat-service-sdk.test.ts.
jest.mock('../../common/injection-guard', () => ({
  guardMessage: jest.fn().mockResolvedValue({ safe: true }),
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
const mockCreateTurnWithUserMessage = chatRepo.createTurnWithUserMessage as jest.Mock;
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
  content: 'Hello!',
  toolCalls: null,
  inputTokens: 100,
  outputTokens: 50,
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

/** Standard SDK happy path stream. */
function sdkHappyPathStream(): AsyncGenerator<ChatTurnStreamEvent> {
  return sdkStreamFrom([
    { type: 'thinking' },
    { type: 'text_delta', text: 'Hello!' },
    {
      type: 'complete',
      outputText: 'Hello!',
      inputTokens: 100,
      outputTokens: 50,
      sessionId: 'session-xyz',
    },
  ]);
}

/** Set up the mock pool to return the given agent row (or empty). */
function mockPoolQuery(rows: any[] = [AGENT_ROW]) {
  const mockQuery = jest.fn().mockImplementation((sql: string, _params?: any[]) => {
    if (sql.includes('internal_agents')) {
      return Promise.resolve({ rows });
    }
    // agent_chat_sessions SELECT (getSessionId)
    if (sql.includes('agent_chat_sessions') && sql.includes('SELECT')) {
      return Promise.resolve({ rows: [] });
    }
    // agent_chat_sessions INSERT (upsertChatSession)
    if (sql.includes('agent_chat_sessions') && sql.includes('INSERT')) {
      return Promise.resolve({ rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
  mockGetPool.mockReturnValue({ query: mockQuery });
  return mockQuery;
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAppendMessage.mockReset();

  // Default pool → returns AGENT_ROW
  mockPoolQuery();

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

  // Default TenantRuntimeClient — SDK happy path
  (TenantRuntimeClient as jest.Mock).mockClear();
  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn().mockReturnValue(sdkHappyPathStream()),
  }));
});

// ── Test cases ────────────────────────────────────────────────────────

describe('runAgentChatTurn', () => {
  // ── 1. Happy path ─────────────────────────────────────────────────

  describe('happy path', () => {
    it('yields thinking -> text_delta -> complete with persisted message', async () => {
      const events = await collectEvents(runAgentChatTurn(INPUT));

      const types = events.map((e) => e.type);
      expect(types[0]).toBe('thinking');
      expect(types).toContain('text_delta');
      expect(types[types.length - 1]).toBe('complete');

      // Verify text delta content
      const deltas = events.filter((e) => e.type === 'text_delta');
      expect(deltas).toHaveLength(1);
      expect((deltas[0] as any).text).toBe('Hello!');

      // Verify complete event carries the persisted message
      const complete = events.find((e) => e.type === 'complete') as any;
      expect(complete.message).toEqual(SAVED_ASSISTANT_MESSAGE);
    });

    it('persists the turn + user message BEFORE the SDK call (plan v13: atomic, attributed)', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      // User message now lands via createTurnWithUserMessage (one tx with the
      // agent_chat_turns row); appendMessage is only the assistant append.
      expect(mockCreateTurnWithUserMessage).toHaveBeenCalledTimes(1);
      const [tenantArg, threadArg, agentArg, turnIdArg, senderArg, contentArg] =
        mockCreateTurnWithUserMessage.mock.calls[0];
      expect(tenantArg).toBe('tenant-1');
      expect(threadArg).toBe('thread-1');
      expect(agentArg).toBe('agent-1');
      expect(turnIdArg).toMatch(/^[0-9a-f-]{36}$/);
      expect(senderArg).toBeNull(); // INPUT carries no senderAccountId
      expect(contentArg).toBe('Hello agent');
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    });

    it('records the operator on a turn sent by a support session, and nothing on an ordinary one', async () => {
      // The product renders both turns identically, as the customer's. This
      // column is the only way to tell afterwards which one support typed.
      await collectEvents(runAgentChatTurn(INPUT));
      expect(mockCreateTurnWithUserMessage.mock.calls[0][9]).toBeNull();

      mockCreateTurnWithUserMessage.mockClear();
      mockAppendMessage.mockResolvedValueOnce(SAVED_ASSISTANT_MESSAGE);
      await collectEvents(runAgentChatTurn({ ...INPUT, impersonatedBy: 'acct-operator' }));
      expect(mockCreateTurnWithUserMessage.mock.calls[0][9]).toBe('acct-operator');
    });

    // An ESCALATED turn ended by handing the work to a person, and the thread
    // is the only place that person looks.
    //
    // The runtime appends its own handoff sentence to the reply it persists and
    // sends that as `outputText` — but this function builds the message from
    // its own stream accumulator and reads `outputText` only when the turn
    // streamed nothing. So on every turn that spoke while it worked, the
    // sentence was dropped and the thread showed a composed, confident reply
    // with no sign the run had escalated.
    //
    // Dev thread ed29c17a: four consecutive escalated turns, the sentence in
    // all four of the runtime rows and none of the four the person read. They
    // retried three times into what looked like a stubborn refusal.
    describe('an escalated turn says so in the thread', () => {
      const withComplete = (extra: Record<string, unknown>) => {
        (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
          retrieveAgentMemories: jest.fn().mockResolvedValue([]),
          runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
            { type: 'text_delta', text: 'The digest already exists, so I stopped.' },
            {
              type: 'complete',
              outputText: 'The digest already exists, so I stopped.',
              inputTokens: 100,
              outputTokens: 50,
              sessionId: 'session-xyz',
              ...extra,
            } as ChatTurnStreamEvent,
          ])),
        }));
      };

      it('appends the handoff to what the team said', async () => {
        withComplete({ escalated: true });
        await collectEvents(runAgentChatTurn(INPUT));
        expect(mockAppendMessage.mock.calls[0][3]).toBe(
          'The digest already exists, so I stopped.\n\nPassed to a person for review.',
        );
      });

      it('states it alone when the run escalated without saying anything', async () => {
        (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
          retrieveAgentMemories: jest.fn().mockResolvedValue([]),
          runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
            {
              type: 'complete',
              outputText: '',
              inputTokens: 100,
              outputTokens: 50,
              sessionId: 'session-xyz',
              escalated: true,
            } as ChatTurnStreamEvent,
          ])),
        }));
        await collectEvents(runAgentChatTurn(INPUT));
        expect(mockAppendMessage.mock.calls[0][3]).toBe('Passed to a person for review.');
      });

      it('leaves an ordinary turn exactly as it was', async () => {
        withComplete({});
        await collectEvents(runAgentChatTurn(INPUT));
        expect(mockAppendMessage.mock.calls[0][3]).toBe('The digest already exists, so I stopped.');
      });

      // Older runtime revisions omit the field entirely.
      it('treats a missing flag as not escalated', async () => {
        withComplete({ escalated: undefined });
        await collectEvents(runAgentChatTurn(INPUT));
        expect(mockAppendMessage.mock.calls[0][3]).not.toContain('Passed to a person');
      });
    });

    it('persists the assistant message AFTER the SDK stream with token usage', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      // Only appendMessage call: assistant message with token counts (the
      // user message goes through createTurnWithUserMessage). Positional 12
      // is the turnId stamp (plan v13); the trailing arg is `contributors`,
      // empty for a turn that handed nothing over (migration 493).
      expect(mockAppendMessage.mock.calls[0].slice(0, 8)).toEqual([
        'tenant-1',
        'thread-1',
        'assistant',
        'Hello!', // accumulatedText
        'agent-1', // agentId
        undefined, // toolCalls
        100, // input tokens
        50, // output tokens
      ]);
      expect(mockAppendMessage.mock.calls[0].at(-1)).toEqual([]);
    });

    it('writes an audit log entry after the turn', async () => {
      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockLogAudit).toHaveBeenCalledWith(
        'agent_chat.chat_turn',
        expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }),
        expect.objectContaining({
          threadId: 'thread-1',
          agentId: 'agent-1',
          executionMode: 'sdk',
          inputTokens: 100,
          outputTokens: 50,
        }),
      );
    });
  });

  // ── 2. Agent not found ────────────────────────────────────────────

  describe('agent not found', () => {
    it('yields AGENT_NOT_FOUND error when query returns no rows', async () => {
      mockPoolQuery([]); // empty result — agent doesn't exist

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const types = events.map((e) => e.type);
      expect(types).toEqual(['thinking', 'error']);

      const error = events[1] as any;
      expect(error.code).toBe('AGENT_NOT_FOUND');
      expect(error.message).toContain('not found');
    });

    it('does NOT persist any messages when agent is not found', async () => {
      mockPoolQuery([]);

      await collectEvents(runAgentChatTurn(INPUT));

      expect(mockAppendMessage).not.toHaveBeenCalled();
    });
  });

  // ── 3. Agent deleted ──────────────────────────────────────────────

  describe('agent deleted (deleted_at IS NULL filter)', () => {
    it('yields AGENT_NOT_FOUND for a deleted agent (empty result set)', async () => {
      // The SQL has `deleted_at IS NULL`, so a deleted agent returns 0 rows
      mockPoolQuery([]);

      const events = await collectEvents(runAgentChatTurn(INPUT));

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('thinking');
      expect(events[1].type).toBe('error');
      expect((events[1] as any).code).toBe('AGENT_NOT_FOUND');
      expect((events[1] as any).message).toContain('deleted');
    });
  });

  // ── 4. Memory retrieval failure ───────────────────────────────────

  describe('memory retrieval failure', () => {
    it('continues without memory context when retrieveAgentMemories fails', async () => {
      (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
        retrieveAgentMemories: jest.fn().mockRejectedValue(new Error('Memory unavailable')),
        runChatTurnStream: jest.fn().mockReturnValue(sdkHappyPathStream()),
      }));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      expect(events[events.length - 1].type).toBe('complete');
    });
  });

  // ── 5. Uncaught outer error ───────────────────────────────────────

  describe('uncaught error in outer try/catch', () => {
    it('yields INTERNAL error when an unexpected exception occurs', async () => {
      // Make listMessages throw to trigger the outer catch
      mockListMessages.mockRejectedValueOnce(new Error('Unexpected DB failure'));

      const events = await collectEvents(runAgentChatTurn(INPUT));

      const types = events.map((e) => e.type);
      expect(types).toEqual(['thinking', 'error']);

      const error = events[1] as any;
      expect(error.code).toBe('INTERNAL');
      expect(error.message).toContain('Something went wrong');
    });
  });
});

const { maybeGenerateThreadTitle } = require('../../shared/thread-title-generation');
const mockMaybeGenerateTitle = maybeGenerateThreadTitle as jest.Mock;

describe('runAgentChatTurn — title generation (SDK path)', () => {
  beforeEach(() => {
    mockMaybeGenerateTitle.mockReset();
    mockMaybeGenerateTitle.mockResolvedValue(undefined);
  });

  it('fires maybeGenerateThreadTitle with agentId on the first turn (priorTurns empty)', async () => {
    // Default beforeEach: listMessages returns [], so priorTurns is empty.
    await collectEvents(runAgentChatTurn(INPUT));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMaybeGenerateTitle).toHaveBeenCalledTimes(1);
    expect(mockMaybeGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: INPUT.threadId,
        tenantId: INPUT.tenantId,
        // CRITICAL: agentId passed so cost lands in interactions bucket.
        agentId: INPUT.agentId,
        userMessage: INPUT.content,
      }),
    );
  });

  it('does NOT fire after the retry window closes (priorTurns.length > 4)', async () => {
    // 6 prior messages → priorTurns = 5 → exceeds the <= 4 threshold.
    mockListMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm6', threadId: INPUT.threadId, tenantId: INPUT.tenantId, agentId: null, role: 'user', content: 'q3', toolCalls: null, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T16:00:00Z' },
        { id: 'm5', threadId: INPUT.threadId, tenantId: INPUT.tenantId, agentId: INPUT.agentId, role: 'assistant', content: 'a2', toolCalls: null, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T15:00:00Z' },
        { id: 'm4', threadId: INPUT.threadId, tenantId: INPUT.tenantId, agentId: null, role: 'user', content: 'q2', toolCalls: null, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T14:00:00Z' },
        { id: 'm3', threadId: INPUT.threadId, tenantId: INPUT.tenantId, agentId: INPUT.agentId, role: 'assistant', content: 'a1', toolCalls: null, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T13:00:00Z' },
        { id: 'm2', threadId: INPUT.threadId, tenantId: INPUT.tenantId, agentId: null, role: 'user', content: 'q1', toolCalls: null, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T12:00:00Z' },
        { id: 'm1', threadId: INPUT.threadId, tenantId: INPUT.tenantId, agentId: INPUT.agentId, role: 'assistant', content: 'a0', toolCalls: null, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T11:00:00Z' },
      ],
      hasMore: false,
      nextCursor: null,
    });

    await collectEvents(runAgentChatTurn(INPUT));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockMaybeGenerateTitle).not.toHaveBeenCalled();
  });
});

// ── Empty message ─────────────────────────────────────────────────────
//
// A bare "@Liftoff" in Slack normalizes to "" and reached here as content.
// The runtime client THROWS on an empty userMessage before it calls fetch, so
// the failure surfaced through the pre-stream catch as "We could not reach the
// agent right now" — naming a network failure that never happened. Refused at
// the entry instead, ahead of persistence and the classifiers.
describe('runAgentChatTurn — empty content', () => {
  const RUNTIME_CALLS: jest.Mock[] = [];

  beforeEach(() => {
    RUNTIME_CALLS.length = 0;
    (TenantRuntimeClient as jest.Mock).mockImplementation(() => {
      const stream = jest.fn().mockReturnValue(sdkHappyPathStream());
      RUNTIME_CALLS.push(stream);
      return {
        retrieveAgentMemories: jest.fn().mockResolvedValue([]),
        runChatTurnStream: stream,
      };
    });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a newline', '\n'],
  ])('yields EMPTY_MESSAGE for %s and never reaches the runtime', async (_label, content) => {
    const events = await collectEvents(runAgentChatTurn({ ...INPUT, content }));

    const error = events.find((e) => e.type === 'error') as any;
    expect(error).toBeDefined();
    expect(error.code).toBe('EMPTY_MESSAGE');
    // The old message claimed a connectivity failure. Whatever the copy says,
    // it must not say that again.
    expect(error.message).not.toMatch(/could not reach/i);
    // Not retryable: resending the same empty message fails identically, and
    // the Slack worker hands retryable failures back to the queue.
    expect(error.retryable).toBeUndefined();

    expect(RUNTIME_CALLS.every((c) => c.mock.calls.length === 0)).toBe(true);
  });

  it('persists no turn and no message, so nothing replays as history', async () => {
    await collectEvents(runAgentChatTurn({ ...INPUT, content: '' }));

    expect(mockCreateTurnWithUserMessage).not.toHaveBeenCalled();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('still runs a turn when there IS content', async () => {
    const events = await collectEvents(runAgentChatTurn(INPUT));

    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(mockCreateTurnWithUserMessage).toHaveBeenCalled();
  });
});
