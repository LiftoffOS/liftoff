// The suggested rung on Teams (Phase 9), mirrored from the Slack ladder: on an
// unbound message the team whose role the message calls for answers without
// binding; the picker card stays the fallback; a bound conversation never
// consults it; a switch never does either.

import { jest } from '@jest/globals';

const getConversationAgentMock = jest.fn<() => Promise<string | null>>();
const getAgentNameAndStatusMock = jest.fn<() => Promise<unknown>>();
const findTenantMock = jest.fn<() => Promise<string | null>>();
const isDupMock = jest.fn<() => Promise<boolean>>();
const bindMock = jest.fn();
const searchAgentsMock = jest.fn<() => Promise<unknown[]>>();
const listRouteCandidatesMock = jest.fn<() => Promise<unknown[]>>();
jest.mock('../repository', () => ({
  findTenantByAadTenant: (...a: unknown[]) => findTenantMock(...(a as [])),
  getConversationAgent: (...a: unknown[]) => getConversationAgentMock(...(a as [])),
  getAgentNameAndStatus: (...a: unknown[]) => getAgentNameAndStatusMock(...(a as [])),
  bindConversationAgent: (...a: unknown[]) => bindMock(...(a as [])),
  upsertConversationReference: jest.fn(),
  isDuplicateActivity: (...a: unknown[]) => isDupMock(...(a as [])),
  searchAgents: (...a: unknown[]) => searchAgentsMock(...(a as [])),
  listRouteCandidates: (...a: unknown[]) => listRouteCandidatesMock(...(a as [])),
}));
const suggestMock = jest.fn<() => Promise<{ agentId: string; probability: number } | null>>();
jest.mock('../../route-suggestion', () => ({
  suggestAnswerer: (...a: unknown[]) => suggestMock(...(a as [])),
}));

const checkExecutionAllowedMock = jest.fn<() => Promise<unknown>>();
jest.mock('../../../billing/execution-guard', () => ({
  checkExecutionAllowed: (...a: unknown[]) => checkExecutionAllowedMock(...(a as [])),
}));
const handleTeamsChatTaskMock = jest.fn<() => Promise<void>>();
jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({ topic: () => ({ publishMessage: jest.fn().mockResolvedValue('msg-1') }) })),
}));
jest.mock('../../chat-turn-dispatch', () => ({
  enqueueChatTurnTask: (_dedupeId: string, payload: { task: unknown }) => handleTeamsChatTaskMock(payload.task as never),
  isDuplicateTaskError: () => false,
}));
jest.mock('../identity-resolver', () => ({
  resolveTeamsUser: jest.fn(async () => ({ userId: 'acc-1', accountId: 'acc-1', displayName: 'Alex', identityLabel: 'Alex' })),
}));
jest.mock('../cards', () => ({ buildAgentPickerCard: jest.fn(() => ({ picker: true })), buildSearchResponse: jest.fn() }));
jest.mock('../review-card-notifier', () => ({ updateAllReviewCards: jest.fn() }));
jest.mock('../../../infrastructure/database', () => ({ withTenantScope: jest.fn(), getPool: jest.fn() }));
const logInfo = jest.fn();
jest.mock('../../../infrastructure/logging', () => ({ log: { info: (...a: unknown[]) => logInfo(...(a as [])), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../../internal-agent-oversight/service-internal', () => ({ approveApprovalForActor: jest.fn(), rejectApprovalForActor: jest.fn() }));

import { LiftoffTeamsBot } from '../teams-bot-handler';

function makeCtx(text: string) {
  const sent: unknown[] = [];
  return {
    sent,
    ctx: {
      activity: {
        id: 'act-1', type: 'message', text,
        conversation: { id: 'conv-1', conversationType: 'personal' },
        from: { id: 'teams-user-1', name: 'Alex' },
        channelData: { tenant: { id: 'aad-1' } },
      },
      sendActivity: async (a: unknown) => { sent.push(a); },
    },
  };
}
async function run(text: string) {
  const { ctx, sent } = makeCtx(text);
  const bot = new LiftoffTeamsBot();
  await (bot as unknown as { handleMessage: (c: unknown) => Promise<void> }).handleMessage(ctx);
  return sent;
}
const pickerSent = (sent: unknown[]) => sent.some((a) => JSON.stringify(a).includes('"picker":true'));

beforeEach(() => {
  jest.clearAllMocks();
  findTenantMock.mockResolvedValue('tenant-1');
  isDupMock.mockResolvedValue(false);
  getConversationAgentMock.mockResolvedValue(null);
  getAgentNameAndStatusMock.mockResolvedValue({ displayName: 'Code Reviewer', status: 'active' });
  checkExecutionAllowedMock.mockResolvedValue({ allowed: true });
  handleTeamsChatTaskMock.mockResolvedValue(undefined);
  searchAgentsMock.mockResolvedValue([]);
  listRouteCandidatesMock.mockResolvedValue([{ id: 'agent-reviewer', role: 'Code Reviewer', summary: 'Reviews pull requests' }]);
  suggestMock.mockResolvedValue(null);
});

describe('Teams: the suggested rung', () => {
  it('the suggested team answers an unbound message without binding', async () => {
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.9 });
    const sent = await run('can you review PR 412');
    expect(suggestMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', message: 'can you review PR 412', channel: { kind: 'dm' }, surface: 'teams',
    }));
    expect(handleTeamsChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-reviewer' }));
    expect(bindMock).not.toHaveBeenCalled();
    expect(pickerSent(sent)).toBe(false);
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ event: 'teams_turn_routed', rung: 'suggested', probability: 0.9 }), expect.any(String));
  });

  it('the picker card on none / sub-threshold / null', async () => {
    const sent = await run('hi');
    expect(pickerSent(sent)).toBe(true);
    expect(handleTeamsChatTaskMock).not.toHaveBeenCalled();
  });

  it('a bound conversation never consults it (no roster query)', async () => {
    getConversationAgentMock.mockResolvedValue('agent-9');
    await run('hello');
    expect(listRouteCandidatesMock).not.toHaveBeenCalled();
    expect(suggestMock).not.toHaveBeenCalled();
    expect(handleTeamsChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-9' }));
  });

  it('a switch never consults it and shows the picker', async () => {
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.99 });
    const sent = await run('switch');
    expect(suggestMock).not.toHaveBeenCalled();
    expect(pickerSent(sent)).toBe(true);
  });
});
