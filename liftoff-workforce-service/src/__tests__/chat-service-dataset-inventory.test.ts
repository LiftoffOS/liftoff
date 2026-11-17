// The datasets kept for a Chief AI Officer conversation reach the model at
// the start of every turn: one internal call to platform-backend's
// dataset_list (inventory: true), placed in the per-turn context under
// "## Datasets", and no section at all when the conversation holds none.

const mockGuard = jest.fn(async (text: string) => text);
jest.mock('../workforce-plans/output-guard-client.js', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...(args as [string])),
}));
const mockFetchInventory = jest.fn();
jest.mock('../workforce-plans/tools/capability.js', () => ({
  ...jest.requireActual('../workforce-plans/tools/capability.js'),
  fetchDatasetInventory: (...args: unknown[]) => mockFetchInventory(...(args as [])),
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

const mockAppend = appendMessage as jest.Mock;
const mockList = listMessages as jest.Mock;
const mockRun = runPlatformAgent as jest.Mock;
const mockStop = isStopRequested as jest.Mock;

const baseInput = {
  threadId: THREAD_ID,
  tenantId: TENANT_ID,
  accountId: CALLER,
  role: 'member' as const,
  userMessage: 'Now the summaries per thread.',
  callerName: 'Dana Reyes',
};

async function collect(input: Parameters<typeof runCAIOChatTurn>[0]): Promise<CAIOChatServiceEvent[]> {
  const out: CAIOChatServiceEvent[] = [];
  for await (const e of runCAIOChatTurn(input)) out.push(e);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStop.mockResolvedValue(false);
  mockAppend.mockImplementation(async (input: Record<string, unknown>) => ({
    id: `m-${mockAppend.mock.calls.length}`, threadId: THREAD_ID, role: input.role, content: input.content,
    visualizationBlocks: null, messageType: input.messageType ?? null, contributors: [], inputTokens: 0, outputTokens: 0,
    createdAt: '2026-09-22T12:00:00Z',
  }));
  mockList.mockResolvedValue({
    messages: [{ id: 'u1', threadId: THREAD_ID, role: 'user', content: baseInput.userMessage, messageType: null, contributors: [], visualizationBlocks: null, inputTokens: 0, outputTokens: 0, createdAt: '2026-09-22T11:00:00Z' }],
    nextCursor: null, hasMore: false,
  });
  mockRun.mockImplementation(() => (async function* () {
    yield { type: 'text_delta', text: 'Here they are.' };
    yield { type: 'complete', summary: { ok: true, text: 'Here they are.', toolCalls: [], inputTokens: 1, outputTokens: 1, terminator: 'normal' } };
  })());
});

const INVENTORY = 'Datasets kept for this conversation. Read them with dataset_query.\n- 8fc9dc75-0000-4000-8000-000000000000 "comments: post ids" — 275 records, 2 runs; fields body (text)';

describe('the datasets kept for a Chief AI Officer conversation', () => {
  it('asks platform-backend once at turn start, scoped to the thread, and places the block in the per-turn context under ## Datasets', async () => {
    mockFetchInventory.mockResolvedValue(INVENTORY);
    await collect(baseInput);
    expect(mockFetchInventory).toHaveBeenCalledTimes(1);
    expect(mockFetchInventory).toHaveBeenCalledWith({ tenantId: TENANT_ID, threadId: THREAD_ID });
    const run = mockRun.mock.calls[0][0] as { priorMessages: Array<{ role: string; content: string }> };
    const context = run.priorMessages.find((m) => m.content.startsWith('[Context]'));
    expect(context?.content).toContain('## Datasets\n' + INVENTORY);
  });

  it('carries no section when the conversation holds none', async () => {
    mockFetchInventory.mockResolvedValue('');
    await collect(baseInput);
    const run = mockRun.mock.calls[0][0] as { priorMessages: Array<{ role: string; content: string }> };
    expect(run.priorMessages.map((m) => m.content).join('\n')).not.toContain('## Datasets');
  });

  it('a threadless greeting asks for nothing', async () => {
    await collect({ ...baseInput, threadId: null, userMessage: undefined });
    expect(mockFetchInventory).not.toHaveBeenCalled();
  });
});
