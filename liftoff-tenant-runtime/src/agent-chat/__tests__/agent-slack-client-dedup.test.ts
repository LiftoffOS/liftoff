// ADR-040 transition: an agent can hold BOTH a legacy per-agent install and
// the workspace-app virtual install for the SAME Slack team. That must not
// read as "installed in multiple workspaces" (slack_workspace_ambiguous) —
// resolveInstallForCall collapses per team id, preferring the workspace
// install (the per-agent row is pending revocation).

const mockResolve = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const BASE = {
  slackAppId: 'A1',
  slackTeamId: 'T1',
  slackTeamName: 'Acme',
  slackBotUserId: 'U1',
  installedAt: '2026-04-01T00:00:00Z',
};

describe('resolveInstallForCall workspace/legacy dedup', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
    process.env.AGENT_SLACK_SERVICE_TOKEN = 'svc-token';
    mockResolve.mockResolvedValue(null);
  });
  afterEach(() => {
    delete process.env.PLATFORM_BACKEND_URL;
    delete process.env.AGENT_SLACK_SERVICE_TOKEN;
  });

  function mockInstalls(installs: unknown[]) {
    return jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ installs }),
    } as unknown as Response);
  }

  it('prefers the workspace install when both cover the same team', async () => {
    const fetchSpy = mockInstalls([
      { ...BASE, installId: 'legacy-1', botToken: 'xoxb-legacy' },
      { ...BASE, installId: 'ws:1', botToken: 'xoxb-ws', kind: 'workspace', postAs: { username: 'Code Reviewer' } },
    ]);
    const { resolveInstallForCall } = require('../agent-slack-client') as typeof import('../agent-slack-client');
    const resolved = await resolveInstallForCall('t1', 'a1');
    expect(resolved.installId).toBe('ws:1');
    expect(resolved.postAs?.username).toBe('Code Reviewer');
    fetchSpy.mockRestore();
  });

  it('still flags genuinely distinct teams as ambiguous', async () => {
    const fetchSpy = mockInstalls([
      { ...BASE, installId: 'legacy-1', botToken: 'xoxb-1' },
      { ...BASE, installId: 'legacy-2', slackTeamId: 'T2', botToken: 'xoxb-2' },
    ]);
    const { resolveInstallForCall, SlackWorkspaceAmbiguousError } =
      require('../agent-slack-client') as typeof import('../agent-slack-client');
    await expect(resolveInstallForCall('t1', 'a1')).rejects.toBeInstanceOf(SlackWorkspaceAmbiguousError);
    fetchSpy.mockRestore();
  });

  it('a lone workspace virtual install resolves directly', async () => {
    const fetchSpy = mockInstalls([
      { ...BASE, installId: 'ws:1', botToken: 'xoxb-ws', kind: 'workspace', postAs: { username: 'New Agent' } },
    ]);
    const { resolveInstallForCall } = require('../agent-slack-client') as typeof import('../agent-slack-client');
    const resolved = await resolveInstallForCall('t1', 'a1');
    expect(resolved.installId).toBe('ws:1');
    fetchSpy.mockRestore();
  });
});
