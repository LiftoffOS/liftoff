// Chat service tool-use loop tests.
//
// Mocks the LLM client, chat repository, tool dispatcher, summarization, and
// audit logging so we can exercise the loop's branches without hitting the
// database, Tenant Runtime, or a real LLM provider.

// The window the loop guards against is pinned here: several registered
// models have far larger windows, so a test that read the registry would pass
// or fail on which model happened to be approved that week.
const MOCK_CONTEXT_WINDOW = 200_000;
jest.mock('../../llm', () => ({
  llmClient: {
    completeStream: jest.fn(),
    complete: jest.fn(),
    resolvePlannedProvider: jest.fn(() => 'anthropic'),
    contextWindowFor: jest.fn(() => MOCK_CONTEXT_WINDOW),
    // The RECORDED window the bound policy reads: these suites run a model
    // the registry has sized, so the two agree.
    recordedContextWindowFor: jest.fn(() => MOCK_CONTEXT_WINDOW),
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
  // Return a resolved promise — the production wrapper calls .catch() on the
  // result, which would throw if the mock returned undefined.
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../tools', () => ({
  dispatchToolCall: jest.fn(),
  getToolDefinitionsForRole: jest.fn().mockReturnValue([
    {
      name: 'get_agent_performance',
      description: 'Get agent performance',
      input_schema: { type: 'object', properties: {} },
    },
  ]),
  buildInsightsSystemPrompt: jest.fn().mockReturnValue('SYSTEM: You are Liftoff Insights.'),
}));

// The dataset store: the three dataset tools read it, and an oversized tool
// result is parked in it. Null by default, which is the failure path.
const mockCreateDataset = jest.fn(async () => null);
const mockListDatasets = jest.fn(async () => []);
jest.mock('../../datasets/store', () => ({
  ...jest.requireActual('../../datasets/store'),
  createDataset: (...args: unknown[]) => mockCreateDataset(...(args as [])),
  listDatasets: (...args: unknown[]) => mockListDatasets(...(args as [])),
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

// The continuation: the row and its task, mocked so the loop's trigger can
// be read; the guard, mocked to a pass-through that records what it was fed.
const mockEnqueueContinuation = jest.fn();
const mockEnqueueContinuationTask = jest.fn(async () => undefined);
jest.mock('../../chat-continuations/store', () => ({
  ...jest.requireActual('../../chat-continuations/store'),
  enqueueContinuation: (...args: unknown[]) => mockEnqueueContinuation(...(args as [])),
}));
jest.mock('../../chat-continuations/dispatch', () => ({
  enqueueContinuationTask: (...args: unknown[]) => mockEnqueueContinuationTask(...(args as [])),
}));
const mockGuard = jest.fn(async (text: string) => ({ text, changed: false, kinds: [] }));
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...(args as [string])),
}));

import { llmClient } from '../../llm';
import {
  appendMessage,
  getThreadRollingSummary,
  listMessages,
  updateThreadRollingSummary,
} from '../chat-repository';
import {
  generateRollingSummary,
  shouldSummarize,
} from '../conversation-summarization';
import { logAudit } from '../../infrastructure/logging';
import { dispatchToolCall } from '../tools';
import { runInsightsChatTurn, type ChatServiceEvent } from '../chat-service';
import type { LLMStreamEvent } from '../../llm/types';
import { buildAssistantBrowserState } from '../../browser-sessions/browser-state';
import { lastAssistantReplyAt } from '../chat-repository';
import { BROWSER_HANDBACK_TURN_TEXT } from '@liftoffos/browser-record';

const llmStream = llmClient.completeStream as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockGetSummary = getThreadRollingSummary as jest.Mock;
const mockUpdateSummary = updateThreadRollingSummary as jest.Mock;
const mockDispatch = dispatchToolCall as jest.Mock;
const mockShouldSummarize = shouldSummarize as jest.Mock;
const mockGenerateSummary = generateRollingSummary as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

const baseInput = {
  threadId: 'thread-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner' as const,
  userMessage: 'How much did I spend last week?',
};

