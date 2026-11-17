// Workspace-app interactivity fork (ADR-040): env-secret signature gate,
// external_select options load (block_suggestion), and picker selection →
// binding + channel self-join + picker replacement.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('../../../infrastructure/database', () => ({
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getApproval: jest.fn() },
}));
jest.mock('../../../internal-agent-oversight/service-internal', () => ({
  approveApprovalAsService: jest.fn(),
  rejectApprovalAsService: jest.fn(),
}));
jest.mock('../review-dm-notifier', () => ({
  chatUpdateAllSiblingCards: jest.fn(),
  reviewDashboardUrl: (id: string) => `https://app.test/review?approvalId=${id}`,
}));
jest.mock('../bot-token-service', () => ({
  resolveBotToken: jest.fn(),
  resolveWorkspaceBotToken: jest.fn(async () => 'xoxb-ws'),
}));

const verifyWsSigMock = jest.fn<() => boolean>();
jest.mock('../webhook-router', () => ({
  verifyWorkspaceSlackSignature: (...a: unknown[]) => verifyWsSigMock(...(a as [])),
}));

jest.mock('../workspace-app', () => ({
  isWorkspaceAppEvent: (id: string | undefined) => id === 'A0LIFTOFF',
}));

const findInstallMock = jest.fn<() => Promise<unknown>>();
const bindAgentMock = jest.fn<() => Promise<void>>();
const agentNameMock = jest.fn<() => Promise<unknown>>();
jest.mock('../workspace-repository', () => ({
  findWorkspaceInstallByTeam: (...a: unknown[]) => findInstallMock(...(a as [])),
  bindAgent: (...a: unknown[]) => bindAgentMock(...(a as [])),
  getAgentNameAndStatus: (...a: unknown[]) => agentNameMock(...(a as [])),
}));

const dispatchChatTurnMock = jest.fn<() => Promise<void>>();
jest.mock('../workspace-event-handler', () => ({
  enqueueChatTurn: (...a: unknown[]) => dispatchChatTurnMock(...(a as [])),
}));
jest.mock('../../chat-turn-dispatch', () => ({
  isDuplicateTaskError: () => false,
}));

const searchAgentsMock = jest.fn<() => Promise<unknown>>();
jest.mock('../../teams-adapter/repository', () => ({
  searchAgents: (...a: unknown[]) => searchAgentsMock(...(a as [])),
}));

const slackApiFetchMock = jest.fn<() => Promise<Record<string, unknown>>>();
jest.mock('../slack-api', () => ({
  slackApiFetch: (...a: unknown[]) => slackApiFetchMock(...(a as [])),
}));

import { slackInteractivityRouterExport } from '../interactivity-router';

// restoreMocks:true un-spies global.fetch after every test — the spy must be
// re-created per test, not once at module scope.
let fetchSpy: jest.SpiedFunction<typeof fetch>;

function makeApp() {
  const app = express();
  app.use('/interactivity', express.raw({ type: '*/*' }), slackInteractivityRouterExport);
  return app;
}

function post(payload: Record<string, unknown>) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  return request(makeApp())
    .post('/interactivity')
    .set('content-type', 'application/x-www-form-urlencoded')
    .set('x-slack-request-timestamp', '123')
    .set('x-slack-signature', 'v0=sig')
    .send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  verifyWsSigMock.mockReturnValue(true);
  findInstallMock.mockResolvedValue({
    id: 'ws-1', tenantId: 'tenant-1', slackTeamId: 'T1',
    slackBotTokenSecretPath: 'p', installStatus: 'installed',
  });
  searchAgentsMock.mockResolvedValue([
    { agentId: 'agent-1', label: 'Code Reviewer' },
    { agentId: 'agent-2', label: 'Claude Coder' },
  ]);
  slackApiFetchMock.mockResolvedValue({ ok: true });
  agentNameMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'active' });
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as unknown as globalThis.Response);
});

describe('workspace interactivity — signature + tenant gates', () => {
  it('401s when the env-secret signature fails', async () => {
    verifyWsSigMock.mockReturnValue(false);
    const res = await post({ type: 'block_suggestion', api_app_id: 'A0LIFTOFF', team: { id: 'T1' }, action_id: 'liftoff_pick_agent', block_id: 'x', value: '' });
    expect(res.status).toBe(401);
  });

  it('acks-and-ignores an unknown workspace', async () => {
    findInstallMock.mockResolvedValue(null);
    const res = await post({ type: 'block_suggestion', api_app_id: 'A0LIFTOFF', team: { id: 'T1' }, action_id: 'liftoff_pick_agent', block_id: 'x', value: '' });
    expect(res.status).toBe(200);
    expect(searchAgentsMock).not.toHaveBeenCalled();
  });
});

