// Mid-run control inside the insights chat loop (ADR-041).
//
// One case per trap the agent-chat rollout paid for, because those follow-up
// fixes are the real specification for this port:
//
//   fb501bb — a mid-run message is claimed only where another model turn is
//             guaranteed. Claiming it anywhere else marks it delivered and then
//             drops it.
//   7ba086a — an injected message must actually run its turn, including when it
//             arrives after the last tool call.
//   c247793 — the turn that answers the injection still keeps its reply.
//   f328bad — a user stop is a stop, not an engine error.

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
    {
      name: 'get_agent_performance',
      description: 'Get agent performance',
      input_schema: { type: 'object', properties: {} },
    },
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

const mockClaimAbortSignal = jest.fn();
const mockClaimUserMessageSignal = jest.fn();
jest.mock('../turn-control', () => ({
  newTurnId: () => '00000000-0000-4000-8000-0000000turnid',
  claimAbortSignal: (...args: unknown[]) => mockClaimAbortSignal(...args),
  claimUserMessageSignal: (...args: unknown[]) => mockClaimUserMessageSignal(...args),
  frameInterrupt: (i: { text: string; senderDisplayName: string | null }) =>
    `FRAMED(${i.senderDisplayName ?? 'anon'}): ${i.text}`,
}));

import { llmClient } from '../../llm';
import { appendMessage, getThreadRollingSummary, listMessages } from '../chat-repository';
import { logAudit } from '../../infrastructure/logging';
import { dispatchToolCall } from '../tools';
import { runInsightsChatTurn, type ChatServiceEvent } from '../chat-service';
import type { LLMStreamEvent } from '../../llm/types';

const llmStream = llmClient.completeStream as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockGetSummary = getThreadRollingSummary as jest.Mock;
const mockDispatch = dispatchToolCall as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

const TURN_ID = 'turn-1';

const baseInput = (overrides = {}) => ({
  threadId: 'thread-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner' as const,
  userMessage: 'How are my agents doing?',
  turnId: TURN_ID,
  abortController: new AbortController(),
  ...overrides,
});

/** Turn one array of stream events into the async iterable the client returns. */
function stream(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

const textTurn = (text: string): LLMStreamEvent[] => [
  { type: 'text_delta', text },
  {
    type: 'message_complete',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  },
];

const toolTurn = (): LLMStreamEvent[] => [
  {
    type: 'tool_use',
    toolCall: { id: 'call-1', name: 'get_agent_performance', input: {} },
  },
  {
    type: 'message_complete',
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5 },
  },
];

async function drain(input: Parameters<typeof runInsightsChatTurn>[0]): Promise<ChatServiceEvent[]> {
  const events: ChatServiceEvent[] = [];
  for await (const e of runInsightsChatTurn(input)) events.push(e);
  return events;
}

/** The messages array handed to the Nth model call (1-based). */
function conversationForCall(n: number): Array<{ role: string; content: string }> {
  return llmStream.mock.calls[n - 1][0].messages;
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks does not drain queued mockReturnValueOnce implementations, so
  // a test that stops the loop early leaves its unused turn behind for the next
  // one to consume. Reset the queue outright.
  llmStream.mockReset();
  mockListMessages.mockResolvedValue({ messages: [], nextCursor: null, hasMore: false });
  mockGetSummary.mockResolvedValue(null);
  mockAppendMessage.mockResolvedValue({ id: 'message-1', role: 'assistant', content: '' });
  mockDispatch.mockResolvedValue({ toolName: 'get_agent_performance', ok: true, data: { ok: true } });
  mockClaimAbortSignal.mockResolvedValue(false);
  mockClaimUserMessageSignal.mockResolvedValue(null);
});

