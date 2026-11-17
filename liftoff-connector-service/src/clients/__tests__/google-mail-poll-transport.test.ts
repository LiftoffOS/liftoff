// The Gmail poll path goes through Composio, not a bare bearer token.
//
// THE REGRESSION. `GoogleMailClient.list()` is the only method the poller
// calls, and it was the only method on the client with its own `fetch`.
// read/search/thread all went through `request()`, which routes
// composio_managed credentials through `tools.proxyExecute`. So Gmail polling
// could return 401 on every cycle while the Composio account was ACTIVE, its
// token freshly refreshed, and the Connections page showed the connector as
// Connected — while the same call through the Composio proxy returned 200 and
// real messages.
//
// The agent-visible symptom is oddly specific and worth remembering: it can
// READ a thread handed to it and can never be WOKEN by one, because only the
// wake path polls.

import { GoogleMailClient } from '../google-mail.js';

const proxyExecute = jest.fn();
jest.mock('../../oauth/composio-client.js', () => ({
  composioProxyRequest: (args: unknown) => proxyExecute(args),
}));

/** Credentials exactly as credentialService returns them for a
 *  composio_managed connector: no bearer token, account id in the config. */
function composioCredentials() {
  return {
    accessToken: '',
    connectorConfig: { composioConnectedAccountId: 'ca_NBaDxkshGW6o' },
    tenantId: 't1',
    connectorId: 'c1',
  };
}

describe('GoogleMailClient.list on a composio_managed connector', () => {
  beforeEach(() => {
    proxyExecute.mockReset();
    proxyExecute.mockResolvedValue({ messages: [{ id: 'm1', threadId: 'th1' }] });
    global.fetch = jest.fn(async () => {
      throw new Error('list() must not issue a direct fetch for a composio_managed connector');
    }) as unknown as typeof fetch;
  });

  it('routes through the Composio proxy and never touches fetch', async () => {
    const client = new GoogleMailClient(async () => composioCredentials());
    const result = await client.list('Email', { limit: 25 });

    expect(proxyExecute).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.records.map(r => r.id)).toEqual(['m1']);
  });

  it('sends the gmail query as structured params, which is what the proxy signs', async () => {
    const client = new GoogleMailClient(async () => composioCredentials());
    await client.list('Email', { limit: 10, q: 'is:unread to:support@example.com' });

    const args = proxyExecute.mock.calls[0][0] as {
      connectedAccountId: string;
      endpoint: string;
      queryParams?: Record<string, string>;
    };
    expect(args.connectedAccountId).toBe('ca_NBaDxkshGW6o');
    // Absolute vendor URL — per-toolkit proxy bases are inconsistent, so the
    // client passes the full URL and Composio forwards it verbatim.
    expect(args.endpoint).toBe('https://www.googleapis.com/gmail/v1/users/me/messages');
    expect(args.queryParams?.q).toContain('is:unread');
    expect(args.queryParams?.maxResults).toBe('10');
  });

  it('carries the incremental cursor so polling stays incremental', async () => {
    const client = new GoogleMailClient(async () => composioCredentials());
    const since = new Date('2026-08-16T00:00:00Z');
    await client.list('Email', { since, pageToken: 'tok123' });

    const args = proxyExecute.mock.calls[0][0] as { queryParams?: Record<string, string> };
    expect(args.queryParams?.q).toContain(`after:${Math.floor(since.getTime() / 1000)}`);
    expect(args.queryParams?.pageToken).toBe('tok123');
  });
});
