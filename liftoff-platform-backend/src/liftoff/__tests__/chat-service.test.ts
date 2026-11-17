// Liftoff chat service turn-loop tests.
//
// Mocks the LLM client, the chat repository, summarization, title generation
// and audit logging, so the loop's branches are exercised without a database,
// a provider, or a real prompt budget being anything other than arithmetic.
//
// The context budget and the system prompt builder are left REAL: both are pure
// functions, and they are the only way to check that what the loop assembles is
// what actually reaches the model.

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
  // Return a resolved promise: the production call site awaits it.
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

// The conversation's datasets, listed at turn start for the inventory: none
// by default, as a thread that has fetched nothing.
const mockListDatasets = jest.fn(async () => []);
// The store a result is parked in when it is larger than one message. Null by
// default, which is the failure path: a test that wants a park sets a row.
const mockCreateDataset = jest.fn(async () => null);
jest.mock('../../datasets/store', () => ({
  ...jest.requireActual('../../datasets/store'),
  listDatasets: (...args: unknown[]) => mockListDatasets(...(args as [])),
  createDataset: (...args: unknown[]) => mockCreateDataset(...(args as [])),
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

// The workspace-action registry, reduced to one tool with the real role rule:
// review_decide is member and above. The base tool list below stays what it
// was; the workspace tools are asserted on their own.
const mockDispatchWorkspaceAction = jest.fn();
const REVIEW_DECIDE_DEF = { name: 'review_decide', description: 'Approve or reject a review', input_schema: { type: 'object', properties: {} } };
jest.mock('../../workspace-actions/tools', () => ({
  toolsForActor: (actor: { role: string }) => (actor.role === 'viewer' ? [] : [{ definition: REVIEW_DECIDE_DEF, permission: 'hitl:approve_level_2' }]),
  isWorkspaceActionTool: (name: string) => name === 'review_decide',
  dispatchWorkspaceAction: (...args: unknown[]) => mockDispatchWorkspaceAction(...args),
}));

// The browser tools and the legacy trail writer: the chat service writes its
// own row ONLY when the runtime did not record the call, under the call's id.
const mockExecuteBrowserDetailed = jest.fn();
jest.mock('../../browser-sessions/assistant-tools', () => ({
  ...jest.requireActual('../../browser-sessions/assistant-tools'),
  executeBrowserAssistantToolDetailed: (...args: unknown[]) => mockExecuteBrowserDetailed(...args),
}));
const mockRecordBrowserActivity = jest.fn(async () => undefined);
jest.mock('../browser-activity', () => ({
  ...jest.requireActual('../browser-activity'),
  recordBrowserActivity: (...args: unknown[]) => mockRecordBrowserActivity(...(args as [])),
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
import {
  appendMessage,
  getThreadRollingSummary,
  listMessages,
  updateThreadRollingSummary,
} from '../chat-repository';
import {
  generateRollingSummary,
  shouldSummarize,
} from '../../insights/conversation-summarization';
import { logAudit } from '../../infrastructure/logging';
import { maybeGenerateThreadTitle } from '../../shared/thread-title-generation';
import {
  composeTurnText,
  describeAttachment,
  runLiftoffChatTurn,
  type ChatServiceEvent,
} from '../chat-service';
import type { LLMStreamEvent } from '../../llm/types';
import { buildAssistantBrowserState } from '../../browser-sessions/browser-state';
import { lastAssistantReplyAt } from '../chat-repository';
import { BROWSER_HANDBACK_TURN_TEXT, BROWSER_POINT_TURN_TEXT } from '@liftoffos/browser-record';

const llmStream = llmClient.completeStream as jest.Mock;
const mockAppendMessage = appendMessage as jest.Mock;
const mockListMessages = listMessages as jest.Mock;
const mockGetSummary = getThreadRollingSummary as jest.Mock;
const mockUpdateSummary = updateThreadRollingSummary as jest.Mock;
const mockShouldSummarize = shouldSummarize as jest.Mock;
const mockGenerateSummary = generateRollingSummary as jest.Mock;
const mockLogAudit = logAudit as jest.Mock;
const mockMaybeGenerateTitle = maybeGenerateThreadTitle as jest.Mock;

const TURN_ID = 'turn-1';

const baseInput = {
  threadId: 'thread-1',
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner' as const,
  userMessage: 'Can you tighten this paragraph?',
};

/** The same input, plus the lock state that makes mid-run control live. */
const stoppableInput = (overrides = {}) => ({
  ...baseInput,
  turnId: TURN_ID,
  abortController: new AbortController(),
  ...overrides,
});

const fakeSavedMessage = {
  id: 'msg-assistant',
  threadId: 'thread-1',
  role: 'assistant' as const,
  content: '',
  inputTokens: 0,
  outputTokens: 0,
  createdAt: '2026-08-08T12:00:00Z',
};

/** Build a mock LLMStreamEvent async iterable from a list of events. */
function streamFrom(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
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

/** Consume an entire ChatServiceEvent stream and collect the events. */
async function collectEvents(
  iter: AsyncIterable<ChatServiceEvent>,
): Promise<ChatServiceEvent[]> {
  const out: ChatServiceEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** The messages array handed to the Nth model call (1-based). */
function conversationForCall(n: number): Array<{ role: string; content: string }> {
  return llmStream.mock.calls[n - 1][0].messages;
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks does not drain queued mockReturnValueOnce implementations, so
  // a test that stops the loop early would otherwise leave its unused turn
  // behind for the next one to consume.
  llmStream.mockReset();
  mockListMessages.mockResolvedValue({
    messages: [
      // Newest-first: the user message the turn just appended.
      {
        id: 'msg-u',
        threadId: 'thread-1',
        role: 'user',
        content: 'Can you tighten this paragraph?',
        inputTokens: 0,
        outputTokens: 0,
        createdAt: '2026-08-08T11:00:00Z',
      },
    ],
    nextCursor: null,
    hasMore: false,
  });
  mockGetSummary.mockResolvedValue(null);
  mockAppendMessage
    .mockResolvedValueOnce({ id: 'msg-user', threadId: 'thread-1', role: 'user' })
    .mockResolvedValue(fakeSavedMessage);
  mockShouldSummarize.mockReturnValue(false);
  mockMaybeGenerateTitle.mockResolvedValue(undefined);
  mockClaimAbortSignal.mockResolvedValue(false);
  mockClaimUserMessageSignal.mockResolvedValue(null);
  mockEnqueueContinuation.mockReset();
  mockEnqueueContinuation.mockResolvedValue({ id: 'cont-1', ordinal: 1 });
  mockEnqueueContinuationTask.mockClear();
  mockGuard.mockClear();
});

describe('runLiftoffChatTurn / basic flow', () => {
  it('yields thinking, then text deltas, then complete for a plain answer', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Try ' },
        { type: 'text_delta', text: 'this: ' },
        { type: 'text_delta', text: 'cut the first clause.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10 } },
      ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    const types = events.map(e => e.type);
    expect(types[0]).toBe('thinking');
    expect(types[types.length - 1]).toBe('complete');
    const deltas = events
      .filter(e => e.type === 'text_delta')
      .map(e => (e.type === 'text_delta' ? e.text : ''));
    expect(deltas.join('')).toBe('Try this: cut the first clause.');
    // Liftoff is speaking, so nobody else is announced. A frame here would put
    // somebody else's name on Liftoff's own answer.
    expect(types).not.toContain('delegation_started');
  });

  it('never emits a content_block event: this surface answers in plain text', async () => {
    // The insights chat parses fenced visualization blocks out of the reply.
    // Liftoff does not, so a fence in the text is just text and the charts stay
    // with the surface that has the data tools.
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Here is a table:\n\n```visualization\n[]\n```\n' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 8 } },
      ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events.map(e => e.type)).not.toContain('content_block');
    // The fence survives verbatim into the persisted reply rather than being
    // stripped by a parser this module does not have.
    expect(mockAppendMessage.mock.calls[1][0].content).toContain('```visualization');
  });

  it('persists the user message first, then the assistant message with its usage', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Done.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 5 } },
      ]),
    );

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockAppendMessage).toHaveBeenCalledTimes(2);
    // First call: the user message, persisted before the model is asked
    // anything, so a crashed turn still leaves a record of the question.
    expect(mockAppendMessage.mock.calls[0][0]).toMatchObject({
      threadId: 'thread-1',
      role: 'user',
      content: 'Can you tighten this paragraph?',
    });
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Done.',
      inputTokens: 30,
      outputTokens: 5,
    });
  });

  it('writes a liftoff.chat_turn audit entry with lengths, never content', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('Short reply.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockLogAudit).toHaveBeenCalledWith(
      'liftoff.chat_turn',
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'account-1' }),
      expect.objectContaining({
        threadId: 'thread-1',
        iterations: 1,
        inputTokens: 10,
        outputTokens: 5,
        userMessageLength: 'Can you tighten this paragraph?'.length,
        assistantMessageLength: 'Short reply.'.length,
      }),
    );
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(JSON.stringify(details)).not.toContain('tighten this paragraph');
  });

  it('tags its spend liftoff_chat so it never lands in the insights bucket', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ tenantId: 'tenant-1', purpose: 'liftoff_chat' }),
    );
  });
});

