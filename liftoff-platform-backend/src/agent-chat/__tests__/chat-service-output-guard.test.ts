// Agent Chat Service — a team's words pass the output guard.
//
// Every agent's reply is relayed from the runtime through this service, so
// this is where the rule "no team ever shows a person its inner workings" is
// enforced for teams: what streams, what is persisted at every exit (the
// reply, the partial before a gate, the partial before a question), and what
// a turn that streamed nothing delivers whole.
//
// Mocks mirror chat-service-delegation-attribution.test.ts; the guard is
// mocked to a deterministic rewrite so guarded and raw are distinguishable.

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

jest.mock('../../internal-agents/runtime-agent-id-map', () => ({
  getRuntimeToInternalMap: jest.fn(),
}));

const mockGuard = jest.fn();
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...args),
}));

jest.mock('../approval-route-description', () => ({
  describeApprovalRoute: jest.fn().mockResolvedValue({ names: ['Ada'], toAdmins: false, unassigned: false }),
}));

import { getPool } from '../../infrastructure/database';
import * as chatRepo from '../chat-repository';
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import { getRuntimeToInternalMap } from '../../internal-agents/runtime-agent-id-map';
import {
  runAgentChatTurn,
  type AgentChatEvent,
  type AgentChatTurnInput,
} from '../chat-service';

const mockGetPool = getPool as jest.Mock;
const mockAppendMessage = chatRepo.appendMessage as jest.Mock;
const mockIdMap = getRuntimeToInternalMap as jest.Mock;

const INPUT: AgentChatTurnInput = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  threadId: 'thread-1',
  userId: 'user-1',
  userDisplayName: 'Test User',
  userRole: 'member',
  tenantName: 'TestCo',
  content: 'Please review this',
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

/** The teammates on the roster, by internal id. */
const TEAMMATES: Record<string, { id: string; role: string }> = {
  'agent-7': { id: 'agent-7', role: 'Security Review' },
  'agent-8': { id: 'agent-8', role: 'Legal Counsel' },
};

const SAVED_USER_MESSAGE = {
  id: 'msg-user-1', tenantId: 'tenant-1', threadId: 'thread-1', agentId: null,
  role: 'user' as const, content: 'Please review this', toolCalls: null,
  inputTokens: 0, outputTokens: 0, createdAt: '2024-01-01T00:00:00Z',
};

const SAVED_ASSISTANT_MESSAGE = {
  id: 'msg-assistant-1', tenantId: 'tenant-1', threadId: 'thread-1', agentId: 'agent-1',
  role: 'assistant' as const, content: 'Reviewed.', toolCalls: null,
  inputTokens: 200, outputTokens: 80, createdAt: '2024-01-01T00:01:00Z',
};

function sdkStreamFrom(events: ChatTurnStreamEvent[]): AsyncGenerator<ChatTurnStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

async function collectEvents(gen: AsyncIterable<AgentChatEvent>): Promise<AgentChatEvent[]> {
  const out: AgentChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function completeEvent(extra: Partial<Extract<ChatTurnStreamEvent, { type: 'complete' }>> = {}): ChatTurnStreamEvent {
  return {
    type: 'complete',
    outputText: 'Reviewed.',
    inputTokens: 200,
    outputTokens: 80,
    sessionId: 'session-abc-123',
    ...extra,
  };
}

function setupMockPool() {
  const mockQuery = jest.fn().mockImplementation((sql: string, params?: any[]) => {
    // resolveContributors: the roster read, by internal id.
    if (sql.includes('FROM internal_agents WHERE id = ANY')) {
      const ids = (params?.[0] ?? []) as string[];
      return Promise.resolve({ rows: ids.filter((id) => TEAMMATES[id]).map((id) => TEAMMATES[id]) });
    }
    if (sql.includes('internal_agents')) {
      return Promise.resolve({ rows: [AGENT_ROW] });
    }
    if (sql.includes('agent_chat_sessions') && sql.includes('SELECT')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('agent_chat_sessions') && sql.includes('INSERT')) {
      return Promise.resolve({ rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
  mockGetPool.mockReturnValue({ query: mockQuery });
  return mockQuery;
}

function runtimeStreams(events: ChatTurnStreamEvent[]) {
  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom(events)),
  }));
}

const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

/** Every assistant row the turn wrote, in order: [content, messageType]. */
function persistedAssistantRows(): Array<[string, string | undefined]> {
  return mockAppendMessage.mock.calls
    .filter((args) => args[2] === 'assistant')
    .map((args) => [args[3] as string, args[8] as string | undefined]);
}

const deltas = (events: AgentChatEvent[]) =>
  events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');

beforeEach(() => {
  jest.clearAllMocks();
  mockAppendMessage.mockReset();
  mockAppendMessage.mockResolvedValue(SAVED_ASSISTANT_MESSAGE);
  (chatRepo.createTurnWithUserMessage as jest.Mock).mockResolvedValue(SAVED_USER_MESSAGE);
  (chatRepo.listMessages as jest.Mock).mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });
  (chatRepo.getThreadRollingSummary as jest.Mock).mockResolvedValue(null);
  // Runtime ids rt-7 / rt-8 provision to internal agent-7 / agent-8; rt-9
  // was never provisioned and resolves to nobody.
  mockIdMap.mockResolvedValue(new Map([['rt-7', 'agent-7'], ['rt-8', 'agent-8']]));
  setupMockPool();
  (TenantRuntimeClient as jest.Mock).mockClear();
  mockGuard.mockImplementation(async (text: string) =>
    text.includes('per the request')
      ? { text: text.replace(', per the request', ''), changed: true, kinds: ['mechanics'] }
      : { text, changed: false, kinds: [] });
});

