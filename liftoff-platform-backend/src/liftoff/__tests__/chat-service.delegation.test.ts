// The handover: what happens inside a Liftoff turn once the model calls
// `bring_in_colleague`.
//
// The colleague's runtime is mocked at the DelegateRuntime seam, which is the
// boundary the relay is written against, so one suite covers all three kinds
// without three copies of it. What differs between them (which HTTP call, which
// stop mechanism) is covered by delegation-runtimes and caio-delegation's own
// suites; nothing here touches the network.
//
// The target resolver is mocked too, because these tests are about the relay.
// That resolution reads live data and re-checks it at delegation time is
// delegation-targets' own suite.

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
  getThreadDelegation: jest.fn(),
  pairThreadDelegation: jest.fn(),
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

const mockClaimAbortSignal = jest.fn();
jest.mock('../turn-control', () => ({
  newTurnId: () => '00000000-0000-4000-8000-0000000turnid',
  claimAbortSignal: (...args: unknown[]) => mockClaimAbortSignal(...args),
  claimUserMessageSignal: jest.fn().mockResolvedValue(null),
  frameInterrupt: (i: { text: string }) => `FRAMED: ${i.text}`,
}));

// The tool definitions stay REAL: the loop matches on their names, and a
// hand-copied string here would drift from the one the model is offered.
const mockListDelegationTargets = jest.fn();
const mockResolveDelegationTarget = jest.fn();
jest.mock('../delegation-targets', () => {
  const actual = jest.requireActual('../delegation-targets');
  return {
    ...actual,
    listDelegationTargets: (...args: unknown[]) => mockListDelegationTargets(...args),
    resolveDelegationTarget: (...args: unknown[]) => mockResolveDelegationTarget(...args),
  };
});

const mockCreateDelegateRuntime = jest.fn();
jest.mock('../delegation-runtimes', () => ({
  createDelegateRuntime: (...args: unknown[]) => mockCreateDelegateRuntime(...args),
}));

import { llmClient } from '../../llm';
import {
  appendMessage,
  getThreadDelegation,
  getThreadRollingSummary,
  listMessages,
  pairThreadDelegation,
} from '../chat-repository';
import { logAudit } from '../../infrastructure/logging';
// The colleague's own parser, not a stand-in: a block that reaches the relay
// having already lost its sentence is not a relay bug, and only the real one
// can prove which it is.
import {
  StreamingVisualizationParser,
  parseVisualizationBlocks,
} from '../../insights/visualization-parser';
import { runLiftoffChatTurn, type ChatServiceEvent } from '../chat-service';
import type { DelegatedEvent } from '../delegation-runtimes';
import type { LLMStreamEvent } from '../../llm/types';

const llmStream = llmClient.completeStream as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockGetSummary = getThreadRollingSummary as jest.Mock;
const mockGetThreadDelegation = getThreadDelegation as jest.Mock;
const mockPairThreadDelegation = pairThreadDelegation as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;

const CAIO_TARGET = {
  kind: 'caio' as const,
  id: 'caio',
  label: 'Chief AI Officer',
  description: 'Designs and changes agents.',
};
const INSIGHTS_TARGET = {
  kind: 'insights' as const,
  id: 'insights',
  label: 'Insights Manager',
  description: 'Answers from real workspace data.',
};
const TEAM_TARGET = {
  kind: 'team' as const,
  id: '11111111-2222-3333-4444-555555555555',
  label: 'Payroll Operations',
  description: 'Runs payroll.',
};

/** A caller who is deliberately NOT an owner, so a role that was defaulted or
 *  widened anywhere in the handover shows up as a failure. */
const baseInput = {
  threadId: 'thread-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'member' as const,
  userMessage: 'Build me a team that chases unpaid invoices.',
  callerName: 'Dana Reyes',
};

const stoppableInput = (overrides: Record<string, unknown> = {}) => ({
  ...baseInput,
  turnId: 'turn-1',
  abortController: new AbortController(),
  ...overrides,
});