describe('runLiftoffChatTurn / the turn loop', () => {
  it('completes in a single model call when the model asks for no tools', async () => {
    // The delegation tools and the browser are offered on every turn, but a
    // question Liftoff can answer itself makes no tool round trip: the first
    // end_turn is the answer.
    llmStream.mockReturnValue(streamFrom(textTurn('Cut the first clause.')));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(1);
    expect(llmStream.mock.calls[0][0].tools.map((t: { name: string }) => t.name)).toEqual([
      'list_colleagues',
      'bring_in_colleague',
      // Capability discovery over the platform's curated surface, plus
      // execution of one capability through the guarded dispatch path. The
      // model sees capabilities, never vendors: run takes an opaque
      // capabilityId. Offered unconditionally like the browser tools below —
      // the dispatch itself refuses with a reason when a vendor is
      // unprovisioned, unclassified, or gated.
      'capability_search',
      'run_capability',
      // A large result is parked as a dataset for the conversation; these
      // read it back, only what is asked for.
      'dataset_query',
      'dataset_extract',
      'dataset_list',
      // Showing a file already in the workspace. Beside the dataset tools
      // because it is intercepted the same way and for the same reason.
      'show_file',
      // What the person is working towards, held across conversations. These
      // do no work: a goal is what is remembered, not work in progress.
      'track_goal',
      'finish_goal',
      // Starting something slow without waiting for it, so one long job does
      // not hold the whole conversation.
      'work_on_this_in_the_background',
      // Reading further back in this conversation than the recent window
      // shows. Offered to every turn: the person is in the thread and their
      // own client already renders the whole scrollback.
      'read_conversation_history',
      // Searching the person's OTHER conversations with Liftoff, scoped to the
      // turns they spoke in.
      'recall_conversations',
      // Offered unconditionally, the way web search is: the browser is a
      // capability the product has, not one the workspace brought. Whether one
      // can actually be opened is the runtime's decision and it says so in the
      // tool result, so gating here as well would mean two copies of that
      // decision.
      'navigate_browser_session',
      'run_browser_task',
      // Collecting a task that outlived the turn that started it.
      'check_browser_task',
      'start_browser_session',
      'read_active_browser_session',
      // The record, the page's controls, one action on one control, and the
      // ask for the person to take over: the runtime's definitions, by name.
      'read_browser_session_activity',
      'read_browser_session_controls',
      'act_in_browser_session',
      'ask_person_to_take_over_browser_session',
      // Taking a picture of the page, and showing it when asked to.
      'screenshot_browser_session',
      // The files the browser downloaded, and bringing one of them, or
      // anything the page points at, into the conversation.
      'list_browser_downloads',
      'fetch_browser_download',
      // The workspace-action tools this person's role permits, listed after
      // the built-ins.
      'review_decide',
    ]);
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0);
    expect(events[events.length - 1].type).toBe('complete');
  });

  it('offers a turn a colleague handed over everything but a colleague of its own', async () => {
    // Depth one, and the roster that exists only to choose a colleague goes
    // with it. The person is present, so the browser, the capabilities and the
    // workspace actions stay.
    llmStream.mockReturnValue(streamFrom(textTurn('Here you go.')));

    await collectEvents(runLiftoffChatTurn({ ...baseInput, asColleague: true }));

    const offered = llmStream.mock.calls[0][0].tools.map((t: { name: string }) => t.name);
    expect(offered).not.toContain('list_colleagues');
    expect(offered).not.toContain('bring_in_colleague');
    expect(offered).toEqual(expect.arrayContaining([
      'capability_search', 'run_capability', 'start_browser_session', 'review_decide',
    ]));
  });

  it('keeps one status row for the brief a colleague forwarded, in that colleague\'s name, and reads the brief once', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('A webhook is a callback.')));
    const brief = 'Background from Insights Manager, which brought you into this conversation. It is not shown to the person: '
      + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.\n\n'
      + 'They were looking at webhook failures for team 122662dd-de4e-4b0d-8873-50cd6a00daaf.';

    await collectEvents(runLiftoffChatTurn({
      ...baseInput,
      userMessage: 'what is a webhook',
      forwardedContext: brief,
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      asColleague: true,
    }));

    // Rows: the person's words, then one status line authored by the
    // colleague that brought Liftoff in, then Liftoff's reply. The brief and
    // its identifier are in no row.
    const rows = mockAppendMessage.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({ role: 'user', content: 'what is a webhook' });
    expect(rows[1]).toEqual({
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Insights Manager shared background from the conversation so far',
      messageType: 'forwarded_context',
      author: 'insights',
      authorLabel: 'Insights Manager',
    });
    for (const row of rows) {
      expect(String(row.content)).not.toContain('122662dd');
      expect(String(row.content)).not.toContain('Background from');
    }
    // The model reads the brief in front of the person's words, once.
    const messages = llmStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    const current = messages[messages.length - 1];
    expect(current.role).toBe('user');
    expect(current.content.startsWith(brief)).toBe(true);
    expect(current.content).toContain('what is a webhook');
    expect(messages.filter((m) => m.content.includes('Background from'))).toHaveLength(1);
  });

  it('dispatches a workspace-action tool with the actor: this person, this role, this surface', async () => {
    mockDispatchWorkspaceAction.mockResolvedValue('{"decided":"approved"}');
    llmStream
      .mockReturnValueOnce(streamFrom([
        { type: 'tool_use', toolCall: { id: 'call-9', name: 'review_decide', input: { approvalId: 'a-1', decision: 'approve' } } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
      ]))
      .mockReturnValueOnce(streamFrom(textTurn('Approved.')));

    const events = await collectEvents(runLiftoffChatTurn({
      ...baseInput,
      role: 'member',
      callerName: 'Ada',
      origin: { via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1' },
    }));

    expect(events).toContainEqual({ type: 'tool_call', tool: 'review_decide' });
    expect(mockDispatchWorkspaceAction).toHaveBeenCalledWith(
      'review_decide',
      { approvalId: 'a-1', decision: 'approve' },
      {
        tenantId: 'tenant-1', accountId: 'account-1', role: 'member', displayName: 'Ada', surface: 'liftoff',
        via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1',
      },
    );
    const second = llmStream.mock.calls[1][0];
    const toolResultTurn = second.messages[second.messages.length - 1];
    expect(toolResultTurn.toolResults[0]).toEqual({ toolCallId: 'call-9', content: '{"decided":"approved"}' });
  });

  it('lists no workspace-action tool for a viewer', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('Sure.')));
    await collectEvents(runLiftoffChatTurn({ ...baseInput, role: 'viewer' }));
    const names = llmStream.mock.calls[0][0].tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('review_decide');
  });

  it('tells the model the tool does not exist rather than leaving it waiting', async () => {
    // Only reachable if a provider echoes a tool call at a surface with none
    // registered. Answering the call is what lets the next turn finish.
    llmStream
      .mockReturnValueOnce(streamFrom(toolTurn()))
      .mockReturnValueOnce(streamFrom(textTurn('I cannot look that up here.')));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events).toContainEqual({ type: 'tool_call', tool: 'get_agent_performance' });
    const second = llmStream.mock.calls[1][0];
    const toolResultTurn = second.messages[second.messages.length - 1];
    expect(toolResultTurn.role).toBe('user');
    expect(toolResultTurn.toolResults[0].toolCallId).toBe('call-1');
    expect(toolResultTurn.toolResults[0].content).toContain('is not available here');
  });

  it('closes the reply with one tool-less call after MAX_ITERATIONS, rather than leaving with the results unread', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none' ? textTurn('Here is what I found so far.') : toolTurn()),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    // Fifty rounds of tools, then the closing call.
    expect(llmStream).toHaveBeenCalledTimes(51);
    const closing = llmStream.mock.calls[50][0];
    expect(closing.toolChoice).toBe('none');
    expect(closing.tools.length).toBeGreaterThan(0);
    expect(closing.serverTools).toEqual([]);
    const lastUser = closing.messages[closing.messages.length - 1];
    expect(lastUser).toMatchObject({ role: 'user', content: expect.stringMatching(/^You must write the reply now, without calling a tool\./) });
    // The note names no mechanic for the model to relay, and asks for the
    // verdict line the loop reads.
    expect(lastUser.content).toContain('do not mention limits, budgets or rounds');
    expect(lastUser.content).toContain('[continue]');
    expect(lastUser.content).toContain('[done]');
    // The round before it carried the last tool results, so nothing is unread.
    expect(closing.messages[closing.messages.length - 2]).toMatchObject({ role: 'user', toolResults: [expect.objectContaining({ toolCallId: 'call-1' })] });
    expect(events[events.length - 1].type).toBe('complete');
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Here is what I found so far.' });
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ iterations: 51, terminatedEarly: 'MAX_ITERATIONS' });
  });

  it('a call whose prompt is past seven tenths of the window closes the reply: tools answered "not run", one tool-less call writes the answer', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? textTurn('Here is what I have.')
        : [
          { type: 'text_delta', text: 'Reading on. ' },
          { type: 'tool_use', toolCall: { id: 'call-1', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', model: 'claude-x', usage: { inputTokens: 150_000, outputTokens: 2_000, contextTokens: 150_000 } },
        ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(2);
    const closing = llmStream.mock.calls[1][0];
    expect(closing.toolChoice).toBe('none');
    const results = closing.messages[closing.messages.length - 2];
    expect(results.toolResults).toEqual([{ toolCallId: 'call-1', content: JSON.stringify({ error: 'Not run: answer now from what you have.' }) }]);
    expect(closing.messages[closing.messages.length - 1]).toMatchObject({ role: 'user', content: expect.stringMatching(/^You must write the reply now, without calling a tool\./) });
    expect(events[events.length - 1].type).toBe('complete');
    // The narration and the closing reply are two messages, so a blank line
    // between them. This asserted 'Reading on. Here is what I have.' while
    // people were served exactly that.
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Reading on. \n\nHere is what I have.' });
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ terminatedEarly: 'CONTEXT_FULL' });
    // The window was read for the model the call reported, on the provider
    // the turn resolves.
    // The RECORDED window, not the one with the fallback already folded in:
    // the shared bound policy needs to tell "this model holds 1M" from
    // "nobody sized it", and only the first may ever drive a destructive
    // decision.
    expect((llmClient.recordedContextWindowFor as jest.Mock)).toHaveBeenCalledWith('anthropic', 'claude-x');
  });

  it('the guard is on the prompt each call carried, never on a sum across calls: thirty rounds of a 14k context do not trip it', async () => {
    let rounds = 0;
    llmStream.mockImplementation((req: { toolChoice?: string }) => {
      if (req.toolChoice === 'none') return streamFrom(textTurn('should not be closed by the guard'));
      rounds++;
      if (rounds > 30) return streamFrom(textTurn('Done after thirty rounds.'));
      return streamFrom([
        { type: 'tool_use', toolCall: { id: `call-${rounds}`, name: 'get_agent_performance', input: {} } },
        { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 14_000, outputTokens: 300, contextTokens: 14_000 } },
      ]);
    });

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    // Thirty rounds of tools (420k cumulative, which the old cap would have
    // stopped at seven) and the answer, with no closing call.
    expect(llmStream).toHaveBeenCalledTimes(31);
    expect(llmStream.mock.calls.every((c) => c[0].toolChoice !== 'none')).toBe(true);
    expect(events[events.length - 1].type).toBe('complete');
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Done after thirty rounds.' });
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ iterations: 31, terminatedEarly: null });
  });

  it('an Anthropic call of 20k uncached and 140k read from the cache trips the guard: the context is what the adapter counted, not the uncached part', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? textTurn('Closing.')
        : [
          { type: 'tool_use', toolCall: { id: 'call-1', name: 'get_agent_performance', input: {} } },
          // What the Anthropic adapter reports: the uncached input alone would
          // read as a tenth of the window; the prompt the model read was 160k.
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 140_000, contextTokens: 160_000 } },
        ]),
    );

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(2);
    expect(llmStream.mock.calls[1][0].toolChoice).toBe('none');
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ terminatedEarly: 'CONTEXT_FULL' });
  });

  it('a round that wrote its answer as the window filled keeps that answer, with no closing call', async () => {
    llmStream.mockImplementation(() =>
      streamFrom([
        { type: 'text_delta', text: 'A very long answer.' },
        { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 150_000, outputTokens: 2_000, contextTokens: 150_000 } },
      ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(llmStream).toHaveBeenCalledTimes(1);
    expect(events[events.length - 1].type).toBe('complete');
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'A very long answer.' });
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ terminatedEarly: 'CONTEXT_FULL' });
  });

  it('closes the reply when the deadline has passed between two calls, and answers the round\'s tools "not run"', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? textTurn('Closing on the deadline.')
        : [
          { type: 'tool_use', toolCall: { id: 'call-1', name: 'get_agent_performance', input: {} } },
          { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5, contextTokens: 10 } },
        ]),
    );

    // A deadline already behind us: the first call returns, the clock is read,
    // and the reply is closed without running the tool.
    const events = await collectEvents(runLiftoffChatTurn({ ...baseInput, deadlineAt: Date.now() - 1 }));

    expect(llmStream).toHaveBeenCalledTimes(2);
    const closing = llmStream.mock.calls[1][0];
    expect(closing.toolChoice).toBe('none');
    expect(closing.messages[closing.messages.length - 2].toolResults).toEqual([
      { toolCallId: 'call-1', content: JSON.stringify({ error: 'Not run: answer now from what you have.' }) },
    ]);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
    expect(events[events.length - 1].type).toBe('complete');
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Closing on the deadline.' });
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ terminatedEarly: 'DEADLINE' });
  });

  it('a deadline still ahead leaves the loop alone', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom(toolTurn()))
      .mockReturnValueOnce(streamFrom(textTurn('Answered in time.')));

    const events = await collectEvents(runLiftoffChatTurn({ ...baseInput, deadlineAt: Date.now() + 60_000 }));

    expect(llmStream).toHaveBeenCalledTimes(2);
    expect(llmStream.mock.calls[1][0].toolChoice).toBeUndefined();
    expect(events[events.length - 1].type).toBe('complete');
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ terminatedEarly: null });
  });
});

