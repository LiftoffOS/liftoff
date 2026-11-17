// A team's chat turn started by the person's browser event: a hand-back or a
// point, verified by the stream router and handed to the turn. With no words
// from the person, the turn writes its turn row alone (no empty user bubble),
// screens nothing, and sends the event to the runtime, which writes the text
// the model reads. The driver's name rides every runtime request while a
// person holds the wheel, so the runtime's Browser section can name them.

jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

jest.mock('../../infrastructure/database', () => {
  const __db: any = { getPool: jest.fn() };
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
  createTurnWithoutUserMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  updateThreadRollingSummary: jest.fn(),
  updateThreadTitleInternal: jest.fn(),
}));

jest.mock('../../shared/thread-title-generation', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

const mockGuardMessage = jest.fn().mockResolvedValue({ safe: true });
jest.mock('../../common/injection-guard', () => ({
  guardMessage: (...a: unknown[]) => mockGuardMessage(...a),
}));
const mockScreenChatMessage = jest.fn().mockResolvedValue({ block: false });
jest.mock('../../injection-detection/gating', () => ({
  screenChatMessage: (...a: unknown[]) => mockScreenChatMessage(...a),
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  TenantRuntimeClient: jest.fn().mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn(),
  })),
}));

const mockDriverName = jest.fn().mockResolvedValue('');
jest.mock('../../browser-sessions/browser-state', () => ({
  browserDriverNameForThread: (...a: unknown[]) => mockDriverName(...a),
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

jest.mock('../../shared/fire-and-forget', () => ({
  fireAndForget: (promise: Promise<void>) => { void promise.catch(() => undefined); },
}));

import { getPool } from '../../infrastructure/database';
import * as chatRepo from '../chat-repository';
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import { runAgentChatTurn, type AgentChatEvent, type AgentChatTurnInput } from '../chat-service';

const HOLD = '11111111-1111-4111-8111-111111111111';
const SENDER = '44444444-4444-4444-8444-444444444444';

const BASE_INPUT: AgentChatTurnInput = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  threadId: 'thread-1',
  userId: 'user-1',
  senderAccountId: SENDER,
  userDisplayName: 'Ada Lovelace',
  userRole: 'member',
  tenantName: 'TestCo',
  content: '',
  channelHint: 'web',
};

const AGENT_ROW = {
  id: 'agent-1', role: 'Test Agent', messaging_nickname: 'Testy', system_prompt: 'You are a test agent.',
  user_instructions: null, additional_context: null, status: 'active',
};

function happyStream(): AsyncGenerator<ChatTurnStreamEvent> {
  return (async function* () {
    yield { type: 'thinking' } as ChatTurnStreamEvent;
    yield { type: 'text_delta', text: 'Picking up where you left the browser.' } as ChatTurnStreamEvent;
    yield { type: 'complete', outputText: 'Picking up where you left the browser.', inputTokens: 100, outputTokens: 50, sessionId: 's' } as ChatTurnStreamEvent;
  })();
}

async function collectEvents(gen: AsyncIterable<AgentChatEvent>): Promise<AgentChatEvent[]> {
  const out: AgentChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

let runChatTurnStream: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  const mockQuery = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('internal_agents')) return Promise.resolve({ rows: [AGENT_ROW] });
    if (sql.includes('agent_chat_sessions') && sql.includes('INSERT')) return Promise.resolve({ rowCount: 1 });
    return Promise.resolve({ rows: [] });
  });
  (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
  (chatRepo.appendMessage as jest.Mock).mockResolvedValue({ id: 'msg-assistant-1', role: 'assistant', content: 'ok' });
  (chatRepo.createTurnWithUserMessage as jest.Mock).mockResolvedValue({ id: 'msg-user-1', role: 'user', content: 'x' });
  (chatRepo.createTurnWithoutUserMessage as jest.Mock).mockResolvedValue(undefined);
  (chatRepo.listMessages as jest.Mock).mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });
  (chatRepo.getThreadRollingSummary as jest.Mock).mockResolvedValue(null);
  runChatTurnStream = jest.fn().mockReturnValue(happyStream());
  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream,
  }));
  mockDriverName.mockResolvedValue('');
});

describe('a hand-back without words', () => {
  it('writes the turn row alone, screens nothing, and sends the event with an empty message to the runtime', async () => {
    const events = await collectEvents(runAgentChatTurn({ ...BASE_INPUT, browserEvent: { kind: 'handback', holdId: HOLD } }));
    expect(events.some((e) => e.type === 'complete')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(chatRepo.createTurnWithoutUserMessage).toHaveBeenCalledWith('tenant-1', 'thread-1', 'agent-1', expect.any(String), SENDER, 'Ada Lovelace', null);
    expect(chatRepo.createTurnWithUserMessage).not.toHaveBeenCalled();
    expect(mockScreenChatMessage).not.toHaveBeenCalled();
    expect(mockGuardMessage).not.toHaveBeenCalled();
    expect(runChatTurnStream).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      userMessage: '', browserHandback: { holdId: HOLD },
    }));
    expect(runChatTurnStream.mock.calls[0][1]).not.toHaveProperty('browserPoint');
  });

  it('words beside an event are stored and screened as any message', async () => {
    await collectEvents(runAgentChatTurn({ ...BASE_INPUT, content: 'now summarise it', browserEvent: { kind: 'handback', holdId: HOLD } }));
    expect(chatRepo.createTurnWithUserMessage).toHaveBeenCalledTimes(1);
    expect(mockScreenChatMessage).toHaveBeenCalledTimes(1);
    expect(runChatTurnStream).toHaveBeenLastCalledWith('tenant-1', expect.objectContaining({ userMessage: 'now summarise it', browserHandback: { holdId: HOLD } }));
  });

  it('an empty message with no event is still refused before any row', async () => {
    const events = await collectEvents(runAgentChatTurn({ ...BASE_INPUT, content: '   ' }));
    expect(events.some((e) => e.type === 'error' && e.code === 'EMPTY_MESSAGE')).toBe(true);
    expect(chatRepo.createTurnWithoutUserMessage).not.toHaveBeenCalled();
    expect(runChatTurnStream).not.toHaveBeenCalled();
  });
});

describe('the driver\'s name on the runtime request', () => {
  it('is stamped as browserDriverName when a person holds the wheel, and left off otherwise', async () => {
    mockDriverName.mockResolvedValueOnce('Ada Lovelace');
    await collectEvents(runAgentChatTurn({ ...BASE_INPUT, content: 'hello' }));
    expect(mockDriverName).toHaveBeenCalledWith('tenant-1', 'thread-1');
    expect(runChatTurnStream).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ browserDriverName: 'Ada Lovelace' }));
    runChatTurnStream.mockReturnValue(happyStream());
    await collectEvents(runAgentChatTurn({ ...BASE_INPUT, content: 'hello again' }));
    expect(runChatTurnStream.mock.calls[1][1]).not.toHaveProperty('browserDriverName');
  });
});
