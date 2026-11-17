// Agent Chat Service — hand-over attribution.
//
// A team that hands part of a turn to a teammate is attributed to that
// teammate twice: live, as a `delegation_started` frame carrying the same
// { author, authorLabel } Liftoff's frame does, and persisted, as the
// `contributors` the reply row carries. Both come from the runtime's own
// record of its delegate_to_agent calls and are resolved by one lookup, so
// what the person watched arrive and what the row says cannot disagree.
//
// Mocks mirror chat-service-sdk.test.ts; the runtime -> internal id map is
// mocked directly because it is fetched over HTTP.

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

import { getPool } from '../../infrastructure/database';
import * as chatRepo from '../chat-repository';
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import { getRuntimeToInternalMap } from '../../internal-agents/runtime-agent-id-map';
import { resolveContributors } from '../contributors';
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

/** The 15th positional argument of appendMessage is `contributors`. */
function persistedContributors(): unknown {
  const call = mockAppendMessage.mock.calls.find((args) => args[2] === 'assistant');
  expect(call).toBeDefined();
  return call![14];
}

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
});

describe('resolveContributors', () => {
  it('resolves runtime ids to internal ids and the names the person sees, in the order given', async () => {
    await expect(resolveContributors('tenant-1', ['rt-8', 'rt-7'])).resolves.toEqual([
      { id: 'agent-8', label: 'Legal Counsel' },
      { id: 'agent-7', label: 'Security Review' },
    ]);
  });

  it('drops duplicates and ids that no longer resolve, and never throws', async () => {
    await expect(resolveContributors('tenant-1', ['rt-7', 'rt-9', 'rt-7'])).resolves.toEqual([
      { id: 'agent-7', label: 'Security Review' },
    ]);
    await expect(resolveContributors('tenant-1', [])).resolves.toEqual([]);
    mockIdMap.mockRejectedValueOnce(new Error('runtime down'));
    await expect(resolveContributors('tenant-1', ['rt-7'])).resolves.toEqual([]);
  });
});

describe('live attribution: delegation_started', () => {
  it('carries the teammate as { author, authorLabel }, the same frame Liftoff sends', async () => {
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-7' },
      { type: 'text_delta', text: 'Reviewed.' },
      completeEvent({ delegatedTo: ['rt-7'] }),
    ]);
    const events = await collectEvents(runAgentChatTurn(INPUT));
    expect(events).toContainEqual({ type: 'delegation_started', author: 'agent-7', authorLabel: 'Security Review' });
  });

  it('skips the frame for a teammate that does not resolve, rather than sending a nameless one', async () => {
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-9' },
      { type: 'text_delta', text: 'Reviewed.' },
      completeEvent(),
    ]);
    const events = await collectEvents(runAgentChatTurn(INPUT));
    expect(events.some((e) => e.type === 'delegation_started')).toBe(false);
    expect(events[events.length - 1].type).toBe('complete');
  });
});

describe('persisted attribution: contributors on the reply', () => {
  it('writes every teammate the runtime says the turn handed work to, in first-call order', async () => {
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-8' },
      { type: 'delegation_started', agentId: 'rt-7' },
      { type: 'text_delta', text: 'Reviewed.' },
      completeEvent({ delegatedTo: ['rt-8', 'rt-7'] }),
    ]);
    await collectEvents(runAgentChatTurn(INPUT));
    expect(persistedContributors()).toEqual([
      { id: 'agent-8', label: 'Legal Counsel' },
      { id: 'agent-7', label: 'Security Review' },
    ]);
  });

  it('writes [] for a turn with no hand-over, and for an older runtime that says nothing', async () => {
    runtimeStreams([{ type: 'text_delta', text: 'Reviewed.' }, completeEvent()]);
    await collectEvents(runAgentChatTurn(INPUT));
    expect(persistedContributors()).toEqual([]);
  });

  it('takes the list from the complete frame, not from what streamed: the two writers must agree', async () => {
    // A hand-over the stream announced but the runtime's own record does not
    // carry is not attributed; the settle callback would not carry it either.
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-7' },
      { type: 'text_delta', text: 'Reviewed.' },
      completeEvent({ delegatedTo: [] }),
    ]);
    await collectEvents(runAgentChatTurn(INPUT));
    expect(persistedContributors()).toEqual([]);
  });
});