describe('runLiftoffChatTurn / stopping mid-turn (ADR-041)', () => {
  it('keeps the partial answer when the stop lands after it has said something', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom(textTurn('here is what I have so far')))
      .mockReturnValueOnce(streamFrom(textTurn('should never run')));
    mockClaimAbortSignal.mockResolvedValue(true);

    const events = await collectEvents(runLiftoffChatTurn(stoppableInput()));

    expect(llmStream).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'here is what I have so far' }),
    );
    // A stop is a success with a marker, never an error frame.
    expect(events.find(e => e.type === 'error')).toBeUndefined();
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details.errorCode).toBe('user_stopped');
  });

  it('invents nothing when the stop lands before a word was written', async () => {
    // Writing "(stopped)" into the message content would show up in the
    // transcript as something the assistant said, which it did not.
    llmStream
      .mockReturnValueOnce(streamFrom(toolTurn()))
      .mockReturnValueOnce(streamFrom(textTurn('should never run')));
    mockClaimAbortSignal.mockResolvedValueOnce(true).mockResolvedValue(false);

    const events = await collectEvents(runLiftoffChatTurn(stoppableInput()));

    expect(events[events.length - 1]).toEqual({ type: 'complete', message: null });
    // Only the person's own message was persisted this turn, with the caller
    // the turn ran as as its sender (migration 492).
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(mockAppendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', senderAccountId: 'account-1' }));
  });

  it('hands the model call an abort signal so a stop does not wait out the answer', async () => {
    llmStream.mockReturnValueOnce(streamFrom(textTurn('streaming')));

    await collectEvents(runLiftoffChatTurn(stoppableInput()));

    expect(llmStream.mock.calls[0][0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('leaves the loop untouched when the turn runs without a lock', async () => {
    llmStream.mockReturnValueOnce(streamFrom(textTurn('done')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockClaimAbortSignal).not.toHaveBeenCalled();
    expect(llmStream.mock.calls[0][0].abortSignal).toBeUndefined();
  });

  it('answers a message that landed after the last thing it said', async () => {
    llmStream
      .mockReturnValueOnce(streamFrom(textTurn('here is the rewrite')))
      .mockReturnValueOnce(streamFrom(textTurn(' and the shorter version')));
    mockClaimUserMessageSignal
      .mockResolvedValueOnce({ text: 'make it shorter', senderDisplayName: null, senderAccountId: null })
      .mockResolvedValue(null);

    await collectEvents(runLiftoffChatTurn(stoppableInput()));

    expect(llmStream).toHaveBeenCalledTimes(2);
    const second = conversationForCall(2);
    expect(second[second.length - 1]).toEqual({
      role: 'user',
      content: 'FRAMED(anon): make it shorter',
    });
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        // Two rounds, so two messages: the round that answered the injected
        // message opens its own paragraph.
        content: 'here is the rewrite\n\nand the shorter version',
      }),
    );
  });
});

describe('runLiftoffChatTurn / errors', () => {
  it('yields a provider error and persists no assistant message', async () => {
    llmStream.mockReturnValue(
      streamFrom([
        { type: 'text_delta', text: 'Starting...' },
        { type: 'error', message: 'provider timeout' },
      ]),
    );

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events).toContainEqual({
      type: 'error',
      code: 'PROVIDER_ERROR',
      message: 'provider timeout',
    });
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    expect(events.find(e => e.type === 'complete')).toBeUndefined();
  });

  it('yields an error when completeStream throws before yielding anything', async () => {
    llmStream.mockImplementation(() => {
      throw new Error('connection refused');
    });

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events.find(e => e.type === 'error')?.type).toBe('error');
  });

  it('yields an internal error when the repository fails', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockRejectedValue(new Error('db connection lost'));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    expect(events).toContainEqual({
      type: 'error',
      code: 'INTERNAL',
      message: 'Something went wrong processing your message. Please try again.',
    });
  });

  it('reports a lost lock in words the person can act on', async () => {
    // The heartbeat aborts the same controller a stop uses. Nobody pressed
    // anything here, so the internal abort message is not a sentence to show
    // someone waiting on a reply.
    const input = stoppableInput();
    input.abortController.abort(new Error('Lock lost'));
    llmStream.mockImplementationOnce(() => {
      throw new Error('The operation was aborted');
    });

    const events = await collectEvents(runLiftoffChatTurn(input));

    expect(events).toContainEqual({
      type: 'error',
      code: 'INTERNAL',
      message: 'The response was interrupted. Please try again.',
    });
    expect(mockAppendMessage).toHaveBeenCalledTimes(1); // the user message only
  });
});

