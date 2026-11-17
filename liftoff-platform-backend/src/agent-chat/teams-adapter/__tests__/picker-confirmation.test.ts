// The picker confirmation replaces the picker card, so it is the only place
// that can say how to get the picker back. Same wording as the Slack surface
// (slack-adapter/interactivity-router.ts) — the two must not drift, since it
// is the same product behaviour on two channels.

import { jest } from '@jest/globals';

const getAgentNameAndStatusMock = jest.fn<() => Promise<unknown>>();
const findTenantMock = jest.fn<() => Promise<string | null>>();
const isDupMock = jest.fn<() => Promise<boolean>>();
const bindMock = jest.fn<() => Promise<void>>();
jest.mock('../repository', () => ({
  findTenantByAadTenant: (...a: unknown[]) => findTenantMock(...(a as [])),
  getConversationAgent: jest.fn(async () => 'agent-9'),
  getAgentNameAndStatus: (...a: unknown[]) => getAgentNameAndStatusMock(...(a as [])),
  bindConversationAgent: (...a: unknown[]) => bindMock(...(a as [])),
  upsertConversationReference: jest.fn(),
  isDuplicateActivity: (...a: unknown[]) => isDupMock(...(a as [])),
  searchAgents: jest.fn(async () => []),
}));

jest.mock('../../../billing/execution-guard', () => ({
  checkExecutionAllowed: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../teams-chat-worker', () => ({ handleTeamsChatTask: jest.fn() }));
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

async function pickIn(conversationType: 'personal' | 'channel' | 'groupChat'): Promise<string> {
  const sent: string[] = [];
  const ctx = {
    activity: {
      id: `act-${conversationType}`, type: 'message',
      conversation: { id: 'conv-1', conversationType },
      from: { id: 'teams-user-1', name: 'Alex', aadObjectId: 'aad-user-1' },
      channelData: { tenant: { id: 'aad-1' } },
      value: { action: 'pick_agent', agentId: 'agent-2' },
    },
    sendActivity: async (a: unknown) => { sent.push(typeof a === 'string' ? a : JSON.stringify(a)); },
  };
  const bot = new LiftoffTeamsBot();
  await (bot as unknown as { handleMessage: (c: unknown) => Promise<void> }).handleMessage(ctx);
  return sent.join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  findTenantMock.mockResolvedValue('tenant-1');
  isDupMock.mockResolvedValue(false);
  bindMock.mockResolvedValue(undefined);
  getAgentNameAndStatusMock.mockResolvedValue({ displayName: 'Code Reviewer', status: 'active' });
});

describe('Teams picker confirmation', () => {
  it('names the teammate and how to reopen the picker in a 1:1 chat', async () => {
    const text = await pickIn('personal');
    expect(text).toContain('You are now talking to Code Reviewer');
    expect(text).toContain('say `switch`');
  });

  it('speaks to the whole channel, not the person who picked', async () => {
    const text = await pickIn('channel');
    expect(text).not.toMatch(/\byou\b/i);
    expect(text).toContain('the agent for this channel');
    expect(text).toContain('Anyone here can mention @Liftoff');
    // Teams delivers a channel message to the bot only when it is mentioned,
    // so a bare switch would never reach us there.
    expect(text).toContain('say `@Liftoff switch`');
  });

  it('calls a group chat a chat, not a channel', async () => {
    const text = await pickIn('groupChat');
    expect(text).toContain('the agent for this chat');
    expect(text).not.toContain('this channel');
  });

  it('uses no contractions in any scope', async () => {
    for (const s of ['personal', 'channel', 'groupChat'] as const) {
      expect(await pickIn(s)).not.toMatch(/\w'(s|re|t|ll|ve|m)\b/);
    }
  });
});