function streamFrom(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** One model turn that calls bring_in_colleague and nothing else. */
const handoverTurn = (target: string, task = 'Build an invoice chasing team'): LLMStreamEvent[] => [
  {
    type: 'tool_use',
    toolCall: { id: 'call-1', name: 'bring_in_colleague', input: { target, task } },
  },
  { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 40, outputTokens: 8 } },
];

async function collectEvents(iter: AsyncIterable<ChatServiceEvent>): Promise<ChatServiceEvent[]> {
  const out: ChatServiceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Drain microtasks until `predicate` holds, or `ticks` runs out.
 *
 *  The stop test runs on fake timers, and the handover awaits a handful of
 *  mocked round trips before the colleague is reached. Counting ticks by hand
 *  makes the test fail the moment one more await is added; waiting on the
 *  condition does not. */
async function flushUntil(predicate: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks && !predicate(); i++) await Promise.resolve();
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

/** What a team's runtime hands back when a gate stops it mid-turn. */
const WAITING = 'Payroll Operations is waiting on an approval before it can continue.';

const REPLY: DelegatedEvent[] = [
  { type: 'thinking' },
  { type: 'tool_call', tool: 'workforce_plan__draft' },
  { type: 'text_delta', text: 'Here is ' },
  { type: 'text_delta', text: 'the team.' },
  { type: 'content_block', block: { type: 'org_chart', title: 'Invoice chasing' } },
  {
    type: 'complete',
    text: 'Here is the team.',
    blocks: [{ type: 'org_chart', title: 'Invoice chasing' }],
    inputTokens: 900,
    outputTokens: 300,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  llmStream.mockReset();
  mockListMessages.mockResolvedValue({
    messages: [
      {
        id: 'msg-u',
        threadId: 'thread-1',
        role: 'user',
        content: baseInput.userMessage,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: '2026-08-12T11:00:00Z',
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  mockGetSummary.mockResolvedValue(null);
  mockAppendMessage.mockResolvedValue({
    id: 'msg-saved',
    threadId: 'thread-1',
    role: 'assistant',
    content: '',
    attachments: [],
    author: null,
    authorLabel: null,
    visualizationBlocks: [],
    inputTokens: 0,
    outputTokens: 0,
    createdAt: '2026-08-12T12:00:00Z',
  });
  mockClaimAbortSignal.mockResolvedValue(false);
  mockGetThreadDelegation.mockResolvedValue(null);
  mockPairThreadDelegation.mockImplementation(
    async (input: { delegateThreadId: string }) => input.delegateThreadId,
  );
  mockResolveDelegationTarget.mockResolvedValue(CAIO_TARGET);
  mockListDelegationTargets.mockResolvedValue([CAIO_TARGET, INSIGHTS_TARGET, TEAM_TARGET]);
});

describe('the paired thread', () => {
  it('creates it on the first handover and stores the pairing', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(runtime.createThread).toHaveBeenCalledTimes(1);
    expect(mockPairThreadDelegation).toHaveBeenCalledWith({
      threadId: 'thread-1',
      targetKind: 'caio',
      // A singleton colleague carries no target_id; only a team does.
      targetId: null,
      delegateThreadId: 'delegate-thread-new',
    });
    expect(runtime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ delegateThreadId: 'delegate-thread-new' }),
    );
  });

  it('reuses it on a later handover so the colleague keeps its plan', async () => {
    mockGetThreadDelegation.mockResolvedValue({
      targetKind: 'caio',
      targetId: null,
      delegateThreadId: 'delegate-thread-existing',
    });
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(runtime.createThread).not.toHaveBeenCalled();
    expect(mockPairThreadDelegation).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({ delegateThreadId: 'delegate-thread-existing' }),
    );
  });

  it('keys a team pairing on the team id, so two teams do not share one thread', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockGetThreadDelegation).toHaveBeenCalledWith('thread-1', 'team', TEAM_TARGET.id);
    expect(mockPairThreadDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: 'team', targetId: TEAM_TARGET.id }),
    );
  });
});

