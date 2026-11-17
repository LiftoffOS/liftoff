// Tests for the per-agent Slack tool handler. Mocks the agent-slack-client
// (install resolution + channel-binding lookup) and the slack-api module
// (Slack Web API). Verifies each tool dispatches with the right API method
// and surfaces structured errors for the agent.

import { jest } from '@jest/globals';

const resolveInstallForCallMock = jest.fn();
const slackApiCallMock = jest.fn();

jest.mock('../../agent-chat/agent-slack-client', () => {
  const orig = jest.requireActual('../../agent-chat/agent-slack-client') as Record<
    string,
    unknown
  >;
  return {
    ...orig,
    resolveInstallForCall: (...args: unknown[]) => resolveInstallForCallMock(...args),
  };
});

jest.mock('../../agent-chat/slack-api', () => {
  const orig = jest.requireActual('../../agent-chat/slack-api') as Record<
    string,
    unknown
  >;
  return {
    ...orig,
    slackApiCall: (...args: unknown[]) => slackApiCallMock(...args),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const INSTALL = {
  installId: 'inst-1',
  slackAppId: 'A1',
  slackTeamId: 'T1',
  slackTeamName: 'Acme',
  slackBotUserId: 'U1',
  installedAt: '2026-05-28T00:00:00Z',
  botToken: 'xoxb-test',
};

beforeEach(() => {
  jest.clearAllMocks();
  resolveInstallForCallMock.mockResolvedValue(INSTALL);
});

describe('agent-slack-handler', () => {
  it('slack_send_message calls chat.postMessage with channel + text', async () => {
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '1.2' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_message',
      toolInput: { channel: '#customer-support', text: 'hi' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith(
      'chat.postMessage',
      'xoxb-test',
      { channel: '#customer-support', text: 'hi' },
    );
    expect(r).toMatchObject({ success: true });
    expect((r.data as { channel: string; ts: string }).ts).toBe('1.2');
  });

  it('slack_reply_in_thread includes thread_ts', async () => {
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '2.2' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_reply_in_thread',
      toolInput: { channel: 'C1', thread_ts: '1.0', text: 'reply' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith(
      'chat.postMessage',
      'xoxb-test',
      { channel: 'C1', thread_ts: '1.0', text: 'reply' },
    );
  });

  it('slack_update_message calls chat.update', async () => {
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '1.0' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_update_message',
      toolInput: { channel: 'C1', ts: '1.0', text: 'edit' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith('chat.update', 'xoxb-test', {
      channel: 'C1',
      ts: '1.0',
      text: 'edit',
    });
  });

  it('slack_add_reaction strips leading/trailing colons on emoji', async () => {
    slackApiCallMock.mockResolvedValueOnce({ ok: true });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_add_reaction',
      toolInput: { channel: 'C1', ts: '1.0', emoji: ':white_check_mark:' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith('reactions.add', 'xoxb-test', {
      channel: 'C1',
      timestamp: '1.0',
      name: 'white_check_mark',
    });
  });

  it('slack_list_channels passes types + cursor + exclude_archived', async () => {
    slackApiCallMock.mockResolvedValueOnce({
      ok: true,
      channels: [{ id: 'C1', name: 'general', is_member: true }],
      response_metadata: { next_cursor: 'cur-2' },
    });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_list_channels',
      toolInput: { types: 'public_channel', cursor: 'cur-1', limit: 50 },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith(
      'conversations.list',
      'xoxb-test',
      {
        types: 'public_channel',
        limit: 50,
        exclude_archived: true,
        cursor: 'cur-1',
      },
    );
    expect((r.data as { next_cursor: string }).next_cursor).toBe('cur-2');
  });

  it('slack_resolve_channel_by_name strips leading # and matches case-insensitive', async () => {
    slackApiCallMock.mockResolvedValueOnce({
      ok: true,
      channels: [
        { id: 'C1', name: 'general' },
        { id: 'C2', name: 'Customer-Support' },
      ],
    });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_resolve_channel_by_name',
      toolInput: { name: '#customer-support' },
      traceId: 'tr',
    });
    expect((r.data as { channel_id: string }).channel_id).toBe('C2');
  });

  it('slack_send_dm opens conversation then posts', async () => {
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: { id: 'D1' } });
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: 'D1', ts: '3.4' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_dm',
      toolInput: { user_id: 'U2', text: 'hi' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenNthCalledWith(1, 'conversations.open', 'xoxb-test', { users: 'U2' });
    expect(slackApiCallMock).toHaveBeenNthCalledWith(2, 'chat.postMessage', 'xoxb-test', { channel: 'D1', text: 'hi' });
    expect((r.data as { ts: string }).ts).toBe('3.4');
  });

  it('returns slack_not_installed error when no install exists', async () => {
    const { SlackNotInstalledError } = await import('../../agent-chat/agent-slack-client');
    resolveInstallForCallMock.mockRejectedValueOnce(
      new SlackNotInstalledError('Agent a1 has no installed Slack workspaces.'),
    );
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_message',
      toolInput: { channel: 'C1', text: 'hi' },
      traceId: 'tr',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^slack_not_installed:/);
  });

  it('returns slack_workspace_ambiguous when multiple installs and no workspace selected', async () => {
    const { SlackWorkspaceAmbiguousError } = await import(
      '../../agent-chat/agent-slack-client'
    );
    resolveInstallForCallMock.mockRejectedValueOnce(
      new SlackWorkspaceAmbiguousError('multi'),
    );
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_message',
      toolInput: { channel: 'C1', text: 'hi' },
      traceId: 'tr',
    });
    expect(r.error).toMatch(/^slack_workspace_ambiguous:/);
  });

  it('surfaces SlackApiError with slack_api_error:<code> prefix', async () => {
    const { SlackApiError } = await import('../../agent-chat/slack-api');
    slackApiCallMock.mockRejectedValueOnce(
      new SlackApiError('chat.postMessage', 'not_in_channel', 200),
    );
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_message',
      toolInput: { channel: 'C1', text: 'hi' },
      traceId: 'tr',
    });
    expect(r.error).toBe('slack_api_error:not_in_channel: slack chat.postMessage: not_in_channel');
  });

  it('rejects unknown tool names', async () => {
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_invalid',
      toolInput: {},
      traceId: 'tr',
    });
    expect(r.error).toMatch(/unknown_slack_tool/);
  });
});

