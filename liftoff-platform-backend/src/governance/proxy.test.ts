// Tests for the governance-engine proxy router (Phase 3 cutover).
//
// Spins up a local http server that impersonates governance-engine, mounts
// the proxy router on a throwaway Express app, and round-trips requests
// through the proxy. Mirrors src/connectors/proxy.test.ts.

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createGovernanceProxyRouter } from './proxy';

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
  respondWith: (res: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    /** If set, the body is streamed as multiple chunks with small delays. */
    chunks?: string[];
  }) => void;
  close: () => Promise<void>;
}

async function startFakeGovernanceService(): Promise<FakeServer> {
  const captured: CapturedRequest[] = [];
  let nextResponse: {
    status: number;
    headers: Record<string, string>;
    body: string;
    chunks?: string[];
  } = {
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
      if (nextResponse.chunks) {
        // Simulate a streamed body: multiple chunks with microtask gaps.
        let i = 0;
        const next = () => {
          if (i >= nextResponse.chunks!.length) {
            res.end();
            return;
          }
          res.write(nextResponse.chunks![i++]);
          setImmediate(next);
        };
        next();
      } else {
        res.end(nextResponse.body);
      }
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
        chunks: r.chunks,
      };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function mountProxy(targetBaseUrl: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/governance',
    createGovernanceProxyRouter({
      targetBaseUrl,
      serviceAuthToken: 'test-governance-token',
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

describe('governance proxy router', () => {
  let fake: FakeServer;

  beforeEach(async () => {
    fake = await startFakeGovernanceService();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('round-trips a GET including query string + status', async () => {
    fake.respondWith({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: [] }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/approvals?status=pending&limit=20',
    });

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ approvals: [] });
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].method).toBe('GET');
    expect(fake.captured[0].url).toBe('/api/governance/approvals?status=pending&limit=20');
  });

  it('forwards X-Service-Auth and OIDC bearer on every request', async () => {
    fake.respondWith({ body: '{}' });
    const app = mountProxy(fake.url);
    await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/approvals',
    });

    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].headers['x-service-auth']).toBe('test-governance-token');
    expect(fake.captured[0].headers['authorization']).toBe('Bearer fake-oidc-id-token');
  });

  it('forwards POST body and status (approval decision)', async () => {
    fake.respondWith({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'appr_123', status: 'approved' }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'POST',
      path: '/api/governance/approvals/appr_123/decision',
      body: { decision: 'approved' },
    });

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ id: 'appr_123', status: 'approved' });
    expect(fake.captured).toHaveLength(1);
    expect(fake.captured[0].method).toBe('POST');
    expect(JSON.parse(fake.captured[0].body)).toEqual({ decision: 'approved' });
  });

  it('preserves upstream 404 for unknown approval', async () => {
    fake.respondWith({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'approval_not_found' }),
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/approvals/unknown',
    });

    expect(out.status).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: 'approval_not_found' });
  });

  it('strips the caller Authorization so it does not reach governance-engine', async () => {
    fake.respondWith({ body: '{}' });
    const app = mountProxy(fake.url);
    await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/approvals',
      headers: { authorization: 'Bearer user-firebase-token' },
    });

    expect(fake.captured[0].headers['authorization']).toBe('Bearer fake-oidc-id-token');
  });

  it('returns 503 when governance-engine is unreachable (fail-closed)', async () => {
    // Point the proxy at a port nobody is listening on.
    const unusedPort = 1;
    const app = mountProxy(`http://127.0.0.1:${unusedPort}`);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/approvals',
    });

    expect(out.status).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: 'governance-engine unreachable' });
  });

  it('returns 503 when GOVERNANCE_SERVICE_URL is unset', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/governance',
      createGovernanceProxyRouter({
        targetBaseUrl: '',
        serviceAuthToken: 'test',
      }),
    );
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/approvals',
    });
    expect(out.status).toBe(503);
    expect(JSON.parse(out.body)).toEqual({ error: 'governance-engine not configured' });
  });

  it('streams a chunked response body without buffering', async () => {
    fake.respondWith({
      status: 200,
      headers: { 'content-type': 'application/json' },
      chunks: ['{"actions":[', '{"id":"a1"},', '{"id":"a2"}', ']}'],
    });

    const app = mountProxy(fake.url);
    const out = await requestViaProxy(app, {
      method: 'GET',
      path: '/api/governance/actions',
    });

    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({
      actions: [{ id: 'a1' }, { id: 'a2' }],
    });
  });
});
