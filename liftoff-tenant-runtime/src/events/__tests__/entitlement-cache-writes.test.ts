// How the entitlement cache is written, and by whom.
//
// The runtime keeps a cached copy of the control plane's entitlement snapshot,
// and that copy is what admission reads. Two paths refresh it and they used to
// disagree about everything:
//
//   * the EVENT handler hand-rolled its own INSERT with its own column list and
//     NO version guard, so an out-of-order redelivery clobbered a newer
//     snapshot, and every column added to the table (billing_suspended most
//     recently) had to be remembered here separately — and was not;
//   * the FETCH path went through the repository, whose guard
//     (`entity_version < EXCLUDED.entity_version`) it could never satisfy,
//     because the control plane serves the same version on every read.
//
// Both now go through the repository, which owns one statement body; the event
// variant adds the ordering guard, the fetch variant does not.
//
// Separately: `tenant.suspended` / `tenant.reactivated` are TENANT-entity
// events carrying a constant entity_version of 1. Writing that onto the cached
// ENTITLEMENT row reset the entitlement's ordering counter, which is precisely
// what the guard depends on — so those handlers must not touch the column.

const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  connect: jest.fn(),
};

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPool),
  getPoolForService: jest.fn(() => mockPool),
  pool: new Proxy({} as Record<string, unknown>, {
    get(_, prop) { return (mockPool as Record<string, unknown>)[prop as string]; },
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: { createAndActivateForInternalAgent: jest.fn() },
}));
jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    activate: jest.fn(), pause: jest.fn(), archive: jest.fn(), ensureSchedulerJob: jest.fn(),
  })),
}));
jest.mock('../../connectors/tool-schema-cache', () => ({ getToolSchemas: jest.fn().mockReturnValue([]) }));
jest.mock('../../tool-gateway/external-agent-handler', () => ({ externalAgentHandler: { clearConfigCache: jest.fn() } }));
jest.mock('../../integrations/web-fetch/limits-config', () => ({ invalidateFlagsCache: jest.fn() }));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// fetchFromControlPlane refuses to call out without a service token. Saved and
// restored rather than assigned at module scope: process.env is shared by every
// test FILE in a jest worker, and other suites in this repo assert on this
// variable being absent.
const ORIGINAL_SERVICE_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
beforeAll(() => { process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-service-token'; });
afterAll(() => {
  if (ORIGINAL_SERVICE_TOKEN === undefined) delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  else process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIGINAL_SERVICE_TOKEN;
});

import { subscriberInternals } from '../subscriber';
import type { ControlPlaneEvent } from '../types';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function event(overrides: Partial<ControlPlaneEvent> = {}): ControlPlaneEvent {
  return {
    event_id: '22222222-2222-2222-2222-222222222222',
    event_type: 'tenant.entitlement.updated',
    entity_type: 'entitlement',
    entity_id: 'ent-1',
    entity_version: 7,
    event_version: 1,
    tenant_id: TENANT_ID,
    occurred_at: '2026-08-07T12:00:00Z',
    payload: {},
    ...overrides,
  } as ControlPlaneEvent;
}

function controlPlaneServes(body: Record<string, unknown>): void {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

/** Every statement the handler issued, whitespace-collapsed. */
function statements(): string[] {
  return mockPool.query.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' ').trim());
}

function upsertCall(): [string, unknown[]] {
  const call = mockPool.query.mock.calls.find(c => String(c[0]).includes('INSERT INTO cached_entitlements'));
  if (!call) throw new Error('no cached_entitlements upsert was issued');
  return [String(call[0]).replace(/\s+/g, ' ').trim(), call[1] as unknown[]];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  // The dedup/versioning bookkeeping the dispatcher does around the handler.
  mockPool.query.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string' && sql.includes('SELECT entity_version FROM event_versions')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
});

describe('tenant.entitlement.updated', () => {
  it('writes through the repository event variant, guard included', async () => {
    controlPlaneServes({
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
      remainingIncludedCredits: 1000,
      overageAllowed: true,
      version: 7,
    });

    await subscriberInternals.handleEvent(event());

    const [sql] = upsertCall();
    expect(sql).toContain('WHERE cached_entitlements.entity_version < EXCLUDED.entity_version');
  });

  it('carries billing_suspended from the served snapshot', async () => {
    controlPlaneServes({
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
      billingSuspended: true,
      remainingIncludedCredits: 1000,
      overageAllowed: true,
      version: 7,
    });

    await subscriberInternals.handleEvent(event());

    const [sql, params] = upsertCall();
    expect(sql).toContain('billing_suspended = EXCLUDED.billing_suspended');
    // Positional: tenant, status, execution_allowed, billing_suspended, …
    expect(params[3]).toBe(true);
  });

  it('reads a snapshot without billingSuspended as NOT suspended', async () => {
    // The control plane deploys ahead of the runtime; during that window the
    // field is simply absent, and absent must never fabricate a suspension.
    controlPlaneServes({
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
      remainingIncludedCredits: 1000,
      overageAllowed: true,
      version: 7,
    });

    await subscriberInternals.handleEvent(event());

    const [, params] = upsertCall();
    expect(params[3]).toBe(false);
  });

  it("stamps the EVENT's entity_version, which is the entitlement's own counter", async () => {
    controlPlaneServes({
      tenantOperationalStatus: 'active',
      agentExecutionAllowed: true,
      remainingIncludedCredits: 1000,
      overageAllowed: true,
      version: 7,
    });

    await subscriberInternals.handleEvent(event({ entity_version: 7 }));

    const [, params] = upsertCall();
    expect(params[params.length - 1]).toBe(7);
  });
});

describe('tenant.suspended / tenant.reactivated', () => {
  it('suspends without touching entity_version', async () => {
    await subscriberInternals.handleEvent(
      event({ event_type: 'tenant.suspended', entity_type: 'tenant', entity_id: TENANT_ID, entity_version: 1 }),
    );

    const update = statements().find(s => s.includes('UPDATE cached_entitlements'));
    expect(update).toBeDefined();
    expect(update).toContain("operational_status = 'suspended'");
    expect(update).toContain('agent_execution_allowed = false');
    // The whole point: a tenant-entity version must not overwrite the
    // entitlement's ordering counter.
    expect(update).not.toContain('entity_version');
  });

  it('reactivates without touching entity_version', async () => {
    await subscriberInternals.handleEvent(
      event({ event_type: 'tenant.reactivated', entity_type: 'tenant', entity_id: TENANT_ID, entity_version: 1 }),
    );

    const update = statements().find(s => s.includes('UPDATE cached_entitlements'));
    expect(update).toBeDefined();
    expect(update).toContain("operational_status = 'active'");
    expect(update).not.toContain('entity_version');
  });
});