describe('runLiftoffChatTurn / prompt assembly', () => {
  it('puts the built system prompt at the head of the conversation', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    const first = conversationForCall(1);
    expect(first[0].role).toBe('system');
    expect(first[0].content).toContain('You are the general assistant inside Liftoff');
    // The tool list the loop actually offers is what the prompt renders.
    expect(first[0].content).toContain('`bring_in_colleague`');
    expect(first[0].content).toContain('`list_colleagues`');
  });

  it('carries the caller role into the user-context preamble', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    const preamble = conversationForCall(1).find(
      m => m.role === 'system' && m.content.includes('User context'),
    );
    expect(preamble?.content).toContain('Caller role: owner');
  });

  it('names the caller when the route knows who they are', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(runLiftoffChatTurn({ ...baseInput, callerName: 'Ada' }));

    const preamble = conversationForCall(1).find(
      m => m.role === 'system' && m.content.includes('User context'),
    );
    expect(preamble?.content).toContain('Caller: Ada (owner)');
  });
});

describe('runLiftoffChatTurn / rolling summary', () => {
  it('loads the summary and folds it into the prompt when present', async () => {
    mockGetSummary.mockResolvedValue({
      userIntent: 'Editing the onboarding email',
      keyFacts: ['Draft is too long'],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-08-05T00:00:00Z',
      messageCount: 8,
    });
    llmStream.mockReturnValue(streamFrom(textTurn('Following up.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    const preamble = conversationForCall(1).find(
      m => m.role === 'system' && m.content.includes('Conversation summary'),
    );
    expect(preamble).toBeDefined();
    expect(preamble?.content).toContain('formatted summary');
  });

  it('does NOT summarize a short thread', async () => {
    mockShouldSummarize.mockReturnValue(false);
    llmStream.mockReturnValue(streamFrom(textTurn('Short reply.')));

    await collectEvents(runLiftoffChatTurn(baseInput));
    // The refresh is fire-and-forget; give it a tick to settle.
    await new Promise(resolve => setImmediate(resolve));

    expect(mockGenerateSummary).not.toHaveBeenCalled();
    expect(mockUpdateSummary).not.toHaveBeenCalled();
  });

  it('refreshes the summary when the thread has grown, tagging the spend to Liftoff', async () => {
    mockShouldSummarize.mockReturnValue(true);
    mockGenerateSummary.mockResolvedValue({
      userIntent: 'new intent',
      keyFacts: [],
      openQuestions: [],
      previousFindings: [],
      nextSteps: [],
      summarizedThrough: '2026-08-08T00:00:00Z',
      messageCount: 12,
    });
    llmStream.mockReturnValue(streamFrom(textTurn('Reply.')));

    await collectEvents(runLiftoffChatTurn(baseInput));
    await new Promise(resolve => setImmediate(resolve));

    // The purpose tag is what keeps this surface's summarization spend out of
    // the insights bucket in llm_usage_log.
    expect(mockShouldSummarize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'liftoff_summarization', tenantId: 'tenant-1' }),
    );
    expect(mockGenerateSummary).toHaveBeenCalled();
    expect(mockUpdateSummary).toHaveBeenCalledWith(
      'thread-1',
      'tenant-1',
      expect.objectContaining({ userIntent: 'new intent' }),
    );
  });

  it('does not let a failed summary refresh break the reply', async () => {
    mockShouldSummarize.mockReturnValue(true);
    mockGenerateSummary.mockRejectedValue(new Error('provider down'));
    llmStream.mockReturnValue(streamFrom(textTurn('Reply.')));

    const events = await collectEvents(runLiftoffChatTurn(baseInput));
    await new Promise(resolve => setImmediate(resolve));

    expect(events[events.length - 1].type).toBe('complete');
    expect(mockUpdateSummary).not.toHaveBeenCalled();
  });
});