const fakeSavedMessage = {
  id: 'msg-assistant',
  threadId: 'thread-1',
  role: 'assistant' as const,
  content: '',
  visualizationBlocks: null,
  inputTokens: 0,
  outputTokens: 0,
  createdAt: '2026-04-08T12:00:00Z',
};

/** Build a mock LLMStreamEvent async iterable from a list of events. */
function streamFrom(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** Consume an entire ChatServiceEvent stream and collect the events. */
async function collectEvents(
  iter: AsyncIterable<ChatServiceEvent>,
): Promise<ChatServiceEvent[]> {
  const out: ChatServiceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListMessages.mockResolvedValue({
    messages: [
      // Newest-first: the user message we just appended
      { id: 'msg-u', threadId: 'thread-1', role: 'user', content: 'How much did I spend last week?', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T11:00:00Z' },
    ],
    nextCursor: null,
    hasMore: false,
  });
  mockGetSummary.mockResolvedValue(null);
  mockAppendMessage
    .mockResolvedValueOnce({ id: 'msg-user', threadId: 'thread-1', role: 'user' })
    .mockResolvedValueOnce(fakeSavedMessage);
  mockEnqueueContinuation.mockReset();
  mockEnqueueContinuation.mockResolvedValue({ id: 'cont-1', ordinal: 1 });
  mockEnqueueContinuationTask.mockClear();
  mockGuard.mockClear();
});

describe('runInsightsChatTurn — basic flow', () => {
  it('yields thinking → text_delta → complete for a simple non-tool turn', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Your ' },
        { type: 'text_delta', text: 'total ' },
        { type: 'text_delta', text: 'was $123.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10 } },
      ]),
    );

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const types = events.map(e => e.type);
    expect(types[0]).toBe('thinking');
    expect(types[types.length - 1]).toBe('complete');
    // Text deltas should appear in order
    const deltas = events.filter(e => e.type === 'text_delta').map(e => (e.type === 'text_delta' ? e.text : ''));
    expect(deltas.join('')).toContain('Your total was $123.');
  });

  it('persists the user message first, then the assistant message', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Done.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
    // First call — user message, with the caller the turn ran as as its
    // sender (migration 492)
    expect(mockAppendMessage.mock.calls[0][0]).toMatchObject({
      threadId: 'thread-1',
      role: 'user',
      senderAccountId: 'account-1',
      content: 'How much did I spend last week?',
    });
    // Second call — assistant message with token usage
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({
      threadId: 'thread-1',
      role: 'assistant',
      inputTokens: 30,
      outputTokens: 5,
    });
  });

  it('writes a chat_turn audit log entry at the end', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Short reply.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 3 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    expect(mockLogAudit).toHaveBeenCalledWith(
      'insights.chat_turn',
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'account-1' }),
      expect.objectContaining({
        threadId: 'thread-1',
        iterations: 1,
        inputTokens: 20,
        outputTokens: 3,
      }),
    );
  });

  it('passes insights_chat purpose in the usage context', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ tenantId: 'tenant-1', purpose: 'insights_chat' }),
    );
  });
});

