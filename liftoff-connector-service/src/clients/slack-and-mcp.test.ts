// SlackClient + the MCP hot-path clients (hubspot, notion, stripe).
// Kept in a separate file from `hot-connectors.test.ts` so the existing
// tests don't need to be touched during the Fix-3 port.

import { SlackClient } from './slack.js';
import { HubSpotMCPClient } from './hubspot-mcp.js';
import { NotionMCPClient } from './notion-mcp.js';
import { StripeMCPClient } from './stripe-mcp.js';
import type { CredentialProvider } from './types.js';
import type { CredentialStore } from '../mcp/credential-store.js';

function mockOk(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: true,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function makeStore(accessToken = 'tkn'): CredentialStore {
  return {
    async getCredentials() {
      return { accessToken, refreshToken: 'rt' };
    },
    async refreshOAuthToken() {
      return { accessToken, expiresInMs: 3600_000 };
    },
  };
}

function stubMCP(
  client: unknown,
  impl: (name: string, args: Record<string, unknown>) => unknown,
): jest.Mock {
  const callTool = jest.fn(async (name: string, args: Record<string, unknown>) =>
    ({ content: [{ type: 'text', text: JSON.stringify(impl(name, args)) }] }),
  );
  (client as { mcpClient: { callTool: unknown } }).mcpClient = { callTool } as never;
  return callTool;
}

// ──────────────────────────────────────────────────────────────────────
// Slack
// ──────────────────────────────────────────────────────────────────────

describe('SlackClient', () => {
  let fetchSpy: jest.SpyInstance;
  const credentialProvider: CredentialProvider = async () => ({ accessToken: 'xoxb-test' });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockOk({ ok: true }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('POSTs to chat.postMessage with Bearer auth on create(message)', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOk({ ok: true, ts: '1700000000.001', channel: 'C01' }),
    );
    const client = new SlackClient(credentialProvider);
    const res = await client.create('message', { channel: 'C01', text: 'hello' });
    expect(res.success).toBe(true);
    expect(res.id).toBe('C01:1700000000.001');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer xoxb-test');
    expect(init.method).toBe('POST');
  });

  it('surfaces Slack ok:false errors as failure results', async () => {
    fetchSpy.mockResolvedValueOnce(mockOk({ ok: false, error: 'not_authed' }));
    const client = new SlackClient(credentialProvider);
    const res = await client.create('message', { channel: 'C', text: 'x' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not_authed');
  });

  it('read(channel) uses conversations.info', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockOk({ ok: true, channel: { id: 'C01', name: 'general' } }),
    );
    const client = new SlackClient(credentialProvider);
    const rec = await client.read('channel', 'C01');
    expect(rec.id).toBe('C01');
    expect((rec.data as { name: string }).name).toBe('general');
  });

  it('rejects unknown entity types on read', async () => {
    const client = new SlackClient(credentialProvider);
    await expect(client.read('widget', 'x')).rejects.toThrow(/Unsupported/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// HubSpot MCP (read-only)
// ──────────────────────────────────────────────────────────────────────

describe('HubSpotMCPClient', () => {
  it('calls get_<entity> for read', async () => {
    const client = new HubSpotMCPClient({ tenantId: 't', credentialStore: makeStore() });
    const spy = stubMCP(client, (name) => {
      expect(name).toBe('get_contact');
      return { id: 'c1', email: 'a@b.com' };
    });
    const rec = await client.read('contact', 'c1');
    expect(spy).toHaveBeenCalled();
    expect(rec.id).toBe('c1');
  });

  it('rejects unsupported entity types', async () => {
    const client = new HubSpotMCPClient({ tenantId: 't', credentialStore: makeStore() });
    await expect(client.read('widget', 'x')).rejects.toThrow();
  });

  it('delegates writes to REST client and returns failure without valid credentials', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
      headers: { get: () => null },
    } as unknown as Response);

    const client = new HubSpotMCPClient({ tenantId: 't', credentialStore: makeStore() });
    const c = await client.create('contact', {});
    const u = await client.update('contact', 'x', {});
    const d = await client.delete('contact', 'x');

    expect(c.success).toBe(false);
    expect(u.success).toBe(false);
    expect(d.success).toBe(false);
    expect(c.error).toBeTruthy();

    fetchSpy.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Notion MCP
// ──────────────────────────────────────────────────────────────────────

describe('NotionMCPClient', () => {
  it('forwards read calls to an MCP tool', async () => {
    const client = new NotionMCPClient({ tenantId: 't', credentialStore: makeStore() });
    const calls: string[] = [];
    stubMCP(client, (name) => {
      calls.push(name);
      return { id: 'pg-1', object: 'page' };
    });
    const rec = await client.read('page', 'pg-1');
    expect(rec.id).toBe('pg-1');
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Stripe MCP
// ──────────────────────────────────────────────────────────────────────

describe('StripeMCPClient', () => {
  it('maps create(customer) to PostCustomers via stripe_api_write', async () => {
    const client = new StripeMCPClient({ tenantId: 't', credentialStore: makeStore() });
    const spy = stubMCP(client, () => ({ id: 'cus_123' }));
    const res = await client.create('customer', { email: 'a@b.com', name: 'A B' });
    expect(res.success).toBe(true);
    expect(res.id).toBe('cus_123');
    expect(spy).toHaveBeenCalledWith('stripe_api_write', expect.objectContaining({ stripe_api_operation_id: 'PostCustomers' }));
  });

  it('maps delete(subscription) to DeleteSubscriptionsSubscriptionExposedId', async () => {
    const client = new StripeMCPClient({ tenantId: 't', credentialStore: makeStore() });
    const spy = stubMCP(client, () => ({ id: 'sub_1', status: 'canceled' }));
    const res = await client.delete('subscription', 'sub_1');
    expect(res.success).toBe(true);
    expect(spy).toHaveBeenCalledWith('stripe_api_write', expect.objectContaining({
      stripe_api_operation_id: 'DeleteSubscriptionsSubscriptionExposedId',
      parameters: { subscription_exposed_id: 'sub_1' },
    }));
  });

  it('throws MCPError for unsupported entity types on create', async () => {
    // validateStripeInput runs BEFORE the try/catch so the error propagates.
    // The RPC handler catches it and returns success=false upstream.
    const client = new StripeMCPClient({ tenantId: 't', credentialStore: makeStore() });
    stubMCP(client, () => ({}));
    await expect(client.create('widget', {})).rejects.toThrow(/widget/);
  });
});