describe('the caller', () => {
  it.each([
    ['caio', CAIO_TARGET],
    ['insights', INSIGHTS_TARGET],
    ['a team', TEAM_TARGET],
  ])('forwards the real tenant role to %s, never a default', async (_name, target) => {
    mockResolveDelegationTarget.mockResolvedValue(target);
    llmStream.mockReturnValue(streamFrom(handoverTurn(target.id)));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    await collectEvents(runLiftoffChatTurn({ ...baseInput, role: 'viewer' }));

    expect(mockCreateDelegateRuntime).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        tenantId: 'tenant-1',
        accountId: 'account-1',
        role: 'viewer',
        displayName: 'Dana Reyes',
      }),
    );
  });

  // The summary used to be concatenated onto the message and sent as one
  // string, which every colleague then persisted as the USER's row: their
  // thread showed a paragraph the person never wrote, in Liftoff's voice, about
  // them. The two travel apart now, and this asserts the separation rather than
  // the old format.
  it('sends the person\'s message alone, with the brief beside it for the model', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio', 'They want unpaid invoices chased')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runLiftoffChatTurn(baseInput));

    const { content, forwardedContext, forwardedBy } = runtime.runTurn.mock.calls[0][0] as {
      content: string;
      forwardedContext: string | null;
      forwardedBy: { id: string; label: string };
    };
    expect(content).toBe(baseInput.userMessage);
    expect(content).not.toContain('They want unpaid invoices chased');
    expect(forwardedContext).toContain('They want unpaid invoices chased');
    // Framed for the colleague's model: what it is, that the person does not
    // see it, and who wrote it. The colleague persists none of it.
    expect(forwardedContext).toMatch(/^Background from Liftoff, which brought you into this conversation\. It is not shown to the person/);
    expect(forwardedBy).toEqual({ id: 'liftoff', label: 'Liftoff' });
  });

  it('forwards nothing when the summary only repeats the message', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio', baseInput.userMessage)));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await collectEvents(runLiftoffChatTurn(baseInput));

    const { forwardedContext } = runtime.runTurn.mock.calls[0][0] as {
      forwardedContext: string | null;
    };
    // Otherwise the colleague's thread carries a note that adds nothing to it,
    // and the model reads the same sentence twice.
    expect(forwardedContext).toBeNull();
  });
});