describe('workspace interactivity — picker', () => {
  it('block_suggestion returns live agent options for the typed query', async () => {
    const res = await post({
      type: 'block_suggestion', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      action_id: 'liftoff_pick_agent', block_id: 'liftoff_pickctx|dm|D1|', value: 'cod',
    });
    expect(res.status).toBe(200);
    expect(searchAgentsMock).toHaveBeenCalledWith('tenant-1', 'cod', 15);
    expect(res.body.options).toEqual([
      { text: { type: 'plain_text', text: 'Code Reviewer' }, value: 'agent-1' },
      { text: { type: 'plain_text', text: 'Claude Coder' }, value: 'agent-2' },
    ]);
  });

  it('a DM selection binds the DM-level slot with the picker context', async () => {
    const res = await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'D1' }, message: { ts: '1.0' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: 'liftoff_pickctx|dm|D1||',
        value: '', selected_option: { value: 'agent-2' },
      }],
    });
    expect(res.status).toBe(200);
    expect(bindAgentMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1', agentId: 'agent-2', slackTeamId: 'T1',
      channelId: 'D1', threadRootTs: null, scope: 'dm', slackUserId: 'U7',
    });
    // DM scope: no self-join.
    expect(slackApiFetchMock).not.toHaveBeenCalledWith('conversations.join', expect.anything());
    // Picker message replaced with the confirmation.
    expect(fetchSpy).toHaveBeenCalledWith('https://hooks.slack.test/resp', expect.objectContaining({ method: 'POST' }));
  });

  it('a channel selection binds the channel and self-joins it', async () => {
    await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'C5' }, message: { ts: '2.0' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: 'liftoff_pickctx|channel|C5||',
        value: '', selected_option: { value: 'agent-1' },
      }],
    });
    expect(bindAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-1', channelId: 'C5', threadRootTs: null, scope: 'channel', slackUserId: null,
    }));
    expect(slackApiFetchMock).toHaveBeenCalledWith('conversations.join', expect.objectContaining({
      authToken: 'xoxb-ws',
      body: { kind: 'json', value: { channel: 'C5' } },
    }));
  });

  it('a thread-context selection binds just that thread', async () => {
    await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'C5' }, message: { ts: '3.1' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: 'liftoff_pickctx|channel|C5|3.0|',
        value: '', selected_option: { value: 'agent-1' },
      }],
    });
    expect(bindAgentMock).toHaveBeenCalledWith(expect.objectContaining({ threadRootTs: '3.0' }));
  });

  it('answers the question that opened the picker, once an agent is chosen', async () => {
    slackApiFetchMock.mockImplementation(async (method: unknown) =>
      method === 'conversations.history'
        ? { ok: true, messages: [{ ts: '9.0', text: 'take a look at PR 42' }] }
        : { ok: true },
    );
    await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'D1' }, message: { ts: '9.5' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: 'liftoff_pickctx|dm|D1||9.0',
        value: '', selected_option: { value: 'agent-2' },
      }],
    });
    expect(dispatchChatTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-2',
      agentName: 'Claude Coder',
      channelId: 'D1',
      scope: 'dm',
      eventTs: '9.0',
      text: 'take a look at PR 42',
    }));
  });

  it('does not dispatch anything when the picker held no question', async () => {
    await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'D1' }, message: { ts: '9.5' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: 'liftoff_pickctx|dm|D1||',
        value: '', selected_option: { value: 'agent-2' },
      }],
    });
    expect(dispatchChatTurnMock).not.toHaveBeenCalled();
  });

  async function pickAndReadConfirmation(blockId: string): Promise<string> {
    await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'D1' }, message: { ts: '9.5' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: blockId,
        value: '', selected_option: { value: 'agent-2' },
      }],
    });
    return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).text;
  }

  it('tells the person how to switch — the picker is replaced by this message', async () => {
    const text = await pickAndReadConfirmation('liftoff_pickctx|dm|D1||');
    expect(text).toContain('Claude Coder');
    // The only place switching is discoverable: the picker does not persist,
    // and reopening it is the only route that shows who is available.
    expect(text).toContain('say `switch`');
    expect(text).not.toContain('\u2014');
  });

  it('speaks to the whole channel, not the person who picked', async () => {
    const text = await pickAndReadConfirmation('liftoff_pickctx|channel|C5||');
    // Public and permanent in the channel, and read mostly by people who did
    // not pick, so it must not address a single reader.
    expect(text).not.toMatch(/\byou\b/i);
    expect(text).toContain('Anyone here can mention @Liftoff');
    // The mention is required in a channel: a bare switch is ignored there.
    expect(text).toContain('say `@Liftoff switch`');
  });

  it('uses no contractions in either scope', async () => {
    const dm = await pickAndReadConfirmation('liftoff_pickctx|dm|D1||');
    fetchSpy.mockClear();
    const channel = await pickAndReadConfirmation('liftoff_pickctx|channel|C5||');
    for (const text of [dm, channel]) expect(text).not.toMatch(/\w'(s|re|t|ll|ve|m)\b/);
  });

  it('ignores a selection with an undecodable block_id', async () => {
    const res = await post({
      type: 'block_actions', api_app_id: 'A0LIFTOFF', team: { id: 'T1' },
      user: { id: 'U7' }, trigger_id: 'tr', channel: { id: 'C5' }, message: { ts: '4.0' },
      response_url: 'https://hooks.slack.test/resp',
      actions: [{
        action_id: 'liftoff_pick_agent', block_id: 'not-a-context',
        value: '', selected_option: { value: 'agent-1' },
      }],
    });
    expect(res.status).toBe(200);
    expect(bindAgentMock).not.toHaveBeenCalled();
  });
});
