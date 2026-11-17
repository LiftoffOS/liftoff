// Tests for the Connect-RPC ConnectorServiceClient in platform-backend.
//
// Layers of coverage:
//   1. Feature-flag parsing (off / shadow / on / garbage)
//   2. Typed round-trip via createRouterTransport — @connectrpc/connect's
//      in-memory transport. Verifies that the client talks to the
//      generated service descriptor correctly.
//   3. Auth interceptor — confirms `X-Service-Auth` is set from
//      `CONNECTOR_SERVICE_TOKEN` by spinning up a real Connect-RPC
//      server locally (connectNodeAdapter) and inspecting the request
//      headers the client sends.

import http from 'node:http';
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

  it.each(['shadow', 'SHADOW', 'Shadow'])('recognises %s as shadow', (raw) => {
    process.env.CONNECTOR_SERVICE_ENABLED = raw;
    expect(getConnectorServiceMode()).toBe('shadow');
    expect(isConnectorServiceEnabled()).toBe(true);
    expect(isShadowMode()).toBe(true);
  });

  it.each(['on', 'ON', 'On'])('recognises %s as on', (raw) => {
    process.env.CONNECTOR_SERVICE_ENABLED = raw;
    expect(getConnectorServiceMode()).toBe('on');
    expect(isConnectorServiceEnabled()).toBe(true);
    expect(isShadowMode()).toBe(false);
  });

  it('treats garbage as off', () => {
    process.env.CONNECTOR_SERVICE_ENABLED = 'maybe';
    expect(getConnectorServiceMode()).toBe('off');
  });
});

describe('ConnectorServiceClient round-trip via createRouterTransport', () => {
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
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].connectorType).toBe('github');
  });
});

describe('defaultAuthInterceptor sets X-Service-Auth over HTTP', () => {
  let server: http.Server;
  let baseUrl: string;
  const capturedHeaders: Array<Record<string, string>> = [];

  beforeAll(async () => {
    const adapter = connectNodeAdapter({
      routes: (router: ConnectRouter) =>
        router.service(ConnectorService, {
          async getFunctionalTypes(_req, ctx) {
            const snap: Record<string, string> = {};
            ctx.requestHeader.forEach((v, k) => {
              snap[k.toLowerCase()] = v;
            });
            capturedHeaders.push(snap);
            return create(GetFunctionalTypesResponseSchema, { connectorTypes: [] });
          },
        }),
    });
    server = http.createServer(adapter);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    capturedHeaders.length = 0;
    resetSharedConnectorServiceClient();
  });

  it('sends X-Service-Auth when CONNECTOR_SERVICE_TOKEN is set', async () => {
    process.env.CONNECTOR_SERVICE_TOKEN = 'secret-token';
    const client = createConnectorServiceClient({ baseUrl });
    await client.getFunctionalTypes({ tenantContext: { tenantId: 't' } });
    expect(capturedHeaders.length).toBe(1);
    expect(capturedHeaders[0]['x-service-auth']).toBe('secret-token');
    delete process.env.CONNECTOR_SERVICE_TOKEN;
  });

  it('omits X-Service-Auth when CONNECTOR_SERVICE_TOKEN is unset', async () => {
    delete process.env.CONNECTOR_SERVICE_TOKEN;
    const client = createConnectorServiceClient({ baseUrl });
    await client.getFunctionalTypes({ tenantContext: { tenantId: 't' } });
    expect(capturedHeaders.length).toBe(1);
    expect(capturedHeaders[0]['x-service-auth']).toBeUndefined();
  });
});