// ── Workspace-app installs (ADR-040): postAs → chat:write.customize ─────────

describe('agent-slack-handler workspace postAs', () => {
  const WS_INSTALL = {
    ...INSTALL,
    installId: 'ws:inst-9',
    kind: 'workspace' as const,
    postAs: { username: 'Code Reviewer' },
  };

  it('slack_send_message names the agent in the text, leaving the sender as the Liftoff app', async () => {
    resolveInstallForCallMock.mockResolvedValue(WS_INSTALL);
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '3.3' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    const r = await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_message',
      toolInput: { channel: '#ci-alerts', text: 'ship it' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith(
      'chat.postMessage',
      'xoxb-test',
      { channel: '#ci-alerts', text: 'Code Reviewer: ship it' },
    );
    expect(r).toMatchObject({ success: true });
  });

  it('slack_send_dm carries the username through conversations.open + post', async () => {
    resolveInstallForCallMock.mockResolvedValue(WS_INSTALL);
    slackApiCallMock
      .mockResolvedValueOnce({ ok: true, channel: { id: 'D9' } })
      .mockResolvedValueOnce({ ok: true, channel: 'D9', ts: '4.4' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_send_dm',
      toolInput: { user_id: 'U7', text: 'need your approval' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenNthCalledWith(
      2,
      'chat.postMessage',
      'xoxb-test',
      { channel: 'D9', text: 'Code Reviewer: need your approval' },
    );
  });

  it('legacy per-agent installs post unprefixed (that bot IS the agent)', async () => {
    resolveInstallForCallMock.mockResolvedValue(INSTALL);
    slackApiCallMock.mockResolvedValueOnce({ ok: true, channel: 'C1', ts: '5.5' });
    const { agentSlackHandler } = await import('../agent-slack-handler');
    await agentSlackHandler.execute({
      tenantId: 't1',
      agentId: 'a1',
      toolName: 'slack_reply_in_thread',
      toolInput: { channel: 'C1', thread_ts: '1.0', text: 'reply' },
      traceId: 'tr',
    });
    expect(slackApiCallMock).toHaveBeenCalledWith(
      'chat.postMessage',
      'xoxb-test',
      { channel: 'C1', thread_ts: '1.0', text: 'reply' },
    );
  });
});