describe('runInsightsChatTurn — tool use', () => {
  it('dispatches tools and loops back to the LLM with results', async () => {
    // Round 1: LLM requests a tool
    // Round 2: LLM responds with text
    llmStream
      .mockReturnValueOnce(
        streamFrom([
          { type: 'tool_use', toolCall: { id: 'call_1', name: 'get_agent_performance', input: { time_range: { preset: 'this_week' } } } },
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([
          { type: 'text_delta', text: 'Agent A had ' },
          { type: 'text_delta', text: '42 tasks.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 150, outputTokens: 15 } },
        ]),
      );

    mockDispatch.mockResolvedValue({
      toolName: 'get_agent_performance',
      ok: true,
      data: { agents: [{ name: 'Agent A', taskCount: 42 }] },
    });

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    // Should yield tool_call event
    const toolCallEvents = events.filter(e => e.type === 'tool_call');
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toEqual({ type: 'tool_call', tool: 'get_agent_performance' });

    // Should have called dispatch once
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      'get_agent_performance',
      { time_range: { preset: 'this_week' } },
      expect.objectContaining({ tenantId: 'tenant-1', accountId: 'account-1', role: 'owner' }),
    );

    // Should have made 2 LLM calls
    expect(llmStream).toHaveBeenCalledTimes(2);

    // Second call should include the tool result in messages
    const secondCallRequest = llmStream.mock.calls[1][0];
    const lastMessage = secondCallRequest.messages[secondCallRequest.messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.toolResults).toEqual([
      {
        toolCallId: 'call_1',
        content: JSON.stringify({ agents: [{ name: 'Agent A', taskCount: 42 }] }),
      },
    ]);

    // The assistant tool_use turn should be the second-to-last message
    const assistantToolTurn = secondCallRequest.messages[secondCallRequest.messages.length - 2];
    expect(assistantToolTurn.role).toBe('assistant');
    expect(assistantToolTurn.toolCalls).toEqual([
      { id: 'call_1', name: 'get_agent_performance', input: { time_range: { preset: 'this_week' } } },
    ]);

    // Final complete should accumulate the text from the second round
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();
  });

  it('recovers when a tool dispatch throws, passing an error result to the LLM', async () => {
    llmStream
      .mockReturnValueOnce(
        streamFrom([
          { type: 'tool_use', toolCall: { id: 'call_1', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 50, outputTokens: 5 } },
        ]),
      )
      .mockReturnValueOnce(
        streamFrom([
          { type: 'text_delta', text: 'Unable to retrieve data.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 10 } },
        ]),
      );

    mockDispatch.mockRejectedValue(new Error('connection lost'));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    // Should still complete gracefully
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeDefined();

    // The second LLM call should have gotten an error-shaped tool result
    const secondCallRequest = llmStream.mock.calls[1][0];
    const lastMessage = secondCallRequest.messages[secondCallRequest.messages.length - 1];
    expect(lastMessage.toolResults[0].content).toContain('Tool execution failed');
    expect(lastMessage.toolResults[0].content).toContain('connection lost');
  });

  it('closes the reply with one tool-less call after MAX_ITERATIONS, rather than leaving with the results unread', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? [
          { type: 'text_delta', text: 'Here is what I found so far.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]
        : [
          { type: 'tool_use', toolCall: { id: 'call_loop', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
        ]),
    );
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { agents: [] } });

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    // Fifty rounds of tools, then the closing call.
    expect(llmStream).toHaveBeenCalledTimes(51);
    const closing = llmStream.mock.calls[50][0];
    expect(closing.toolChoice).toBe('none');
    expect(closing.tools.length).toBeGreaterThan(0);
    expect(closing.serverTools).toEqual([]);
    expect(closing.messages[closing.messages.length - 1]).toMatchObject({ role: 'user', content: expect.stringMatching(/^You must write the reply now, without calling a tool\./) });
    expect(closing.messages[closing.messages.length - 1].content).toContain('[continue]');
    expect(closing.messages[closing.messages.length - 2]).toMatchObject({ role: 'user', toolResults: [expect.objectContaining({ toolCallId: 'call_loop' })] });
    expect(events.find(e => e.type === 'complete')).toBeDefined();
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Here is what I found so far.' });
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ iterations: 51, terminatedEarly: 'MAX_ITERATIONS' });
  });

  it('a call whose prompt is past seven tenths of the window closes the reply while the model asked for tools', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? [
          { type: 'text_delta', text: 'Here is what I have.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]
        : [
          { type: 'tool_use', toolCall: { id: 'call_big', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', model: 'claude-x', usage: { inputTokens: 150_000, outputTokens: 2_000, contextTokens: 150_000 } },
        ]),
    );

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(2);
    expect(mockDispatch).not.toHaveBeenCalled();
    const closing = llmStream.mock.calls[1][0];
    expect(closing.toolChoice).toBe('none');
    expect(closing.messages[closing.messages.length - 2].toolResults).toEqual([
      { toolCallId: 'call_big', content: JSON.stringify({ error: 'Not run: answer now from what you have.' }) },
    ]);
    expect(closing.messages[closing.messages.length - 1]).toMatchObject({ role: 'user', content: expect.stringMatching(/^You must write the reply now, without calling a tool\./) });
    expect(events.find(e => e.type === 'complete')).toBeDefined();
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Here is what I have.' });
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ terminatedEarly: 'CONTEXT_FULL' });
    // The RECORDED window, not the one with the fallback already folded in:
    // the shared bound policy needs to tell "this model holds 1M" from
    // "nobody sized it", and only the first may ever drive a destructive
    // decision.
    expect((llmClient.recordedContextWindowFor as jest.Mock)).toHaveBeenCalledWith('anthropic', 'claude-x');
  });

  it('the guard is on the prompt each call carried, never on a sum: thirty rounds of a 14k context do not trip it', async () => {
    let rounds = 0;
    llmStream.mockImplementation((req: { toolChoice?: string }) => {
      if (req.toolChoice === 'none') {
        return streamFrom([
          { type: 'text_delta', text: 'should not be closed by the guard' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]);
      }
      rounds++;
      if (rounds > 30) {
        return streamFrom([
          { type: 'text_delta', text: 'Done after thirty rounds.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 14_000, outputTokens: 50, contextTokens: 14_000 } },
        ]);
      }
      return streamFrom([
        { type: 'tool_use', toolCall: { id: `call_${rounds}`, name: 'get_agent_performance', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 14_000, outputTokens: 300, contextTokens: 14_000 } },
      ]);
    });
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { agents: [] } });

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(31);
    expect(llmStream.mock.calls.every((c) => c[0].toolChoice !== 'none')).toBe(true);
    expect(events.find(e => e.type === 'complete')).toBeDefined();
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Done after thirty rounds.' });
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ iterations: 31, terminatedEarly: null });
  });

  it('an Anthropic call of 20k uncached and 140k read from the cache trips the guard', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? [
          { type: 'text_delta', text: 'Closing.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]
        : [
          { type: 'tool_use', toolCall: { id: 'call_cached', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 140_000, contextTokens: 160_000 } },
        ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(2);
    expect(llmStream.mock.calls[1][0].toolChoice).toBe('none');
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ terminatedEarly: 'CONTEXT_FULL' });
  });

  it('closes the reply when the deadline has passed between two calls', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? [
          { type: 'text_delta', text: 'Closing on the deadline.' },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]
        : [
          { type: 'tool_use', toolCall: { id: 'call_late', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5, contextTokens: 10 } },
        ]),
    );

    const events = await collectEvents(runInsightsChatTurn({ ...baseInput, deadlineAt: Date.now() - 1 }));

    expect(llmStream).toHaveBeenCalledTimes(2);
    expect(mockDispatch).not.toHaveBeenCalled();
    const closing = llmStream.mock.calls[1][0];
    expect(closing.toolChoice).toBe('none');
    expect(closing.messages[closing.messages.length - 2].toolResults).toEqual([
      { toolCallId: 'call_late', content: JSON.stringify({ error: 'Not run: answer now from what you have.' }) },
    ]);
    expect(events.find(e => e.type === 'complete')).toBeDefined();
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Closing on the deadline.' });
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ terminatedEarly: 'DEADLINE' });
  });
});