describe('runLiftoffChatTurn / thread titles', () => {
  it('generates a title on the first turn', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('Here is a tighter version.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockMaybeGenerateTitle).toHaveBeenCalledTimes(1);
    expect(mockMaybeGenerateTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        tenantId: 'tenant-1',
        userMessage: 'Can you tighten this paragraph?',
        assistantMessage: 'Here is a tighter version.',
      }),
    );
    // No agentId: the title cost belongs to platform LLM operations, not to
    // some team's interactions bucket.
    expect(mockMaybeGenerateTitle.mock.calls[0][0]).not.toHaveProperty('agentId');
  });

  it('does NOT try to title a thread that is already under way', async () => {
    // 6 messages of history means 5 prior turns, past the retry window.
    mockListMessages.mockResolvedValueOnce({
      messages: Array.from({ length: 6 }, (_, i) => ({
        id: `m${i}`,
        threadId: 'thread-1',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
        inputTokens: 0,
        outputTokens: 0,
        createdAt: `2026-08-08T1${i}:00:00Z`,
      })),
      nextCursor: null,
      hasMore: false,
    });
    llmStream.mockReturnValue(streamFrom(textTurn('reply')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockMaybeGenerateTitle).not.toHaveBeenCalled();
  });

  it('does NOT title a turn that errored before it answered', async () => {
    llmStream.mockReturnValue(streamFrom([{ type: 'error', message: 'provider down' }]));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockMaybeGenerateTitle).not.toHaveBeenCalled();
  });
});

describe('composeTurnText', () => {
  it('returns the typed message unchanged when nothing is attached', () => {
    expect(composeTurnText('just a question')).toBe('just a question');
  });

  it('puts attached file bodies BEFORE the question', () => {
    // Load-bearing order: the budget truncates the current message from its
    // start, so an overflowing turn loses document body, not the question
    // being asked about it.
    const composed = composeTurnText('summarise this', [
      { kind: 'upload', name: 'notes.md', content: 'line one', addedAt: '2026-08-08T00:00:00Z' },
    ]);

    expect(composed).toBe('<attachment name="notes.md">\nline one\n</attachment>\n\nsummarise this');
    expect(composed.indexOf('line one')).toBeLessThan(composed.indexOf('summarise this'));
  });

  it('skips connector references, which carry a pointer and no text', () => {
    const composed = composeTurnText('what is in there', [
      {
        kind: 'connector',
        name: 'Q3 board deck',
        connectorId: 'conn-1',
        connectorType: 'google_drive',
        externalId: 'file-123',
        addedAt: '2026-08-08T00:00:00Z',
      },
    ]);

    expect(composed).toBe('what is in there');
  });

  it('skips an upload whose text came through empty', () => {
    const composed = composeTurnText('and this one', [
      { kind: 'upload', name: 'empty.txt', content: '', addedAt: '2026-08-08T00:00:00Z' },
    ]);

    expect(composed).toBe('and this one');
  });
});