describe('the relay', () => {
  it('passes the colleague\'s events through in order', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events.map(e => e.type)).toEqual([
      'thinking', // the Liftoff turn starting
      'tool_call', // bring_in_colleague
      'delegation_started', // who has the floor now
      'thinking', // the colleague starting
      'tool_call', // the colleague's own tool
      // One paragraph, not two deltas: a relayed reply is cut on paragraphs,
      // the same as every other surface streams. It still arrives BEFORE the
      // block it introduces, which is what the flush at a block is for.
      'text_delta',
      'content_block',
      'complete',
    ]);
    expect(events[6]).toEqual({
      type: 'content_block',
      block: { type: 'org_chart', title: 'Invoice chasing' },
    });
  });

  // Attribution while the reply streams. Without it the colleague's name only
  // exists on the persisted message, so on a long answer the person watches an
  // unattributed bubble until the turn is over.
  it('names the colleague before the colleague is even asked', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    // Read one frame at a time rather than collecting: a generator pauses at a
    // yield, so stopping on this frame freezes the world at the instant it
    // reached the stream, which is a stronger claim than "no relayed event came
    // before it in the list".
    const iterator = runLiftoffChatTurn(baseInput)[Symbol.asyncIterator]();
    const events: ChatServiceEvent[] = [];
    let started: ChatServiceEvent | undefined;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      events.push(next.value);
      if (next.value.type === 'delegation_started') {
        started = next.value;
        break;
      }
    }

    // The resolved target, in the words the persisted reply will use: `author`
    // is what the message stores, `authorLabel` what the person reads.
    expect(started).toEqual({
      type: 'delegation_started',
      author: TEAM_TARGET.id,
      authorLabel: 'Payroll Operations',
    });
    expect(runtime.createThread).not.toHaveBeenCalled();
    expect(runtime.runTurn).not.toHaveBeenCalled();

    // Once per handover, not once per relayed event.
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      events.push(next.value);
    }
    expect(events.filter(e => e.type === 'delegation_started')).toHaveLength(1);
  });

  // No closing counterpart exists, and none is wanted: Liftoff never takes the
  // floor back, so the terminal frame ends the delegated segment as well as the
  // turn, and a consumer that drops the attribution there is right to.
  it('runs the handover to the turn\'s own terminal frame', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    const startedAt = events.findIndex(e => e.type === 'delegation_started');
    expect(events.slice(startedAt + 1).map(e => e.type)).toEqual([
      'thinking',
      'tool_call',
      // One paragraph, not two deltas: a relayed reply is cut on paragraphs,
      // the same as every other surface streams. It still arrives BEFORE the
      // block it introduces, which is what the flush at a block is for.
      'text_delta',
      'content_block',
      'complete',
    ]);
  });

  it('persists the reply under the colleague\'s name, with its blocks', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockAppendMessage).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Here is the team.',
      author: TEAM_TARGET.id,
      authorLabel: 'Payroll Operations',
      visualizationBlocks: [{ type: 'org_chart', title: 'Invoice chasing' }],
      inputTokens: 900,
      outputTokens: 300,
      // The colleague's reply belongs to the turn the person opened, so it is
      // recalled with it rather than as an orphan (migration 547).
      turnId: '00000000-0000-4000-8000-0000000turnid',
    });
  });

  // End to end on the shape that actually broke, with nothing hand-written in
  // the middle: the Insights Manager's real reply text goes through its real
  // parser, and what that parser produces is what the fake colleague says. The
  // relay and the persist step are the code under test.
  it('carries an Insights observation into the transcript with its sentence intact', async () => {
    // The exact shape of a persisted reply, `text` field and all. Every
    // observation block either surface writes looks like this.
    const insightsReply = `AI spend is down 39% this week.

\`\`\`visualization
[{ "icon": "!", "text": "The payroll line reports an identical figure for both weeks, which looks like a data issue rather than real spend.", "type": "observation" }]
\`\`\``;

    // The colleague streams from one parser and persists from another, so both
    // are run here and both feed the handover.
    const streamingParser = new StreamingVisualizationParser();
    const streamed = [...streamingParser.feed(insightsReply), ...streamingParser.flush()];
    const { cleanedText, blocks } = parseVisualizationBlocks(insightsReply);

    const delegated: DelegatedEvent[] = [
      ...streamed.map((event): DelegatedEvent =>
        event.type === 'text'
          ? { type: 'text_delta', text: event.content }
          : { type: 'content_block', block: event.blocks[0] },
      ),
      { type: 'complete', text: cleanedText, blocks, inputTokens: 120, outputTokens: 60 },
    ];

    mockResolveDelegationTarget.mockResolvedValue(INSIGHTS_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn('insights')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(delegated));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    // `content` is the field the renderer reads, and the only one it reads.
    const observation = {
      type: 'observation',
      icon: '!',
      content:
        'The payroll line reports an identical figure for both weeks, which looks like a data issue rather than real spend.',
    };

    // What the reader watches arrive.
    expect(
      events.flatMap(e => (e.type === 'content_block' ? [e.block] : [])),
    ).toEqual([observation]);

    // What the reader sees on reload, which is where it was reported from.
    expect(mockAppendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        author: 'insights',
        authorLabel: 'Insights Manager',
        visualizationBlocks: [observation],
      }),
    );
  });

  it('does not let Liftoff speak again after the colleague has', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    // One model call: the one that decided to hand over. No second turn was run
    // with a tool result, which is what would produce a summary of the answer
    // the person has just read.
    expect(llmStream).toHaveBeenCalledTimes(1);
    // Two writes: the user message, and the colleague's reply. Nothing of
    // Liftoff's own.
    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
    expect(mockAppendMessage.mock.calls[1][0].author).toBe('caio');
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1);
  });

  it('keeps a preamble the person already watched arrive', async () => {
    // The prompt asks for no preamble, but text that was streamed must not
    // vanish on reload just because the model wrote some anyway.
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'One moment.' },
        ...handoverTurn('caio'),
      ]),
    );
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockAppendMessage).toHaveBeenCalledTimes(3);
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({
      role: 'assistant',
      content: 'One moment.',
    });
    // Liftoff's own preamble carries no author: it was Liftoff speaking.
    expect(mockAppendMessage.mock.calls[1][0].author).toBeUndefined();
  });

  it('records the handover and the whole turn cost in the audit line', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockLogAudit).toHaveBeenCalledWith(
      'liftoff.chat_turn',
      { tenantId: 'tenant-1', userId: 'account-1' },
      expect.objectContaining({
        delegatedTo: 'caio',
        delegatedToKind: 'caio',
        inputTokens: 940, // 40 deciding + 900 delegated
        outputTokens: 308,
      }),
    );
  });
});

