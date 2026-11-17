// The transport decision, taken once, tested once.
//
// This is the structural answer to a defect that was fixed three times in one
// day and came back each time: the transport choice lived at 88 call sites, so
// every fix could only cover the ones it touched. A client handed a transport
// instead of a token cannot send an empty bearer, because it never sees a
// token.

import { makeConnectorTransport } from './connector-transport.js';

const proxyRequest = jest.fn();
jest.mock('../oauth/composio-client.js', () => ({
  composioProxyRequest: (args: unknown) => proxyRequest(args),
}));

const COMPOSIO = { accessToken: '', connectorConfig: { composioConnectedAccountId: 'ca_1' } };
const DIRECT = { accessToken: 'real-token-123', connectorConfig: {} };

describe('composio_managed connectors', () => {
  beforeEach(() => {
    proxyRequest.mockReset().mockResolvedValue({ ok: true });
    global.fetch = jest.fn(async () => {
      throw new Error('a composio_managed connector must never reach fetch');
    }) as unknown as typeof fetch;
  });

  it('routes through the proxy and never touches fetch', async () => {
    const transport = makeConnectorTransport(COMPOSIO, 'google_mail');
    const resp = await transport({ method: 'GET', url: 'https://www.googleapis.com/gmail/v1/users/me/messages' });

    expect(proxyRequest).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ ok: true });
  });

  it('sends the absolute vendor URL, which is what the proxy signs', async () => {
    const transport = makeConnectorTransport(COMPOSIO, 'google_drive');
    await transport({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', query: { q: 'x' } });

    const args = proxyRequest.mock.calls[0][0] as { endpoint: string; connectedAccountId: string; queryParams?: Record<string, string> };
    // Absolute, not base-relative: Composio's per-toolkit bases are
    // inconsistent, so a version-prefixed path is right for some toolkits and
    // doubles the segment for others.
    expect(args.endpoint).toBe('https://www.googleapis.com/drive/v3/files');
    expect(args.connectedAccountId).toBe('ca_1');
    expect(args.queryParams).toEqual({ q: 'x' });
  });

  it('preserves the vendor status when the proxy errors', async () => {
    // A 404 must stay a 404. Collapsing it into a 500 would silently change
    // behaviour for every caller that branches on resp.status.
    proxyRequest.mockRejectedValue(new Error('composio proxy failed: 404 Not Found'));
    const transport = makeConnectorTransport(COMPOSIO, 'google_mail');
    const resp = await transport({ method: 'GET', url: 'https://example.test/x' });
    expect(resp.status).toBe(404);
  });

  it('rethrows an error carrying no vendor status rather than inventing one', async () => {
    proxyRequest.mockRejectedValue(new Error('socket hang up'));
    const transport = makeConnectorTransport(COMPOSIO, 'google_mail');
    await expect(transport({ method: 'GET', url: 'https://example.test/x' })).rejects.toThrow('socket hang up');
  });
});

describe('direct-OAuth connectors', () => {
  beforeEach(() => {
    proxyRequest.mockReset();
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });

  it('sends the bearer itself and never consults the proxy', async () => {
    const transport = makeConnectorTransport(DIRECT, 'salesforce');
    await transport({ method: 'GET', url: 'https://example.test/api' });

    expect(proxyRequest).not.toHaveBeenCalled();
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer real-token-123');
  });

  it('appends query params to the URL', async () => {
    const transport = makeConnectorTransport(DIRECT, 'salesforce');
    await transport({ method: 'GET', url: 'https://example.test/api', query: { a: '1', b: '2' } });
    const [url] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('a=1');
    expect(String(url)).toContain('b=2');
  });

  it('refuses to send an empty bearer', async () => {
    // The failure that started this. A direct connector with no token means the
    // credential never loaded; sending `Bearer ` would come back 401 and read
    // as an expired grant.
    const transport = makeConnectorTransport({ accessToken: '', connectorConfig: {} }, 'zendesk');
    await expect(transport({ method: 'GET', url: 'https://example.test/x' }))
      .rejects.toThrow(/no access token/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('the branch itself', () => {
  it('is taken from the same field tryComposioProxy reads', async () => {
    // If these two ever disagreed about which connectors are composio_managed,
    // one of them would send an empty bearer. Same field, one decision.
    proxyRequest.mockReset().mockResolvedValue({});
    global.fetch = jest.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

    await makeConnectorTransport({ connectorConfig: { composioConnectedAccountId: 'ca_x' } }, 't')(
      { method: 'GET', url: 'https://example.test/x' });
    expect(proxyRequest).toHaveBeenCalled();

    proxyRequest.mockClear();
    await makeConnectorTransport({ accessToken: 'tok', connectorConfig: { composioConnectedAccountId: '' } }, 't')(
      { method: 'GET', url: 'https://example.test/x' });
    expect(proxyRequest).not.toHaveBeenCalled();
  });
});