describe('runLiftoffChatTurn / attachments and the context budget', () => {
  it('sends a modest attachment to the model whole', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(
      runLiftoffChatTurn({
        ...baseInput,
        attachments: [
          { kind: 'upload', name: 'notes.md', content: 'body text', addedAt: '2026-08-08T00:00:00Z' },
        ],
      }),
    );

    const messages = conversationForCall(1);
    const current = messages[messages.length - 1].content;
    expect(current).toContain(
      '<attachment name="notes.md">\nbody text\n</attachment>\n\nCan you tighten this paragraph?',
    );
  });

  it('names the attachments on the user turn, never in the system prompt', async () => {
    // The system prompt is the provider's cache prefix and is marked as the
    // breakpoint below. A per-turn attachment list inside it moves those bytes
    // on every message that carries a file, so the naming rides the turn.
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(
      runLiftoffChatTurn({
        ...baseInput,
        attachments: [
          { kind: 'upload', name: 'notes.md', content: 'body text', addedAt: '2026-08-08T00:00:00Z' },
        ],
      }),
    );

    const messages = conversationForCall(1);
    const current = messages[messages.length - 1].content;
    expect(current).toContain('## Attached To This Message');
    expect(current).toContain('- notes.md');
    expect(messages[0].content).not.toContain('## Attached To This Message');
  });

  it('marks the system prompt as the prompt-cache breakpoint', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));

    await collectEvents(runLiftoffChatTurn({ ...baseInput }));

    const messages = conversationForCall(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].cacheControl).toEqual({ type: 'ephemeral' });
  });

  // Regression guard for a budget that was short by the wrapper. The allowance
  // once counted only attachment CONTENT, ignoring the `<attachment name="…">`
  // tags and the joins composeTurnText adds around each body, so a message at
  // the accepted caps overflowed by a few hundred characters. Because
  // truncateToTokenBudget drops from the START, the cost landed on the opening
  // of the first document and nothing said so.
  //
  // The sentinel below is the point: assert the HEAD survives, not merely that
  // some text arrived.
  it(
    'a message at the accepted caps reaches the model with its first attachment intact',
    async () => {
      llmStream.mockReturnValue(streamFrom(textTurn('ok')));
      const attachments = Array.from({ length: 8 }, (_, i) => ({
        kind: 'upload' as const,
        name: `file-${i}.md`,
        content: `HEAD-${i} ` + 'x'.repeat(4000 - `HEAD-${i} `.length),
        addedAt: '2026-08-08T00:00:00Z',
      }));

      await collectEvents(
        runLiftoffChatTurn({
          ...baseInput,
          userMessage: 'q'.repeat(4000),
          attachments,
        }),
      );

      const messages = conversationForCall(1);
      const current = messages[messages.length - 1].content;
      expect(current).toContain('<attachment name="file-0.md">');
      expect(current).toContain('HEAD-0');
    },
  );
});

