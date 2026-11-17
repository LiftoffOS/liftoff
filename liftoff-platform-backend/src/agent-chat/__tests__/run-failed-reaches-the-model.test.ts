// A run that stopped must reach the MODEL, or the next turn writes fiction.
//
// The failure mode: turn one promises "The weekly competitor sweep is starting
// now" for a graph refused one second later. The failure row is narration, so
// `isConversationRow` keeps it out of everything built from the conversation —
// and the promise, which is ordinary speech, stays in. On turn two the model
// can see its own promise and can NOT see the error, and produces a detailed,
// confident, entirely fictional progress report before refusing the retry
// that is the only thing that could help.
//
// So the row stays narration and the FACT travels on `conversationSummary`,
// which is the control-plane→runtime model-context seam. Asserting on the row
// alone would pass while the model still never sees it — which is the defect.

jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

jest.mock('../../infrastructure/database', () => {
  const __db: any = { getPool: jest.fn() };
  const __mkc = () => (__db.getPool ? __db.getPool() : { query: jest.fn() });
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
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../common/injection-guard', () => ({
  guardMessage: jest.fn().mockResolvedValue({ safe: true }),
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  TenantRuntimeClient: jest.fn(),
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
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import { runAgentChatTurn, type AgentChatEvent, type AgentChatTurnInput } from '../chat-service';
import { RUN_FAILED_MESSAGE_TYPE, RUN_FAILED_SUMMARY_NOTE } from '../run-progress';

const mockGetPool = getPool as jest.Mock;
const mockAppendMessage = chatRepo.appendMessage as jest.Mock;
const mockListMessages = chatRepo.listMessages as jest.Mock;
const mockGetSummary = chatRepo.getThreadRollingSummary as jest.Mock;

const INPUT: AgentChatTurnInput = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  threadId: 'thread-1',
  userId: 'user-1',
  userDisplayName: 'Test User',
  userRole: 'member',
  tenantName: 'TestCo',
  content: 'i want my report now',
  channelHint: 'web',
};

const AGENT_ROW = {
  id: 'agent-1',
  role: 'Competitive Intelligence Analyst',
  messaging_nickname: null,
  system_prompt: 'You are a test agent.',
  user_instructions: null,
  additional_context: null,
  status: 'active',
};

let runChatTurnStream: jest.Mock;

/** One row of transcript history, as `listMessages` returns them. */
function row(
  overrides: Partial<{ id: string; role: 'user' | 'assistant'; content: string; messageType: string | null }>,
): Record<string, unknown> {
  return {
    id: 'm',
    tenantId: 'tenant-1',
    threadId: 'thread-1',
    agentId: null,
    role: 'user',
    content: 'x',
    toolCalls: null,
    inputTokens: 0,
    outputTokens: 0,
    messageType: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** `listMessages` returns NEWEST first. */
function history(oldestFirst: Array<Record<string, unknown>>): void {
  mockListMessages.mockResolvedValue({
    messages: [...oldestFirst].reverse(),
    hasMore: false,
    nextCursor: null,
  });
}

function stream(events: ChatTurnStreamEvent[]): AsyncGenerator<ChatTurnStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

async function drain(gen: AsyncIterable<AgentChatEvent>): Promise<AgentChatEvent[]> {
  const out: AgentChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** The request this turn actually put on the wire to the runtime. */
function runtimeRequest(): Record<string, unknown> {
  expect(runChatTurnStream).toHaveBeenCalled();
  return runChatTurnStream.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppendMessage.mockReset();
  mockAppendMessage.mockResolvedValue({
    id: 'msg-assistant-1',
    tenantId: 'tenant-1',
    threadId: 'thread-1',
    agentId: 'agent-1',
    role: 'assistant',
    content: 'Hello!',
    toolCalls: null,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2024-01-01T00:01:00Z',
  });
  (chatRepo.createTurnWithUserMessage as jest.Mock).mockResolvedValue({
    id: 'msg-user-current',
    tenantId: 'tenant-1',
    threadId: 'thread-1',
    agentId: null,
    role: 'user',
    content: INPUT.content,
    toolCalls: null,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2024-01-01T00:02:00Z',
  });
  mockGetPool.mockReturnValue({
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('internal_agents')) return Promise.resolve({ rows: [AGENT_ROW] });
      return Promise.resolve({ rows: [] });
    }),
  });
  mockGetSummary.mockResolvedValue(null);
  history([]);

  runChatTurnStream = jest.fn().mockImplementation(() => stream([
    { type: 'thinking' },
    { type: 'text_delta', text: 'Hello!' },
    { type: 'complete', outputText: 'Hello!', inputTokens: 1, outputTokens: 1, sessionId: 's' },
  ]));
  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream,
  }));
});

