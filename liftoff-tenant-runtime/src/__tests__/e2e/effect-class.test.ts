// 1b end to end, with the governance engine's transport mocked: a custom
// server's `enrich_company` reaches `authorize` as DECLARED_READ and the
// engine's level-2 answer for a declared read is allow (no approval); its
// `delete_record` reaches it as DECLARED_NON_READ and gates. The engine
// itself is untouched — its authorize.test.ts covers the three classes — so
// the mock implements the one rule this test needs from it: a declared read
// is allowed at level 2, a declared non-read is not, an unspecified class is
// the name heuristic (an unknown verb is not a read).
//
// Then the kill and the version, carried on the wire: a tool whose effect
// class has cleared the gate is gated again after the control plane turns
// the classifier off and one refresh tick runs, with no row written; and a
// server cached before a classification-version bump is re-classified on
// the tick that sees the new version.

const mockAuthorize = jest.fn();
const mockExecute = jest.fn();
const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.mock('../../governance/wal', () => ({ writeWalEntry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../governance/governance-service-flag', () => ({
  getGovernanceServiceMode: () => 'on',
  isGovernanceServiceEnabled: () => true,
  isGovernanceShadowMode: () => false,
}));
jest.mock('../../governance/preflight-cache', () => ({ getPreflight: jest.fn().mockResolvedValue({ preflightToken: 'pf' }) }));
jest.mock('../../governance/governance-service-client', () => {
  const actual = jest.requireActual('../../governance/governance-service-client');
  return { ...actual, getGovernanceServiceClient: () => ({ record: jest.fn(), authorize: (...a: unknown[]) => mockAuthorize(...a) }) };
});
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({ resolveInternalAgentId: jest.fn().mockResolvedValue('internal-agent-1') }));
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute, executeBatch: jest.fn(), listTools: jest.fn() }),
}));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// The served tenants come from the real registry over a stubbed database
// (two of them, so the refresh's fan-out is the real one); every other
// statement lands on mockQuery, which the "no row written" check reads.
jest.mock('../../infrastructure/database', () => {
  const { servedTenantsPool } = require('../../test-utils/served-tenants');
  const served = servedTenantsPool(['tenant-1', 'tenant-2']);
  const query = (sql: string, params?: unknown[]) => (/FROM\s+tenants/i.test(sql) ? served.query(sql, params) : mockQuery(sql, params));
  return { getPool: () => ({ query }), getPoolForService: () => ({ query }) };
});
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: () => 'svc-token' }));
jest.mock('../../admission/service', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({ checkAdmission: jest.fn().mockResolvedValue({ allowed: true }) })),
}));
jest.mock('../../action-ledger/service', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: jest.fn().mockResolvedValue(null),
    recordIntent: jest.fn().mockResolvedValue('action-123'),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordPostActionSnapshot: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../tool-gateway/state-fetcher', () => ({
  stateFetcherRegistry: { fetchState: jest.fn().mockResolvedValue({ data: {}, fetchedAt: new Date(), versionToken: 'v1' }) },
  ExternalStateFetcherRegistry: jest.fn(),
}));
jest.mock('../../tool-gateway/permission-validator', () => ({
  permissionValidator: { validate: jest.fn().mockResolvedValue({ allowed: true, appliedEntry: null }) },
}));
jest.mock('../../tool-gateway/conflict-policy-registry', () => ({
  ConflictPolicyRegistry: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({
      connector: 'custom-mcp-d144a7ea', entityType: 'record', actionType: 'x',
      freshnessTTL: null, freshReadBeforeWriteRequired: false, versionTokenField: null,
      fieldComparisonSet: [], conflictResolutionMode: 'last-write-wins',
      escalateOnConflict: false, undoSupportMode: 'none',
    }),
  })),
}));

import { ActionReadClass } from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb';
import { AuthorizeDecision, AdmissionReason } from '../../governance/governance-service-client';
import { ToolGatewayService } from '../../tool-gateway/service';
import {
  _refreshCustomMcpServerSchemasOnceForTesting,
  _seedCustomMcpServerSchemasForTesting,
  withEffectClass,
} from '../../connectors/tool-schema-cache';
import type { ExecuteInput } from '../../tool-gateway/types';

const SERVER = 'd144a7ea-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = 'tenant-1';

/** The engine's rule for this test, at oversight level 2. */
function engineAuthorize(args: { actionType: string; actionReadClass: ActionReadClass }) {
  const isRead = args.actionReadClass === ActionReadClass.DECLARED_READ
    || (args.actionReadClass === ActionReadClass.UNSPECIFIED && /^(get|list|search|read)_/.test(args.actionType));
  return isRead
    ? { decision: AuthorizeDecision.ALLOWED }
    : { decision: AuthorizeDecision.BLOCKED, blockedReason: AdmissionReason.UNSPECIFIED };
}

const input = (actionType: string): ExecuteInput => ({
  tenantId: TENANT, agentId: 'agent-1', instructionVersion: 1, traceId: 't', idempotencyKey: `k-${actionType}`,
  connector: 'custom-mcp-d144a7ea', entityType: 'record', actionType, payload: { id: '1' },
});