describe('runInsightsChatTurn — errors', () => {
  it('yields error on provider stream error event and does not persist assistant message', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Starting...' },
        { type: 'error', message: 'provider timeout' },
      ]),
    );

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const error = events.find(e => e.type === 'error');
    expect(error).toEqual({ type: 'error', code: 'PROVIDER_ERROR', message: 'provider timeout' });
    // Only the user message should have been persisted (appendMessage once)
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    // No complete event
    expect(events.find(e => e.type === 'complete')).toBeUndefined();
  });

  it('yields error when llmClient.completeStream() throws synchronously', async () => {
    llmStream.mockImplementation(() => {
      // simulate a provider SDK exception BEFORE it yields any events
      throw new Error('connection refused');
    });

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const error = events.find(e => e.type === 'error');
    expect(error?.type).toBe('error');
  });

  it('yields internal error when something uncaught throws (e.g. repository failure)', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockRejectedValue(new Error('db connection lost'));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const error = events.find(e => e.type === 'error');
    expect(error).toEqual({
      type: 'error',
      code: 'INTERNAL',
      message: 'Something went wrong processing your message. Please try again.',
    });
  });
});

describe('runInsightsChatTurn — visualization blocks', () => {
  it('emits content_block events and persists cleaned text for fenced blocks', async () => {
    const METRIC_BLOCK = {
      type: 'metric_card',
      label: 'Total Cost',
      value: '$4,832',
    };
    const rawText =
      'Here are the numbers:\n\n```visualization\n' +
      JSON.stringify([METRIC_BLOCK]) +
      '\n```\n\nThat is the summary.';

    // Stream the text in a few chunks
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: rawText.slice(0, 30) },
        { type: 'text_delta', text: rawText.slice(30) },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 20 } },
      ]),
    );

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    // Should have emitted at least one content_block event
    const blockEvents = events.filter(e => e.type === 'content_block');
    expect(blockEvents.length).toBeGreaterThanOrEqual(1);
    if (blockEvents[0].type === 'content_block') {
      expect(blockEvents[0].block).toMatchObject(METRIC_BLOCK);
    }

    // Persisted message should have the cleaned text (no fence markers)
    const assistantPersist = mockAppendMessage.mock.calls[1][0];
    expect(assistantPersist.content).not.toContain('```visualization');
    expect(assistantPersist.content).toContain('Here are the numbers');
    expect(assistantPersist.content).toContain('That is the summary');
    expect(assistantPersist.visualizationBlocks).toEqual([METRIC_BLOCK]);
  });
});

