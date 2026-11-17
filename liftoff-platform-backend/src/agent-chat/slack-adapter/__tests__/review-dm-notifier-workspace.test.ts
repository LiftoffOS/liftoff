// Escalation fan-out via the workspace app (ADR-040): workspace install
// preferred over per-agent installs, cards posted under the agent's name,
// and the card's thread bound to the owning agent. One app posted every card,
// so one token updates them all.

import { jest } from '@jest/globals';

const queryMock = jest.fn<(...a: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const resolveWsTokenMock = jest.fn<() => Promise<string | null>>();
jest.mock('../bot-token-service', () => ({
  resolveWorkspaceBotToken: (...a: unknown[]) => resolveWsTokenMock(...(a as [])),
}));

const resolveIdentityMock = jest.fn<() => Promise<unknown>>();
jest.mock('../identity-resolver', () => ({
  resolveSlackIdentity: (...a: unknown[]) => resolveIdentityMock(...(a as [])),
}));

const slackApiFetchMock = jest.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>();
jest.mock('../slack-api', () => ({
  slackApiFetch: (...a: unknown[]) => slackApiFetchMock(...a),
}));

const getWsInstallMock = jest.fn<() => Promise<unknown>>();
const bindAgentMock = jest.fn<() => Promise<void>>();
jest.mock('../workspace-repository', () => ({
  getInstalledWorkspaceInstall: (...a: unknown[]) => getWsInstallMock(...(a as [])),
  bindAgent: (...a: unknown[]) => bindAgentMock(...(a as [])),
}));

import { postReviewDmFanout, chatUpdateAllSiblingCards } from '../review-dm-notifier';

const WS_INSTALL = {
  id: 'ws-1', tenantId: 'tenant-1', slackTeamId: 'T1', slackTeamName: 'Acme',
  slackBotUserId: 'UBOT', slackBotTokenSecretPath: 'p', installStatus: 'installed',
  installedAt: '2026-08-01T00:00:00.000Z',
};

const PAYLOAD = {
  reviewId: '33333333-3333-3333-3333-333333333333',
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  channelId: 'C9',
  draftText: 'draft body',
  assigneeAccountIds: ['44444444-4444-4444-4444-444444444444'],
};

beforeEach(() => {
  jest.clearAllMocks();
  bindAgentMock.mockResolvedValue(undefined);
  resolveWsTokenMock.mockResolvedValue('xoxb-ws');
  resolveIdentityMock.mockResolvedValue({ slackTeamId: 'T1', slackUserId: 'U44' });
  // Query order in postReviewDmFanout: assignee emails, agent display name,
  // per-agent installs (parallel), then the review_slack_messages INSERT.
  queryMock.mockImplementation(async (sql: unknown) => {
    const q = String(sql);
    if (q.includes('FROM accounts a')) {
      return { rows: [{ account_id: PAYLOAD.assigneeAccountIds[0], email: 'h@acme.test' }] };
    }
    if (q.includes('FROM internal_agents')) {
      return { rows: [{ display_name: 'Code Reviewer' }] };
    }
    if (q.includes('FROM agent_slack_installs')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
});

describe('postReviewDmFanout — workspace app preferred', () => {
  it('posts the card via the workspace token, records posted_via, binds the card thread', async () => {
    getWsInstallMock.mockResolvedValue(WS_INSTALL);
    slackApiFetchMock.mockImplementation(async (method: unknown) => {
      if (method === 'conversations.info') return { ok: true, channel: { name: 'ci-alerts' } };
      if (method === 'conversations.open') return { ok: true, channel: { id: 'D77' } };
      if (method === 'chat.postMessage') return { ok: true, ts: '100.1' };
      return { ok: true };
    });

    const result = await postReviewDmFanout(PAYLOAD);

    expect(result).toEqual({ totalAssignees: 1, delivered: 1, unreachable: [] });

    const postCall = slackApiFetchMock.mock.calls.find(([m]) => m === 'chat.postMessage');
    expect(postCall).toBeDefined();
    const postBody = (postCall![1] as { authToken: string; body: { value: Record<string, unknown> } });
    expect(postBody.authToken).toBe('xoxb-ws');
    expect(postBody.body.value.channel).toBe('D77');
    // The sender stays the Liftoff app: the card names the agent in its body
    // (Agent field + fallback text), never by renaming the bot.
    expect(postBody.body.value.username).toBeUndefined();
    expect(postBody.body.value.text).toContain('Code Reviewer');

    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO review_slack_messages'));
    expect(insert).toBeDefined();

    expect(bindAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1', channelId: 'D77', threadRootTs: '100.1',
      scope: 'dm', slackUserId: 'U44', accountId: PAYLOAD.assigneeAccountIds[0],
    }));
  });

  it('reports everyone unreachable when Slack is not connected for the tenant', async () => {
    getWsInstallMock.mockResolvedValue(null);
    const result = await postReviewDmFanout(PAYLOAD);
    expect(result).toEqual({
      totalAssignees: 1, delivered: 0, unreachable: PAYLOAD.assigneeAccountIds,
    });
    expect(bindAgentMock).not.toHaveBeenCalled();
  });

  it('reports an assignee unreachable when their Slack identity cannot be resolved', async () => {
    getWsInstallMock.mockResolvedValue(WS_INSTALL);
    resolveIdentityMock.mockResolvedValue(null);
    slackApiFetchMock.mockResolvedValue({ ok: true, channel: { name: 'ci-alerts' } });
    const result = await postReviewDmFanout(PAYLOAD);
    expect(result.delivered).toBe(0);
    expect(result.unreachable).toEqual(PAYLOAD.assigneeAccountIds);
  });
});

describe('chatUpdateAllSiblingCards', () => {
  it('updates every sibling card with the one workspace token', async () => {
    getWsInstallMock.mockResolvedValue(WS_INSTALL);
    queryMock.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('FROM review_slack_messages')) {
        return { rows: [
          { slack_team_id: 'T1', slack_dm_channel_id: 'D77', slack_dm_root_ts: '100.1' },
          { slack_team_id: 'T1', slack_dm_channel_id: 'D88', slack_dm_root_ts: '200.1' },
        ] };
      }
      return { rows: [] };
    });
    slackApiFetchMock.mockResolvedValue({ ok: true });

    await chatUpdateAllSiblingCards({ reviewId: 'r1', tenantId: 'tenant-1', footer: 'done' });

    const updates = slackApiFetchMock.mock.calls.filter(([m]) => m === 'chat.update');
    expect(updates).toHaveLength(2);
    // One bot posted them all, so one token updates them all.
    expect(updates.every(([, o]) => (o as { authToken: string }).authToken === 'xoxb-ws')).toBe(true);
  });
});
