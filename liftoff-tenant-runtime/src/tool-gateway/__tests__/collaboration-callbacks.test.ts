// Trust-critical contract for the peer-collaboration callbacks. Both the
// interactive MCP handler and the workflow-step __builtin arm route through
// this module, so these assertions guard both paths at once.

import {
  callFindTeammates,
  callSendAgentMessage,
  callReadAgentMessages,
  messagesCarryUntrustedOrigin,
  readCollabCallbackEnv,
} from '../collaboration-callbacks';

const ENV = { platformBackendUrl: 'https://pb.test', platformCallbackToken: 'tok-123' };

function mockFetchOnce(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body = {} } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

afterEach(() => { jest.restoreAllMocks(); });

describe('messagesCarryUntrustedOrigin — the taint predicate', () => {
  it('is false for no messages / empty / malformed', () => {
    expect(messagesCarryUntrustedOrigin(null)).toBe(false);
    expect(messagesCarryUntrustedOrigin({})).toBe(false);
    expect(messagesCarryUntrustedOrigin({ messages: [] })).toBe(false);
    expect(messagesCarryUntrustedOrigin({ messages: [{}] })).toBe(false);
  });

  it('is true when ANY message carries an untrusted origin (either spelling)', () => {
    expect(messagesCarryUntrustedOrigin({ messages: [{ originTrust: 'trusted' }, { originTrust: 'untrusted_inbound' }] })).toBe(true);
    expect(messagesCarryUntrustedOrigin({ messages: [{ origin_trust: 'untrusted_inbound' }] })).toBe(true);
  });

  it('is false when every message is trusted', () => {
    expect(messagesCarryUntrustedOrigin({ messages: [{ originTrust: 'trusted' }, { origin_trust: 'trusted' }] })).toBe(false);
  });
});

describe('callSendAgentMessage — origin trust is stamped from the caller, never invented', () => {
  it('forwards senderAgentId and the caller-supplied originTrust verbatim', async () => {
    let sentBody: Record<string, unknown> = {};
    mockFetchOnce((_url, init) => { sentBody = JSON.parse(String(init?.body)); return { body: { ok: true } }; });

    await callSendAgentMessage(ENV, {
      tenantId: 't1', senderAgentId: 'agent-self', recipientAgentId: 'agent-peer',
      content: 'hello', originTrust: 'untrusted_inbound',
    });

    expect(sentBody.senderAgentId).toBe('agent-self');
    expect(sentBody.originTrust).toBe('untrusted_inbound');
    expect(sentBody.recipientAgentId).toBe('agent-peer');
  });

  it('returns ok:false with the status on a non-2xx', async () => {
    mockFetchOnce(() => ({ status: 503 }));
    const r = await callSendAgentMessage(ENV, {
      tenantId: 't1', senderAgentId: 'a', recipientAgentId: 'b', content: 'x', originTrust: 'trusted',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });
});

describe('callFindTeammates / callReadAgentMessages — request shape', () => {
  it('find_teammates hits the GET endpoint with the query', async () => {
    let calledUrl = '';
    mockFetchOnce((url) => { calledUrl = url; return { body: { agents: [] } }; });
    const r = await callFindTeammates(ENV, { tenantId: 't1', agentId: 'a1', query: 'reviewer' });
    expect(r.ok).toBe(true);
    expect(calledUrl).toContain('/api/internal/platform-tools/find-teammates');
    expect(calledUrl).toContain('query=reviewer');
  });

  it('read_agent_messages hits the agent-messages endpoint with the agentId', async () => {
    let calledUrl = '';
    mockFetchOnce((url) => { calledUrl = url; return { body: { messages: [] } }; });
    const r = await callReadAgentMessages(ENV, { tenantId: 't1', agentId: 'a1', limit: 5 });
    expect(r.ok).toBe(true);
    expect(calledUrl).toContain('/api/internal/platform-tools/agent-messages');
    expect(calledUrl).toContain('agentId=a1');
    expect(calledUrl).toContain('limit=5');
  });
});

describe('readCollabCallbackEnv', () => {
  const saved = { url: process.env.PLATFORM_BACKEND_URL, tok: process.env.PLATFORM_CALLBACK_TOKEN };
  afterEach(() => {
    process.env.PLATFORM_BACKEND_URL = saved.url;
    process.env.PLATFORM_CALLBACK_TOKEN = saved.tok;
  });
  it('is null when either half is missing, set when both present', () => {
    delete process.env.PLATFORM_BACKEND_URL;
    process.env.PLATFORM_CALLBACK_TOKEN = 'tok';
    expect(readCollabCallbackEnv()).toBeNull();
    process.env.PLATFORM_BACKEND_URL = 'https://pb';
    expect(readCollabCallbackEnv()).toEqual({ platformBackendUrl: 'https://pb', platformCallbackToken: 'tok' });
  });
});
