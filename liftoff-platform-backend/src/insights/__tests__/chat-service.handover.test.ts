// The hand-over: what happens inside an Insights Manager turn once the model
// calls `bring_in_colleague`.
//
// The colleague's runtime is mocked at the DelegateRuntime seam, which is the
// boundary the shared rail (agent-chat/handover.ts) is written against, so
// one suite covers both colleagues. What differs between them (which HTTP
// call, which stop mechanism) is delegation-runtimes' own suite; the rail's
// own behaviour under a stop and a lost lock is Liftoff's delegation suite,
// which drives the same module. What this suite pins is the Insights side:
// the preamble row, the pairing on its own table, the colleague row and its
// attribution, the status row on a pause, and depth one.

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

jest.mock('../../agent-chat/assistant-delegations', () => ({
  getAssistantThreadDelegation: jest.fn(),
  pairAssistantThreadDelegation: jest.fn(),
}));

jest.mock('../../shared/thread-title-generation', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
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

jest.mock('../../notifications', () => ({
  notifyPlatformChatReply: jest.fn().mockResolvedValue(undefined),
}));

const mockClaimAbortSignal = jest.fn();
jest.mock('../turn-control', () => ({
  newTurnId: () => '00000000-0000-4000-8000-0000000turnid',
  claimAbortSignal: (...args: unknown[]) => mockClaimAbortSignal(...args),
  claimUserMessageSignal: jest.fn().mockResolvedValue(null),
  frameInterrupt: (i: { text: string }) => `FRAMED: ${i.text}`,
}));

// The tool module stays REAL: the loop matches on the tool's name and resolves
// the colleague through it, and a hand-copied string here would drift from
// the one the model is offered. Only the listing is pinned, so the prompt
// builder sees a fixed tool set.
const mockGetToolDefinitionsForRole = jest.fn();
const mockDispatchToolCall = jest.fn();
jest.mock('../tools', () => {
  const actual = jest.requireActual('../tools');
  return {
    ...actual,
    dispatchToolCall: (...args: unknown[]) => mockDispatchToolCall(...args),
    getToolDefinitionsForRole: (...args: unknown[]) => mockGetToolDefinitionsForRole(...args),
    buildInsightsSystemPrompt: jest.fn().mockReturnValue('SYSTEM: You are Liftoff Insights.'),
  };
});

const mockCreateDelegateRuntime = jest.fn();
jest.mock('../../liftoff/delegation-runtimes', () => ({
  createDelegateRuntime: (...args: unknown[]) => mockCreateDelegateRuntime(...args),
}));

import { llmClient } from '../../llm';
import { appendMessage, getThreadRollingSummary, listMessages } from '../chat-repository';
import {
  getAssistantThreadDelegation,
  pairAssistantThreadDelegation,
} from '../../agent-chat/assistant-delegations';
import { logAudit } from '../../infrastructure/logging';
import { notifyPlatformChatReply } from '../../notifications';
import { runInsightsChatTurn, type ChatServiceEvent } from '../chat-service';
import type { DelegatedEvent } from '../../liftoff/delegation-runtimes';
import type { LLMStreamEvent } from '../../llm/types';

const llmStream = llmClient.completeStream as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockGetSummary = getThreadRollingSummary as jest.Mock;
const mockGetPairing = getAssistantThreadDelegation as jest.Mock;
const mockPair = pairAssistantThreadDelegation as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;
const mockNotify = notifyPlatformChatReply as jest.Mock;

/** A caller who is deliberately NOT an owner, so a role that was defaulted or
 *  widened anywhere in the hand-over shows up as a failure. */
const baseInput = {
  threadId: 'insights-thread-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'member' as const,
  userMessage: 'Which team costs the most, and pause it.',
  callerName: 'Dana Reyes',
};

function streamFrom(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** One model turn that says `preamble` (if any) and then calls the tool. */
const handoverTurn = (
  colleague: string,
  request = 'Pause the Watches Trend Watcher team; it costs the most this month.',
  preamble?: string,
): LLMStreamEvent[] => [
  ...(preamble ? [{ type: 'text_delta' as const, text: preamble }] : []),
  {
    type: 'tool_use',
    toolCall: { id: 'call-1', name: 'bring_in_colleague', input: { colleague, request } },
  },
  { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 40, outputTokens: 8 } },
];

async function collectEvents(iter: AsyncIterable<ChatServiceEvent>): Promise<ChatServiceEvent[]> {
  const out: ChatServiceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** A colleague that says `events` and nothing else. */
function fakeRuntime(events: DelegatedEvent[]) {
  return {
    createThread: jest.fn().mockResolvedValue('delegate-thread-new'),
    runTurn: jest.fn(() =>
      (async function* () {
        for (const e of events) yield e;
      })(),
    ),
    requestStop: jest.fn().mockResolvedValue(undefined),
  };
}

const REPLY: DelegatedEvent[] = [
  { type: 'thinking' },
  { type: 'tool_call', tool: 'workforce_plan__preview' },
  { type: 'text_delta', text: 'Here is what ' },
  { type: 'text_delta', text: 'would change.' },
  { type: 'content_block', block: { type: 'org_chart', title: 'Watches Trend Watcher' } },
  {
    type: 'complete',
    text: 'Here is what would change.',
    blocks: [{ type: 'org_chart', title: 'Watches Trend Watcher' }],
    inputTokens: 900,
    outputTokens: 300,
    answeredBy: null,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  llmStream.mockReset();
  mockGetToolDefinitionsForRole.mockReturnValue([
    { name: 'get_cost_breakdown', description: 'cost', input_schema: { type: 'object', properties: {} } },
    { name: 'bring_in_colleague', description: 'colleague', input_schema: { type: 'object', properties: {} } },
  ]);
  mockListMessages.mockResolvedValue({
    messages: [
      {
        id: 'msg-u',
        threadId: baseInput.threadId,
        role: 'user',
        content: baseInput.userMessage,
        visualizationBlocks: null,
        inputTokens: 0,
        outputTokens: 0,
        messageType: null,
        contributors: [],
        createdAt: '2026-09-19T11:00:00Z',
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  mockGetSummary.mockResolvedValue(null);
  mockAppendMessage.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'msg-saved',
    threadId: baseInput.threadId,
    role: input.role,
    content: input.content,
    visualizationBlocks: input.visualizationBlocks ?? null,
    messageType: input.messageType ?? null,
    contributors: input.contributors ?? [],
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    createdAt: '2026-09-19T12:00:00Z',
  }));
  mockClaimAbortSignal.mockResolvedValue(false);
  mockGetPairing.mockResolvedValue(null);
  mockPair.mockImplementation(async (input: { delegateThreadId: string }) => input.delegateThreadId);
});

describe('the tools offered', () => {
  it('lists the colleague on an ordinary turn and withholds it on a hand-over', async () => {
    llmStream.mockReturnValue(streamFrom([
      { type: 'text_delta', text: 'Twelve.' },
      { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]));

    await collectEvents(runInsightsChatTurn(baseInput));
    expect(mockGetToolDefinitionsForRole).toHaveBeenLastCalledWith('member', {
      answerOnly: false,
      asColleague: false,
    });

    llmStream.mockReturnValue(streamFrom([
      { type: 'text_delta', text: 'Twelve.' },
      { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]));
    await collectEvents(runInsightsChatTurn({ ...baseInput, asColleague: true }));
    expect(mockGetToolDefinitionsForRole).toHaveBeenLastCalledWith('member', {
      answerOnly: false,
      asColleague: true,
    });
  });
});

describe('the paired thread', () => {
  it('creates it on the first hand-over and records the pairing on the Insights table', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runInsightsChatTurn(baseInput));

    expect(mockGetPairing).toHaveBeenCalledWith('tenant-1', 'insights', 'insights-thread-1', 'caio', null);
    expect(runtime.createThread).toHaveBeenCalledTimes(1);
    expect(mockPair).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      surface: 'insights',
      threadId: 'insights-thread-1',
      targetKind: 'caio',
      // A singleton colleague carries no target_id.
      targetId: null,
      delegateThreadId: 'delegate-thread-new',
    });
    expect(runtime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ delegateThreadId: 'delegate-thread-new' }),
    );
  });

  it('reuses it on a later hand-over, which is what lets a preview be applied on "yes"', async () => {
    mockGetPairing.mockResolvedValue({
      targetKind: 'caio',
      targetId: null,
      delegateThreadId: 'delegate-thread-existing',
    });
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio', 'Yes, apply the pause it previewed.')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runInsightsChatTurn({ ...baseInput, userMessage: 'yes' }));

    expect(runtime.createThread).not.toHaveBeenCalled();
    expect(mockPair).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ delegateThreadId: 'delegate-thread-existing' }),
    );
  });
});

