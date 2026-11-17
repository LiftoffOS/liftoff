// Unit tests for the shared fan-out governance gate (governed-dispatch.ts).
//
// These functions are the safety boundary for BOTH delegateToAgents and the DAG
// executor: the per-tenant fan-out width cap, the delegation-depth cap, the
// global/tenant spawn-pause kill switch, and the cross-tenant delegation block.
// DB access goes through the globally-mocked pool (test-utils/setup.ts);
// getTenantRuntimeConfig and the audit sink are mocked here so each gate is
// exercised in isolation.

import { pool } from '../../infrastructure/database';
import {
  loadDispatchGate,
  assertFanoutWithinCap,
  assertDepthWithinCap,
  assertNotSpawnPaused,
  assertSameTenantAgents,
  assertChildCapacity,
  assertNoDelegationCycle,
  DelegationError,
  type DispatchGate,
} from '../governed-dispatch';
import { DELEGATION_HARD_CAPS } from '../delegation-defaults';
import * as metrics from '../../observability/runtime-extensions-metrics';

jest.mock('../../tenant-runtime-config/service', () => ({
  getTenantRuntimeConfig: jest.fn(),
}));
jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const { getTenantRuntimeConfig } = jest.requireMock('../../tenant-runtime-config/service');
const { insertAuditLog } = jest.requireMock('../../audit');
const mockPool = pool as jest.Mocked<typeof pool>;

const TENANT = '11111111-1111-1111-1111-111111111111';
const PARENT_AGENT = '22222222-2222-2222-2222-222222222222';
// A gate with the hard-cap ceilings so cap tests don't depend on env defaults.
const GATE: DispatchGate = { maxDepth: 3, maxFanout: 16, maxConcurrent: 8, maxChildrenPerAgent: 3 };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loadDispatchGate', () => {
  it('falls back to conservative defaults when tenant config is all-null', async () => {
    getTenantRuntimeConfig.mockResolvedValue({
      maxDelegationDepth: null,
      maxDelegationFanout: null,
      defaultMaxConcurrentChildren: null,
      maxChildrenPerAgent: null,
    });
    // DELEGATION_DEFAULTS: depth 2 / fanout 16 / concurrent 8 / per-agent 3.
    await expect(loadDispatchGate(TENANT)).resolves.toEqual({ maxDepth: 2, maxFanout: 16, maxConcurrent: 8, maxChildrenPerAgent: 3 });
  });

  it('uses tenant values when set and within the hard caps', async () => {
    getTenantRuntimeConfig.mockResolvedValue({
      maxDelegationDepth: 2,
      maxDelegationFanout: 32,
      defaultMaxConcurrentChildren: 16,
      maxChildrenPerAgent: 5,
    });
    await expect(loadDispatchGate(TENANT)).resolves.toEqual({ maxDepth: 2, maxFanout: 32, maxConcurrent: 16, maxChildrenPerAgent: 5 });
  });

  it('clamps tenant values that exceed the hard caps', async () => {
    getTenantRuntimeConfig.mockResolvedValue({
      maxDelegationDepth: 99,
      maxDelegationFanout: 999,
      defaultMaxConcurrentChildren: 999,
      maxChildrenPerAgent: 999,
    });
    await expect(loadDispatchGate(TENANT)).resolves.toEqual({
      maxDepth: DELEGATION_HARD_CAPS.MAX_DEPTH,
      maxFanout: DELEGATION_HARD_CAPS.MAX_FANOUT,
      maxConcurrent: DELEGATION_HARD_CAPS.DEFAULT_CONCURRENT,
      maxChildrenPerAgent: DELEGATION_HARD_CAPS.PER_AGENT_CHILDREN,
    });
  });
});

describe('assertFanoutWithinCap', () => {
  it('passes when the fan-out count is within the cap', () => {
    expect(() => assertFanoutWithinCap(16, GATE, TENANT)).not.toThrow();
  });

  it('throws DelegationError(fanout_exceeded) and emits the rejection metric when over cap', () => {
    const inc = jest.spyOn(metrics.delegation_fanout_rejected_total, 'inc').mockImplementation(() => {});
    let caught: unknown;
    try {
      assertFanoutWithinCap(17, GATE, TENANT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DelegationError);
    expect((caught as DelegationError).code).toBe('fanout_exceeded');
    expect(inc).toHaveBeenCalledWith({ tenant_id: TENANT, reason: 'fanout_exceeded' });
  });

  it('does not emit the rejection metric when no tenantId is supplied', () => {
    const inc = jest.spyOn(metrics.delegation_fanout_rejected_total, 'inc').mockImplementation(() => {});
    expect(() => assertFanoutWithinCap(100, GATE)).toThrow(DelegationError);
    expect(inc).not.toHaveBeenCalled();
  });
});

describe('assertDepthWithinCap', () => {
  it('returns parentDepth+1 for a within-cap parent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ delegation_depth: 0 }], rowCount: 1 } as never);
    await expect(assertDepthWithinCap('inv-1', GATE)).resolves.toBe(1);
  });

  it('refuses a missing parent row rather than resetting depth to 0', async () => {
    // The old behaviour read a missing row as depth 0 — a fail-open that let
    // any hop whose parent id did not resolve restart the chain's depth count,
    // making the cap unenforceable below the first unresolvable link.
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(assertDepthWithinCap('inv-missing', GATE)).rejects.toMatchObject({ code: 'parent_not_found' });
  });

  it('still reads a NULL depth on an EXISTING row as 0', async () => {
    // Root invocations legitimately carry NULL delegation_depth; only the
    // absent ROW is an error.
    mockPool.query.mockResolvedValueOnce({ rows: [{ delegation_depth: null }], rowCount: 1 } as never);
    await expect(assertDepthWithinCap('inv-root', GATE)).resolves.toBe(1);
  });

  it('throws DelegationError(depth_exceeded) when the child would exceed the cap', async () => {
    // parent already at the cap (3) → child would be 4 > 3.
    mockPool.query.mockResolvedValueOnce({ rows: [{ delegation_depth: 3 }], rowCount: 1 } as never);
    await expect(assertDepthWithinCap('inv-deep', GATE)).rejects.toMatchObject({ code: 'depth_exceeded' });
  });
});

