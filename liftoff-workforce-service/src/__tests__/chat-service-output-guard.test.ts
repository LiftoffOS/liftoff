// The Chief AI Officer's words pass the output guard before a person reads
// them. The guard client is mocked to a deterministic rewrite, so what
// streams and what is persisted can be told apart from the model's raw
// words; the model loop is mocked at the platform-agent seam as the
// hand-over suite does.

const mockGuard = jest.fn();
jest.mock('../workforce-plans/output-guard-client.js', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...args),
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
  userMessage: 'How many runs did the Watches team make this week?',
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
  mockGuard.mockImplementation(async (text: string) => text.replace(', per the request', ''));
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

describe('the output guard on a Chief AI Officer turn', () => {
  it('streams and persists what the guard returned, block by block, with the tools it was offered', async () => {
    mockRun.mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', text: 'Here is the change to "Support Triage", per the request.' };
        yield { type: 'text_delta', text: '\n\n' };
        yield { type: 'text_delta', text: 'Say yes and I will apply it.' };
        yield { type: 'complete', summary: { ok: true, text: 'raw, never read', toolCalls: [], inputTokens: 1, outputTokens: 1, terminator: 'normal' } };
      })(),
    );

    const events = await collect(baseInput);

    const shown = events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(shown).toBe('Here is the change to "Support Triage".\n\nSay yes and I will apply it.');

    const reply = mockAppend.mock.calls.map((c) => c[0]).find((m) => m.role === 'assistant');
    expect(reply.content).toBe('Here is the change to "Support Triage".\n\nSay yes and I will apply it.');

    expect(mockGuard).toHaveBeenCalledTimes(3);
    const [text, ctx] = mockGuard.mock.calls[0];
    expect(text).toBe('Here is the change to "Support Triage", per the request.');
    expect(ctx).toMatchObject({ tenantId: TENANT_ID, threadId: THREAD_ID });
    expect(ctx.toolNames).toEqual(expect.arrayContaining(['bring_in_colleague']));
  });
});
