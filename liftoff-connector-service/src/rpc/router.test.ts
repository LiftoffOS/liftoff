// Connect-RPC server tests.
//
// Spins up an in-memory HTTP server against a real Express app, creates
// a Connect client via createConnectTransport, and verifies every RPC
// end-to-end. Credential + DB layers are stubbed so the tests are hermetic.
//
// Every RPC is exercised:
//   - GetFunctionalTypes + GetCapabilities return deterministic data
//   - Warm routes type→id + returns failures for unknown types
//   - GetCredentials dispatches on flow kind
//   - Execute dispatches to a registered executor, bubbles typed errors
//   - ExecuteBatch returns per-item partial success
// Auth failures are also covered.

import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createClient, Code } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@liftoffos/proto-gen';
import { AuthFlowKind } from '@liftoffos/proto-gen/liftoff/connector/v1/types_pb.js';
import { buildApp } from '../server.js';
import { logger } from '../infra/logging.js';
import {
  credentialService,
  clearWarmCache,
  unregisterAllOAuthRefreshHandlers,
} from '../credentials/service.js';
import {
  registerConnectorExecutor,
  unregisterAllConnectorExecutors,
} from './execute-dispatcher.js';
import * as connectorOps from '../oauth/connector-ops.js';
import { connectorCrudService } from '../crud/service.js';
import {
  getRegistryVersion,
  __resetToolSchemaCache,
} from '../catalog/tool-schemas.js';

function startTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
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

function tenantContext(tenantId: string) {
  return { tenantId, tier: '', projectId: '' };
}

