// The slack dual-grant handoff: bot token → platform-backend
// /api/internal/agent-slack/workspace-install, authed with
// PLATFORM_CALLBACK_TOKEN. Best-effort — every failure path returns false
// and never throws (a failed handoff must not fail the connector connect).

jest.mock('../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { handoffSlackWorkspaceInstall } from './slack-workspace-handoff.js';

const INPUT = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  slackTeamId: 'T1',
  slackTeamName: 'Acme',
  slackBotUserId: 'UBOT',
  botToken: 'xoxb-bot',
  installedByAccountId: '33333333-3333-3333-3333-333333333333',
};

describe('handoffSlackWorkspaceInstall', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.BACKEND_URL = 'https://api-dev.test';
    process.env.PLATFORM_CALLBACK_TOKEN = 'cb-token';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BACKEND_URL;
    delete process.env.PLATFORM_CALLBACK_TOKEN;
  });

  it('POSTs the install to platform-backend with the callback token', async () => {
    const fetchMock = jest.fn(async () => new Response('{"ok":true}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ok = await handoffSlackWorkspaceInstall(INPUT);

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-dev.test/api/internal/agent-slack/workspace-install');
    expect((init.headers as Record<string, string>)['X-Service-Auth']).toBe('cb-token');
    expect(JSON.parse(init.body as string)).toEqual(INPUT);
  });

  it('returns false (no throw) when platform-backend rejects', async () => {
    global.fetch = jest.fn(async () => new Response('{"error":"invalid_body"}', { status: 400 })) as unknown as typeof fetch;
    await expect(handoffSlackWorkspaceInstall(INPUT)).resolves.toBe(false);
  });

  it('returns false (no throw) on network failure', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(handoffSlackWorkspaceInstall(INPUT)).resolves.toBe(false);
  });

  it('skips (false) when BACKEND_URL/PLATFORM_CALLBACK_TOKEN are unset', async () => {
    delete process.env.PLATFORM_CALLBACK_TOKEN;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(handoffSlackWorkspaceInstall(INPUT)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Chat forward (Slack owns one Events URL; this service owns it) ──────────

describe('forwardSlackEventToChat', () => {
  let originalFetch: typeof fetch;
  const ENVELOPE = {
    team_id: 'T1',
    api_app_id: 'A0LIFTOFF',
    event_id: 'Ev1',
    event: { type: 'message', channel: 'D1', user: 'U1', text: 'hi', ts: '1.0' },
  };

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.BACKEND_URL = 'https://api-dev.test';
    process.env.PLATFORM_CALLBACK_TOKEN = 'cb-token';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BACKEND_URL;
    delete process.env.PLATFORM_CALLBACK_TOKEN;
  });

  it('POSTs the verified envelope to the chat route with the callback token', async () => {
    const fetchMock = jest.fn(async () => new Response('OK', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { forwardSlackEventToChat } = await import('./slack-workspace-handoff.js');
    await expect(forwardSlackEventToChat(ENVELOPE)).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-dev.test/api/internal/agent-slack/workspace-event');
    expect((init.headers as Record<string, string>)['X-Service-Auth']).toBe('cb-token');
    expect(JSON.parse(init.body as string)).toEqual(ENVELOPE);
  });

  it('returns false without throwing when platform-backend is unreachable', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch;
    const { forwardSlackEventToChat } = await import('./slack-workspace-handoff.js');
    // Never throws: the ack to Slack must not depend on chat routing.
    await expect(forwardSlackEventToChat(ENVELOPE)).resolves.toBe(false);
  });
});