describe('runInsightsChatTurn — rolling summary', () => {
  it('loads the rolling summary and passes it to the prompt when present', async () => {
    mockGetSummary.mockResolvedValue({
      userIntent: 'Investigating cost spike',
      keyFacts: ['Costs up 20%'],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-04-05T00:00:00Z',
      messageCount: 8,
    });
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Following up.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    // The system-role preamble (with the summary) should be in the messages
    const firstCallRequest = llmStream.mock.calls[0][0];
    const systemPreamble = firstCallRequest.messages.find(
      (m: { role: string; content: string }) =>
        m.role === 'system' && m.content.includes('Conversation summary'),
    );
    expect(systemPreamble).toBeDefined();
  });

  it('does NOT trigger summarization for short threads (fire-and-forget noop)', async () => {
    mockShouldSummarize.mockReturnValue(false);
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Short reply.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    // The fire-and-forget promise runs asynchronously; give it a tick to settle.
    await new Promise(resolve => setImmediate(resolve));

    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(mockUpdateSummary).not.toHaveBeenCalled();
  });

  it('triggers summarization when shouldSummarize returns true (fire-and-forget)', async () => {
    mockShouldSummarize.mockReturnValue(true);
    mockGenerateSummary.mockResolvedValue({
      userIntent: 'new intent',
      keyFacts: [],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-04-08T00:00:00Z',
      messageCount: 12,
    });
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Reply.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));

    // Let fire-and-forget settle
    await new Promise(resolve => setImmediate(resolve));

    expect(mockGenerateSummary).toHaveBeenCalled();
    expect(mockUpdateSummary).toHaveBeenCalledWith(
      'thread-1',
      'tenant-1',
      expect.objectContaining({ userIntent: 'new intent' }),
    );
  });
});

const { maybeGenerateThreadTitle } = require('../../shared/thread-title-generation');
const mockMaybeGenerateTitle = maybeGenerateThreadTitle as jest.Mock;

