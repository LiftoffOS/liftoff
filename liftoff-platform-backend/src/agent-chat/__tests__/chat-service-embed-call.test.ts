// Plan v6 Change 8.3 — the chat-service embed call site: flag-gated,
// sender-gated, fire-and-forget, and NEVER able to affect the turn stream.
// Mock rig mirrors chat-service.test.ts; fireAndForget is mocked with the
// real helper's swallow-rejections behavior so both the call assertions and
// the rejection-isolation case run against the same shape.

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
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

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

const mockEmbedTurn = jest.fn();
jest.mock('../turn-embedding-service', () => ({
  embedTurn: (...args: unknown[]) => mockEmbedTurn(...args),
}));

// Mimic the real helper's contract (swallow + log rejections) while
// recording calls — lets the rejection-isolation case use the same mock.
const mockFireAndForget = jest.fn((promise: Promise<void>, _label: string) => {
  void promise.catch(() => undefined);
});
jest.mock('../../shared/fire-and-forget', () => ({
  fireAndForget: (promise: Promise<void>, label: string) => mockFireAndForget(promise, label),
}));

import { getPool } from '../../infrastructure/database';
import * as chatRepo from '../chat-repository';
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import {
  runAgentChatTurn,
  type AgentChatEvent,
  type AgentChatTurnInput,
} from '../chat-service';

const SENDER = '44444444-4444-4444-8444-444444444444';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BASE_INPUT: AgentChatTurnInput = {
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

function sdkHappyPathStream(): AsyncGenerator<ChatTurnStreamEvent> {
  return (async function* () {
    yield { type: 'thinking' } as ChatTurnStreamEvent;
    yield { type: 'text_delta', text: 'Hello!' } as ChatTurnStreamEvent;
    yield {
      type: 'complete',
      outputText: 'Hello!',
      inputTokens: 100,
      outputTokens: 50,
      sessionId: 'session-xyz',
    } as ChatTurnStreamEvent;
  })();
}

async function collectEvents(gen: AsyncIterable<AgentChatEvent>): Promise<AgentChatEvent[]> {
  const out: AgentChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RECALL_EMBED_WRITE_ENABLED;

  const mockQuery = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('internal_agents')) return Promise.resolve({ rows: [AGENT_ROW] });
    if (sql.includes('agent_chat_sessions') && sql.includes('INSERT')) return Promise.resolve({ rowCount: 1 });
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query: mockQuery });

  (chatRepo.appendMessage as jest.Mock).mockResolvedValue({
    id: 'msg-assistant-1', role: 'assistant', content: 'Hello!',
  });
  (chatRepo.createTurnWithUserMessage as jest.Mock).mockResolvedValue({
    id: 'msg-user-1', role: 'user', content: 'Hello agent',
  });
  (chatRepo.listMessages as jest.Mock).mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });
  (chatRepo.getThreadRollingSummary as jest.Mock).mockResolvedValue(null);

  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn().mockReturnValue(sdkHappyPathStream()),
  }));

  mockEmbedTurn.mockResolvedValue('embedded');
});

afterAll(() => {
  delete process.env.RECALL_EMBED_WRITE_ENABLED;
});

describe('chat-service inline embed call site (plan v6 Change 3)', () => {
  it('write-flag on + sender → fireAndForget invoked with label turn-embedding; embedTurn gets tenantId + the turnId', async () => {
    process.env.RECALL_EMBED_WRITE_ENABLED = 'true';
    const events = await collectEvents(
      runAgentChatTurn({ ...BASE_INPUT, senderAccountId: SENDER }),
    );

    expect(events.some((e) => e.type === 'complete')).toBe(true);
    // chat-service has other fireAndForget users (rolling-summary refresh) —
    // assert the turn-embedding labeled call specifically.
    const embedFires = mockFireAndForget.mock.calls.filter((c) => c[1] === 'turn-embedding');
    expect(embedFires).toHaveLength(1);
    expect(mockEmbedTurn).toHaveBeenCalledTimes(1);
    const [tenantId, turnId] = mockEmbedTurn.mock.calls[0] as [string, string];
    expect(tenantId).toBe('tenant-1');
    expect(turnId).toMatch(UUID_RE);
  });

  it('guest turn (no senderAccountId) → embed never fired even with the flag on', async () => {
    process.env.RECALL_EMBED_WRITE_ENABLED = 'true';
    const events = await collectEvents(runAgentChatTurn(BASE_INPUT));

    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(mockFireAndForget.mock.calls.filter((c) => c[1] === 'turn-embedding')).toHaveLength(0);
    expect(mockEmbedTurn).not.toHaveBeenCalled();
  });

  it('flag off → embed never fired even with a sender', async () => {
    const events = await collectEvents(
      runAgentChatTurn({ ...BASE_INPUT, senderAccountId: SENDER }),
    );

    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(mockFireAndForget.mock.calls.filter((c) => c[1] === 'turn-embedding')).toHaveLength(0);
    expect(mockEmbedTurn).not.toHaveBeenCalled();
  });

  it('embed rejection never affects the turn stream', async () => {
    process.env.RECALL_EMBED_WRITE_ENABLED = 'true';
    mockEmbedTurn.mockRejectedValue(new Error('embed exploded'));

    const events = await collectEvents(
      runAgentChatTurn({ ...BASE_INPUT, senderAccountId: SENDER }),
    );

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