describe('the failure the model has to see', () => {
  it('reaches the runtime on conversationSummary when the preceding exchange failed', async () => {
    history([
      row({ id: 'u1', role: 'user', content: 'i want my report now' }),
      row({
        id: 'f1',
        role: 'assistant',
        content: 'This run stopped on an error before it could answer.',
        messageType: RUN_FAILED_MESSAGE_TYPE,
      }),
      row({ id: 'u2', role: 'user', content: INPUT.content }),
    ]);

    await drain(runAgentChatTurn(INPUT));

    expect(String(runtimeRequest().conversationSummary)).toContain(RUN_FAILED_SUMMARY_NOTE);
  });

  it('carries the note even on a thread with no rolling summary of its own', async () => {
    // Short threads legitimately have none, and those are exactly the threads
    // where a failure is the second row.
    mockGetSummary.mockResolvedValue(null);
    history([
      row({ id: 'u1', role: 'user' }),
      row({ id: 'f1', role: 'assistant', content: 'stopped', messageType: RUN_FAILED_MESSAGE_TYPE }),
      row({ id: 'u2', role: 'user', content: INPUT.content }),
    ]);

    await drain(runAgentChatTurn(INPUT));

    expect(runtimeRequest().conversationSummary).toBe(RUN_FAILED_SUMMARY_NOTE);
  });

  it('appends to an existing rolling summary rather than replacing it', async () => {
    mockGetSummary.mockResolvedValue({
      userIntent: 'x', keyFacts: [], openQuestions: [], previousFindings: [], nextSteps: [],
      summarizedThrough: '2024-01-01T00:00:00Z',
    });
    history([
      row({ id: 'u1', role: 'user' }),
      row({ id: 'f1', role: 'assistant', content: 'stopped', messageType: RUN_FAILED_MESSAGE_TYPE }),
      row({ id: 'u2', role: 'user', content: INPUT.content }),
    ]);

    await drain(runAgentChatTurn(INPUT));

    const summary = String(runtimeRequest().conversationSummary);
    expect(summary).toContain('formatted summary');
    expect(summary).toContain(RUN_FAILED_SUMMARY_NOTE);
  });

  it('says nothing when the preceding exchange succeeded', async () => {
    history([
      row({ id: 'u1', role: 'user' }),
      row({ id: 'f1', role: 'assistant', content: 'stopped', messageType: RUN_FAILED_MESSAGE_TYPE }),
      row({ id: 'u2', role: 'user' }),
      row({ id: 'a2', role: 'assistant', content: 'Here is the report.' }),
      row({ id: 'u3', role: 'user', content: INPUT.content }),
    ]);

    await drain(runAgentChatTurn(INPUT));

    // The note is scoped to the LAST EXCHANGE, not the last failure. "The most
    // recent run_failed row" stays the most recent one forever, so a run that
    // succeeded three turns later would still be introduced as a failure.
    expect(String(runtimeRequest().conversationSummary ?? '')).not.toContain(RUN_FAILED_SUMMARY_NOTE);
  });

  it('says nothing on a thread that has never failed', async () => {
    history([
      row({ id: 'u1', role: 'user' }),
      row({ id: 'a1', role: 'assistant', content: 'Here is the report.' }),
      row({ id: 'u2', role: 'user', content: INPUT.content }),
    ]);

    await drain(runAgentChatTurn(INPUT));

    expect(String(runtimeRequest().conversationSummary ?? '')).not.toContain(RUN_FAILED_SUMMARY_NOTE);
  });

  it('keeps the failure row itself out of the conversation', async () => {
    // It stays narration. Admitted as ordinary assistant speech it would become
    // words the team appears to have said — in summaries, absorption,
    // embeddings, recall and the reply clock.
    const { isConversationRow } = await import('../transcript-context');
    expect(isConversationRow({ messageType: RUN_FAILED_MESSAGE_TYPE })).toBe(false);
  });
});

describe('the terminal row is typed as a failure', () => {
  it('is written with the run_failed type, not the progress type', async () => {
    runChatTurnStream.mockImplementation(() => stream([
      { type: 'thinking' },
      {
        type: 'error',
        code: 'EXEC_ERROR',
        message: 'That request could not be processed as written. Try rephrasing it.',
        failureClass: 'validation',
        retryable: false,
      },
    ]));

    await drain(runAgentChatTurn(INPUT));

    const typed = mockAppendMessage.mock.calls.map((c) => c[8]);
    expect(typed).toContain(RUN_FAILED_MESSAGE_TYPE);
  });
});

describe('the runtime\'s classification survives the mapping', () => {
  it('relays an explicit `retryable: false` rather than dropping it', async () => {
    // `...(event.retryable === true ? { retryable: true } : {})` dropped the
    // false, so nothing downstream could honour it and the status row invited a
    // retry into a run that could never work.
    runChatTurnStream.mockImplementation(() => stream([
      { type: 'thinking' },
      {
        type: 'error',
        code: 'EXEC_ERROR',
        message: 'That request could not be processed as written. Try rephrasing it.',
        failureClass: 'validation',
        retryable: false,
      },
    ]));

    const events = await drain(runAgentChatTurn(INPUT));
    const error = events.find((e) => e.type === 'error') as { retryable?: boolean; failureClass?: string };
    expect(error).toBeDefined();
    expect(error.retryable).toBe(false);
    expect(error.failureClass).toBe('validation');
  });

  it('still relays a true', async () => {
    runChatTurnStream.mockImplementation(() => stream([
      { type: 'thinking' },
      { type: 'error', code: 'EXEC_ERROR', message: 'Busy, try shortly.', failureClass: 'rate_limit', retryable: true },
    ]));

    const events = await drain(runAgentChatTurn(INPUT));
    const error = events.find((e) => e.type === 'error') as { retryable?: boolean };
    expect(error.retryable).toBe(true);
  });

  it('does not invite a retry on a failure the runtime called permanent', async () => {
    runChatTurnStream.mockImplementation(() => stream([
      { type: 'thinking' },
      {
        type: 'error',
        code: 'EXEC_ERROR',
        message: 'That request could not be processed as written. Try rephrasing it.',
        failureClass: 'validation',
        retryable: false,
      },
    ]));

    await drain(runAgentChatTurn(INPUT));

    const failureRow = mockAppendMessage.mock.calls.find((c) => c[8] === RUN_FAILED_MESSAGE_TYPE);
    expect(failureRow).toBeDefined();
    const text = String(failureRow![3]);
    expect(text).not.toContain('Trying again is safe');
    // And it says what the runtime said to do instead.
    expect(text).toContain('could not be processed as written');
  });
});
