// The Chief AI Officer's chat service writes the person's turn with the
// CALLER's account id as its sender (migration 027).
//
// The turn is driven for real up to the point the message is persisted: the
// repository is mocked and the history load that follows the append is made to
// fail, so the turn ends right after the write under test. What is asserted is
// not that some sender was passed but that it is the account the turn ran as.

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  appendMessage: jest.fn(),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  // When the Chief AI Officer last spoke, for the Browser section: none by default.
  lastAssistantReplyAt: jest.fn().mockResolvedValue(null),
  updateThreadRollingSummary: jest.fn(),
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
  withTenantContext: jest.fn(),
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
jest.mock('../platform-agent/execution.js', () => ({
  runPlatformAgent: jest.fn(),
}));
jest.mock('../platform-agent/config.js', () => ({
  loadPlatformAgentConfig: jest.fn().mockResolvedValue({ systemPromptTemplate: 'x', model: 'm' }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { appendMessage, listMessages } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn } from '../workforce-plans/chat-service.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const CALLER = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  (appendMessage as jest.Mock).mockReset().mockResolvedValue({ id: 'message-1' });
  // The step after the append; failing it ends the turn without a model call.
  (listMessages as jest.Mock).mockReset().mockRejectedValue(new Error('stop here'));
});

it("writes the person's message with the caller's account id as its sender, before anything else", async () => {
  const events: unknown[] = [];
  const run = async () => {
    for await (const event of runCAIOChatTurn({
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      accountId: CALLER,
      role: 'owner',
      userMessage: 'Plan me a support pod.',
    })) {
      events.push(event);
    }
  };
  await run().catch(() => undefined);

  expect(appendMessage).toHaveBeenCalledTimes(1);
  expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
    threadId: THREAD_ID,
    tenantId: TENANT_ID,
    role: 'user',
    senderAccountId: CALLER,
    content: 'Plan me a support pod.',
  }));
});
