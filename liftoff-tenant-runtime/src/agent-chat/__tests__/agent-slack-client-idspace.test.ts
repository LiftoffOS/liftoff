// Regression (INV-TR-010): PB keys agent_slack_installs by the INTERNAL agent
// id, but TR callers hold the RUNTIME id. Before the client-boundary
// translation, the installs lookup silently returned [] for every mapped
// agent — Claude Coder's April Slack install existed the whole time while its
// chat catalog lost the slack_* bot tools.

const mockResolve = jest.fn();
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: (...a: unknown[]) => mockResolve(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('listAgentSlackInstalls id-space translation', () => {
  const RUNTIME = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';
  const INTERNAL = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
    process.env.AGENT_SLACK_SERVICE_TOKEN = 'svc-token';
  });
  afterEach(() => {
    delete process.env.PLATFORM_BACKEND_URL;
    delete process.env.AGENT_SLACK_SERVICE_TOKEN;
  });

  it('queries PB with the INTERNAL id when the runtime id maps', async () => {
    mockResolve.mockResolvedValue(INTERNAL);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        installs: [{
          installId: 'i1', slackAppId: 'A1', slackTeamId: 'T1',
          slackTeamName: null, slackBotUserId: null, installedAt: '',
          botToken: 'xoxb-1',
        }],
      }),
    } as unknown as Response);

    const { listAgentSlackInstalls } = require('../agent-slack-client') as typeof import('../agent-slack-client');
    const installs = await listAgentSlackInstalls('t1', RUNTIME);

    expect(installs).toHaveLength(1);
    expect(mockResolve).toHaveBeenCalledWith('t1', RUNTIME, 'agent-slack-client.listAgentSlackInstalls');
    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('agentId')).toBe(INTERNAL);
    fetchSpy.mockRestore();
  });

  it('falls back to the given id when no mapping row exists (already-internal callers)', async () => {
    mockResolve.mockResolvedValue(null);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ installs: [] }),
    } as unknown as Response);

    const { listAgentSlackInstalls } = require('../agent-slack-client') as typeof import('../agent-slack-client');
    await listAgentSlackInstalls('t1', INTERNAL);

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('agentId')).toBe(INTERNAL);
    fetchSpy.mockRestore();
  });
});
