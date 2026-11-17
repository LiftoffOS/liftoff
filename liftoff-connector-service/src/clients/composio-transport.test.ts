// Tests for the shared composio_managed routing helper.
//
// The helper sits between every connector client and
// composio.tools.proxyExecute. Two invariants matter:
//
//   1. When credentials lack `connectorConfig.composioConnectedAccountId`
//      → returns `{ handled: false }` so the caller's direct-HTTP path runs.
//   2. When that field is present → calls composioProxyRequest with the
//      args mapped 1:1, and returns the result wrapped as `{ handled:
//      true, data }`.

jest.mock('../oauth/composio-client.js', () => ({
  composioProxyRequest: jest.fn(),
}));

import { tryComposioProxy } from './composio-transport.js';
import { composioProxyRequest } from '../oauth/composio-client.js';
import type { ConnectorCredentials } from './types.js';

const mockProxy = composioProxyRequest as jest.MockedFunction<typeof composioProxyRequest>;

describe('tryComposioProxy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns { handled: false } when connectorConfig is undefined', async () => {
    const creds: ConnectorCredentials = { accessToken: 'real-token' };
    const out = await tryComposioProxy(creds, { method: 'GET', path: '/foo' });
    expect(out.handled).toBe(false);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('returns { handled: false } when connectorConfig.composioConnectedAccountId is missing', async () => {
    const creds: ConnectorCredentials = {
      accessToken: 'real-token',
      connectorConfig: { someOtherField: 'x' },
    };
    const out = await tryComposioProxy(creds, { method: 'GET', path: '/foo' });
    expect(out.handled).toBe(false);
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it('routes through composioProxyRequest when the account id is set', async () => {
    const creds: ConnectorCredentials = {
      accessToken: '',
      connectorConfig: { composioConnectedAccountId: 'ca_TEST' },
    };
    mockProxy.mockResolvedValueOnce({ ok: true } as never);

    const out = await tryComposioProxy<{ ok: boolean }>(creds, {
      method: 'POST',
      path: '/users/me/watch',
      body: { topicName: 'projects/x/topics/y' },
      query: { foo: 'bar' },
      headers: { 'X-Vendor-Header': 'val' },
    });

    expect(out).toEqual({ handled: true, data: { ok: true } });
    expect(mockProxy).toHaveBeenCalledWith({
      connectedAccountId: 'ca_TEST',
      method: 'POST',
      endpoint: '/users/me/watch',
      body: { topicName: 'projects/x/topics/y' },
      queryParams: { foo: 'bar' },
      headers: { 'X-Vendor-Header': 'val' },
    });
  });

  it('propagates errors from composioProxyRequest unchanged', async () => {
    const creds: ConnectorCredentials = {
      accessToken: '',
      connectorConfig: { composioConnectedAccountId: 'ca_TEST' },
    };
    mockProxy.mockRejectedValueOnce(new Error('composio 401'));

    await expect(
      tryComposioProxy(creds, { method: 'GET', path: '/foo' }),
    ).rejects.toThrow('composio 401');
  });
});