describe('runInsightsChatTurn — title generation fire-and-forget', () => {
  beforeEach(() => {
    mockMaybeGenerateTitle.mockReset();
    mockMaybeGenerateTitle.mockResolvedValue(undefined);
  });

  it('fires maybeGenerateThreadTitle on the first turn (priorTurns empty)', async () => {
    // Default beforeEach: listMessages returns just the user msg, so priorTurns is empty.
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Your total was $42.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));
    await new Promise(resolve => setImmediate(resolve));

    expect(mockMaybeGenerateTitle).toHaveBeenCalledTimes(1);
    expect(mockMaybeGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        tenantId: 'tenant-1',
        userMessage: 'How much did I spend last week?',
        assistantMessage: 'Your total was $42.',
      }),
    );
    // Insights does NOT pass agentId — its title cost stays in platformLLMOperations.
    expect(mockMaybeGenerateTitle.mock.calls[0][0]).not.toHaveProperty('agentId');
  });

  it('fires on the second turn too (retry window — priorTurns.length === 2)', async () => {
    mockListMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm3', threadId: 'thread-1', role: 'user', content: 'How much did I spend last week?', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T11:00:00Z' },
        { id: 'm2', threadId: 'thread-1', role: 'assistant', content: 'a1', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T10:00:00Z' },
        { id: 'm1', threadId: 'thread-1', role: 'user', content: 'q1', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T09:00:00Z' },
      ],
      nextCursor: null,
      hasMore: false,
    });
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'reply' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));
    await new Promise(resolve => setImmediate(resolve));

    expect(mockMaybeGenerateTitle).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire after the retry window closes (priorTurns.length > 4)', async () => {
    // 6 messages in history → priorTurns = 5 → exceeds the <= 4 threshold.
    mockListMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm6', threadId: 'thread-1', role: 'user', content: 'How much did I spend last week?', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T16:00:00Z' },
        { id: 'm5', threadId: 'thread-1', role: 'assistant', content: 'a2', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T15:00:00Z' },
        { id: 'm4', threadId: 'thread-1', role: 'user', content: 'q2', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T14:00:00Z' },
        { id: 'm3', threadId: 'thread-1', role: 'assistant', content: 'a1', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T13:00:00Z' },
        { id: 'm2', threadId: 'thread-1', role: 'user', content: 'q1', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T12:00:00Z' },
        { id: 'm1', threadId: 'thread-1', role: 'assistant', content: 'a0', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T11:00:00Z' },
      ],
      nextCursor: null,
      hasMore: false,
    });
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'reply' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));
    await new Promise(resolve => setImmediate(resolve));

    expect(mockMaybeGenerateTitle).not.toHaveBeenCalled();
  });

  it('does NOT fire when the turn errored before completion', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'error', message: 'provider down' },
      ]),
    );

    await collectEvents(runInsightsChatTurn(baseInput));
    await new Promise(resolve => setImmediate(resolve));

    expect(mockMaybeGenerateTitle).not.toHaveBeenCalled();
  });
});