describe('the caller', () => {
  it.each([
    ['caio', 'caio', 'Chief AI Officer'],
    ['liftoff', 'liftoff', 'Liftoff'],
  ])('brings in %s as a colleague, with the real role and no colleague of its own', async (colleague, id, label) => {
    llmStream.mockReturnValue(streamFrom(handoverTurn(colleague)));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    const events = await collectEvents(runInsightsChatTurn({ ...baseInput, role: 'viewer' }));

    expect(mockCreateDelegateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: id, id, label }),
      expect.objectContaining({
        tenantId: 'tenant-1',
        accountId: 'account-1',
        role: 'viewer',
        displayName: 'Dana Reyes',
        // Depth one.
        asColleague: true,
      }),
    );
    expect(events).toContainEqual({ type: 'delegation_started', author: id, authorLabel: label });
  });

  it('sends the person\'s message alone, with the note beside it in the Insights Manager\'s name', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio', 'Pause the Watches team; it costs the most.')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runInsightsChatTurn(baseInput));

    const args = runtime.runTurn.mock.calls[0][0] as {
      content: string;
      forwardedContext: string | null;
      forwardedBy: { id: string; label: string } | null;
    };
    expect(args.content).toBe(baseInput.userMessage);
    expect(args.forwardedContext).toBe(
      'Background from Insights Manager, which brought you into this conversation. It is not shown to the person: '
      + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.\n\n'
      + 'Pause the Watches team; it costs the most.',
    );
    expect(args.forwardedBy).toEqual({ id: 'insights', label: 'Insights Manager' });
  });

  it('answers an unknown colleague with a tool result so the model can recover', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom(handoverTurn('the team')))
      .mockReturnValueOnce(streamFrom([
        { type: 'text_delta', text: 'I can bring in the Chief AI Officer for that.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ]));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    expect(mockCreateDelegateRuntime).not.toHaveBeenCalled();
    const secondCall = llmStream.mock.calls[1][0] as { messages: Array<{ toolResults?: Array<{ content: string }> }> };
    const toolResult = secondCall.messages.at(-1)?.toolResults?.[0]?.content ?? '';
    expect(toolResult).toContain('the team');
    expect(toolResult).toContain("'caio'");
    expect(toolResult).toContain("'liftoff'");
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });
});

