// Tests for the connector-service proxy router (Phase 2a cutover).
//
// Spins up a local http server that impersonates connector-service, mounts
// the proxy router on a throwaway Express app, and round-trips requests
// through the proxy.

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createConnectorsProxyRouter } from './proxy';

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({
    Authorization: 'Bearer fake-oidc-id-token',
  }),
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface FakeServer {
  server: http.Server;
  port: number;
  url: string;
  captured: CapturedRequest[];
  respondWith: (res: { status?: number; headers?: Record<string, string>; body?: string }) => void;
  close: () => Promise<void>;
}

async function startFakeConnectorService(): Promise<FakeServer> {
  const captured: CapturedRequest[] = [];
  let nextResponse: { status: number; headers: Record<string, string>; body: string } = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      res.writeHead(nextResponse.status, nextResponse.headers);
      res.end(nextResponse.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    captured,
    respondWith: (r) => {
      nextResponse = {
        status: r.status ?? 200,
        headers: r.headers ?? { 'content-type': 'application/json' },
        body: r.body ?? '',
      };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function mountProxy(targetBaseUrl: string, opts: { userId?: string } = {}): express.Express {
  const app = express();
  app.use(express.json());
  if (opts.userId) {
    // Simulate what authMiddleware does — attach verified user to req
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { uid: string } }).user = { uid: opts.userId! };
      next();
    });
  }
  app.use(
    '/api/connectors',
    createConnectorsProxyRouter({
      targetBaseUrl,
      serviceAuthToken: 'test-service-token',
    }),
  );
  return app;
}