describe('assertNoDelegationCycle', () => {
  const A = 'aaaaaaaa-1111-1111-1111-111111111111';
  const B = 'bbbbbbbb-2222-2222-2222-222222222222';
  const C = 'cccccccc-3333-3333-3333-333333333333';

  it('allows a target that is not already in the chain', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ agent_id: A }, { agent_id: B }], rowCount: 2 } as never);
    await expect(assertNoDelegationCycle('inv-1', [C])).resolves.toBeUndefined();
  });

  it('refuses delegating back to an ancestor', async () => {
    // A -> B -> A. Two hops, inside a cap of two, so every other gate passes it.
    // The second run of A lands at the depth limit, is made a leaf, and has the
    // delegation tool it was asked to use stripped from its own catalog.
    mockPool.query.mockResolvedValueOnce({ rows: [{ agent_id: B }, { agent_id: A }], rowCount: 2 } as never);
    await expect(assertNoDelegationCycle('inv-b', [A])).rejects.toMatchObject({ code: 'delegation_cycle' });
  });

  it('refuses an agent delegating to itself', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ agent_id: A }], rowCount: 1 } as never);
    await expect(assertNoDelegationCycle('inv-a', [A])).rejects.toMatchObject({ code: 'delegation_cycle' });
  });

  it('refuses when the ancestry cannot be read, rather than assuming no cycle', async () => {
    // Same fail-closed posture as assertDepthWithinCap: a chain that cannot be
    // read is a chain whose cycles cannot be ruled out.
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(assertNoDelegationCycle('inv-missing', [A])).rejects.toMatchObject({ code: 'parent_not_found' });
  });
});

describe('assertNotSpawnPaused', () => {
  it('passes when no pause row matches the tenant or global scope', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(assertNotSpawnPaused(TENANT)).resolves.toBeUndefined();
  });

  it('throws DelegationError(spawn_paused) when a global spawn pause is active', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ scope: 'global' }], rowCount: 1 } as never);
    await expect(assertNotSpawnPaused(TENANT)).rejects.toMatchObject({ code: 'spawn_paused' });
  });
});

describe('assertSameTenantAgents', () => {
  it('returns immediately (no query) for an empty target list', async () => {
    await expect(assertSameTenantAgents(TENANT, PARENT_AGENT, [])).resolves.toBeUndefined();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('passes when every target agent belongs to the caller tenant', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'a1', tenant_id: TENANT }, { id: 'a2', tenant_id: TENANT }],
      rowCount: 2,
    } as never);
    await expect(assertSameTenantAgents(TENANT, PARENT_AGENT, ['a1', 'a2'])).resolves.toBeUndefined();
    expect(insertAuditLog).not.toHaveBeenCalled();
  });

  it('throws target_not_found when a requested agent does not exist', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(assertSameTenantAgents(TENANT, PARENT_AGENT, ['ghost'])).rejects.toMatchObject({ code: 'target_not_found' });
  });

  it('blocks + audits + counts a cross-tenant target', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'a1', tenant_id: 'other-tenant' }], rowCount: 1 } as never);
    const inc = jest.spyOn(metrics.delegation_cross_tenant_blocked_total, 'inc').mockImplementation(() => {});
    await expect(assertSameTenantAgents(TENANT, PARENT_AGENT, ['a1'])).rejects.toMatchObject({ code: 'cross_tenant' });
    expect(insertAuditLog).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ tenant_id: TENANT });
  });
});

describe('assertChildCapacity', () => {
  // The bound that stands in for the per-agent execution lock, which delegated
  // children bypass on purpose (the lock would serialise a fan-out to one
  // specialist and deadlock self-delegation).
  it('passes while the agent is under its cap', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: '2' }], rowCount: 1 } as never);
    await expect(assertChildCapacity(TENANT, 'agent-1', GATE)).resolves.toBeUndefined();
  });

  it('refuses when the agent already has the capped number of children running', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: '3' }], rowCount: 1 } as never);
    await expect(assertChildCapacity(TENANT, 'agent-1', GATE)).rejects.toMatchObject({ code: 'child_capacity_exceeded' });
  });

  it('ignores rows too old to still be running, so a crash cannot wedge the cap', async () => {
    // Nothing reaps delegation_active: a row is closed by the run that opened
    // it or not at all, so an instance killed mid-run (deploy, OOM, SIGTERM)
    // leaves 'running' behind forever. Counting that debris would refuse every
    // future delegation to the team, permanently, citing runs that finished
    // hours ago. The window is bounded by the Cloud Run request ceiling, past
    // which a row cannot represent live work.
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: '0' }], rowCount: 1 } as never);
    await expect(assertChildCapacity(TENANT, 'agent-1', GATE)).resolves.toBeUndefined();
    const sql = (mockPool.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/started_at > now\(\) - interval/);
  });

  it('counts only running children, so a paused one does not hold a slot', () => {
    // A child waiting on a human can sit for hours. Holding a capacity slot for
    // that whole time would starve the team of every other delegation.
    const sqlSource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'governed-dispatch.ts'), 'utf8',
    ) as string;
    const fn = sqlSource.slice(sqlSource.indexOf('export async function assertChildCapacity'));
    expect(fn).toMatch(/status = 'running'/);
  });
});
