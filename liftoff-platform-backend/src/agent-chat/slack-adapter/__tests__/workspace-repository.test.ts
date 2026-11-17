// slack_conversation_agents binding CRUD (migration 314): upsert arbiter must
// match the expression unique index (COALESCE(thread_root_ts, '')), and
// binding lookups fold NULL thread_root_ts into the channel-level slot.

import { jest } from '@jest/globals';

const tenantQueryMock = jest.fn<(...a: unknown[]) => Promise<{ rows: unknown[] }>>();
const adminQueryMock = jest.fn<(...a: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof tenantQueryMock }) => Promise<unknown>) =>
    fn({ query: tenantQueryMock }),
  withAdminScope: (_o: unknown, fn: (c: { query: typeof adminQueryMock }) => Promise<unknown>) =>
    fn({ query: adminQueryMock }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  bindAgent,
  getBinding,
  findWorkspaceInstallByTeam,
  upsertWorkspaceInstall,
} from '../workspace-repository';

beforeEach(() => {
  jest.clearAllMocks();
  tenantQueryMock.mockResolvedValue({ rows: [] });
  adminQueryMock.mockResolvedValue({ rows: [] });
});

describe('bindAgent', () => {
  it('upserts on the COALESCE expression index with null thread for channel-level bindings', async () => {
    await bindAgent({
      tenantId: 't1', agentId: 'a1', slackTeamId: 'T1',
      channelId: 'C1', threadRootTs: null, scope: 'channel',
    });
    const [sql, params] = tenantQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT (slack_team_id, channel_id, COALESCE(thread_root_ts, ''))");
    expect(params).toEqual(['t1', 'a1', null, 'T1', 'C1', null, 'channel', null, null]);
  });

  it('passes the thread root for thread bindings', async () => {
    await bindAgent({
      tenantId: 't1', agentId: 'a1', slackTeamId: 'T1',
      channelId: 'D1', threadRootTs: '9.0', scope: 'dm', slackUserId: 'U1', accountId: 'acc1',
    });
    const [, params] = tenantQueryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['t1', 'a1', null, 'T1', 'D1', '9.0', 'dm', 'U1', 'acc1']);
  });

  it('binds a platform assistant by its reserved id, in the other column', async () => {
    // 'caio' is not a UUID and never an internal_agents id: it goes to
    // assistant_kind, and agent_id stays NULL.
    await bindAgent({
      tenantId: 't1', agentId: 'caio', slackTeamId: 'T1',
      channelId: 'D1', threadRootTs: null, scope: 'dm', slackUserId: 'U1',
    });
    const [sql, params] = tenantQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('assistant_kind');
    expect(params).toEqual(['t1', null, 'caio', 'T1', 'D1', null, 'dm', 'U1', null]);
  });
});

describe('getBinding', () => {
  it('folds a null thread into the channel-level slot via COALESCE', async () => {
    await getBinding('t1', 'T1', 'C1', null);
    const [sql, params] = tenantQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("COALESCE(thread_root_ts, '') = COALESCE($4, '')");
    expect(params).toEqual(['t1', 'T1', 'C1', null]);
  });

  it('maps a row to the binding shape', async () => {
    tenantQueryMock.mockResolvedValue({ rows: [{
      id: 'b1', tenant_id: 't1', agent_id: 'a1', slack_team_id: 'T1',
      channel_id: 'C1', thread_root_ts: null, scope: 'channel',
      slack_user_id: null, account_id: null,
    }] });
    const binding = await getBinding('t1', 'T1', 'C1', null);
    expect(binding).toEqual({
      id: 'b1', tenantId: 't1', agentId: 'a1', assistantKind: null, slackTeamId: 'T1',
      channelId: 'C1', threadRootTs: null, scope: 'channel',
      slackUserId: null, accountId: null,
    });
  });

  it('reads an assistant binding back under the reserved id, with its thread', async () => {
    tenantQueryMock.mockResolvedValue({ rows: [{
      id: 'b2', tenant_id: 't1', agent_id: null, assistant_kind: 'insights',
      slack_team_id: 'T1', channel_id: 'D1', thread_root_ts: null, scope: 'dm',
      slack_user_id: 'U1', account_id: 'acc1',
    }] });
    const binding = await getBinding('t1', 'T1', 'D1', null);
    expect(binding).toMatchObject({ agentId: 'insights', assistantKind: 'insights' });
  });
});

describe('the three assistants are colleagues too', () => {
  it('resolves an assistant by name before the roster, and its status is always active', async () => {
    const { findAgentByName, getAgentNameAndStatus } = require('../workspace-repository') as typeof import('../workspace-repository');
    expect(await findAgentByName('t1', 'chief ai officer')).toEqual({ agentId: 'caio', displayName: 'Chief AI Officer' });
    expect(tenantQueryMock).not.toHaveBeenCalled();
    expect(await getAgentNameAndStatus('t1', 'liftoff')).toEqual({ displayName: 'Liftoff', status: 'active' });
  });

  it('sets a workspace default of an assistant in its own column', async () => {
    const { setWorkspaceDefaultAgent } = require('../workspace-repository') as typeof import('../workspace-repository');
    tenantQueryMock.mockResolvedValue({ rowCount: 1, rows: [] });
    await setWorkspaceDefaultAgent('t1', 'T1', 'liftoff');
    const [, params] = tenantQueryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['t1', 'T1', null, 'liftoff']);
  });
});

describe('findLatestReviewCardInDm', () => {
  it('orders by the column that actually exists (posted_at, not created_at)', async () => {
    const { findLatestReviewCardInDm } = require('../workspace-repository') as typeof import('../workspace-repository');
    await findLatestReviewCardInDm('t1', 'T1', 'D1');
    const [sql, params] = tenantQueryMock.mock.calls[0] as [string, unknown[]];
    // review_slack_messages (migration 246) has posted_at; ordering by
    // created_at threw and, unguarded, took the instance down.
    expect(sql).toContain('ORDER BY posted_at DESC');
    expect(sql).not.toContain('created_at');
    expect(params).toEqual(['t1', 'T1', 'D1']);
  });

  it('maps the row to reviewId + rootTs', async () => {
    tenantQueryMock.mockResolvedValue({ rows: [{ review_id: 'r1', slack_dm_root_ts: '100.1' }] });
    const { findLatestReviewCardInDm } = require('../workspace-repository') as typeof import('../workspace-repository');
    await expect(findLatestReviewCardInDm('t1', 'T1', 'D1')).resolves.toEqual({ reviewId: 'r1', rootTs: '100.1' });
  });
});

describe('installs', () => {
  it('findWorkspaceInstallByTeam runs under admin scope and filters to installed', async () => {
    await findWorkspaceInstallByTeam('T1');
    expect(adminQueryMock).toHaveBeenCalled();
    const [sql, params] = adminQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("install_status = 'installed'");
    expect(params).toEqual(['T1']);
    expect(tenantQueryMock).not.toHaveBeenCalled();
  });

  it('upsertWorkspaceInstall keys on slack_team_id and re-activates revoked rows', async () => {
    await upsertWorkspaceInstall({
      tenantId: 't1', slackTeamId: 'T1', slackTeamName: 'Acme',
      slackBotUserId: 'UBOT', slackBotTokenSecretPath: 'path', installedByAccountId: 'acc1',
    });
    const [sql] = tenantQueryMock.mock.calls[0] as [string];
    expect(sql).toContain('ON CONFLICT (slack_team_id) DO UPDATE');
    expect(sql).toContain("install_status = 'installed'");
  });
});
