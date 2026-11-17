// The attachment-claim check runs on the reply as PERSISTED.
//
// chat-service composes the visible reply as `accumulatedText ||
// event.outputText` — its own streamed accumulation first — so a correction
// that lived anywhere else could vanish from what the person reads. These
// tests assert on the row appendMessage receives: that is the text every
// surface renders and the transcript keeps, and the only place the line can
// be proven to survive that choice.
//
// The finding is logged after the row lands, never before: the settle
// backstop races this insert under acm_assistant_turn_uniq, and the writer
// that lost has nothing to report.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
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
  countFileCardsProducedInTurn: jest.fn(),
  getAssistantMessageByTurnId: jest.fn(),
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
import { log } from '../../infrastructure/logging';
import { TenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import type { ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import { runAgentChatTurn, type AgentChatEvent, type AgentChatTurnInput } from '../chat-service';
import { NO_FILE_ATTACHED } from '../attachment-claims';

const mockAppendMessage = chatRepo.appendMessage as jest.Mock;
const mockCount = chatRepo.countFileCardsProducedInTurn as jest.Mock;

const INPUT: AgentChatTurnInput = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  threadId: 'thread-1',
  userId: 'user-1',
  userDisplayName: 'Test User',
  userRole: 'member',
  tenantName: 'TestCo',
  content: 'Send me the NDA',
  channelHint: 'web',
};

const AGENT_ROW = {
  id: 'agent-1',
  role: 'NDA Analyst',
  messaging_nickname: 'NDA',
  system_prompt: 'You review NDAs.',
  user_instructions: null,
  additional_context: null,
  status: 'active',
};

const CLAIM_STREAMED = 'The signed NDA is attached below this message.';
// The runtime's own final text differs, so the test can tell which one the
// check ran on: the accumulation is what is persisted.
const CLAIM_RUNTIME = 'Attached below.';

function streamFrom(events: ChatTurnStreamEvent[]): AsyncGenerator<ChatTurnStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function replyStream(streamed: string, outputText = streamed): AsyncGenerator<ChatTurnStreamEvent> {
  return streamFrom([
    { type: 'thinking' },
    { type: 'text_delta', text: streamed },
    { type: 'complete', outputText, inputTokens: 10, outputTokens: 5, sessionId: 'session-1' },
  ]);
}

async function drain(gen: AsyncIterable<AgentChatEvent>): Promise<AgentChatEvent[]> {
  const out: AgentChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** The text appendMessage was asked to persist for the assistant reply. */
function persistedReply(): string {
  const call = mockAppendMessage.mock.calls.find((c) => c[2] === 'assistant');
  expect(call).toBeDefined();
  return call![3] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppendMessage.mockReset();
  mockCount.mockReset();
  mockAppendMessage.mockImplementation(async (_t, _th, role, content) => ({
    id: 'msg-assistant-1', tenantId: 'tenant-1', threadId: 'thread-1', agentId: 'agent-1',
    role, content, toolCalls: null, inputTokens: 10, outputTokens: 5, createdAt: '2026-09-17T10:36:00.000Z',
  }));
  (chatRepo.createTurnWithUserMessage as jest.Mock).mockResolvedValue({
    id: 'msg-user-1', tenantId: 'tenant-1', threadId: 'thread-1', agentId: null, role: 'user',
    content: INPUT.content, toolCalls: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-17T10:35:00.000Z',
  });
  (chatRepo.listMessages as jest.Mock).mockResolvedValue({ messages: [], hasMore: false, nextCursor: null });
  (chatRepo.getThreadRollingSummary as jest.Mock).mockResolvedValue(null);
  (getPool as jest.Mock).mockReturnValue({
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('internal_agents')) return Promise.resolve({ rows: [AGENT_ROW] });
      if (sql.includes('agent_chat_sessions') && sql.includes('INSERT')) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve({ rows: [] });
    }),
  });
  (TenantRuntimeClient as jest.Mock).mockClear();
  (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
    retrieveAgentMemories: jest.fn().mockResolvedValue([]),
    runChatTurnStream: jest.fn().mockReturnValue(replyStream(CLAIM_STREAMED, CLAIM_RUNTIME)),
  }));
});