async function requestViaProxy(
  app: express.Express,
  init: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}${init.path}`;
    const res = await fetch(url, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    const headers: http.IncomingHttpHeaders = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body: text };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('connector proxy router', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeConnectorService();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('round-trips a GET including query string + status', async () => {
    fake.respondWith({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectors: ['slack'] }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/connectors/foo?x=1&y=2',
    });

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ connectors: ['slack'] });
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].method).toBe('GET');
    expect(fake.captured[0].url).toBe('/api/connectors/foo?x=1&y=2');
  });

  it('forwards X-Service-Auth and OIDC bearer on every request', async () => {
    fake.respondWith({ body: '{}' });
    const app = mountProxy(fake.url);
    await requestViaProxy(app, { method: 'GET', path: '/api/connectors/slack' });

    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].headers['x-service-auth']).toBe('test-service-token');
    expect(fake.captured[0].headers['authorization']).toBe('Bearer fake-oidc-id-token');
  });

  it('forwards POST body and status', async () => {
    fake.respondWith({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'conn_123' }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'POST',
      path: '/api/connectors/slack',
      body: { displayName: 'Slack' },
    });

    expect(out.status).toBe(201);
    expect(JSON.parse(out.body)).toEqual({ id: 'conn_123' });
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].method).toBe('POST');
    expect(JSON.parse(fake.captured[0].body)).toEqual({ displayName: 'Slack' });
  });

  it('forwards DELETE and preserves upstream 404', async () => {
    fake.respondWith({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'not_found' }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'DELETE',
      path: '/api/connectors/unknown',
    });

    expect(out.status).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: 'not_found' });
    expect(fake.captured[0].method).toBe('DELETE');
  });

  it('forwards PATCH body', async () => {
    fake.respondWith({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updated: true }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'PATCH',
      path: '/api/connectors/slack',
      body: { status: 'paused' },
    });

    expect(out.status).toBe(200);
    expect(fake.captured[0].method).toBe('PATCH');
    expect(JSON.parse(fake.captured[0].body)).toEqual({ status: 'paused' });
  });

  it('injects x-account-id from req.user.uid when authenticated', async () => {
    fake.respondWith({ body: '{}' });
    const app = mountProxy(fake.url, { userId: 'firebase-uid-abc' });
    await requestViaProxy(app, {
      method: 'POST',
      path: '/api/connectors/oauth/dropbox/start?tenantId=t1',
      body: { returnUrl: 'https://app.example.com/oauth/callback' },
    });

    expect(fake.captured[0].headers['x-account-id']).toBe('firebase-uid-abc');
  });

  it('does not add x-account-id when request is unauthenticated', async () => {
    fake.respondWith({ body: '{}' });
    const app = mountProxy(fake.url);
    await requestViaProxy(app, { method: 'GET', path: '/api/connectors/catalog' });

    expect(fake.captured[0].headers['x-account-id']).toBeUndefined();
  });

  it('strips the caller Authorization so it does not reach connector-service', async () => {
    fake.respondWith({ body: '{}' });
    const app = mountProxy(fake.url);
    await requestViaProxy(app, {
      method: 'GET',
      path: '/api/connectors/slack',
      headers: { authorization: 'Bearer user-firebase-token' },
    });

    expect(fake.captured[0].headers['authorization']).toBe('Bearer fake-oidc-id-token');
  });

  it('returns 503 when connector-service is unreachable', async () => {
    // Point the proxy at a port nobody is listening on.
    const unusedPort = 1; // privileged + guaranteed closed for loopback clients
    const app = mountProxy(`http://127.0.0.1:${unusedPort}`);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/connectors/slack',
    });

    expect(out.status).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: 'connector-service unreachable' });
  });

  // Phase 2 Gap 2.1: prove the catalog endpoint survives the proxy chain
  // end-to-end. The proxy is generic (forwards any /api/connectors/* path)
  // so this is a regression guard — if someone adds hop-by-hop stripping or
  // body mangling that breaks the catalog shape, this test fails.
  it('round-trips GET /api/connectors/catalog with full ConnectorCatalogResponse', async () => {
    const catalogBody = {
      connectors: [
        {
          type: 'github',
          displayName: 'GitHub',
          category: 'engineering',
          objectsCovered: ['Repositories', 'Issues', 'Pull Requests', 'Actions'],
          status: 'available',
          auth: {
            kind: 'static_oauth',
            clientIdEnvVar: 'GITHUB_CLIENT_ID',
            clientSecretEnvVar: 'GITHUB_CLIENT_SECRET',
            authUrl: 'https://github.com/login/oauth/authorize',
            tokenUrl: 'https://github.com/login/oauth/access_token',
            scopes: ['repo', 'read:user'],
            scopeDelimiter: ',',
          },
          mcp: {
            kind: 'vendor_hosted',
            mcpUrl: 'https://api.githubcopilot.com/mcp/',
            transport: 'streamable-http',
          },
        },
        {
          type: 'quickbooks',
          displayName: 'QuickBooks Online',
          category: 'accounting',
          status: 'coming_soon',
          statusReason: 'Intuit OAuth app registration pending',
          auth: { kind: 'static_oauth', clientIdEnvVar: 'INTUIT_CLIENT_ID' },
        },
      ],
      version: 'vabc123',
      categoryLabels: { engineering: 'Engineering', accounting: 'Accounting' },
    };
    fake.respondWith({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
      },
      body: JSON.stringify(catalogBody),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/connectors/catalog',
    });

    expect(out.status).toBe(200);
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].method).toBe('GET');
    expect(fake.captured[0].url).toBe('/api/connectors/catalog');
    expect(fake.captured[0].headers['x-service-auth']).toBe('test-service-token');
    expect(fake.captured[0].headers['authorization']).toBe('Bearer fake-oidc-id-token');
    expect(JSON.parse(out.body)).toEqual(catalogBody);
    expect(out.headers['content-type']).toMatch(/application\/json/);
    expect(out.headers['cache-control']).toBe('public, max-age=300');
  });

  // Regression test for OAuth popup not closing.
  //
  // The connector-service OAuth callback handler returns a 302 redirect to the
  // frontend's /oauth/callback page. With redirect:'manual', fetch does not
  // follow the redirect — the proxy receives the opaque redirect response and
  // forwards it directly to the browser so the popup navigates correctly.
  it('forwards 302 redirect to browser (OAuth popup close fix)', async () => {
    const redirectTarget = `https://example.com/oauth/callback?connected=google_calendar&connectorId=conn_123`;

    fake.respondWith({
      status: 302,
      headers: { location: redirectTarget },
      body: '',
    });

    const app = mountProxy(fake.url);
    const proxyServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => proxyServer.once('listening', resolve));
    const proxyPort = (proxyServer.address() as AddressInfo).port;

    try {
      // Use Node's http.request (no redirect following) to see what the proxy returns
      const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>(
        (resolve, reject) => {
          const req = http.request(
            `http://127.0.0.1:${proxyPort}/api/connectors/oauth/callback?state=abc&code=xyz`,
            (res) => {
              res.resume(); // drain
              resolve({ status: res.statusCode!, headers: res.headers });
            },
          );
          req.on('error', reject);
          req.end();
        },
      );

      expect(result.status).toBe(302);
      expect(result.headers['location']).toBe(redirectTarget);
    } finally {
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }
  });
});