describe('when the colleague cannot answer', () => {
  it('turns its error into one clean Liftoff error event and persists nothing', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(
      fakeRuntime([
        { type: 'text_delta', text: 'Starting.' },
        { type: 'error', message: 'The Chief AI Officer could not be reached just now.' },
      ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events[events.length - 1]).toEqual({
      type: 'error',
      code: 'DELEGATION_ERROR',
      message: 'The Chief AI Officer could not be reached just now.',
    });
    expect(events.filter(e => e.type === 'complete')).toHaveLength(0);
    // The user message only: half an answer is not persisted as if it were one.
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
  });

  it('says so plainly when it is already busy, rather than waiting on a reply that is not coming', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime([{ type: 'busy' }]));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'DELEGATION_ERROR',
      message: expect.stringContaining('Chief AI Officer is still finishing'),
    });
  });

  // A pause is NOT a failure. It used to travel as an `error` frame, and the
  // client read that literally: it put the person's message back in the composer
  // as though the send had failed and toasted a failure over a turn where the
  // message was persisted and the run was still alive.
  it('keeps what a paused colleague said, and then says it is waiting', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockCreateDelegateRuntime.mockReturnValue(
      fakeRuntime([
        { type: 'text_delta', text: 'I have drafted the run.' },
        { type: 'paused', reason: WAITING },
      ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    // What it managed to say, as its own reply, before anything about the wait.
    expect(mockAppendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: 'I have drafted the run.',
        author: TEAM_TARGET.id,
      }),
    );
    expect(events[events.length - 1]).toMatchObject({
      type: 'delegation_paused',
      author: TEAM_TARGET.id,
      authorLabel: TEAM_TARGET.label,
      delegateThreadId: 'delegate-thread-new',
      reason: WAITING,
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  // The frame reaches only the one client whose turn tripped the gate. Without a
  // row in the thread, a reload loses the pause entirely and everyone else on
  // the conversation watches it stop with no explanation.
  it('writes the wait into the thread as a status row, not as speech', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockCreateDelegateRuntime.mockReturnValue(
      fakeRuntime([
        { type: 'text_delta', text: 'I have drafted the run.' },
        { type: 'paused', reason: WAITING },
      ]),
    );

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockAppendMessage).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      role: 'assistant',
      content: WAITING,
      author: TEAM_TARGET.id,
      authorLabel: TEAM_TARGET.label,
      messageType: 'hitl_status',
    });
  });

  // The row is the durable half; a status row that could not be written is not
  // worth failing a turn that has already delivered everything it had.
  it('still reports the pause when the status row cannot be written', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockCreateDelegateRuntime.mockReturnValue(
      fakeRuntime([{ type: 'paused', reason: WAITING }]),
    );
    const persistOk = mockAppendMessage.getMockImplementation();
    mockAppendMessage.mockImplementation(async (input: { messageType?: string }) => {
      if (input.messageType === 'hitl_status') throw new Error('write failed');
      return persistOk ? persistOk(input) : undefined;
    });

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events[events.length - 1]).toMatchObject({
      type: 'delegation_paused',
      message: null,
      reason: WAITING,
    });
  });

  // A pause is a legitimate outcome, so the audit line records it as one rather
  // than as a delegation that failed.
  it('audits a pause without calling it a failure', async () => {
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    llmStream.mockReturnValue(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockCreateDelegateRuntime.mockReturnValue(
      fakeRuntime([{ type: 'paused', reason: WAITING }]),
    );

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockLogAudit).toHaveBeenCalledWith(
      'liftoff.chat_turn',
      expect.anything(),
      expect.objectContaining({ errorCode: 'delegate_paused' }),
    );
  });

  it('cannot open the paired thread, so it says so without inventing a reply', async () => {
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    const runtime = fakeRuntime(REPLY);
    runtime.createThread.mockRejectedValue(new Error('workforce unreachable'));
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(runtime.runTurn).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toMatchObject({
      type: 'error',
      code: 'DELEGATION_ERROR',
      message: expect.stringContaining('Chief AI Officer could not be reached'),
    });
  });
});