describe('what is persisted', () => {
  it('keeps the figure the Insights Manager gave before handing over, as its own row', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio', undefined, 'Watches Trend Watcher costs the most: $41.20.')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    // Streamed before the hand-over frame, so the person read it first.
    const firstText = events.findIndex((e) => e.type === 'text_delta');
    const started = events.findIndex((e) => e.type === 'delegation_started');
    expect(firstText).toBeGreaterThan(-1);
    expect(firstText).toBeLessThan(started);

    // Rows: user, preamble (the Insights Manager's own), colleague reply.
    const rows = mockAppendMessage.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({
      role: 'assistant',
      content: 'Watches Trend Watcher costs the most: $41.20.',
      visualizationBlocks: null,
    });
    expect(rows[1]).not.toHaveProperty('contributors');
    expect(rows[1]).not.toHaveProperty('messageType');
  });

  it('persists the colleague\'s reply on the Insights thread as a colleague row with its blocks', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const rows = mockAppendMessage.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2); // user + colleague; no empty preamble row
    expect(rows[1]).toEqual({
      threadId: 'insights-thread-1',
      role: 'assistant',
      content: 'Here is what would change.',
      messageType: 'colleague',
      contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
      visualizationBlocks: [{ type: 'org_chart', title: 'Watches Trend Watcher' }],
      inputTokens: 900,
      outputTokens: 300,
      // The colleague's reply belongs to the turn the person opened, so it is
      // recalled with it rather than as an orphan (migration 547).
      turnId: '00000000-0000-4000-8000-0000000turnid',
    });
    // The turn ends on the colleague's reply: the model is not called again.
    expect(llmStream).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      message: expect.objectContaining({ messageType: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }] }),
    });
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'insights',
      threadId: 'insights-thread-1',
      text: 'Here is what would change.',
    }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      'insights.chat_turn',
      expect.anything(),
      expect.objectContaining({ delegatedTo: 'caio', delegatedToKind: 'caio', inputTokens: 940, outputTokens: 308 }),
    );
  });

  it('writes a status row attributed to the colleague when it pauses, and ends without an error', async () => {
    const WAITING = 'Chief AI Officer is waiting on an approval before it can continue.';
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime([
      { type: 'text_delta', text: 'Pausing it now.' },
      { type: 'paused', reason: WAITING },
    ]));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    const rows = mockAppendMessage.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({ content: 'Pausing it now.', messageType: 'colleague' });
    expect(rows[2]).toEqual({
      threadId: 'insights-thread-1',
      role: 'assistant',
      content: WAITING,
      messageType: 'hitl_status',
      contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
    });
    expect(events.at(-1)).toMatchObject({
      type: 'delegation_paused',
      author: 'caio',
      authorLabel: 'Chief AI Officer',
      delegateThreadId: 'delegate-thread-new',
      reason: WAITING,
      message: expect.objectContaining({ messageType: 'hitl_status' }),
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('persists nothing and reports the failure when the colleague could not answer', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('liftoff')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime([
      { type: 'error', message: 'Liftoff is unavailable.' },
    ]));

    const events = await collectEvents(runInsightsChatTurn(baseInput));

    expect(mockAppendMessage).toHaveBeenCalledTimes(1); // the user row only
    expect(events.at(-1)).toEqual({ type: 'error', code: 'DELEGATION_ERROR', message: 'Liftoff is unavailable.' });
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('the history the model reads', () => {
  it('reads a colleague row in the colleague\'s name, and its own rows as its own', async () => {
    // Observed live: without the speaker, the Insights Manager read the Chief
    // AI Officer's preview as its own work and answered the follow-up with
    // "I presented the change as my own work".
    mockListMessages.mockResolvedValue({
      messages: [
        {
          id: 'u2', threadId: baseInput.threadId, role: 'user', content: 'yes',
          visualizationBlocks: null, inputTokens: 0, outputTokens: 0, messageType: null, contributors: [],
          createdAt: '2026-09-19T11:03:00Z',
        },
        {
          id: 'c1', threadId: baseInput.threadId, role: 'assistant', content: 'Here is what would change.',
          visualizationBlocks: null, inputTokens: 0, outputTokens: 0,
          messageType: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
          createdAt: '2026-09-19T11:02:00Z',
        },
        {
          id: 'a1', threadId: baseInput.threadId, role: 'assistant', content: 'Watches costs the most: $41.20.',
          visualizationBlocks: null, inputTokens: 0, outputTokens: 0, messageType: null, contributors: [],
          createdAt: '2026-09-19T11:01:00Z',
        },
        {
          id: 'u1', threadId: baseInput.threadId, role: 'user', content: baseInput.userMessage,
          visualizationBlocks: null, inputTokens: 0, outputTokens: 0, messageType: null, contributors: [],
          createdAt: '2026-09-19T11:00:00Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    llmStream.mockReturnValue(streamFrom([
      { type: 'text_delta', text: 'ok' },
      { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]));

    await collectEvents(runInsightsChatTurn({ ...baseInput, userMessage: 'yes' }));

    const messages = llmStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    const assistantTurns = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(assistantTurns).toEqual([
      'Watches costs the most: $41.20.',
      'Chief AI Officer: Here is what would change.',
    ]);
  });
});

describe('the brief a colleague forwarded to the Insights Manager', () => {
  it('is read this turn and never stored; the thread keeps one status row attributed to the forwarder', async () => {
    llmStream.mockReturnValue(streamFrom([
      { type: 'text_delta', text: 'Twelve runs.' },
      { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ]));
    const brief = 'Background from Chief AI Officer, which brought you into this conversation. It is not shown to the person: '
      + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.\n\n'
      + 'They are sizing team 122662dd-de4e-4b0d-8873-50cd6a00daaf.';

    await collectEvents(runInsightsChatTurn({
      ...baseInput,
      userMessage: 'how many runs this week',
      forwardedContext: brief,
      forwardedBy: { id: 'caio', label: 'Chief AI Officer' },
      asColleague: true,
    }));

    const rows = mockAppendMessage.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({ role: 'user', content: 'how many runs this week' });
    expect(rows[1]).toEqual({
      threadId: 'insights-thread-1',
      role: 'assistant',
      content: 'Chief AI Officer shared background from the conversation so far',
      messageType: 'forwarded_context',
      contributors: [{ id: 'caio', label: 'Chief AI Officer' }],
    });
    for (const row of rows) {
      expect(String(row.content)).not.toContain('122662dd');
      expect(String(row.content)).not.toContain('Background from');
    }
    const messages = llmStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[messages.length - 1].content.startsWith(brief)).toBe(true);
  });
});