describe('runLiftoffChatTurn / the browser trail fallback', () => {
  const browserTurn = (name: string, input: Record<string, unknown>): LLMStreamEvent[] => [
    { type: 'tool_use', toolCall: { id: 'call-b', name, input } },
    { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ];
  const detailed = (over: Record<string, unknown>) => ({
    content: 'The browser finished the task.',
    trail: { outcome: 'done', steps: [], stepsTruncated: false, captureGap: false, gapReason: '' },
    activityId: '11111111-1111-4111-8111-111111111111', runtimeRecorded: true, legacyFallbackNeeded: false,
    safeInstruction: 'count the pull requests', instructionTruncated: false, instructionProtectedDataOmitted: false,
    ...over,
  });

  beforeEach(() => {
    mockRecordBrowserActivity.mockClear();
    mockExecuteBrowserDetailed.mockReset();
  });

  it('an echoed id suppresses the legacy insert', async () => {
    mockExecuteBrowserDetailed.mockResolvedValueOnce(detailed({}));
    llmStream
      .mockReturnValueOnce(streamFrom(browserTurn('run_browser_task', { prompt: 'count the pull requests' })))
      .mockReturnValueOnce(streamFrom(textTurn('Eighteen.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(mockExecuteBrowserDetailed).toHaveBeenCalledWith('run_browser_task', { prompt: 'count the pull requests' }, expect.objectContaining({ surface: 'liftoff', senderAccountId: 'account-1' }));
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
  });

  it('a response without an echo (an older runtime) writes exactly one legacy row under that id, with the safe instruction', async () => {
    mockExecuteBrowserDetailed.mockResolvedValueOnce(detailed({
      runtimeRecorded: false, legacyFallbackNeeded: true,
      safeInstruction: 'sign in with password=[redacted]', instructionProtectedDataOmitted: true,
    }));
    llmStream
      .mockReturnValueOnce(streamFrom(browserTurn('run_browser_task', { prompt: 'sign in with password=hunter2' })))
      .mockReturnValueOnce(streamFrom(textTurn('Done.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    await new Promise((r) => setImmediate(r));
    expect(mockRecordBrowserActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordBrowserActivity).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111', tenantId: 'tenant-1', threadId: 'thread-1', tool: 'run_browser_task',
      instruction: { text: 'sign in with password=[redacted]', truncated: false, protectedDataOmitted: true },
      outcome: 'done', steps: [],
    });
    // The raw input was never reparsed for the fallback row.
    expect(JSON.stringify(mockRecordBrowserActivity.mock.calls)).not.toContain('hunter2');
  });

  it('a runtime-answered error, and a refusal before a session, write none', async () => {
    mockExecuteBrowserDetailed.mockResolvedValueOnce(detailed({ activityId: null, runtimeRecorded: false, legacyFallbackNeeded: false }));
    llmStream
      .mockReturnValueOnce(streamFrom(browserTurn('run_browser_task', { prompt: 'x' })))
      .mockReturnValueOnce(streamFrom(textTurn('No browser.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
  });

  it('a transport failure writes one row under the id with the not-answered marker as the outcome', async () => {
    mockExecuteBrowserDetailed.mockResolvedValueOnce(detailed({
      runtimeRecorded: false, legacyFallbackNeeded: true,
      trail: { outcome: '[not answered]', steps: null, stepsTruncated: false, captureGap: true, gapReason: 'not_answered' },
    }));
    llmStream
      .mockReturnValueOnce(streamFrom(browserTurn('run_browser_task', { prompt: 'count the pull requests' })))
      .mockReturnValueOnce(streamFrom(textTurn('The browser did not answer.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    await new Promise((r) => setImmediate(r));
    expect(mockRecordBrowserActivity).toHaveBeenCalledTimes(1);
    expect(mockRecordBrowserActivity.mock.calls[0][0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', outcome: '[not answered]', steps: null });
  });

  it('start_browser_session is not an activity and writes none', async () => {
    mockExecuteBrowserDetailed.mockResolvedValueOnce(detailed({ activityId: null, runtimeRecorded: false, legacyFallbackNeeded: false, safeInstruction: '' }));
    llmStream
      .mockReturnValueOnce(streamFrom(browserTurn('start_browser_session', {})))
      .mockReturnValueOnce(streamFrom(textTurn('Open.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(mockRecordBrowserActivity).not.toHaveBeenCalled();
  });
});

describe('describeAttachment', () => {
  it('names an upload plainly', () => {
    expect(
      describeAttachment({
        kind: 'upload',
        name: 'notes.md',
        content: 'x',
        addedAt: '2026-08-08T00:00:00Z',
      }),
    ).toBe('notes.md');
  });

  it('says where a connector reference lives, so the model can too', () => {
    expect(
      describeAttachment({
        kind: 'connector',
        name: 'Q3 board deck',
        connectorId: 'conn-1',
        connectorType: 'google_drive',
        externalId: 'file-123',
        addedAt: '2026-08-08T00:00:00Z',
      }),
    ).toBe('Q3 board deck (google_drive)');
  });
});

describe('runLiftoffChatTurn / the Browser section and the person\'s browser events', () => {
  const mockBuildBrowserState = buildAssistantBrowserState as jest.Mock;
  const mockLastReplyAt = lastAssistantReplyAt as jest.Mock;

  it('builds the Browser section on every turn from when it last spoke, and puts it in the preamble', async () => {
    mockLastReplyAt.mockResolvedValueOnce('2026-08-08T11:00:00.000Z');
    mockBuildBrowserState.mockResolvedValueOnce('## Browser\n\nThe browser beside this conversation is open on https://a.example/.');
    llmStream.mockReturnValue(streamFrom(textTurn('Sure.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(mockBuildBrowserState).toHaveBeenCalledWith({ tenantId: 'tenant-1', threadId: 'thread-1', sinceLastReply: '2026-08-08T11:00:00.000Z' });
    const preamble = conversationForCall(1)[1];
    expect(preamble.role).toBe('system');
    expect(preamble.content).toContain('## Browser');
    expect(preamble.content.indexOf('## User context')).toBeLessThan(preamble.content.indexOf('## Browser'));
  });

  it('a hand-back without words: no user row, the model reads the shared hand-back text, and the history keeps every prior turn', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('Picking up from the page you left.')));
    const events = await collectEvents(runLiftoffChatTurn({
      ...baseInput, userMessage: '', browserEvent: { kind: 'handback', holdId: '11111111-1111-4111-8111-111111111111' },
    }));
    expect(events[events.length - 1].type).toBe('complete');
    // Only the assistant row: the person's row is the status line the router wrote.
    expect(mockAppendMessage.mock.calls.map((c) => c[0].role)).toEqual(['assistant']);
    const conversation = conversationForCall(1);
    expect(conversation[conversation.length - 1]).toEqual({ role: 'user', content: BROWSER_HANDBACK_TURN_TEXT });
    // The newest stored row (the person's earlier message) is history, not dropped as this turn's own row.
    expect(conversation.some((m) => m.role === 'user' && m.content === 'Can you tighten this paragraph?')).toBe(true);
  });


  it('keeps the person\'s browser event rows out of the model\'s history', async () => {
    mockListMessages.mockResolvedValueOnce({
      messages: [
        { id: 'msg-u', threadId: 'thread-1', role: 'user', content: 'Can you tighten this paragraph?', inputTokens: 0, outputTokens: 0, createdAt: '2026-08-08T11:00:00Z', messageType: null },
        { id: 'msg-h', threadId: 'thread-1', role: 'assistant', content: 'Ada handed the browser back', inputTokens: 0, outputTokens: 0, createdAt: '2026-08-08T10:59:00Z', messageType: 'browser_handback' },
        { id: 'msg-p', threadId: 'thread-1', role: 'assistant', content: 'Ada pointed at link "Sports"', inputTokens: 0, outputTokens: 0, createdAt: '2026-08-08T10:58:00Z', messageType: 'browser_point' },
        { id: 'msg-a', threadId: 'thread-1', role: 'assistant', content: 'Earlier reply.', inputTokens: 0, outputTokens: 0, createdAt: '2026-08-08T10:57:00Z', messageType: null },
      ],
      nextCursor: null, hasMore: false,
    });
    llmStream.mockReturnValue(streamFrom(textTurn('Sure.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    const contents = conversationForCall(1).map((m) => m.content);
    expect(contents).toContain('Earlier reply.');
    expect(contents).not.toContain('Ada handed the browser back');
    expect(contents).not.toContain('Ada pointed at link "Sports"');
  });
});

describe('runLiftoffChatTurn / the datasets kept for the conversation', () => {
  const DATASET_ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';

  it('lists the thread\'s datasets newest first at turn start and puts the inventory in the preamble under ## Datasets', async () => {
    mockListDatasets.mockResolvedValueOnce([
      { id: DATASET_ID, label: 'comments: post ids', source: 's', sourceRef: 'r', recordCount: 275, bytes: 1, fields: [{ name: 'body', type: 'text', present: 1, avgChars: 380 }], createdAt: new Date(), runs: 2 },
    ] as never);
    llmStream.mockReturnValue(streamFrom(textTurn('Summaries follow.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    expect(mockListDatasets).toHaveBeenCalledWith('tenant-1', { kind: 'liftoff_thread', id: 'thread-1' }, { order: 'newest' });
    const preamble = conversationForCall(1)[1];
    expect(preamble.role).toBe('system');
    expect(preamble.content).toContain('## Datasets');
    expect(preamble.content).toContain('Datasets kept for this conversation.');
    expect(preamble.content).toContain(`- ${DATASET_ID} "comments: post ids" — 275 records, 2 runs; fields body (text, avg 380 chars)`);
    // Never in the system prompt: that is the cache prefix.
    expect(conversationForCall(1)[0].content).not.toContain('Datasets kept');
  });

  it('carries no datasets section when the thread holds none', async () => {
    llmStream.mockReturnValue(streamFrom(textTurn('ok')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(conversationForCall(1).map((m) => m.content).join('\n')).not.toContain('## Datasets');
  });
});

describe('runLiftoffChatTurn / work bigger than a turn (the continuation)', () => {
  const ORIGIN = '44444444-4444-4444-8444-444444444444';
  /** The model asks for a tool on every round until the closing call, whose
   *  reply is `closingText`. */
  const alwaysTools = (closingText: string) =>
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none'
        ? [
          { type: 'text_delta', text: closingText.slice(0, 12) },
          { type: 'text_delta', text: closingText.slice(12) },
          { type: 'message_complete', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
        ]
        : toolTurn()),
    );
  /** The user row this turn writes, with an id the continuation carries. */
  const userRowSaved = () => {
    mockAppendMessage.mockReset();
    mockAppendMessage
      .mockResolvedValueOnce({ id: ORIGIN, threadId: 'thread-1', role: 'user' })
      .mockResolvedValue(fakeSavedMessage);
  };

  it('holds the closing round: the verdict line never reaches the guard, the stream or the row, and [continue] queues a continuation after the reply is persisted', async () => {
    userRowSaved();
    alwaysTools('Twelve of the twenty are summarised; eight are still to do.\n[continue]');

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    // What streamed and what was persisted is the reply without its last line.
    const shown = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(shown).toBe('Twelve of the twenty are summarised; eight are still to do.');
    expect(shown).not.toContain('[continue]');
    expect(mockAppendMessage.mock.calls[1][0]).toMatchObject({ role: 'assistant', content: 'Twelve of the twenty are summarised; eight are still to do.' });
    // The guard read the closing reply once, whole, already stripped.
    const fed = mockGuard.mock.calls.map((c) => c[0] as string);
    expect(fed.some((t) => t.includes('[continue]'))).toBe(false);
    expect(fed.some((t) => t.includes('eight are still to do'))).toBe(true);
    // The continuation: queued on the origin message, for this person, on
    // this surface, with the bound that closed the turn; then its task.
    expect(mockEnqueueContinuation).toHaveBeenCalledTimes(1);
    expect(mockEnqueueContinuation).toHaveBeenCalledWith({
      tenantId: 'tenant-1', surface: 'liftoff', threadId: 'thread-1', accountId: 'account-1', originMessageId: ORIGIN, reason: 'MAX_ITERATIONS',
    });
    expect(mockEnqueueContinuationTask).toHaveBeenCalledWith('cont-1', 'tenant-1');
    // After the row, before the audit.
    expect(mockEnqueueContinuation.mock.invocationCallOrder[0]).toBeGreaterThan(mockAppendMessage.mock.invocationCallOrder[1]);
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ terminatedEarly: 'MAX_ITERATIONS', closingUnfinished: true });
  });

  it('[done] queues nothing, and a stray marker mid-text is removed too', async () => {
    userRowSaved();
    alwaysTools('All twenty are summarised. [done] That is everything.\n[done]');

    const events = await collectEvents(runLiftoffChatTurn(baseInput));

    const shown = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(shown).toBe('All twenty are summarised. That is everything.');
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ closingUnfinished: false });
  });

  it('a closing reply with no verdict line is unfinished: the bound closed it, so it continues', async () => {
    userRowSaved();
    alwaysTools('Here is what I have so far.');
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(mockEnqueueContinuation).toHaveBeenCalledTimes(1);
  });

  it('a turn that ended on its own queues nothing and asks for no verdict', async () => {
    userRowSaved();
    llmStream.mockReturnValue(streamFrom(textTurn('Done in one.')));
    await collectEvents(runLiftoffChatTurn(baseInput));
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).not.toHaveProperty('closingUnfinished');
  });

  it('a continuation writes no user row, reads the continuation note as its message, keeps the origin and the account, and can queue the next', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockResolvedValue(fakeSavedMessage);
    mockListMessages.mockResolvedValueOnce({
      messages: [
        { id: 'msg-a', threadId: 'thread-1', role: 'assistant', content: 'Twelve so far.', inputTokens: 0, outputTokens: 0, createdAt: '2026-08-08T11:30:00Z' },
        { id: ORIGIN, threadId: 'thread-1', role: 'user', content: 'summaries per thread', inputTokens: 0, outputTokens: 0, createdAt: '2026-08-08T11:00:00Z' },
      ],
      nextCursor: null, hasMore: false,
    });
    alwaysTools('Eighteen now; two to go.\n[continue]');

    await collectEvents(runLiftoffChatTurn({ ...baseInput, userMessage: '', continuation: { originMessageId: ORIGIN, ordinal: 2 } }));

    // Only the assistant row: the person's message is the origin, already there.
    expect(mockAppendMessage.mock.calls.map((c) => c[0].role)).toEqual(['assistant']);
    // The model's current message is the note; the whole history is prior turns.
    const conversation = conversationForCall(1);
    expect(conversation[conversation.length - 1]).toEqual({
      role: 'user',
      content: 'Continue the work in progress in this conversation. The datasets kept for it are listed. Write the reply when the work is done, or when you must stop again.',
    });
    expect(conversation.some((m) => m.role === 'assistant' && m.content === 'Twelve so far.')).toBe(true);
    // The next continuation is queued on the SAME origin, for the same person.
    expect(mockEnqueueContinuation).toHaveBeenCalledWith(expect.objectContaining({ originMessageId: ORIGIN, accountId: 'account-1' }));
    const details = mockLogAudit.mock.calls.find(c => c[0] === 'liftoff.chat_turn')?.[2];
    expect(details).toMatchObject({ continuationOf: ORIGIN, continuationOrdinal: 2 });
  });

  it('the fifth continuation is the last: its closing note asks for no verdict and says the person can ask it to go on, and nothing is queued', async () => {
    mockAppendMessage.mockReset();
    mockAppendMessage.mockResolvedValue(fakeSavedMessage);
    alwaysTools('Nineteen done; one remains. The person can ask me to go on.');

    await collectEvents(runLiftoffChatTurn({ ...baseInput, userMessage: '', continuation: { originMessageId: ORIGIN, ordinal: 5 } }));

    const closing = llmStream.mock.calls[llmStream.mock.calls.length - 1][0];
    const note = closing.messages[closing.messages.length - 1].content as string;
    expect(note).toContain('say that the person can ask you to go on in their next message');
    expect(note).not.toContain('[continue]');
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
  });

  it('an event turn with no message of the person\'s cannot continue: the final note, nothing queued', async () => {
    llmStream.mockImplementation((req: { toolChoice?: string }) =>
      streamFrom(req.toolChoice === 'none' ? textTurn('Picked up from the page.') : toolTurn()),
    );
    await collectEvents(runLiftoffChatTurn({
      ...baseInput, userMessage: '', browserEvent: { kind: 'handback', holdId: '11111111-1111-4111-8111-111111111111' },
    }));
    const closing = llmStream.mock.calls[llmStream.mock.calls.length - 1][0];
    expect((closing.messages[closing.messages.length - 1].content as string)).not.toContain('[continue]');
    expect(mockEnqueueContinuation).not.toHaveBeenCalled();
  });
});

describe('runLiftoffChatTurn / a tool result larger than one message', () => {
  const DATASET_ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
  /** Over the 50,000-character bound every surface shares. */
  const HUGE = JSON.stringify([{ body: 'x'.repeat(60_000) }]);

  const workspaceToolTurn = (): LLMStreamEvent[] => [
    { type: 'tool_use', toolCall: { id: 'call-1', name: 'review_decide', input: {} } },
    { type: 'message_complete', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
  ];

  it('parks it under this conversation and hands the model the view, not the records', async () => {
    mockCreateDataset.mockResolvedValueOnce({
      id: DATASET_ID, recordCount: 1, added: 1, truncated: false,
      fields: [{ name: 'body', type: 'text', present: 1, avgChars: 60_000 }], run: 1,
    } as never);
    mockDispatchWorkspaceAction.mockResolvedValueOnce(HUGE);
    llmStream
      .mockReturnValueOnce(streamFrom(workspaceToolTurn()))
      .mockReturnValueOnce(streamFrom(textTurn('Done.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    // Parked for THIS conversation, named by the tool that produced it.
    expect(mockCreateDataset).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      scope: { kind: 'liftoff_thread', id: 'thread-1' },
      label: 'review_decide result',
      source: 'liftoff_tool',
      sourceRef: 'review_decide',
    }));
    // The second call reads the view; the records never reach the window.
    const second = llmStream.mock.calls[1][0].messages;
    const results = second.flatMap((m: { toolResults?: Array<{ content: string }> }) => m.toolResults ?? []);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain(DATASET_ID);
    expect(results[0].content).not.toContain('x'.repeat(1_000));
  });

  it('bounds it rather than handing it over whole when it could not be parked', async () => {
    mockCreateDataset.mockResolvedValueOnce(null as never);
    mockDispatchWorkspaceAction.mockResolvedValueOnce(HUGE);
    llmStream
      .mockReturnValueOnce(streamFrom(workspaceToolTurn()))
      .mockReturnValueOnce(streamFrom(textTurn('Done.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    const second = llmStream.mock.calls[1][0].messages;
    const results = second.flatMap((m: { toolResults?: Array<{ content: string }> }) => m.toolResults ?? []);
    expect(results[0].content).not.toBe(HUGE);
    expect(results[0].content.length).toBeLessThan(HUGE.length);
    // And the turn still finished.
    expect(llmStream).toHaveBeenCalledTimes(2);
  });

  it('leaves an ordinary result exactly as it was, and never reaches the store', async () => {
    mockDispatchWorkspaceAction.mockResolvedValueOnce('{"ok":true}');
    llmStream
      .mockReturnValueOnce(streamFrom(workspaceToolTurn()))
      .mockReturnValueOnce(streamFrom(textTurn('Done.')));

    await collectEvents(runLiftoffChatTurn(baseInput));

    const second = llmStream.mock.calls[1][0].messages;
    const results = second.flatMap((m: { toolResults?: Array<{ content: string }> }) => m.toolResults ?? []);
    expect(results[0].content).toBe('{"ok":true}');
    expect(mockCreateDataset).not.toHaveBeenCalled();
  });
});