describe('a target that no longer resolves', () => {
  it('comes back as an ordinary tool result carrying the live roster', async () => {
    // A team deleted between the model listing it and asking for it. The turn
    // must survive that and let the model explain, not die on a stale id.
    mockResolveDelegationTarget.mockResolvedValue(null);
    llmStream
      .mockReturnValueOnce(streamFrom(handoverTurn('a-team-that-was-just-deleted')))
      .mockReturnValueOnce(
        streamFrom([
          { type: 'text_delta', text: 'That team is gone. The Chief AI Officer can help instead.' },
          {
            type: 'message_complete',
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 12 },
          },
        ]),
      );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockCreateDelegateRuntime).not.toHaveBeenCalled();
    // A second model call happened, carrying the tool result.
    expect(llmStream).toHaveBeenCalledTimes(2);
    const results = llmStream.mock.calls[1][0].messages.at(-1).toolResults;
    expect(results[0].content).toContain('a-team-that-was-just-deleted');
    expect(results[0].content).toContain('Chief AI Officer');
    expect(events[events.length - 1].type).toBe('complete');
    // Nobody took the turn, so nobody is announced. Liftoff answered this one
    // itself and the reply belongs to it.
    expect(events.map(e => e.type)).not.toContain('delegation_started');
  });

  it('answers list_colleagues from live data and carries on', async () => {
    llmStream
      .mockReturnValueOnce(
        streamFrom([
          {
            type: 'tool_use',
            toolCall: { id: 'call-0', name: 'list_colleagues', input: {} },
          },
          {
            type: 'message_complete',
            stopReason: 'tool_use',
            usage: { inputTokens: 20, outputTokens: 4 },
          },
        ]),
      )
      .mockReturnValueOnce(streamFrom(handoverTurn(TEAM_TARGET.id)));
    mockResolveDelegationTarget.mockResolvedValue(TEAM_TARGET);
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime(REPLY));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockListDelegationTargets).toHaveBeenCalledWith('tenant-1');
    const results = llmStream.mock.calls[1][0].messages.at(-1).toolResults;
    expect(results[0].content).toContain('Payroll Operations');
  });
});