describe('insights chat mid-run user messages', () => {
  it('appends a claimed message as its own user entry AFTER the tool-result entry', async () => {
    llmStream
      .mockReturnValueOnce(stream(toolTurn()))
      .mockReturnValueOnce(stream(textTurn('answered the redirect')));
    mockClaimUserMessageSignal
      .mockResolvedValueOnce({ text: 'also look at support', senderDisplayName: 'Ada', senderAccountId: 'a1' })
      .mockResolvedValue(null);

    await drain(baseInput());

    const second = conversationForCall(2);
    expect(second[second.length - 1]).toEqual({
      role: 'user',
      content: 'FRAMED(Ada): also look at support',
    });
    // The entry before it is the tool-result turn, whose content is empty.
    expect(second[second.length - 2].content).toBe('');
  });

  it('runs another model turn for a message that lands after the last tool call', async () => {
    llmStream
      .mockReturnValueOnce(stream(textTurn('here is the report')))
      .mockReturnValueOnce(stream(textTurn(' and the change you asked for')));
    mockClaimUserMessageSignal
      .mockResolvedValueOnce({ text: 'break it down by team', senderDisplayName: null, senderAccountId: null })
      .mockResolvedValue(null);

    await drain(baseInput());

    expect(llmStream).toHaveBeenCalledTimes(2);
    const second = conversationForCall(2);
    expect(second[second.length - 1]).toEqual({
      role: 'user',
      content: 'FRAMED(anon): break it down by team',
    });
    // c247793: the reply of the turn that answered the injection is persisted.
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        // Two rounds, so two messages.
        content: 'here is the report\n\nand the change you asked for',
      }),
    );
  });

  it('never claims a message it cannot answer', async () => {
    // fb501bb: a provider error ends the turn, so nothing is claimed and marked
    // delivered on the way out.
    llmStream.mockReturnValueOnce(
      stream([{ type: 'error', message: 'provider exploded' }]),
    );

    await drain(baseInput());

    expect(mockClaimUserMessageSignal).not.toHaveBeenCalled();
  });

  it('bounds trailing continuations so a stream of messages cannot run forever', async () => {
    llmStream.mockReturnValue(stream(textTurn('ok')));
    mockClaimUserMessageSignal.mockResolvedValue({
      text: 'and another thing',
      senderDisplayName: null,
      senderAccountId: null,
    });

    await drain(baseInput());

    expect(llmStream).toHaveBeenCalledTimes(3);
    expect(mockClaimUserMessageSignal).toHaveBeenCalledTimes(2);
  });

  it('leaves the loop untouched when the turn runs without a lock', async () => {
    llmStream.mockReturnValueOnce(stream(textTurn('done')));

    await drain(baseInput({ turnId: undefined, abortController: undefined }));

    expect(llmStream).toHaveBeenCalledTimes(1);
    expect(mockClaimAbortSignal).not.toHaveBeenCalled();
    expect(llmStream.mock.calls[0][0].abortSignal).toBeUndefined();
  });
});

describe('insights chat user stop', () => {
  it('records a stop as a stop and writes no reply the assistant never gave', async () => {
    // f328bad: a stop is success with a user_stopped marker, never a failure.
    // And nothing is invented: a marker in the message content would show up
    // in the transcript as something the assistant said.
    llmStream
      .mockReturnValueOnce(stream(toolTurn()))
      .mockReturnValueOnce(stream(textTurn('should never run')));
    mockClaimAbortSignal.mockResolvedValueOnce(true).mockResolvedValue(false);

    const events = await drain(baseInput());

    expect(llmStream).toHaveBeenCalledTimes(1);
    expect(events.find(e => e.type === 'error')).toBeUndefined();
    // Terminal all the same, so the composer stops streaming - it just
    // carries no message.
    expect(events[events.length - 1]).toEqual({ type: 'complete', message: null });
    // Only the user's own message was persisted this turn.
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user' }),
    );
    const auditDetails = mockLogAudit.mock.calls.find(c => c[0] === 'insights.chat_turn')?.[2];
    expect(auditDetails.errorCode).toBe('user_stopped');
  });

  it('keeps a partial answer when the stop lands after it has said something', async () => {
    llmStream
      .mockReturnValueOnce(stream(textTurn('here is what I found so far')))
      .mockReturnValueOnce(stream(textTurn('should never run')));
    // Nothing pending at the trailing poll, then stopped on the next boundary.
    mockClaimAbortSignal.mockResolvedValue(true);

    await drain(baseInput());

    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'here is what I found so far' }),
    );
  });

  it('checks abort before a mid-run message, so a stop wins over a redirect', async () => {
    llmStream.mockReturnValueOnce(stream(toolTurn()));
    mockClaimAbortSignal.mockResolvedValue(true);
    mockClaimUserMessageSignal.mockResolvedValue({
      text: 'change course',
      senderDisplayName: null,
      senderAccountId: null,
    });

    await drain(baseInput());

    expect(mockClaimAbortSignal).toHaveBeenCalled();
    expect(mockClaimUserMessageSignal).not.toHaveBeenCalled();
  });

  it('hands the model call an abort signal so a stop does not wait it out', async () => {
    llmStream.mockReturnValueOnce(stream(textTurn('streaming')));
    await drain(baseInput());
    expect(llmStream.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('claims signals inside the turn’s tenant, never by turn id alone', async () => {
    // The signals policy resolves tenancy through the lock row, so a claim
    // without the tenant would match nothing and mid-run control would look
    // "broken but green".
    llmStream.mockReturnValueOnce(stream(toolTurn())).mockReturnValueOnce(stream(textTurn('ok')));
    await drain(baseInput());
    expect(mockClaimAbortSignal).toHaveBeenCalledWith('tenant-1', TURN_ID);
    expect(mockClaimUserMessageSignal).toHaveBeenCalledWith('tenant-1', TURN_ID);
  });

  it('reports a lost lock in words the person can act on', async () => {
    // The heartbeat aborts the same controller a stop uses. Nobody pressed
    // anything, so this is an error — but the internal abort message is not a
    // sentence to show someone waiting on a reply.
    const input = baseInput();
    input.abortController.abort(new Error('Lock lost'));
    llmStream.mockImplementationOnce(() => {
      throw new Error('The operation was aborted');
    });

    const events = await drain(input);

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toEqual({
      type: 'error',
      code: 'INTERNAL',
      message: 'The response was interrupted. Please try again.',
    });
    // Not persisted as a reply: nothing was written and nobody asked to stop.
    expect(mockAppendMessage).toHaveBeenCalledTimes(1); // the user message only
  });
});
