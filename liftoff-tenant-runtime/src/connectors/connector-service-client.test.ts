// Connect-RPC client tests — tenant-runtime side.
//
// Mirror of platform-backend's suite: flag parsing, router-transport
// round trip, and auth-header verification via a real Connect-RPC
// server started locally.

import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  createClient,
  createRouterTransport,
  type ConnectRouter,
} from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { ConnectorService } from '@liftoffos/proto-gen';
import {
  GetFunctionalTypesResponseSchema,
  WarmResponseSchema,
  WarmFailureSchema,
} from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb.js';
import {
  buildTransportOptions,
  createConnectorServiceClient,
  resetSharedConnectorServiceClient,
  getConnectorServiceMode,
  isConnectorServiceEnabled,
  isShadowMode,
} from './connector-service-client';

describe('CONNECTOR_SERVICE_ENABLED flag', () => {
  const original = process.env.CONNECTOR_SERVICE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.CONNECTOR_SERVICE_ENABLED;
    else process.env.CONNECTOR_SERVICE_ENABLED = original;
  });

  it('defaults to off when unset', () => {
    delete process.env.CONNECTOR_SERVICE_ENABLED;
    expect(getConnectorServiceMode()).toBe('off');
    expect(isConnectorServiceEnabled()).toBe(false);
    expect(isShadowMode()).toBe(false);
  });

  it.each(['shadow', 'SHADOW'])('recognises %s as shadow', (raw) => {
    process.env.CONNECTOR_SERVICE_ENABLED = raw;
    expect(getConnectorServiceMode()).toBe('shadow');
    expect(isShadowMode()).toBe(true);
  });

  it.each(['on', 'ON'])('recognises %s as on', (raw) => {
    process.env.CONNECTOR_SERVICE_ENABLED = raw;
    expect(getConnectorServiceMode()).toBe('on');
    expect(isShadowMode()).toBe(false);
  });

  it('treats garbage as off', () => {
    process.env.CONNECTOR_SERVICE_ENABLED = 'maybe';
    expect(getConnectorServiceMode()).toBe('off');
  });
});

describe('round-trip via createRouterTransport', () => {
  beforeEach(() => resetSharedConnectorServiceClient());

  it('calls getFunctionalTypes and parses the typed response', async () => {
    const transport = createRouterTransport(({ service }: { service: ConnectRouter['service'] }) => {
      service(ConnectorService, {
        async getFunctionalTypes() {
          return create(GetFunctionalTypesResponseSchema, {
            connectorTypes: ['slack', 'github'],
          });
        },
      });
    });
    const client = createClient(ConnectorService, transport);
    const res = await client.getFunctionalTypes({ tenantContext: { tenantId: 't' } });
    expect(res.connectorTypes).toEqual(['slack', 'github']);
  });

  it('calls warm and parses the failure list', async () => {
    const transport = createRouterTransport(({ service }: { service: ConnectRouter['service'] }) => {
      service(ConnectorService, {
        async warm() {
          return create(WarmResponseSchema, {
            warmedConnectorTypes: ['slack'],
            failures: [
              create(WarmFailureSchema, { connectorType: 'github', reason: 'no active connectors' }),
            ],
          });
        },
      });
    });
    const client = createClient(ConnectorService, transport);
    const res = await client.warm({
      tenantContext: { tenantId: 't' },
      connectorTypes: ['slack', 'github'],
    });
    expect(res.warmedConnectorTypes).toEqual(['slack']);
    expect(res.failures[0].connectorType).toBe('github');
  });
});