// A reply that stopped for a gate or a question is attributed exactly like
// one that finished: the runtime says who the turn handed work to on those
// frames too, from the same durable record, and the partial the team wrote
// before it stopped carries the chips.
describe('persisted attribution: a turn that paused', () => {
  const persistedByContent = (content: string) => {
    const call = mockAppendMessage.mock.calls.find((args) => args[3] === content);
    expect(call).toBeDefined();
    return call![14];
  };

  it('puts the teammates on the partial written before a human gate', async () => {
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-7' },
      { type: 'text_delta', text: 'Security Review says the keys must rotate. ' },
      { type: 'text_delta', text: 'Rotating them needs a sign-off.' },
      { type: 'hitl_required', approvalId: 'approval-1', reason: 'needs approval', delegatedTo: ['rt-7'] },
    ]);
    await collectEvents(runAgentChatTurn({ ...INPUT, turnId: '00000000-0000-0000-0000-00000000aaaa' }));

    expect(persistedByContent('Security Review says the keys must rotate. Rotating them needs a sign-off.'))
      .toEqual([{ id: 'agent-7', label: 'Security Review' }]);
    // The stall row is narration about the conversation, not speech: no chips.
    const status = mockAppendMessage.mock.calls.find((args) => args[8] === 'hitl_status');
    expect(status).toBeDefined();
    expect(status![14]).toBeUndefined();
  });

  it('puts the teammates on the partial written before a question', async () => {
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-8' },
      { type: 'text_delta', text: 'Legal Counsel flagged the indemnity clause.' },
      { type: 'awaiting_input', question: 'Which version of the contract should I use?', sessionId: 's-1', delegatedTo: ['rt-8'] },
    ]);
    await collectEvents(runAgentChatTurn({ ...INPUT, turnId: '00000000-0000-0000-0000-00000000bbbb' }));

    expect(persistedByContent('Legal Counsel flagged the indemnity clause.'))
      .toEqual([{ id: 'agent-8', label: 'Legal Counsel' }]);
    // The question is the team's own speech, and the partial already carries
    // the turn's attribution.
    expect(persistedByContent('Which version of the contract should I use?')).toEqual([]);
  });

  it('puts them on the question itself when the team asked before saying anything else', async () => {
    runtimeStreams([
      { type: 'delegation_started', agentId: 'rt-8' },
      { type: 'awaiting_input', question: 'Legal Counsel needs the signed copy. Which one is it?', sessionId: 's-2', delegatedTo: ['rt-8'] },
    ]);
    await collectEvents(runAgentChatTurn({ ...INPUT, turnId: '00000000-0000-0000-0000-00000000cccc' }));

    expect(persistedByContent('Legal Counsel needs the signed copy. Which one is it?'))
      .toEqual([{ id: 'agent-8', label: 'Legal Counsel' }]);
  });

  it('attributes a paused partial to nobody when the runtime says the turn handed nothing over', async () => {
    runtimeStreams([
      { type: 'text_delta', text: 'Drafted.' },
      { type: 'hitl_required', approvalId: 'approval-2', reason: 'needs approval' },
    ]);
    await collectEvents(runAgentChatTurn({ ...INPUT, turnId: '00000000-0000-0000-0000-00000000dddd' }));

    expect(persistedByContent('Drafted.')).toEqual([]);
  });
});

// A colleague's reply inside the team's chat is stored verbatim; the one sink
// with no chip to look at — the rolling summary the next turn reads — gets
// the speaker put back, so the team never remembers offering what a colleague
// offered. Every other row reaches the summary untouched.
describe('the rolling summary knows who spoke', () => {
  it('prefixes a colleague row with its contributors, and nothing else', async () => {
    const shouldSummarize = jest.requireMock('../../insights/conversation-summarization').shouldSummarize as jest.Mock;
    shouldSummarize.mockClear();
    (chatRepo.listMessages as jest.Mock).mockResolvedValue({
      messages: [
        { id: 'm3', role: 'assistant', content: 'Reviewed.', messageType: null, contributors: [{ id: 'agent-7', label: 'Security Review' }], createdAt: '2024-01-01T00:03:00Z' },
        { id: 'm2', role: 'assistant', content: 'Here is what would change. Apply it?', messageType: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }], createdAt: '2024-01-01T00:02:00Z' },
        { id: 'm1', role: 'user', content: 'Please review this', messageType: null, contributors: [], createdAt: '2024-01-01T00:01:00Z' },
      ],
      hasMore: false,
      nextCursor: null,
    });
    runtimeStreams([{ type: 'text_delta', text: 'Reviewed.' }, completeEvent()]);

    await collectEvents(runAgentChatTurn(INPUT));
    // The refresh is fire-and-forget; let it run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(shouldSummarize).toHaveBeenCalled();
    const { allMessages } = shouldSummarize.mock.calls.at(-1)![0] as { allMessages: Array<{ content: string }> };
    expect(allMessages.map((m) => m.content)).toEqual([
      'Please review this',
      'Chief AI Officer: Here is what would change. Apply it?',
      // The team's own reply, delegated or not, is the team speaking.
      'Reviewed.',
    ]);
  });
});

describe('the brief a colleague forwarded', () => {
  it('is read this turn and never stored; the thread keeps one status row attributed to the forwarder', async () => {
    runtimeStreams([{ type: 'text_delta', text: 'Reviewed.' }, completeEvent()]);
    const brief = 'Background from Liftoff, which brought you into this conversation. It is not shown to the person: '
      + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.\n\n'
      + 'They want the contract checked for indemnities.';

    await collectEvents(runAgentChatTurn({
      ...INPUT,
      forwardedContext: brief,
      forwardedBy: { id: 'liftoff', label: 'Liftoff' },
    }));

    const noteRow = mockAppendMessage.mock.calls.find((args) => args[8] === 'forwarded_context');
    expect(noteRow).toBeDefined();
    expect(noteRow!.slice(0, 5)).toEqual([
      'tenant-1', 'thread-1', 'assistant', 'Liftoff shared background from the conversation so far', 'agent-1',
    ]);
    // The 15th positional argument is `contributors`: the colleague that
    // brought the team in, not this team.
    expect(noteRow![14]).toEqual([{ id: 'liftoff', label: 'Liftoff' }]);
    for (const args of mockAppendMessage.mock.calls) {
      expect(String(args[3])).not.toContain('Background from');
    }
  });

  it('names Liftoff on the status row when nobody was named, as an older caller does', async () => {
    runtimeStreams([{ type: 'text_delta', text: 'Reviewed.' }, completeEvent()]);

    await collectEvents(runAgentChatTurn({
      ...INPUT,
      forwardedContext: 'Liftoff shared background from the conversation so far\n\nContext.',
    }));

    const noteRow = mockAppendMessage.mock.calls.find((args) => args[8] === 'forwarded_context');
    expect(noteRow).toBeDefined();
    expect(noteRow![3]).toBe('Liftoff shared background from the conversation so far');
    expect(noteRow![14]).toBeUndefined();
  });
});
