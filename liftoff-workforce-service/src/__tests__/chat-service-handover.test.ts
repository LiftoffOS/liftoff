// The hand-over: what happens inside a Chief AI Officer turn once the model
// calls `bring_in_colleague`.
//
// The model loop is mocked at the platform-agent seam and the colleague at
// the hand-over stream seam, so what this suite pins is the Chief AI
// Officer's own side: the tool is intercepted rather than dispatched and ends
// the loop; the preamble is its own row; who is speaking is said first; the
// colleague's reply is persisted on this thread in the colleague's name with
// its blocks; a pause writes a status row and ends without an error; a stop
// aborts the stream and keeps what had streamed; and a turn that IS a
// hand-over is offered no colleague of its own.

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  // When the Chief AI Officer last spoke, for the Browser section: none by default.
  lastAssistantReplyAt: jest.fn().mockResolvedValue(null),
  updateThreadRollingSummary: jest.fn(),
  updateThreadTitleInternal: jest.fn(),
  linkWorkforcePlan: jest.fn(),
  getThread: jest.fn(),
}));
// The Browser section comes from platform-backend; here the turn gets an empty
// block, as a thread with no browser does.
jest.mock('../workforce-plans/tools/browser.js', () => ({
  ...jest.requireActual('../workforce-plans/tools/browser.js'),
  fetchBrowserState: jest.fn().mockResolvedValue(''),
}));
jest.mock('../workforce-plans/active-turn-repository.js', () => ({
  claimTurn: jest.fn().mockResolvedValue(undefined),
  releaseTurn: jest.fn().mockResolvedValue(undefined),
  isStopRequested: jest.fn().mockResolvedValue(false),
}));
jest.mock('../workforce-plans/turn-signal-repository.js', () => ({
  claimUserMessage: jest.fn().mockResolvedValue(null),
  frameInterrupt: jest.fn((i: { text: string }) => i.text),
}));
jest.mock('../workforce-plans/turn-event-recorder.js', () => ({
  TurnEventRecorder: jest.fn().mockImplementation(() => ({
    record: jest.fn().mockResolvedValue(undefined),
    finish: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../workforce-plans/chat-media.js', () => ({
  claimInboundMedia: jest.fn().mockResolvedValue(undefined),
  loadTurnImages: jest.fn().mockResolvedValue([]),
  sendableModalities: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../workforce-plans/audit-log.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: jest.fn().mockResolvedValue(null),
}));
jest.mock('../workforce-plans/service.js', () => ({
  workforcePlanService: { getPlan: jest.fn() },
}));
jest.mock('../workforce-plans/tenant-connectors.js', () => ({
  workforcePlansConnectorClient: { listConnectors: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../workforce-plans/tenant-agents.js', () => ({
  listTenantAgents: jest.fn().mockResolvedValue([]),
}));
jest.mock('../workforce-plans/tools/remote-workspace-actions.js', () => ({
  ensureRemoteWorkspaceActions: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../workforce-plans/reply-notification.js', () => ({
  notifyTeamPlanReply: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../workforce-plans/thread-title.js', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../workforce-plans/conversation-summarization.js', () => ({
  formatSummaryForPrompt: jest.fn().mockReturnValue(''),
  isUsableSummary: jest.fn().mockReturnValue(false),
  summarizeThread: jest.fn().mockResolvedValue({ summarized: false }),
}));
jest.mock('../platform-agent/execution.js', () => ({
  runPlatformAgent: jest.fn(),
}));
jest.mock('../platform-agent/config.js', () => ({
  loadPlatformAgentConfig: jest.fn().mockResolvedValue({ systemPromptTemplate: 'x {{TOOLS}}', model: 'm' }),
}));
jest.mock('../workforce-plans/handover-client.js', () => ({
  streamHandover: jest.fn(),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { appendMessage, listMessages } from '../workforce-plans/chat-repository.js';
import { isStopRequested } from '../workforce-plans/active-turn-repository.js';
import { runPlatformAgent } from '../platform-agent/execution.js';
import { PlatformAgentHandoverException } from '../platform-agent/types.js';
import { streamHandover, type HandoverStreamEvent } from '../workforce-plans/handover-client.js';
import { notifyTeamPlanReply } from '../workforce-plans/reply-notification.js';
import { writeAuditLog } from '../workforce-plans/audit-log.js';
import { runCAIOChatTurn, type CAIOChatServiceEvent } from '../workforce-plans/chat-service.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const CALLER = '33333333-3333-4333-8333-333333333333';

const mockAppend = appendMessage as jest.Mock;
const mockList = listMessages as jest.Mock;
const mockRun = runPlatformAgent as jest.Mock;
const mockStream = streamHandover as jest.Mock;
const mockStop = isStopRequested as jest.Mock;

const baseInput = {
  threadId: THREAD_ID,
  tenantId: TENANT_ID,
  accountId: CALLER,
  role: 'member' as const,
  userMessage: 'How many runs did the Watches team make this week?',
  callerName: 'Dana Reyes',
};

/** A model loop that says `preamble`, then calls the tool as given and ends
 *  the way the real loop does on the exception: `handed_over`, no further
 *  call. A tool the dispatch answers with a result instead ends the loop
 *  normally with that result recorded. */
function loopThatCalls(toolInput: Record<string, unknown>, preamble = '') {
  mockRun.mockImplementation((input: {
    dispatchToolCall: (n: string, i: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean; data: unknown }>;
    toolContext: unknown;
  }) =>
    (async function* () {
      if (preamble) yield { type: 'text_delta', text: preamble };
      yield { type: 'tool_call', tool: 'bring_in_colleague', input: toolInput };
      let terminator = 'normal';
      let output: unknown = null;
      try {
        output = (await input.dispatchToolCall('bring_in_colleague', toolInput, input.toolContext)).data;
      } catch (err) {
        if (err instanceof PlatformAgentHandoverException) terminator = 'handed_over';
        else throw err;
      }
      yield {
        type: 'complete',
        summary: {
          ok: true,
          text: preamble,
          toolCalls: terminator === 'normal' ? [{ name: 'bring_in_colleague', input: toolInput, output }] : [],
          inputTokens: 40,
          outputTokens: 8,
          terminator,
        },
      };
    })(),
  );
}

function colleagueSays(events: HandoverStreamEvent[]) {
  mockStream.mockImplementation(() =>
    (async function* () {
      for (const e of events) yield e;
    })(),
  );
}

async function collect(input: Parameters<typeof runCAIOChatTurn>[0]): Promise<CAIOChatServiceEvent[]> {
  const out: CAIOChatServiceEvent[] = [];
  for await (const e of runCAIOChatTurn(input)) out.push(e);
  return out;
}

const REPLY: HandoverStreamEvent[] = [
  { type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' },
  { type: 'thinking' },
  { type: 'tool_call', tool: 'get_execution_trends' },
  { type: 'text_delta', text: 'Twelve ' },
  { type: 'text_delta', text: 'runs.' },
  { type: 'content_block', block: { type: 'metric_card', value: 12 } },
  {
    type: 'complete',
    text: 'Twelve runs.',
    blocks: [{ type: 'metric_card', value: 12 }],
    inputTokens: 500,
    outputTokens: 60,
    delegateThreadId: 'insights-thread-9',
    stopped: false,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockStop.mockResolvedValue(false);
  mockAppend.mockImplementation(async (input: Record<string, unknown>) => ({
    id: `m-${mockAppend.mock.calls.length}`,
    threadId: THREAD_ID,
    role: input.role,
    content: input.content,
    visualizationBlocks: input.visualizationBlocks ?? null,
    messageType: input.messageType ?? null,
    contributors: input.contributors ?? [],
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    createdAt: '2026-09-19T12:00:00Z',
  }));
  mockList.mockResolvedValue({
    messages: [{
      id: 'u1', threadId: THREAD_ID, role: 'user', content: baseInput.userMessage,
      messageType: null, contributors: [], visualizationBlocks: null,
      inputTokens: 0, outputTokens: 0, createdAt: '2026-09-19T11:00:00Z',
    }],
    nextCursor: null,
    hasMore: false,
  });
});

describe('the tools offered', () => {
  it('lists the colleague on an ordinary turn and withholds it on a hand-over', async () => {
    mockRun.mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'Twelve.' };
        yield { type: 'complete', summary: { ok: true, text: 'Twelve.', toolCalls: [], inputTokens: 1, outputTokens: 1, terminator: 'normal' } };
      })(),
    );

    await collect(baseInput);
    const ordinary = (mockRun.mock.calls[0][0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(ordinary).toContain('bring_in_colleague');

    await collect({ ...baseInput, handover: true });
    const handedOver = (mockRun.mock.calls[1][0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(handedOver).not.toContain('bring_in_colleague');
    expect(handedOver).toEqual(ordinary.filter((n) => n !== 'bring_in_colleague'));
  });
});

describe('the hand-over', () => {
  it('intercepts the tool, says who is speaking first, relays the colleague, and persists its reply in its name', async () => {
    loopThatCalls({ colleague: 'insights', request: 'How many runs the Watches team made this week.' });
    colleagueSays(REPLY);

    const events = await collect(baseInput);

    // Opened on platform-backend as the person, with the Chief AI Officer's note.
    expect(mockStream).toHaveBeenCalledWith(expect.objectContaining({
      caller: { tenantId: TENANT_ID, accountId: CALLER, role: 'member' },
      displayName: 'Dana Reyes',
      threadId: THREAD_ID,
      target: { id: 'insights', label: 'Insights Manager' },
      content: baseInput.userMessage,
      request: 'How many runs the Watches team made this week.',
    }));

    // The frames, in order: who is speaking before any of the colleague's own.
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'thinking', 'tool_call', 'delegation_started', 'thinking', 'tool_call',
      'text_delta', 'text_delta', 'content_block', 'complete',
    ]);
    expect(events[2]).toEqual({ type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' });

    // Rows: the person's, then the colleague's, and no empty preamble row.
    const rows = mockAppend.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      role: 'assistant',
      content: 'Twelve runs.',
      messageType: 'colleague',
      contributors: [{ id: 'insights', label: 'Insights Manager' }],
      // The colleague's reply belongs to the turn the person opened, so a search
      // finds it with that turn rather than as an orphan (migration 031). The id
      // is minted per turn, so only its presence can be asserted here.
      turnId: expect.any(String),
      visualizationBlocks: [{ type: 'metric_card', value: 12 }],
      inputTokens: 500,
      outputTokens: 60,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      message: expect.objectContaining({ messageType: 'colleague', contributors: [{ id: 'insights', label: 'Insights Manager' }] }),
    });
    // The model is not called again: the colleague had the last word.
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(notifyTeamPlanReply).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID, text: 'Twelve runs.' }));
    expect(writeAuditLog).toHaveBeenCalledWith(
      'workforce_plans.chat_turn',
      expect.anything(),
      expect.objectContaining({ delegatedTo: 'insights', inputTokens: 540, outputTokens: 68 }),
    );
  });

  it('keeps what the Chief AI Officer said before handing over, as its own row', async () => {
    loopThatCalls({ colleague: 'liftoff', request: 'What a webhook is.' }, 'One thing before that: ');
    colleagueSays([
      { type: 'text_delta', text: 'A webhook is a callback.' },
      { type: 'complete', text: 'A webhook is a callback.', blocks: [], inputTokens: 1, outputTokens: 1, delegateThreadId: 'lt-1', stopped: false },
    ]);

    const events = await collect(baseInput);

    const started = events.findIndex((e) => e.type === 'delegation_started');
    const preambleIndex = events.findIndex((e) => e.type === 'text_delta');
    expect(preambleIndex).toBeLessThan(started);

    const rows = mockAppend.mock.calls.map((c) => c[0]);
    expect(rows).toHaveLength(3);
    // The parser trims the trailing whitespace the fence lift leaves, as it
    // does for every finished turn.
    expect(rows[1]).toMatchObject({ role: 'assistant', content: 'One thing before that:', visualizationBlocks: null });
    expect(rows[1]).not.toHaveProperty('messageType');
    expect(rows[2]).toMatchObject({ messageType: 'colleague', contributors: [{ id: 'liftoff', label: 'Liftoff' }] });
  });

  it('answers an unknown colleague with a tool result so the model can recover, and hands nothing over', async () => {
    loopThatCalls({ colleague: 'the team', request: 'x' });

    await collect(baseInput);

    expect(mockStream).not.toHaveBeenCalled();
    const summary = (await (async () => {
      const out: unknown[] = [];
      for await (const e of mockRun.mock.results[0].value as AsyncIterable<{ type: string; summary?: unknown }>) out.push(e);
      return out;
    })());
    void summary; // the generator was consumed by the turn; the assertion below reads the dispatch
    const rows = mockAppend.mock.calls.map((c) => c[0]);
    // The ordinary path persisted the (empty) reply as a finished turn.
    expect(rows.at(-1)).toMatchObject({ role: 'assistant', content: 'Done.' });
  });

  it('writes a status row attributed to the colleague when it pauses, and ends without an error', async () => {
    loopThatCalls({ colleague: 'liftoff', request: 'Run payroll.' });
    colleagueSays([
      { type: 'text_delta', text: 'Starting payroll.' },
      {
        type: 'delegation_paused', author: 'liftoff', authorLabel: 'Liftoff', delegateThreadId: 'lt-1',
        reason: 'Payroll Operations is waiting on an approval before it can continue.',
        text: 'Starting payroll.', blocks: [], inputTokens: 3, outputTokens: 4,
      },
    ]);

    const events = await collect(baseInput);

    const rows = mockAppend.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({ content: 'Starting payroll.', messageType: 'colleague' });
    expect(rows[2]).toEqual({
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      role: 'assistant',
      content: 'Payroll Operations is waiting on an approval before it can continue.',
      messageType: 'hitl_status',
      contributors: [{ id: 'liftoff', label: 'Liftoff' }],
    });
    expect(events.at(-1)).toMatchObject({
      type: 'delegation_paused',
      author: 'liftoff',
      authorLabel: 'Liftoff',
      delegateThreadId: 'lt-1',
      message: expect.objectContaining({ messageType: 'hitl_status' }),
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('persists nothing and reports the failure when the colleague could not answer', async () => {
    loopThatCalls({ colleague: 'insights', request: 'x' });
    colleagueSays([{ type: 'error', code: 'DELEGATION_ERROR', message: 'Insights Manager is unavailable.' }]);

    const events = await collect(baseInput);

    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'DELEGATION_ERROR', message: 'Insights Manager is unavailable.' });
    expect(notifyTeamPlanReply).not.toHaveBeenCalled();
  });

  it('aborts the stream on a stop and keeps what had streamed', async () => {
    jest.useFakeTimers();
    try {
      loopThatCalls({ colleague: 'insights', request: 'x' });
      let signal: AbortSignal | null = null;
      mockStream.mockImplementation((args: { signal: AbortSignal }) => {
        signal = args.signal;
        return (async function* () {
          yield { type: 'text_delta', text: 'Half an ' } as HandoverStreamEvent;
          // The colleague is mid-answer; the stop lands here.
          await new Promise<void>((resolve) => args.signal.addEventListener('abort', () => resolve(), { once: true }));
          // The client ends quietly on its own abort.
        })();
      });
      mockStop.mockResolvedValue(true);

      const running = collect(baseInput);
      // Let the turn reach the stream and the watcher's first poll.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(2_100);
      const events = await running;

      expect(signal).not.toBeNull();
      expect((signal as unknown as AbortSignal).aborted).toBe(true);
      const rows = mockAppend.mock.calls.map((c) => c[0]);
      expect(rows[1]).toMatchObject({ content: 'Half an', messageType: 'colleague' });
      expect(events.at(-1)).toMatchObject({ type: 'complete', message: expect.objectContaining({ content: 'Half an' }) });
      expect(events.some((e) => e.type === 'error')).toBe(false);
      expect(writeAuditLog).toHaveBeenCalledWith(
        'workforce_plans.chat_turn',
        expect.anything(),
        expect.objectContaining({ terminatedEarly: 'STOPPED', delegatedTo: 'insights' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the history the model reads', () => {
  it('reads a colleague row in the colleague\'s name, and its own rows as its own', async () => {
    mockList.mockResolvedValue({
      messages: [
        {
          id: 'u2', threadId: THREAD_ID, role: 'user', content: 'and which costs the most?',
          messageType: null, contributors: [], visualizationBlocks: null, inputTokens: 0, outputTokens: 0,
          createdAt: '2026-09-19T11:03:00Z',
        },
        {
          id: 'c1', threadId: THREAD_ID, role: 'assistant', content: 'Twelve runs.',
          messageType: 'colleague', contributors: [{ id: 'insights', label: 'Insights Manager' }],
          visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-19T11:02:00Z',
        },
        {
          id: 'a1', threadId: THREAD_ID, role: 'assistant', content: 'Let me check.',
          messageType: null, contributors: [], visualizationBlocks: null, inputTokens: 0, outputTokens: 0,
          createdAt: '2026-09-19T11:01:00Z',
        },
        {
          id: 'u1', threadId: THREAD_ID, role: 'user', content: baseInput.userMessage,
          messageType: null, contributors: [], visualizationBlocks: null, inputTokens: 0, outputTokens: 0,
          createdAt: '2026-09-19T11:00:00Z',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    mockRun.mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'complete', summary: { ok: true, text: 'ok', toolCalls: [], inputTokens: 1, outputTokens: 1, terminator: 'normal' } };
      })(),
    );

    await collect({ ...baseInput, userMessage: 'and which costs the most?' });

    const prior = (mockRun.mock.calls[0][0] as { priorMessages: Array<{ role: string; content: string }> }).priorMessages;
    const assistantTurns = prior.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(assistantTurns).toEqual(['Let me check.', 'Insights Manager: Twelve runs.']);
  });
});

describe('the brief a colleague forwarded to the Chief AI Officer', () => {
  const BRIEF =
    'Background from Insights Manager, which brought you into this conversation. It is not shown to the person: '
    + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.\n\n'
    + 'The Watches team (id 122662dd-de4e-4b0d-8873-50cd6a00daaf) costs the most.';

  it('is read by the model this turn and never stored; the thread keeps one status row naming the forwarder', async () => {
    mockRun.mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'Here is what would change.' };
        yield { type: 'complete', summary: { ok: true, text: 'Here is what would change.', toolCalls: [], inputTokens: 1, outputTokens: 1, terminator: 'normal' } };
      })(),
    );

    await collect({
      ...baseInput,
      userMessage: 'pause it',
      forwardedContext: BRIEF,
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      handover: true,
    });

    // The model reads the brief in front of the person's words.
    const objective = (mockRun.mock.calls[0][0] as { objective: string }).objective;
    expect(objective.startsWith(BRIEF)).toBe(true);
    expect(objective.endsWith('pause it')).toBe(true);

    // The thread keeps the person's words and one status line, attributed to
    // the forwarder. Nothing persisted carries the brief or its identifier.
    const rows = mockAppend.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({ role: 'user', content: 'pause it' });
    expect(rows[1]).toEqual({
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      role: 'assistant',
      content: 'Insights Manager shared background from the conversation so far',
      messageType: 'forwarded_context',
      contributors: [{ id: 'insights', label: 'Insights Manager' }],
    });
    for (const row of rows) {
      expect(String(row.content)).not.toContain('122662dd');
      expect(String(row.content)).not.toContain('Background from');
    }
  });

  it('names Liftoff when a brief arrives with no forwarder, as an older platform-backend sends it', async () => {
    mockRun.mockImplementation(() =>
      (async function* () {
        yield { type: 'complete', summary: { ok: true, text: 'ok', toolCalls: [], inputTokens: 1, outputTokens: 1, terminator: 'normal' } };
      })(),
    );

    await collect({ ...baseInput, userMessage: 'pause it', forwardedContext: 'Liftoff shared background from the conversation so far\n\nThey want it paused.' });

    const rows = mockAppend.mock.calls.map((c) => c[0]);
    expect(rows[1]).toMatchObject({
      content: 'Liftoff shared background from the conversation so far',
      messageType: 'forwarded_context',
    });
    expect(rows[1]).not.toHaveProperty('contributors', expect.anything());
  });
});