describe('runInsightsChatTurn — the Browser section and the person\'s browser events', () => {
  const mockBuildBrowserState = buildAssistantBrowserState as jest.Mock;
  const mockLastReplyAt = lastAssistantReplyAt as jest.Mock;
  const answer = (text: string): LLMStreamEvent[] => [
    { type: 'text_delta', text },
    { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ];

  it('builds the Browser section on every turn from when it last spoke, and puts it in the preamble after the user context', async () => {
    mockLastReplyAt.mockResolvedValueOnce('2026-04-08T10:00:00.000Z');
    mockBuildBrowserState.mockResolvedValueOnce('## Browser\n\nThe browser beside this conversation is open on https://a.example/.');
    llmStream.mockReturnValue(streamFrom(answer('Sure.')));
    await collectEvents(runInsightsChatTurn(baseInput));
    expect(mockBuildBrowserState).toHaveBeenCalledWith({ tenantId: 'tenant-1', threadId: 'thread-1', sinceLastReply: '2026-04-08T10:00:00.000Z' });
    const messages = llmStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    const preamble = messages[1];
    expect(preamble.role).toBe('system');
    expect(preamble.content.indexOf('## User context')).toBeLessThan(preamble.content.indexOf('## Browser'));
  });

  it('a hand-back without words: no user row, the model reads the shared text, and the newest stored row stays in the history', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockResolvedValue(fakeSavedMessage);
    llmStream.mockReturnValue(streamFrom(answer('Picking up from the page you left.')));
    const events = await collectEvents(runInsightsChatTurn({
      ...baseInput, userMessage: '', browserEvent: { kind: 'handback', holdId: '11111111-1111-4111-8111-111111111111' },
    }));
    expect(events[events.length - 1].type).toBe('complete');
    expect(mockAppendMessage.mock.calls.map((c) => c[0].role)).toEqual(['assistant']);
    const messages = llmStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: BROWSER_HANDBACK_TURN_TEXT });
    expect(messages.some((m) => m.content === 'How much did I spend last week?')).toBe(true);
  });

  it('keeps the person\'s browser event rows out of the model\'s history', async () => {
    mockListMessages.mockResolvedValueOnce({
      messages: [
        { id: 'msg-u', threadId: 'thread-1', role: 'user', content: 'How much did I spend last week?', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T11:00:00Z', messageType: null },
        { id: 'msg-h', threadId: 'thread-1', role: 'assistant', content: 'Ada handed the browser back', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T10:59:00Z', messageType: 'browser_handback' },
        { id: 'msg-p', threadId: 'thread-1', role: 'assistant', content: 'Ada pointed at link "Sports"', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T10:58:00Z', messageType: 'browser_point' },
        { id: 'msg-a', threadId: 'thread-1', role: 'assistant', content: 'Earlier reply.', visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-04-08T10:57:00Z', messageType: null },
      ],
      nextCursor: null, hasMore: false,
    });
    llmStream.mockReturnValue(streamFrom(answer('Sure.')));
    await collectEvents(runInsightsChatTurn(baseInput));
    const contents = (llmStream.mock.calls[0][0].messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toContain('Earlier reply.');
    expect(contents).not.toContain('Ada handed the browser back');
    expect(contents).not.toContain('Ada pointed at link "Sports"');
  });
});

describe('runInsightsChatTurn — work bigger than a turn (the continuation)', () => {
  const toolRound = (): LLMStreamEvent[] => [
    { type: 'tool_use', toolCall: { id: 'call_loop', name: 'get_agent_performance', input: {} } },
    { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
  const alwaysTools = (closingText: string) =>
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? [
          { type: 'text_delta', text: closingText.slice(0, 10) },
          { type: 'text_delta', text: closingText.slice(10) },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]
        : toolRound()),
    );

  it('holds the closing round, strips the verdict before the guard and the stream, and [continue] queues the continuation on the origin message', async () => {
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { agents: [] } });
    alwaysTools('Half the teams are covered; the rest are still to do.\n[continue]');

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const shown = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(shown).toBe('Half the teams are covered; the rest are still to do.');
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Half the teams are covered; the rest are still to do.' });
    expect(mockGuard.mock.calls.some((c) => (c[0] as string).includes('[continue]'))).toBe(false);
    expect(mockEnqueueContinuation).toHaveBeenCalledWith({
      tenantId: 'tenant-1', surface: 'insights', threadId: 'thread-1', accountId: 'account-1', originMessageId: 'msg-user', reason: 'MAX_ITERATIONS',
    });
    expect(mockEnqueueContinuationTask).toHaveBeenCalledWith('cont-1', 'tenant-1');
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ terminatedEarly: 'MAX_ITERATIONS', closingUnfinished: true });
  });

  it('[done] queues nothing', async () => {
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { agents: [] } });
    alwaysTools('Every team is covered.\n[done]');
    const events = await collectEvents(runInsightsChatTurn(baseInput));
    const shown = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(shown).toBe('Every team is covered.');
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
  });

  it('a continuation writes no user row, reads the note as its message, and keeps the origin for the next', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockResolvedValue(fakeSavedMessage);
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { agents: [] } });
    alwaysTools('Nearly there.\n[continue]');

    await collectEvents(runInsightsChatTurn({ ...baseInput, userMessage: '', continuation: { originMessageId: 'msg-user', ordinal: 3 } }));

    expect(mockAppendMessage.mock.calls.map((c) => c[0].role)).toEqual(['assistant']);
    const first = llmStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(first[first.length - 1].content).toMatch(/^Continue the work in progress in this conversation\./);
    expect(mockEnqueueContinuation).toHaveBeenCalledWith(expect.objectContaining({ originMessageId: 'msg-user', accountId: 'account-1' }));
    expect(mockLogAudit.mock.calls[0][2]).toMatchObject({ continuationOf: 'msg-user', continuationOrdinal: 3 });
  });

  it('the fifth continuation is the last: the final note, nothing queued', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockResolvedValue(fakeSavedMessage);
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { agents: [] } });
    alwaysTools('One remains; the person can ask me to go on.');
    await collectEvents(runInsightsChatTurn({ ...baseInput, userMessage: '', continuation: { originMessageId: 'msg-user', ordinal: 5 } }));
    const closing = llmStream.mock.calls[llmStream.mock.calls.length - 1][0];
    const note = closing.messages[closing.messages.length - 1].content as string;
    expect(note).toContain('say that the person can ask you to go on in their next message');
    expect(note).not.toContain('[continue]');
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
  });
});