describe('the correction on the persisted reply', () => {
  it('is appended to the STREAMED text when a known turn has no cards, and survives the accumulatedText || outputText choice', async () => {
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 0 });

    const events = await drain(runAgentChatTurn(INPUT));

    expect(persistedReply()).toBe(`${CLAIM_STREAMED}\n\n${NO_FILE_ATTACHED}`);
    // The complete frame hands the client the same row.
    const complete = events.find((e) => e.type === 'complete') as { message: { content: string } };
    expect(complete.message.content).toBe(`${CLAIM_STREAMED}\n\n${NO_FILE_ATTACHED}`);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_unbacked', threadId: 'thread-1', invocationId: expect.any(String) }),
      expect.any(String),
    );
  });

  it('reads the cards by the turn PB minted — the same turn the reply is persisted under', async () => {
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 0 });

    await drain(runAgentChatTurn(INPUT));

    expect(mockCount).toHaveBeenCalledTimes(1);
    const [tenantId, threadId, turnId] = mockCount.mock.calls[0];
    expect(tenantId).toBe('tenant-1');
    expect(threadId).toBe('thread-1');
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
    const assistantCall = mockAppendMessage.mock.calls.find((c) => c[2] === 'assistant')!;
    expect(assistantCall[11]).toBe(turnId);
  });

  it('logs nothing when the settle backstop won the race — its row, its finding', async () => {
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 0 });
    mockAppendMessage.mockImplementation(async (_t, _th, role) => {
      if (role === 'assistant') throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { id: 'other', role };
    });
    (chatRepo.getAssistantMessageByTurnId as jest.Mock).mockResolvedValue({
      id: 'msg-settled', tenantId: 'tenant-1', threadId: 'thread-1', agentId: 'agent-1', role: 'assistant',
      content: CLAIM_STREAMED, toolCalls: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-17T10:36:00.000Z',
    });

    const events = await drain(runAgentChatTurn(INPUT));

    const complete = events.find((e) => e.type === 'complete') as { message: { id: string } };
    expect(complete.message.id).toBe('msg-settled');
    expect(log.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'attachment_claim_unbacked' }), expect.any(String));
    expect(log.info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'attachment_claim_check_skipped' }), expect.any(String));
  });

  it('is not appended when this turn produced a card', async () => {
    mockCount.mockResolvedValue({ attributed: 1, unattributed: 0 });
    await drain(runAgentChatTurn(INPUT));
    expect(persistedReply()).toBe(CLAIM_STREAMED);
    expect(log.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'attachment_claim_unbacked' }), expect.any(String));
  });

  it('is not appended when an unattributed card exists since the turn started — the mixed-version case', async () => {
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 1 });
    await drain(runAgentChatTurn(INPUT));
    expect(persistedReply()).toBe(CLAIM_STREAMED);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_check_skipped', reason: 'unattributed_card_present' }),
      expect.any(String),
    );
  });

  it('is not appended when the lookup throws; the reply is persisted unchanged with the reason', async () => {
    mockCount.mockRejectedValue(new Error('timeout'));
    await drain(runAgentChatTurn(INPUT));
    expect(persistedReply()).toBe(CLAIM_STREAMED);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_check_skipped', reason: 'lookup_failed' }),
      expect.any(String),
    );
  });

  it('is not appended, and nothing is looked up, for a reply that makes no claim', async () => {
    const text = 'I attached a note to the CRM record.';
    (TenantRuntimeClient as jest.Mock).mockImplementation(() => ({
      retrieveAgentMemories: jest.fn().mockResolvedValue([]),
      runChatTurnStream: jest.fn().mockReturnValue(replyStream(text)),
    }));
    await drain(runAgentChatTurn(INPUT));
    expect(persistedReply()).toBe(text);
    expect(mockCount).not.toHaveBeenCalled();
  });
});
