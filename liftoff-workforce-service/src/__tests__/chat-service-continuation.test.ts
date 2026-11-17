// The Chief AI Officer's continuation: a bound closed the turn and the
// closing reply said the work is not finished, so a continuation row and its
// task are queued after the reply is persisted, on the origin message, for
// the person; [done] queues nothing; a continuation turn writes no user row
// and reads the note; at the cap the loop is told to ask for no verdict.

const mockGuard = jest.fn(async (text: string) => text);
jest.mock('../workforce-plans/output-guard-client.js', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...(args as [string])),
}));
jest.mock('../workforce-plans/tools/capability.js', () => ({
  ...jest.requireActual('../workforce-plans/tools/capability.js'),
  fetchDatasetInventory: jest.fn(async () => ''),
}));
const mockEnqueue = jest.fn();
const mockEnqueueTask = jest.fn(async () => undefined);
jest.mock('../workforce-plans/chat-continuations.js', () => ({
  ...jest.requireActual('../workforce-plans/chat-continuations.js'),
  enqueueContinuation: (...args: unknown[]) => mockEnqueue(...(args as [])),
  enqueueContinuationTask: (...args: unknown[]) => mockEnqueueTask(...(args as [])),
}));
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
import { runCAIOChatTurn, type CAIOChatServiceEvent } from '../workforce-plans/chat-service.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const CALLER = '33333333-3333-4333-8333-333333333333';
const ORIGIN = '44444444-4444-4444-8444-444444444444';

const mockAppend = appendMessage as jest.Mock;
const mockList = listMessages as jest.Mock;
const mockRun = runPlatformAgent as jest.Mock;
const mockStop = isStopRequested as jest.Mock;

const baseInput = {
  threadId: THREAD_ID, tenantId: TENANT_ID, accountId: CALLER, role: 'member' as const,
  userMessage: 'Now the summaries per thread.', callerName: 'Dana Reyes',
};

async function collect(input: Parameters<typeof runCAIOChatTurn>[0]): Promise<CAIOChatServiceEvent[]> {
  const out: CAIOChatServiceEvent[] = [];
  for await (const e of runCAIOChatTurn(input)) out.push(e);
  return out;
}

const closedBy = (terminator: string, unfinished: boolean | undefined, text = 'Twelve of twenty are done.') =>
  mockRun.mockImplementation(() => (async function* () {
    yield { type: 'text_delta', text };
    yield { type: 'complete', summary: { ok: true, text, toolCalls: [], inputTokens: 1, outputTokens: 1, terminator, ...(unfinished !== undefined ? { unfinished } : {}) } };
  })());

beforeEach(() => {
  jest.clearAllMocks();
  mockStop.mockResolvedValue(false);
  mockEnqueue.mockResolvedValue({ id: 'cont-1', ordinal: 1 });
  mockAppend.mockImplementation(async (input: Record<string, unknown>) => ({
    id: input.role === 'user' ? ORIGIN : `m-${mockAppend.mock.calls.length}`, threadId: THREAD_ID, role: input.role, content: input.content,
    visualizationBlocks: null, messageType: input.messageType ?? null, contributors: [], inputTokens: 0, outputTokens: 0,
    createdAt: '2026-09-22T12:00:00Z',
  }));
  mockList.mockResolvedValue({
    messages: [{ id: ORIGIN, threadId: THREAD_ID, role: 'user', content: baseInput.userMessage, messageType: null, contributors: [], visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-22T11:00:00Z' }],
    nextCursor: null, hasMore: false,
  });
});

describe('the Chief AI Officer\'s continuation', () => {
  it('a bound-closed turn whose reply is unfinished queues the row on the origin message, for the person, then its task, after the reply is persisted', async () => {
    closedBy('max_iterations', true);
    await collect(baseInput);
    expect(mockEnqueue).toHaveBeenCalledWith({ tenantId: TENANT_ID, threadId: THREAD_ID, accountId: CALLER, originMessageId: ORIGIN, reason: 'MAX_ITERATIONS' });
    expect(mockEnqueueTask).toHaveBeenCalledWith('cont-1', TENANT_ID);
    const assistantRow = mockAppend.mock.calls.findIndex((c) => (c[0] as { role: string }).role === 'assistant');
    expect(mockEnqueue.mock.invocationCallOrder[0]).toBeGreaterThan(mockAppend.mock.invocationCallOrder[assistantRow]);
    // The loop was asked for the verdict.
    expect((mockRun.mock.calls[0][0] as { reply: { askVerdict: boolean } }).reply.askVerdict).toBe(true);
  });

  it('[done] queues nothing; a turn that ended on its own queues nothing', async () => {
    closedBy('context_full', false);
    await collect(baseInput);
    expect(mockEnqueue).not.toHaveBeenCalled();
    closedBy('normal', undefined);
    await collect(baseInput);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('a continuation writes no user row, reads the note as its message, keeps the origin, and queues the next on it', async () => {
    closedBy('deadline', true);
    await collect({ ...baseInput, userMessage: '', continuation: { originMessageId: ORIGIN, ordinal: 2 } });
    expect(mockAppend.mock.calls.map((c) => (c[0] as { role: string }).role)).toEqual(['assistant']);
    const run = mockRun.mock.calls[0][0] as { objective: string; reply: { askVerdict: boolean } };
    expect(run.objective).toMatch(/^Continue the work in progress in this conversation\./);
    expect(run.reply.askVerdict).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ originMessageId: ORIGIN, accountId: CALLER, reason: 'DEADLINE' }));
  });

  it('a closing call that failed is unfinished: the continuation is queued even though no reply was written', async () => {
    mockRun.mockImplementation(() => (async function* () {
      yield { type: 'text_delta', text: 'Half way.' };
      yield { type: 'error', code: 'PROVIDER_ERROR', message: 'the relay timed out', closingCallFailed: true };
    })());
    const events = await collect(baseInput);
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'PROVIDER_ERROR' });
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ originMessageId: ORIGIN, reason: 'CLOSING_CALL_FAILED' }));
    // An ordinary failed call queues nothing.
    mockEnqueue.mockClear();
    mockRun.mockImplementation(() => (async function* () {
      yield { type: 'error', code: 'PROVIDER_ERROR', message: 'down' };
    })());
    await collect(baseInput);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('the fifth continuation asks for no verdict and queues nothing', async () => {
    closedBy('max_iterations', true);
    await collect({ ...baseInput, userMessage: '', continuation: { originMessageId: ORIGIN, ordinal: 5 } });
    expect((mockRun.mock.calls[0][0] as { reply: { askVerdict: boolean } }).reply.askVerdict).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