describe('1b end to end: the effect class reaches authorize', () => {
  let svc: ToolGatewayService;
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockImplementation(async (args) => engineAuthorize(args));
    mockExecute.mockResolvedValue({ success: true, result: { ok: true }, error: '' });
    const fn = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} }, categories: [] as never });
    _seedCustomMcpServerSchemasForTesting([{
      serverId: SERVER, tenantId: TENANT, name: 'crm',
      functions: [
        withEffectClass(fn('enrich_company'), 'read', true),
        withEffectClass(fn('delete_record'), 'destructive', true),
        fn('verify_email'),
      ],
      version: '2026-09-21T00:00:00.000Z|1',
    }]);
    svc = new ToolGatewayService();
  });

  it('enrich_company reaches authorize as DECLARED_READ and no approval is created', async () => {
    await svc.execute(input('enrich_company'));
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ connector: 'custom-mcp-d144a7ea', actionType: 'enrich_company', actionReadClass: ActionReadClass.DECLARED_READ });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('delete_record reaches it as DECLARED_NON_READ and gates', async () => {
    await expect(svc.execute(input('delete_record'))).rejects.toThrow(/authorize denied/);
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ actionReadClass: ActionReadClass.DECLARED_NON_READ });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a tool with no stored class (the flag off, or a seed row) reaches it UNSPECIFIED, and the name heuristic decides', async () => {
    await expect(svc.execute(input('verify_email'))).rejects.toThrow(/authorize denied/);
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ actionReadClass: ActionReadClass.UNSPECIFIED });
  });
});

describe('1b end to end: the kill and the version travel on the wire', () => {
  const realFetch = global.fetch;
  const tools = [
    { name: 'enrich_company', description: 'Enrich', inputSchema: { type: 'object', properties: {} } },
    { name: 'verify_email', description: 'Verify', inputSchema: { type: 'object', properties: {} } },
  ];
  /** The control plane's two endpoints for one server at one version string. */
  function controlPlane(version: string, effectClasses: Record<string, string>, classifierEnabled: boolean) {
    global.fetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/by-id/raw-tools')
        ? { tools, version, effectClasses, classifierEnabled }
        : new URL(url).searchParams.get('tenantId') === TENANT
          ? { servers: [{ id: SERVER, name: 'crm', connectorId: SERVER, updatedAt: '2026-09-21T00:00:00.000Z', version }] }
          : { servers: [] }),
    })) as unknown as typeof fetch;
  }
  const writes = () => mockQuery.mock.calls
    .map((c) => String(c[0]))
    .filter((sql) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql) && /\b(connectors|custom_mcp_servers)\b/i.test(sql));

  let svc: ToolGatewayService;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
    mockAuthorize.mockImplementation(async (args) => engineAuthorize(args));
    mockExecute.mockResolvedValue({ success: true, result: { ok: true }, error: '' });
    _seedCustomMcpServerSchemasForTesting([]);
    svc = new ToolGatewayService();
  });
  afterEach(() => { global.fetch = realFetch; });

  it('a class that cleared the gate is gated again after the flag is turned off and one tick runs, with no row written', async () => {
    controlPlane('2026-09-21T00:00:00.000Z|1', { enrich_company: 'read' }, true);
    await _refreshCustomMcpServerSchemasOnceForTesting();
    await svc.execute(input('enrich_company'));
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ actionReadClass: ActionReadClass.DECLARED_READ });
    expect(mockExecute).toHaveBeenCalledTimes(1);

    // The control plane's classifier kill is off: the version string moves,
    // the effect classes are omitted, and nothing is written anywhere.
    controlPlane('2026-09-21T00:00:00.000Z|off', {}, false);
    await _refreshCustomMcpServerSchemasOnceForTesting();
    mockAuthorize.mockClear();
    mockExecute.mockClear();
    await expect(svc.execute({ ...input('enrich_company'), idempotencyKey: 'k-enrich-2' })).rejects.toThrow(/authorize denied/);
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ actionReadClass: ActionReadClass.UNSPECIFIED });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('a server cached before the classification-version bump is re-classified on the next tick', async () => {
    // Cached at version 1: verify_email had no confident class and gates
    // on its name.
    controlPlane('2026-09-21T00:00:00.000Z|1', { enrich_company: 'read' }, true);
    await _refreshCustomMcpServerSchemasOnceForTesting();
    await expect(svc.execute(input('verify_email'))).rejects.toThrow(/authorize denied/);
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ actionReadClass: ActionReadClass.UNSPECIFIED });

    // The set version moved on the control plane and its rediscovery
    // classified verify_email as a read. Same updatedAt: the version string
    // alone refetches the entry.
    controlPlane('2026-09-21T00:00:00.000Z|2', { enrich_company: 'read', verify_email: 'read' }, true);
    await _refreshCustomMcpServerSchemasOnceForTesting();
    mockAuthorize.mockClear();
    await svc.execute({ ...input('verify_email'), idempotencyKey: 'k-verify-2' });
    expect(mockAuthorize.mock.calls[0][0]).toMatchObject({ actionReadClass: ActionReadClass.DECLARED_READ });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