describe('runInsightsChatTurn / the datasets this conversation keeps', () => {
  const DATASET_ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
  /** Over the 50,000-character bound every surface shares. */
  const HUGE = { rows: [{ body: 'x'.repeat(60_000) }] };

  const toolUseTurn = (name: string, id = 'call_1'): LLMStreamEvent[] => [
    { type: 'tool_use', toolCall: { id, name, input: {} } },
    { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
  const answerTurn = (): LLMStreamEvent[] => [
    { type: 'text_delta', text: 'Done.' },
    { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ];

  it('parks an oversized tool result under this conversation and hands the model the view', async () => {
    mockCreateDataset.mockResolvedValueOnce({
      id: DATASET_ID, recordCount: 1, added: 1, truncated: false,
      fields: [{ name: 'body', type: 'text', present: 1, avgChars: 60_000 }], run: 1,
    } as never);
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: HUGE });
    llmStream
      .mockReturnValueOnce(streamFrom(toolUseTurn('get_agent_performance')))
      .mockReturnValueOnce(streamFrom(answerTurn()));

    await collectEvents(runInsightsChatTurn(baseInput));

    expect(mockCreateDataset).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      scope: { kind: 'insights_thread', id: 'thread-1' },
      label: 'get_agent_performance result',
      source: 'insights_tool',
      sourceRef: 'get_agent_performance',
    }));
    const second = llmStream.mock.calls[1][0].messages;
    const results = second.flatMap((m: { toolResults?: Array<{ content: string }> }) => m.toolResults ?? []);
    expect(results[0].content).toContain(DATASET_ID);
    expect(results[0].content).not.toContain('x'.repeat(1_000));
  });

  it('bounds it rather than handing it over whole when it could not be parked', async () => {
    mockCreateDataset.mockResolvedValueOnce(null as never);
    mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: HUGE });
    llmStream
      .mockReturnValueOnce(streamFrom(toolUseTurn('get_agent_performance')))
      .mockReturnValueOnce(streamFrom(answerTurn()));

    await collectEvents(runInsightsChatTurn(baseInput));

    const second = llmStream.mock.calls[1][0].messages;
    const results = second.flatMap((m: { toolResults?: Array<{ content: string }> }) => m.toolResults ?? []);
    expect(results[0].content.length).toBeLessThan(JSON.stringify(HUGE).length);
    expect(llmStream).toHaveBeenCalledTimes(2);
  });

  it('answers dataset_list itself, scoped to this thread, rather than through the registry', async () => {
    mockListDatasets.mockResolvedValueOnce([] as never);
    llmStream
      .mockReturnValueOnce(streamFrom(toolUseTurn('dataset_list')))
      .mockReturnValueOnce(streamFrom(answerTurn()));

    await collectEvents(runInsightsChatTurn(baseInput));

    // Never dispatched through the registry: its prose would be cut at 500
    // characters by the sanitizer there.
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockListDatasets).toHaveBeenCalledWith('tenant-1', { kind: 'insights_thread', id: 'thread-1' });
    const second = llmStream.mock.calls[1][0].messages;
    const results = second.flatMap((m: { toolResults?: Array<{ content: string }> }) => m.toolResults ?? []);
    expect(results[0].content).toContain('No datasets are kept for this conversation yet.');
  });
});