describe('stopping a handover', () => {
  it('tells the colleague to stop, and keeps what it had already said', async () => {
    jest.useFakeTimers();
    try {
      const input = stoppableInput();
      llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));

      // The colleague speaks, then waits. While it waits, the stop is claimed on
      // the Liftoff side; the colleague notices through its own control plane
      // and finishes with what it had, exactly as a stopped turn does.
      let release: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runtime = {
        createThread: jest.fn().mockResolvedValue('delegate-thread-new'),
        requestStop: jest.fn().mockResolvedValue(undefined),
        runTurn: jest.fn(() =>
          (async function* (): AsyncGenerator<DelegatedEvent> {
            yield { type: 'text_delta', text: 'Half a ' };
            await waiting;
            yield {
              type: 'complete',
              text: 'Half a plan',
              blocks: null,
              inputTokens: 5,
              outputTokens: 2,
            };
          })(),
        ),
      };
      mockCreateDelegateRuntime.mockReturnValue(runtime);
      mockClaimAbortSignal.mockResolvedValue(true);

      const collecting = collectEvents(runLiftoffChatTurn(input));

      // Let the turn reach the point where the colleague is mid-sentence. The
      // handover awaits several mocked round trips on the way, so this drains
      // microtasks until the colleague has actually started rather than
      // guessing at a number of ticks.
      await flushUntil(() => runtime.runTurn.mock.calls.length > 0);
      await flushUntil(() => false, 20);

      // The stop watcher's poll fires.
      jest.advanceTimersByTime(2_100);
      await flushUntil(() => input.abortController.signal.aborted);

      release();
      const events = await collecting;

      // Terminated, not orphaned: the colleague was told through its own
      // control plane, not merely dropped.
      expect(runtime.requestStop).toHaveBeenCalledWith({
        delegateThreadId: 'delegate-thread-new',
      });
      expect(input.abortController.signal.aborted).toBe(true);
      // What it managed to say is kept, under its own name.
      expect(mockAppendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: 'Half a plan', author: 'caio' }),
      );
      expect(events[events.length - 1].type).toBe('complete');
      expect(mockLogAudit).toHaveBeenCalledWith(
        'liftoff.chat_turn',
        expect.anything(),
        expect.objectContaining({ errorCode: 'user_stopped' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not start a handover at all when the stop was claimed first', async () => {
    const input = stoppableInput();
    input.abortController.abort(new Error('user_stop'));
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    const runtime = fakeRuntime(REPLY);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    const events = await collectEvents(runLiftoffChatTurn(input));

    expect(runtime.runTurn).not.toHaveBeenCalled();
    // Nothing was said, so nothing is invented.
    expect(events[events.length - 1]).toEqual({ type: 'complete', message: null });
  });

  it('stops the colleague and writes nothing when the Liftoff lock is lost', async () => {
    // Aborted with no stop claimed: another turn owns this thread now. The
    // colleague must still be told, or it runs on with nobody reading it.
    const input = stoppableInput();
    llmStream.mockReturnValue(streamFrom(handoverTurn('caio')));
    const runtime = {
      createThread: jest.fn().mockResolvedValue('delegate-thread-new'),
      requestStop: jest.fn().mockResolvedValue(undefined),
      runTurn: jest.fn(() =>
        (async function* (): AsyncGenerator<DelegatedEvent> {
          yield { type: 'text_delta', text: 'Working' };
          input.abortController.abort(new Error('Lock lost'));
          yield { type: 'text_delta', text: ' on it' };
        })(),
      ),
    };
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    const events = await collectEvents(runLiftoffChatTurn(input));

    expect(runtime.requestStop).toHaveBeenCalledTimes(1);
    expect(events[events.length - 1]).toEqual({
      type: 'error',
      code: 'INTERNAL',
      message: 'The response was interrupted. Please try again.',
    });
    expect(mockAppendMessage).toHaveBeenCalledTimes(1); // the user message only
  });
});
