// Liftoff's words pass the output guard before a person reads them.
//
// The guard is mocked to a deterministic rewrite so the test can tell the
// difference between "guarded" and "raw" at every exit: what streams, what
// is persisted, and what the model reads back as its own history (raw).

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

jest.mock('../../insights/conversation-summarization', () => ({
  shouldSummarize: jest.fn().mockReturnValue(false),
  generateRollingSummary: jest.fn(),
  formatSummaryForPrompt: jest.fn().mockReturnValue('formatted summary'),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../workspace-actions/tools', () => ({
  toolsForActor: () => [],
  isWorkspaceActionTool: () => false,
  dispatchWorkspaceAction: jest.fn(),
}));

jest.mock('../turn-control', () => ({
  newTurnId: () => '00000000-0000-4000-8000-0000000turnid',
  claimAbortSignal: jest.fn().mockResolvedValue(false),
  claimUserMessageSignal: jest.fn().mockResolvedValue(null),
  frameInterrupt: (i: { text: string }) => i.text,
}));

const mockGuard = jest.fn();
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...args),
}));

import { llmClient } from '../../llm';
import { appendMessage, getThreadRollingSummary, listMessages } from '../chat-repository';
import { runLiftoffChatTurn, type ChatServiceEvent } from '../chat-service';
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
    messages: [{ id: 'm', threadId: 'thread-1', role: 'user', content: input.userMessage, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-01T00:00:00Z' }],
    nextCursor: null,
    hasMore: false,
  });
  (getThreadRollingSummary as jest.Mock).mockResolvedValue(null);
  mockAppendMessage
    .mockResolvedValueOnce({ id: 'msg-user', threadId: 'thread-1', role: 'user' })
    .mockResolvedValue({ id: 'msg-assistant', threadId: 'thread-1', role: 'assistant', content: '', inputTokens: 0, outputTokens: 0, createdAt: '2026-09-01T00:00:01Z' });
  // The rewrite the guard makes, recognisable at every exit.
  mockGuard.mockImplementation(async (text: string) =>
    text.includes('per the request')
      ? { text: text.replace(', per the request', ''), changed: true, kinds: ['mechanics'] }
      : { text, changed: false, kinds: [] });
});

describe('Liftoff output guard', () => {
  it('streams and persists the guarded text, scrubbed of the id, and keeps the raw words for the model only', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: `The Support Triage team (id ${ID}) is busiest` },
        { type: 'text_delta', text: '.\n\nLet me check' },
        { type: 'text_delta', text: ' the numbers, per the request.' },
        { type: 'tool_use', toolCall: { id: 'call-1', name: 'list_colleagues', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
      ]))
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'Forty-eight tasks this month.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      ]));

    const events = await collect(runLiftoffChatTurn(input));

    // The round said it would check, ran a tool, and the round after it
    // answered: two messages, so a blank line between them. This line used
    // to read '...the numbers.Forty-eight tasks...' and that is what people
    // were served.
    const shown = 'The Support Triage team is busiest.\n\nLet me check the numbers.\n\nForty-eight tasks this month.';
    expect(deltas(events)).toBe(shown);
    expect(deltas(events)).not.toContain(ID);

    const persisted = mockAppendMessage.mock.calls.find((c) => c[0].role === 'assistant')![0];
    expect(persisted.content).toBe(shown);

    // The guard read each paragraph once, already scrubbed.
    expect(mockGuard.mock.calls.map((c) => c[0])).toEqual([
      'The Support Triage team is busiest.',
      'Let me check the numbers, per the request.',
      'Forty-eight tasks this month.',
    ]);
    expect(mockGuard.mock.calls[0][1]).toEqual({ tenantId: 'tenant-1', speaker: 'liftoff', threadId: 'thread-1' });

    // The model's next round reads its own raw words, id and all.
    const secondCall = llmStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const ownTurn = secondCall.find((m) => m.role === 'assistant')!;
    expect(ownTurn.content).toContain(ID);
    expect(ownTurn.content).toContain('per the request');
  });

  it('flushes the paragraph in flight when the person stops the turn mid-stream, and persists it guarded', async () => {
    // The watcher polls the stop signal on a timer while the model call is
    // outstanding; the stream is cancelled once it claims one.
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const { claimAbortSignal } = jest.requireMock('../turn-control');
      (claimAbortSignal as jest.Mock).mockResolvedValue(true);
      llmStream.mockReturnValueOnce((async function* () {
        yield { type: 'text_delta', text: 'Half done, per the request' } as LLMStreamEvent;
        await jest.advanceTimersByTimeAsync(2_500);
        throw new Error('aborted');
      })());

      const events = await collect(runLiftoffChatTurn({ ...input, turnId: 'turn-1', abortController }));

      expect(deltas(events)).toBe('Half done');
      expect(events.find((e) => e.type === 'error')).toBeUndefined();
      const persisted = mockAppendMessage.mock.calls.find((c) => c[0].role === 'assistant')![0];
      expect(persisted.content).toBe('Half done');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('where one assistant message ends and the next begins', () => {
  it('puts a blank line at each round boundary, in the stream and in the stored row alike', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'Comments came back for four of the posts, so let me pull the rest.' },
        { type: 'tool_use', toolCall: { id: 'c1', name: 'list_colleagues', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]))
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'Still missing a few. One more pull.' },
        { type: 'tool_use', toolCall: { id: 'c2', name: 'list_colleagues', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]))
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'Here are the top 20 in r/founder this week.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ]));

    const events = await collect(runLiftoffChatTurn(input));

    const expected = [
      'Comments came back for four of the posts, so let me pull the rest.',
      'Still missing a few. One more pull.',
      'Here are the top 20 in r/founder this week.',
    ].join('\n\n');
    expect(deltas(events)).toBe(expected);
    // The row is what a reload and a /share link show, so it must agree with
    // what streamed rather than being reassembled some other way.
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

    const events = await collect(runLiftoffChatTurn(input));

    // One gap between each, not two: the boundary rule is about rounds, and
    // the guard hands each paragraph back with its own blank line intact.
    expect(deltas(events)).toBe('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
  });

  it('opens no gap when the round before it showed the person nothing', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom([
        { type: 'tool_use', toolCall: { id: 'c1', name: 'list_colleagues', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]))
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'Forty-eight tasks this month.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ]));

    const events = await collect(runLiftoffChatTurn(input));

    expect(deltas(events)).toBe('Forty-eight tasks this month.');
  });
});
