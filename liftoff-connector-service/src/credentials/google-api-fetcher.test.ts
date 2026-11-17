// Tests for the transport-aware Google fetcher.
//
// Six routes in the CRUD router and three job handlers each opened with
// `if (!creds.accessToken) return 401` and then built a direct-token fetcher.
// A composio_managed connector never has an access token — Composio holds the
// grant and reports the token as REDACTED — so all of them answered 401 for
// those tenants: read a presentation, create a doc, copy-and-replace, and the
// async jobs behind them. Every one of those calls is JSON in and JSON out,
// which is exactly what Composio's signed proxy carries, so the transport
// choice belongs in one place instead of nine.

jest.mock('../clients/composio-transport.js', () => ({ tryComposioProxy: jest.fn() }));

import { jest } from '@jest/globals';
import { makeGoogleApiFetcher } from './google-fetcher.js';
import { tryComposioProxy } from '../clients/composio-transport.js';

const mockProxy = tryComposioProxy as unknown as jest.Mock;

const composioCreds = {
  flowKind: 'composio_managed',
  accessToken: '',
  connectorConfig: { composioConnectedAccountId: 'ca_test' },
} as never;

const directCreds = { flowKind: 'oauth2', accessToken: 'ya29.token' } as never;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('composio_managed connectors', () => {
  it('routes a GET through the proxy and returns a normal Response', async () => {
    mockProxy.mockResolvedValueOnce({ handled: true, data: { title: 'Deck' } } as never);

    const gFetch = makeGoogleApiFetcher('t1', 'c1', composioCreds);
    const resp = await gFetch('https://slides.googleapis.com/v1/presentations/p1');

    expect(resp.ok).toBe(true);
    expect(await resp.json()).toEqual({ title: 'Deck' });
  });

  it('splits the query string out of the URL, which is how the proxy takes it', async () => {
    mockProxy.mockResolvedValueOnce({ handled: true, data: {} } as never);

    const gFetch = makeGoogleApiFetcher('t1', 'c1', composioCreds);
    await gFetch('https://www.googleapis.com/drive/v3/files/f1?fields=name,mimeType&alt=json');

    const args = mockProxy.mock.calls[0][1] as {
      path: string;
      query: Record<string, string>;
    };
    expect(args.path).toBe('https://www.googleapis.com/drive/v3/files/f1');
    expect(args.query).toEqual({ fields: 'name,mimeType', alt: 'json' });
  });

  it('forwards a POST body as an object, not a JSON string', async () => {
    mockProxy.mockResolvedValueOnce({ handled: true, data: { ok: true } } as never);

    const gFetch = makeGoogleApiFetcher('t1', 'c1', composioCreds);
    await gFetch('https://docs.googleapis.com/v1/documents', {
      method: 'POST',
      body: JSON.stringify({ title: 'New doc' }),
    });

    const args = mockProxy.mock.calls[0][1] as { method: string; body: unknown };
    expect(args.method).toBe('POST');
    expect(args.body).toEqual({ title: 'New doc' });
  });

  it('recovers the vendor status from a proxy error so 404 stays 404', async () => {
    mockProxy.mockRejectedValueOnce(
      new Error('Composio proxy GET /v1/presentations/p1: HTTP 404 {"error":"not found"}') as never,
    );

    const gFetch = makeGoogleApiFetcher('t1', 'c1', composioCreds);
    const resp = await gFetch('https://slides.googleapis.com/v1/presentations/p1');

    // Callers branch on this: a missing file is not an auth problem, and
    // collapsing it into 500 is what sent readDocument down the wrong path.
    expect(resp.status).toBe(404);
  });

  it('never throws, so a caller that returns its promise cannot hang the request', async () => {
    mockProxy.mockRejectedValueOnce(new Error('socket hang up') as never);

    const gFetch = makeGoogleApiFetcher('t1', 'c1', composioCreds);
    const resp = await gFetch('https://slides.googleapis.com/v1/presentations/p1');

    expect(resp.status).toBe(502);
  });
});

describe('direct-token connectors', () => {
  it('is left on the plain fetcher, with the bearer token attached', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
      new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const gFetch = makeGoogleApiFetcher('t1', 'c1', directCreds);
    await gFetch('https://slides.googleapis.com/v1/presentations/p1');

    expect(mockProxy).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.token');
  });
});
