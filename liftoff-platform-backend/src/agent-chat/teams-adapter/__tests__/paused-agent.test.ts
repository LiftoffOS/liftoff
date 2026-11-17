// A paused teammate cannot answer, so Liftoff says so itself rather than
// leaving the person waiting on silence. Same wording as the Slack surface
// (slack-adapter/workspace-event-handler.ts postPausedNotice) — the two must
// not drift, since it is the same product behaviour on two channels.

import { jest } from '@jest/globals';

const getConversationAgentMock = jest.fn<() => Promise<string | null>>();
const getAgentNameAndStatusMock = jest.fn<() => Promise<unknown>>();
const findTenantMock = jest.fn<() => Promise<string | null>>();
const isDupMock = jest.fn<() => Promise<boolean>>();
jest.mock('../repository', () => ({
  findTenantByAadTenant: (...a: unknown[]) => findTenantMock(...(a as [])),
  getConversationAgent: (...a: unknown[]) => getConversationAgentMock(...(a as [])),
  getAgentNameAndStatus: (...a: unknown[]) => getAgentNameAndStatusMock(...(a as [])),
  bindConversationAgent: jest.fn(),
  upsertConversationReference: jest.fn(),
  isDuplicateActivity: (...a: unknown[]) => isDupMock(...(a as [])),
  searchAgents: jest.fn(async () => []),
}));

const checkExecutionAllowedMock = jest.fn<() => Promise<unknown>>();
jest.mock('../../../billing/execution-guard', () => ({
  checkExecutionAllowed: (...a: unknown[]) => checkExecutionAllowedMock(...(a as [])),
}));

const handleTeamsChatTaskMock = jest.fn<() => Promise<void>>();
// The connector-events publish is now awaited pre-return; stub PubSub so the
// test never opens a real client.
jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    topic: () => ({ publishMessage: jest.fn().mockResolvedValue('msg-1') }),
  })),
}));

// The handler now ENQUEUES the turn (chat-turn-dispatch) instead of invoking
// the worker inline; the shim forwards the queued task payload so the
// task-shape assertions keep working.
jest.mock('../../chat-turn-dispatch', () => ({
  enqueueChatTurnTask: (_dedupeId: string, payload: { task: unknown }) =>
    handleTeamsChatTaskMock(payload.task as never),
  isDuplicateTaskError: () => false,
}));

jest.mock('../identity-resolver', () => ({
  resolveTeamsUser: jest.fn(async () => ({
    userId: 'acc-1', accountId: 'acc-1', displayName: 'Alex', identityLabel: 'Alex',
  })),
}));
jest.mock('../cards', () => ({ buildAgentPickerCard: jest.fn(() => ({})), buildSearchResponse: jest.fn() }));
jest.mock('../review-card-notifier', () => ({ updateAllReviewCards: jest.fn() }));
jest.mock('../../../infrastructure/database', () => ({ withTenantScope: jest.fn(), getPool: jest.fn() }));
jest.mock('../../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../../internal-agent-oversight/service-internal', () => ({
  approveApprovalForActor: jest.fn(), rejectApprovalForActor: jest.fn(),
}));

import { LiftoffTeamsBot } from '../teams-bot-handler';

function makeCtx(text: string) {
  const sent: string[] = [];
  return {
    sent,
    ctx: {
      activity: {
        id: 'act-1', type: 'message', text,
        conversation: { id: 'conv-1', conversationType: 'personal' },
        from: { id: 'teams-user-1', name: 'Alex' },
        channelData: { tenant: { id: 'aad-1' } },
      },
      sendActivity: async (a: unknown) => { sent.push(typeof a === 'string' ? a : JSON.stringify(a)); },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  findTenantMock.mockResolvedValue('tenant-1');
  isDupMock.mockResolvedValue(false);
  getConversationAgentMock.mockResolvedValue('agent-9');
  checkExecutionAllowedMock.mockResolvedValue({ allowed: true });
  handleTeamsChatTaskMock.mockResolvedValue(undefined);
});

describe('Teams: paused agent', () => {
  it('replies "Liftoff: <name> is paused right now" and runs no turn', async () => {
    getAgentNameAndStatusMock.mockResolvedValue({ displayName: 'Code Reviewer', status: 'paused' });
    const { ctx, sent } = makeCtx('are you there?');

    const bot = new LiftoffTeamsBot();
    await (bot as unknown as { handleMessage: (c: unknown) => Promise<void> }).handleMessage(ctx);

    expect(sent).toContain('Liftoff: Code Reviewer is paused right now');
    expect(handleTeamsChatTaskMock).not.toHaveBeenCalled();
  });

  it('an active agent still runs the turn', async () => {
    getAgentNameAndStatusMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'active' });
    const { ctx } = makeCtx('ship it');

    const bot = new LiftoffTeamsBot();
    await (bot as unknown as { handleMessage: (c: unknown) => Promise<void> }).handleMessage(ctx);

    expect(handleTeamsChatTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', agentId: 'agent-9' }),
    );
  });
});
