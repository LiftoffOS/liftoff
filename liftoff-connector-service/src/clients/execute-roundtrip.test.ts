// End-to-end Execute round-trip. Imports clients/index.js so every executor
// self-registers, then drives an Execute RPC against an in-memory Express
// server via Connect. global.fetch is stubbed so the Slack executor's
// vendor call resolves without the network.
//
// This is the "does the wiring actually work?" sanity check the phase
// review will ask for.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@liftoffos/proto-gen';
import { buildApp } from '../server.js';
import { logger } from '../infra/logging.js';
import {
  credentialService,
  clearWarmCache,
  unregisterAllOAuthRefreshHandlers,
} from '../credentials/service.js';
import {
  hasConnectorExecutor,
  unregisterAllConnectorExecutors,
} from '../rpc/execute-dispatcher.js';

// Importing the clients index triggers the self-registration of every
// connector executor. The registrations persist for the lifetime of the
// test process — the unregisterAllConnectorExecutors() in beforeEach on the
// other test suites does NOT undo this import because no re-import happens.
// Tests in this file explicitly re-import AFTER any unregister to keep
// other suites hermetic.
import './index.js';

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  process.env.CONNECTOR_SERVICE_TOKEN = 'test-token';
  const app = buildApp({ port: 0, log: logger });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

function makeClient(baseUrl: string) {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [
      (next) => async (req) => {
        req.header.set('X-Service-Auth', 'test-token');
        return next(req);
      },
    ],
  });
  return createClient(ConnectorService, transport);
}

const mockZendeskResponse = {
  ok: true,
  status: 201,
  text: async () => JSON.stringify({ ticket: { id: 12345 } }),
  json: async () => ({ ticket: { id: 12345 } }),
} as unknown as Response;

describe('Execute round-trip — zendesk executor', () => {
  // Not slack or salesforce, which are composio_managed. A composio_managed
  // type's registry functions carry definitionSource='composio', so Execute routes them to Composio and no
  // vendor fetch happens here — which is what this suite asserts on. zendesk is
  // the closest still-direct OAuth + REST sidecar with a write function in
  // CONNECTOR_FUNCTIONS (create_ticket → entityType 'ticket').
  let server: http.Server;
  let client: ReturnType<typeof makeClient>;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    // Re-import to guarantee registrations even if a previous test suite
    // called unregisterAllConnectorExecutors (Jest isolates module caches
    // per file, but belt-and-braces).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./index.js');
    const started = await startServer();
    server = started.server;
    client = makeClient(started.baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.CONNECTOR_SERVICE_TOKEN;
    unregisterAllConnectorExecutors();
  });

  beforeEach(() => {
    clearWarmCache();
    unregisterAllOAuthRefreshHandlers();

    if (!hasConnectorExecutor('zendesk')) {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./index.js');
    }

    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(mockZendeskResponse);

    jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
      flowKind: 'static_oauth',
      accessToken: 'zd-test',
      // Zendesk is subdomain-scoped: the client derives the host from instanceUrl.
      instanceUrl: 'https://acme.zendesk.com',
    });
    jest
      .spyOn(credentialService, 'getConnectorConfig')
      .mockResolvedValue({ connectorType: 'zendesk', config: {} });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('dispatches to the zendesk executor and returns the vendor response', async () => {
    const res = await client.execute({
      tenantContext: { tenantId: 't1' },
      connectorId: 'c-zd',
      // Registry function — maps to entityType 'ticket', category 'write'
      // → .create('ticket', data) on ZendeskClient.
      functionName: 'create_ticket',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: { subject: 'Acme cannot log in', comment: 'Steps to reproduce…' } as any,
      idempotencyKey: 'k1',
      traceId: 'tr1',
    });
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('acme.zendesk.com');
  });

  it('has every hot connector type registered at import time', () => {
    // NB: github intentionally absent — Phase 3.1 in tenant-runtime
    // removed the REST client and moved github to a pure vendor MCP
    // server. Calls for connectorType 'github' will not have a REST
    // executor and should flow through a generic MCP dispatcher instead.
    for (const type of [
      'slack',
      'salesforce',
      'google_drive',
      'google_mail',
      'google_calendar',
      'microsoft_outlook_mail',
      'box',
      'dropbox',
      'zendesk',
      'linear',
      'hubspot',
      'stripe',
      'notion',
      'asana',
      'trello',
      'paypal',
      'quickbooks',
      'xero',
      'intercom',
    ]) {
      expect(hasConnectorExecutor(type)).toBe(true);
    }
  });
});