describe('ConnectorService (Connect-RPC)', () => {
  let server: http.Server;
  let client: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    const started = await startTestServer();
    server = started.server;
    client = makeClient(started.baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.CONNECTOR_SERVICE_TOKEN;
  });

  beforeEach(() => {
    clearWarmCache();
    unregisterAllOAuthRefreshHandlers();
    unregisterAllConnectorExecutors();
  });

  // ── GetFunctionalTypes + GetCapabilities ────────────────────────────
  describe('GetFunctionalTypes', () => {
    it('returns a non-empty list of connector types', async () => {
      const res = await client.getFunctionalTypes({ tenantContext: tenantContext('t') });
      expect(res.connectorTypes.length).toBeGreaterThan(0);
      expect(res.connectorTypes).toContain('slack');
      expect(res.connectorTypes).toContain('github');
    });

    it('returns a sorted list (deterministic for golden tests)', async () => {
      const res = await client.getFunctionalTypes({ tenantContext: tenantContext('t') });
      const sorted = [...res.connectorTypes].sort();
      expect(res.connectorTypes).toEqual(sorted);
    });
  });

  describe('GetCapabilities', () => {
    it('returns the capability groups with providers and scopes', async () => {
      const res = await client.getCapabilities({ tenantContext: tenantContext('t') });
      expect(res.capabilities.length).toBeGreaterThan(0);

      const crm = res.capabilities.find((c) => c.capability === 6); // CRM = 6
      expect(crm).toBeDefined();
      const types = crm!.providers.map((p) => p.connectorType);
      expect(types).toEqual(expect.arrayContaining(['salesforce', 'hubspot']));
      const sf = crm!.providers.find((p) => p.connectorType === 'salesforce')!;
      // Empty: salesforce is composio_managed and Composio's
      // managed OAuth app holds the grant, so there is no Liftoff-side scope set
      // to require. hubspot still carries its own, which is what keeps this
      // assertion from passing vacuously.
      expect(sf.requiredScopes).toEqual([]);
      const hs = crm!.providers.find((p) => p.connectorType === 'hubspot')!;
      expect(hs.requiredScopes).toContain('crm.objects.contacts.read');
    });
  });

  // ── Warm ─────────────────────────────────────────────────────────────
  describe('Warm', () => {
    it('rejects missing tenantContext.tenantId', async () => {
      await expect(client.warm({ connectorTypes: ['slack'] })).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });
    });

    it('returns failures for connector types with no active connectors', async () => {
      const getSpy = jest
        .spyOn(credentialService, 'getCredentials')
        .mockResolvedValue({ flowKind: 'none' });
      // No DB stub — withTenantScope will throw. Verify the failure is surfaced.
      const res = await client.warm({
        tenantContext: tenantContext('t1'),
        connectorTypes: ['slack'],
      });
      expect(res.warmedConnectorTypes).toEqual([]);
      expect(res.failures.length).toBeGreaterThan(0);
      expect(res.failures[0].connectorType).toBe('slack');
      getSpy.mockRestore();
    });
  });

  // ── GetCredentials ──────────────────────────────────────────────────
  describe('GetCredentials', () => {
    it('rejects missing connectorId', async () => {
      await expect(
        client.getCredentials({ tenantContext: tenantContext('t'), connectorId: '' }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('returns oauth payload with STATIC_OAUTH kind', async () => {
      const spy = jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
        flowKind: 'static_oauth',
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: new Date('2026-05-01T00:00:00Z'),
        scopes: ['a', 'b'],
      });
      const res = await client.getCredentials({
        tenantContext: tenantContext('t'),
        connectorId: 'c1',
      });
      expect(res.flowKind).toBe(AuthFlowKind.STATIC_OAUTH);
      expect(res.oauth?.accessToken).toBe('at');
      expect(res.oauth?.refreshToken).toBe('rt');
      expect(res.oauth?.scopes).toEqual(['a', 'b']);
      expect(res.apiKey).toBeUndefined();
      expect(res.keypair).toBeUndefined();
      spy.mockRestore();
    });

    it('returns api_key payload with API_KEY kind', async () => {
      const spy = jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
        flowKind: 'api_key',
        apiKey: 'secret-xyz',
      });
      const res = await client.getCredentials({
        tenantContext: tenantContext('t'),
        connectorId: 'c1',
      });
      expect(res.flowKind).toBe(AuthFlowKind.API_KEY);
      expect(res.apiKey?.apiKey).toBe('secret-xyz');
      expect(res.oauth).toBeUndefined();
      spy.mockRestore();
    });

    it('surfaces OAuthRefreshError as FailedPrecondition', async () => {
      const { OAuthRefreshError } = jest.requireActual('../credentials/service');
      const spy = jest
        .spyOn(credentialService, 'getCredentials')
        .mockRejectedValue(
          new OAuthRefreshError('reconnect_required', 'token revoked', {
            connectorId: 'c1',
            tenantId: 't',
            vendor: 'slack',
          }),
        );
      await expect(
        client.getCredentials({ tenantContext: tenantContext('t'), connectorId: 'c1' }),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
      spy.mockRestore();
    });

    it('flips connector status to error via markConnectorReconnectRequired on OAuthRefreshError', async () => {
      const { OAuthRefreshError } = jest.requireActual('../credentials/service');
      const credSpy = jest
        .spyOn(credentialService, 'getCredentials')
        .mockRejectedValue(
          new OAuthRefreshError('reconnect_required', 'token revoked', {
            connectorId: 'c1',
            tenantId: 't',
            vendor: 'slack',
          }),
        );
      const markSpy = jest
        .spyOn(connectorOps, 'markConnectorReconnectRequired')
        .mockResolvedValue(undefined);

      await expect(
        client.getCredentials({ tenantContext: tenantContext('t'), connectorId: 'c1' }),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });

      expect(markSpy).toHaveBeenCalledWith('t', 'c1', 'slack');

      credSpy.mockRestore();
      markSpy.mockRestore();
    });
  });

  // ── Execute / ExecuteBatch ──────────────────────────────────────────
  describe('Execute', () => {
    beforeEach(() => {
      jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
        flowKind: 'api_key',
        apiKey: 'k',
      });
      jest
        .spyOn(credentialService, 'getConnectorConfig')
        .mockResolvedValue({ connectorType: 'fake_connector', config: {} });
    });

    it('returns UNIMPLEMENTED when no executor is registered', async () => {
      await expect(
        client.execute({
          tenantContext: tenantContext('t'),
          connectorId: 'c1',
          functionName: 'ping',
          input: {},
          idempotencyKey: 'k1',
          traceId: 'tr1',
        }),
      ).rejects.toMatchObject({ code: Code.Unimplemented });
    });

    it('dispatches to a registered executor and packs the response', async () => {
      registerConnectorExecutor('fake_connector', async () => ({
        result: { echoed: true },
        vendorLatencyMs: 7,
        costUsd: 0.0005,
      }));
      const res = await client.execute({
        tenantContext: tenantContext('t'),
        connectorId: 'c1',
        functionName: 'ping',
        input: { x: 1 },
        idempotencyKey: 'k1',
        traceId: 'tr1',
      });
      expect(res.success).toBe(true);
      expect(res.result).toEqual({ echoed: true });
      expect(res.vendorLatencyMs).toBe(7n);
      expect(res.costUsd).toBeCloseTo(0.0005);
    });

    it('converts executor throws into success=false responses, not thrown errors', async () => {
      // Only ExecuteBatch swallows errors; single Execute still rethrows
      // unless the executor itself returns a structured failure. Verify
      // the executor's thrown error surfaces through the RPC.
      registerConnectorExecutor('fake_connector', async () => {
        throw new Error('vendor exploded');
      });
      // Note: runConnectorExecution wraps executor throws into the
      // ExecuteResponse (success=false). Verify that.
      const res = await client.execute({
        tenantContext: tenantContext('t'),
        connectorId: 'c1',
        functionName: 'ping',
        input: {},
        idempotencyKey: 'k1',
        traceId: 'tr1',
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain('vendor exploded');
    });

    it('flips connector status via markConnectorReconnectRequired when executor throws OAuthRefreshError', async () => {
      const { OAuthRefreshError } = jest.requireActual('../credentials/service');
      registerConnectorExecutor('fake_connector', async () => {
        throw new OAuthRefreshError('reconnect_required', 'token revoked', {
          connectorId: 'c1',
          tenantId: 't',
          vendor: 'fake_connector',
        });
      });
      const markSpy = jest
        .spyOn(connectorOps, 'markConnectorReconnectRequired')
        .mockResolvedValue(undefined);

      await expect(
        client.execute({
          tenantContext: tenantContext('t'),
          connectorId: 'c1',
          functionName: 'ping',
          input: {},
          idempotencyKey: 'kreconnect',
          traceId: 'trreconnect',
        }),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });

      expect(markSpy).toHaveBeenCalledWith('t', 'c1', 'fake_connector');

      markSpy.mockRestore();
    });
  });

  describe('ExecuteBatch', () => {
    beforeEach(() => {
      jest.spyOn(credentialService, 'getCredentials').mockResolvedValue({
        flowKind: 'api_key',
        apiKey: 'k',
      });
      jest
        .spyOn(credentialService, 'getConnectorConfig')
        .mockResolvedValue({ connectorType: 'fake_connector', config: {} });
    });

    it('returns per-item results — success + failure preserved in order', async () => {
      let i = 0;
      registerConnectorExecutor('fake_connector', async () => {
        i += 1;
        if (i === 2) throw new Error('second one fails');
        return { result: { idx: i } };
      });

      const res = await client.executeBatch({
        tenantContext: tenantContext('t'),
        operations: [
          { tenantContext: tenantContext('t'), connectorId: 'c1', functionName: 'a', input: {}, idempotencyKey: 'k1', traceId: 'tr1' },
          { tenantContext: tenantContext('t'), connectorId: 'c1', functionName: 'b', input: {}, idempotencyKey: 'k2', traceId: 'tr2' },
          { tenantContext: tenantContext('t'), connectorId: 'c1', functionName: 'c', input: {}, idempotencyKey: 'k3', traceId: 'tr3' },
        ],
      });

      expect(res.results).toHaveLength(3);
      expect(res.results[0].success).toBe(true);
      expect(res.results[1].success).toBe(false);
      expect(res.results[1].error).toContain('second one fails');
      expect(res.results[2].success).toBe(true);
    });
  });

  // ── ListTools ───────────────────────────────────────────────────────
  describe('ListTools', () => {
    // Warm the tool-schema cache ONCE for this block. Building every tool set
    // (incl. the large generated native HRIS surfaces) + hashing them is a heavy
    // one-time cost; resetting per-test would rebuild it each time. The version is
    // deterministic, so a single warm build serves every assertion here.
    beforeAll(() => {
      __resetToolSchemaCache();
      getRegistryVersion();
    }, 120000);

    it('rejects missing tenantContext.tenantId', async () => {
      await expect(
        client.listTools({ connectorTypes: [], cachedVersion: '' }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    // Verifies the RPC glue returns the registry version + non-empty tool sets. Uses a
    // bounded connector filter on purpose: connectorTypes:[] would serialize EVERY tool
    // set (the full native HRIS surface — Oracle ~8037 tools, Workday WWS) over the
    // in-process Connect-RPC transport, which is too large to ship reliably in-test. The
    // "empty filter → all connectors" behavior is covered directly in tool-schemas.test.ts.
    it('returns the registry version + tool sets for the requested connectors', async () => {
      const res = await client.listTools({
        tenantContext: tenantContext('t'),
        connectorTypes: ['microsoft_teams'],
        cachedVersion: '',
      });
      expect(res.unchanged).toBe(false);
      expect(res.version).toMatch(/^[a-f0-9]{16}$/);
      expect(res.toolSets.length).toBeGreaterThan(0);
    });

    it('short-circuits with unchanged=true when cachedVersion matches', async () => {
      const currentVersion = getRegistryVersion();
      const res = await client.listTools({
        tenantContext: tenantContext('t'),
        connectorTypes: [],
        cachedVersion: currentVersion,
      });
      expect(res.unchanged).toBe(true);
      expect(res.toolSets).toEqual([]);
      expect(res.version).toBe(currentVersion);
    });

    it('filters by connectorTypes (direct-routed connector returns tools)', async () => {
      // composio_managed connectors return no tools from listTools (tool list
      // comes from Composio's MCP server instead). microsoft_teams is still
      // direct-routed and exposes a tool registry.
      const res = await client.listTools({
        tenantContext: tenantContext('t'),
        connectorTypes: ['microsoft_teams'],
        cachedVersion: '',
      });
      expect(res.unchanged).toBe(false);
      expect(res.toolSets).toHaveLength(1);
      expect(res.toolSets[0].connectorType).toBe('microsoft_teams');
      expect(res.toolSets[0].tools.length).toBeGreaterThan(0);
    });

    it('marks write tools with isWrite=true and read tools with isWrite=false', async () => {
      const res = await client.listTools({
        tenantContext: tenantContext('t'),
        connectorTypes: ['microsoft_teams'],
        cachedVersion: '',
      });
      const teams = res.toolSets[0];
      const writeTool = teams.tools.find(
        (t) => t.name === 'send_message',
      );
      const readTool = teams.tools.find(
        (t) => t.name === 'read_channel',
      );
      expect(writeTool?.isWrite).toBe(true);
      expect(readTool?.isWrite).toBe(false);
    });
  });

  // ── ListTenantConnectors ────────────────────────────────────────────
  describe('ListTenantConnectors', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('rejects missing tenantContext.tenantId', async () => {
      await expect(
        client.listTenantConnectors({ connectorTypes: [], statuses: [] }),
      ).rejects.toMatchObject({ code: Code.InvalidArgument });
    });

    it('returns the tenant connector rows from the service', async () => {
      const spy = jest
        .spyOn(connectorCrudService, 'listTenantConnectors')
        .mockResolvedValue([
          {
            id: 'c-1',
            connectorType: 'slack',
            displayName: 'Slack',
            name: 'Engineering Slack',
            status: 'active',
            flowKind: 'static_oauth',
            apiKeyHint: '',
            lastSyncAtEpochSec: 1_700_000_000,
            createdAtEpochSec: 1_699_999_000,
            updatedAtEpochSec: 1_700_000_500,
          },
        ]);

      const res = await client.listTenantConnectors({
        tenantContext: tenantContext('t1'),
        connectorTypes: [],
        statuses: [],
      });

      expect(spy).toHaveBeenCalledWith('t1', {
        connectorTypes: [],
        statuses: [],
      });
      expect(res.connectors).toHaveLength(1);
      const c = res.connectors[0];
      expect(c.id).toBe('c-1');
      expect(c.connectorType).toBe('slack');
      expect(c.displayName).toBe('Slack');
      expect(c.name).toBe('Engineering Slack');
      expect(c.status).toBe('active');
      expect(c.flowKind).toBe(AuthFlowKind.STATIC_OAUTH);
      expect(c.apiKeyHint).toBe('');
      expect(c.lastSyncAtEpochSec).toBe(1_700_000_000n);
      expect(c.createdAtEpochSec).toBe(1_699_999_000n);
      expect(c.updatedAtEpochSec).toBe(1_700_000_500n);
    });

    it('passes connectorTypes + statuses filters through to the service', async () => {
      const spy = jest
        .spyOn(connectorCrudService, 'listTenantConnectors')
        .mockResolvedValue([]);
      const res = await client.listTenantConnectors({
        tenantContext: tenantContext('t1'),
        connectorTypes: ['slack', 'github'],
        statuses: ['active'],
      });
      expect(res.connectors).toEqual([]);
      expect(spy).toHaveBeenCalledWith('t1', {
        connectorTypes: ['slack', 'github'],
        statuses: ['active'],
      });
    });

    it('maps api_key flow kind + hint correctly', async () => {
      jest
        .spyOn(connectorCrudService, 'listTenantConnectors')
        .mockResolvedValue([
          {
            id: 'c-2',
            connectorType: 'sendgrid',
            displayName: 'SendGrid',
            name: 'Prod SendGrid',
            status: 'active',
            flowKind: 'api_key',
            apiKeyHint: '•••abcd',
            lastSyncAtEpochSec: 0,
            createdAtEpochSec: 1_700_000_000,
            updatedAtEpochSec: 1_700_000_000,
          },
        ]);
      const res = await client.listTenantConnectors({
        tenantContext: tenantContext('t1'),
        connectorTypes: [],
        statuses: [],
      });
      expect(res.connectors[0].flowKind).toBe(AuthFlowKind.API_KEY);
      expect(res.connectors[0].apiKeyHint).toBe('•••abcd');
      expect(res.connectors[0].lastSyncAtEpochSec).toBe(0n);
    });
  });

  // ── auth ────────────────────────────────────────────────────────────
  describe('auth', () => {
    it('rejects requests without X-Service-Auth', async () => {
      const { baseUrl } = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      // Use a client without the auth interceptor
      const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' });
      const unauthed = createClient(ConnectorService, transport);
      await expect(
        unauthed.getFunctionalTypes({ tenantContext: tenantContext('t') }),
      ).rejects.toThrow();
    });

    it('rejects wrong token', async () => {
      const { baseUrl } = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
      const transport = createConnectTransport({
        baseUrl,
        httpVersion: '1.1',
        interceptors: [
          (next) => async (req) => {
            req.header.set('X-Service-Auth', 'wrong-token');
            return next(req);
          },
        ],
      });
      const unauthed = createClient(ConnectorService, transport);
      await expect(
        unauthed.getFunctionalTypes({ tenantContext: tenantContext('t') }),
      ).rejects.toThrow();
    });
  });
});

// Mock Connect errors with a serialisable `code` so expect().rejects.toMatchObject works.
jest.mock('@connectrpc/connect', () => {
  const actual = jest.requireActual('@connectrpc/connect');
  return actual;
});
export {}; // ESM-friendly