describe('a team\'s reply', () => {
  it('streams and persists the guarded text, scrubbed of the id and of the tools it called', async () => {
    runtimeStreams([
      { type: 'text_delta', text: `I looked at the run (id ${ID}) with github__list_pull_requests` },
      { type: 'text_delta', text: ', per the request.' },
      { type: 'text_break' },
      { type: 'tool_call', tool: 'Read' },
      { type: 'text_delta', text: 'Then I used Read on the file.' },
      { type: 'text_break' },
      completeEvent({ outputText: 'raw, never read' }),
    ]);

    const events = await collectEvents(runAgentChatTurn(INPUT));

    // The break between the two messages is structure on the stream and a
    // blank line in the row, as before.
    expect(deltas(events)).toBe('I looked at the run with.Then I used on the file.');
    expect(persistedAssistantRows()).toEqual([['I looked at the run with.\n\nThen I used on the file.', undefined]]);
    expect(mockGuard.mock.calls.map((c) => c[0])).toEqual([
      'I looked at the run with, per the request.',
      'Then I used on the file.',
    ]);
    expect(mockGuard.mock.calls[0][1]).toEqual({ tenantId: 'tenant-1', speaker: 'agent-1', threadId: 'thread-1' });
    // Each message reached the person before the break that ended it.
    const order = events.map((e) => e.type).filter((t) => t === 'text_delta' || t === 'text_break');
    expect(order).toEqual(['text_delta', 'text_break', 'text_delta', 'text_break']);
  });

  it('reads a turn that streamed nothing whole, before its outputText is persisted', async () => {
    runtimeStreams([completeEvent({ outputText: `Done (id ${ID}), per the request.` })]);

    await collectEvents(runAgentChatTurn(INPUT));

    expect(persistedAssistantRows()).toEqual([['Done.', undefined]]);
    expect(mockGuard).toHaveBeenCalledTimes(1);
  });

  it('reads the partial before a gate stops the turn, so the row written first is guarded', async () => {
    (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
      retrieveAgentMemories: jest.fn().mockResolvedValue([]),
      getApproval: jest.fn().mockResolvedValue({ hitlLevel: 2 }),
      runChatTurnStream: jest.fn().mockReturnValue(sdkStreamFrom([
        { type: 'text_delta', text: `Opening the pull request (id ${ID}), per the request` },
        { type: 'hitl_required', approvalId: 'appr-1', reason: 'needs a review' } as ChatTurnStreamEvent,
      ])),
    }));

    const events = await collectEvents(runAgentChatTurn(INPUT));

    expect(deltas(events)).toBe('Opening the pull request');
    expect(persistedAssistantRows()[0]).toEqual(['Opening the pull request', undefined]);
  });

  it('reads the partial before a question pauses the turn', async () => {
    runtimeStreams([
      { type: 'text_delta', text: `Checked the run (id ${ID}), per the request.` },
      { type: 'awaiting_input', question: 'Which branch?' } as ChatTurnStreamEvent,
    ]);

    const events = await collectEvents(runAgentChatTurn(INPUT));

    expect(deltas(events)).toBe('Checked the run.');
    expect(persistedAssistantRows()[0]).toEqual(['Checked the run.', undefined]);
  });
});
