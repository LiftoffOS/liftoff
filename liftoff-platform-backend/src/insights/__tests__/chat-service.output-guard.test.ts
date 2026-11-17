// The Insights Manager's words pass the output guard before a person reads
// them, and BEFORE the visualization parser: a chart's fence reaches the
// parser scrubbed and otherwise untouched, and the prose around it guarded.

jest.mock('../../llm', () => ({
  llmClient: {
    completeStream: jest.fn(),
    complete: jest.fn(),
    // The context guard reads the window of the model that served each
    // round; a fixed window keeps these turns well inside it.
    resolvePlannedProvider: jest.fn(() => 'anthropic'),
    contextWindowFor: jest.fn(() => 200_000),
    // The RECORDED window the bound policy reads: these suites run a model
    // the registry has sized, so the two agree.
    recordedContextWindowFor: jest.fn(() => 200_000),
  },
}));

jest.mock('../chat-repository', () => ({
  appendMessage: jest.fn(),
  createTurn: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  // When the assistant last spoke, for the Browser section: none by default.
  lastAssistantReplyAt: jest.fn().mockResolvedValue(null),
  updateThreadRollingSummary: jest.fn(),
  updateThreadTitleInternal: jest.fn(),
}));

// The Browser section is its own module with its own suite; here the turn
// gets an empty block, as a thread with no browser does.
jest.mock('../../browser-sessions/browser-state', () => ({
  buildAssistantBrowserState: jest.fn().mockResolvedValue(''),
  browserDriverNameForThread: jest.fn().mockResolvedValue(''),
}));

jest.mock('../../shared/thread-title-generation', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../tools', () => ({
  dispatchToolCall: jest.fn(),
  getToolDefinitionsForRole: jest.fn().mockReturnValue([
    { name: 'get_agent_performance', description: 'Get agent performance', input_schema: { type: 'object', properties: {} } },
  ]),
  buildInsightsSystemPrompt: jest.fn().mockReturnValue('SYSTEM: You are Liftoff Insights.'),
}));

jest.mock('../conversation-summarization', () => ({
  shouldSummarize: jest.fn().mockReturnValue(false),
  generateRollingSummary: jest.fn(),
  formatSummaryForPrompt: jest.fn().mockReturnValue('formatted summary'),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockGuard = jest.fn();
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...args),
}));

import { llmClient } from '../../llm';
import { appendMessage, getThreadRollingSummary, listMessages } from '../chat-repository';
import { runInsightsChatTurn, type ChatServiceEvent } from '../chat-service';
import type { LLMStreamEvent } from '../../llm/types';

const llmStream = llmClient.completeStream as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;

const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

const input = {
  threadId: 'thread-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner' as const,
  userMessage: 'Which team is busiest?',
};

function streamFrom(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

async function collect(iter: AsyncIterable<ChatServiceEvent>): Promise<ChatServiceEvent[]> {
  const out: ChatServiceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const deltas = (events: ChatServiceEvent[]) =>
  events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');

beforeEach(() => {
  jest.clearAllMocks();
  llmStream.mockReset();
  (listMessages as jest.Mock).mockResolvedValue({
    messages: [{ id: 'm', threadId: 'thread-1', role: 'user', content: input.userMessage, visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-01T00:00:00Z' }],
    nextCursor: null,
    hasMore: false,
  });
  (getThreadRollingSummary as jest.Mock).mockResolvedValue(null);
  mockAppendMessage
    .mockResolvedValueOnce({ id: 'msg-user', threadId: 'thread-1', role: 'user' })
    .mockResolvedValue({ id: 'msg-assistant', threadId: 'thread-1', role: 'assistant', content: '', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-01T00:00:01Z' });
  mockGuard.mockImplementation(async (text: string) =>
    text.includes('per the request')
      ? { text: text.replace(', per the request', ''), changed: true, kinds: ['mechanics'] }
      : { text, changed: false, kinds: [] });
});

describe('Insights output guard', () => {
  it('guards the prose, passes the chart through scrubbed, and persists the guarded text with the block lifted out', async () => {
    const chart = `[{"type":"metric_card","label":"Busiest team (id ${ID})","value":"48 tasks"}]`;
    llmStream.mockReturnValueOnce(streamFrom([
      { type: 'text_delta', text: `The Support Triage team (id ${ID}) ran the most, per the request.\n\n` },
      { type: 'text_delta', text: '```visualization\n' },
      { type: 'text_delta', text: `${chart}\n\`\`\`\n\n` },
      { type: 'text_delta', text: 'That is 48 tasks.' },
      { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
    ]));

    const events = await collect(runInsightsChatTurn(input));

    const text = deltas(events);
    expect(text).not.toContain(ID);
    expect(text).not.toContain('per the request');
    expect(text).toContain('The Support Triage team ran the most.');
    expect(text).toContain('That is 48 tasks.');

    // The chart came through the parser as a block, its id emptied, and was
    // never handed to the guard.
    const blocks = events.filter((e) => e.type === 'content_block').map((e) => (e.type === 'content_block' ? e.block : null));
    expect(blocks).toHaveLength(1);
    // The scrub emptied the id inside the JSON string and kept it parseable.
    expect(blocks[0]).toEqual({ type: 'metric_card', label: 'Busiest team', value: '48 tasks' });
    expect(mockGuard.mock.calls.map((c) => c[0])).toEqual([
      `The Support Triage team ran the most, per the request.`,
      'That is 48 tasks.',
    ]);
    expect(mockGuard.mock.calls[0][1]).toEqual({ tenantId: 'tenant-1', speaker: 'insights', threadId: 'thread-1' });

    const persisted = mockAppendMessage.mock.calls.find((c) => c[0].role === 'assistant')![0];
    expect(persisted.content).not.toContain(ID);
    expect(persisted.content).not.toContain('per the request');
    expect(persisted.content).not.toContain('```');
    expect(persisted.visualizationBlocks).toHaveLength(1);
  });
});

describe('where one assistant message ends and the next begins', () => {
  it('puts a blank line at the round boundary, in the stream and in the stored row alike', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'Let me pull the task counts.' },
        { type: 'tool_use', toolCall: { id: 'c1', name: 'get_agent_performance', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]))
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'The Support Triage team ran the most.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ]));

    const { dispatchToolCall } = jest.requireMock('../tools');
    (dispatchToolCall as jest.Mock).mockResolvedValue({ ok: true, rows: [] });

    const events = await collect(runInsightsChatTurn(input));

    const expected = 'Let me pull the task counts.\n\nThe Support Triage team ran the most.';
    expect(deltas(events)).toBe(expected);
    const persisted = mockAppendMessage.mock.calls.find((c) => c[0].role === 'assistant')![0];
    expect(persisted.content).toBe(expected);
    expect(persisted.content).not.toMatch(/[a-z][.!?][A-Z]/);
  });

  it('leaves the paragraphs inside one round exactly as the model wrote them', async () => {
    llmStream.mockReturnValueOnce(streamFrom([
      { type: 'text_delta', text: 'First paragraph.\n\nSecond paragraph.\n\n' },
      { type: 'text_delta', text: 'Third paragraph.' },
      { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]));

    const events = await collect(runInsightsChatTurn(input));

    expect(deltas(events)).toBe('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
  });
});