describe('buildTransportOptions — Phase 1a-ii perf fix #1 (HTTP/2 keep-alive)', () => {
  it('uses HTTP/2 so connector-service RPCs multiplex over a single session', () => {
    const opts = buildTransportOptions('https://connector-service.example.com', []);
    expect(opts.httpVersion).toBe('2');
  });

  it('disables idle-connection ping to avoid ERR_HTTP2_INVALID_SESSION crashes', () => {
    // Rationale: connectrpc/connect-es#1143 — ping on idle races with session
    // teardown and throws from the ping timer. Keep pingIntervalMs configured
    // for the transport's active-session heartbeat but never let the session
    // manager ping an idle session.
    const opts = buildTransportOptions('https://connector-service.example.com', []);
    expect(opts.pingIdleConnection).toBe(false);
    expect(typeof opts.pingIntervalMs).toBe('number');
    expect(opts.pingIntervalMs).toBeGreaterThan(0);
    expect(opts.pingIntervalMs).toBeLessThan(60_000);
  });

  it('sets a finite idleConnectionTimeoutMs so dead sessions are reaped', () => {
    const opts = buildTransportOptions('https://connector-service.example.com', []);
    expect(typeof opts.idleConnectionTimeoutMs).toBe('number');
    expect(opts.idleConnectionTimeoutMs).toBeGreaterThan(0);
  });

  it('threads the caller-provided baseUrl and interceptors through unchanged', () => {
    const sentinelInterceptor = ((next: unknown) => next) as never;
    const opts = buildTransportOptions('https://example.test', [sentinelInterceptor]);
    expect(opts.baseUrl).toBe('https://example.test');
    expect(opts.interceptors).toEqual([sentinelInterceptor]);
  });
});

describe('getConnectorServiceClient reuses a shared instance (connection reuse)', () => {
  beforeEach(() => {
    resetSharedConnectorServiceClient();
    process.env.CONNECTOR_SERVICE_URL = 'https://connector-service.example.com';
  });
  afterEach(() => {
    delete process.env.CONNECTOR_SERVICE_URL;
    resetSharedConnectorServiceClient();
  });

  it('returns the same client across calls so the HTTP/2 session is retained', async () => {
    const { getConnectorServiceClient } = await import('./connector-service-client');
    const a = getConnectorServiceClient();
    const b = getConnectorServiceClient();
    expect(a).toBe(b);
  });
});

describe('defaultAuthInterceptor sets X-Service-Auth over HTTP', () => {
  // Phase 1a-ii perf fix #1: client is now HTTP/2-only, so the auth
  // verification server must also speak h2 (via http2.createServer for h2c).
  let server: http2.Http2Server;
  let baseUrl: string;
  const captured: Array<Record<string, string>> = [];
  const liveSessions = new Set<http2.ServerHttp2Session>();

  beforeAll(async () => {
    const adapter = connectNodeAdapter({
      routes: (router: ConnectRouter) =>
        router.service(ConnectorService, {
          async getFunctionalTypes(_req, ctx) {
            const snap: Record<string, string> = {};
            ctx.requestHeader.forEach((v, k) => {
              snap[k.toLowerCase()] = v;
            });
            captured.push(snap);
            return create(GetFunctionalTypesResponseSchema, { connectorTypes: [] });
          },
        }),
    });
    server = http2.createServer(adapter);
    server.on('session', (s) => {
      liveSessions.add(s);
      s.on('close', () => liveSessions.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // Client's Http2SessionManager keeps sessions alive; server.close()
    // otherwise blocks indefinitely. Force-destroy live sessions first.
    for (const s of liveSessions) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    captured.length = 0;
    resetSharedConnectorServiceClient();
  });

  it('sends X-Service-Auth when CONNECTOR_SERVICE_TOKEN is set', async () => {
    process.env.CONNECTOR_SERVICE_TOKEN = 'secret-token';
    const client = createConnectorServiceClient({ baseUrl });
    await client.getFunctionalTypes({ tenantContext: { tenantId: 't' } });
    expect(captured.length).toBe(1);
    expect(captured[0]['x-service-auth']).toBe('secret-token');
    delete process.env.CONNECTOR_SERVICE_TOKEN;
  });

  it('omits X-Service-Auth when CONNECTOR_SERVICE_TOKEN is unset', async () => {
    delete process.env.CONNECTOR_SERVICE_TOKEN;
    const client = createConnectorServiceClient({ baseUrl });
    await client.getFunctionalTypes({ tenantContext: { tenantId: 't' } });
    expect(captured.length).toBe(1);
    expect(captured[0]['x-service-auth']).toBeUndefined();
  });
});
