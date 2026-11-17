// The performance-snapshot-tick cron route computes the PRIOR ISO week and saves one
// snapshot per ACTIVE agent, for EVERY tenant this runtime serves, tolerating
// per-agent failures.

const mockAgentsQuery = jest.fn();
const mockCompute = jest.fn();
const mockSave = jest.fn();

// Two served tenants. A weekly sweep that resolves "the" tenant and returns
// snapshots exactly one workspace and reports success; with one tenant in the
// fixture that behaviour is indistinguishable from covering them all.
const SERVED = ['t1', 't2'];

jest.mock('../../infrastructure/database', () => {
  const { servedTenantsPool } = require('../../test-utils/served-tenants');
  const tenants = servedTenantsPool(SERVED);
  return {
    // One pool answers both readers: the tenant registry's `tenants` reads go to
    // the fixture, everything else is this suite's agents query. Stubbing the
    // database rather than the registry keeps the fan-out itself under test.
    getPool: () => ({
      query: (sql: string, params?: unknown[]) =>
        /FROM\s+tenants/i.test(sql) ? tenants.query(sql, params) : mockAgentsQuery(sql, params),
    }),
    getPoolForService: () => ({ query: jest.fn() }),
  };
});
jest.mock('../../learning/performance-tracker', () => ({
  computePerformanceSnapshot: (...a: unknown[]) => mockCompute(...a),
  savePerformanceSnapshot: (...a: unknown[]) => mockSave(...a),
}));
jest.mock('../../reactive-subscriptions/computed-metric-poller', () => ({ runComputedMetricPollingCycle: jest.fn() }));
jest.mock('../../agent-execution/engine/escalation-helper', () => ({ createEscalation: jest.fn() }));
jest.mock('../../agent-lifecycle/service', () => ({ AgentLifecycleService: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import express from 'express';
import request from 'supertest';
import router from '../internal-cron-handler';

function app() {
  const a = express();
  a.use('/api/internal', express.json(), router);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCompute.mockResolvedValue({ some: 'snapshot' });
  mockSave.mockResolvedValue(undefined);
});

describe('POST /api/internal/performance-snapshot-tick', () => {
  it('saves one snapshot per ACTIVE agent, for every tenant it serves', async () => {
    mockAgentsQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ag-1' }, { id: 'ag-2' }] })  // t1
      .mockResolvedValueOnce({ rows: [{ id: 'ag-3' }] });                  // t2

    const res = await request(app()).post('/api/internal/performance-snapshot-tick');

    expect(res.status).toBe(200);
    expect(res.body.tenants).toBe(2);
    expect(res.body.ok).toBe(2);
    // Three agents across two tenants — the second tenant is not skipped.
    expect(mockCompute).toHaveBeenCalledTimes(3);
    expect(mockSave).toHaveBeenCalledTimes(3);
    expect(res.body.results.map((r: { tenantId: string }) => r.tenantId)).toEqual(SERVED);
    expect(res.body.results[1].value).toEqual({ agents: 1, saved: 1 });

    // Prior ISO week: periodEnd is a Monday, periodStart is exactly 7 days earlier.
    const start = new Date(res.body.periodStart);
    const end = new Date(res.body.periodEnd);
    expect(end.getUTCDay()).toBe(1); // Monday
    expect((end.getTime() - start.getTime()) / (24 * 3600 * 1000)).toBe(7);

    // The agents query filters ACTIVE, scoped to the tenant being swept.
    const sql = String(mockAgentsQuery.mock.calls[0][0]);
    expect(sql).toMatch(/lifecycle = 'ACTIVE'/);
    expect(mockAgentsQuery.mock.calls[0][1]).toEqual(['t1']);
    expect(mockAgentsQuery.mock.calls[1][1]).toEqual(['t2']);
  });

  it('tolerates a per-agent failure and still counts the successes', async () => {
    mockAgentsQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ag-1' }, { id: 'ag-2' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockCompute.mockRejectedValueOnce(new Error('compute blew up')); // first agent fails

    const res = await request(app()).post('/api/internal/performance-snapshot-tick');

    expect(res.status).toBe(200);
    expect(res.body.results[0].value).toEqual({ agents: 2, saved: 1 });
  });

  it('keeps sweeping after a tenant whose agent lookup fails', async () => {
    // One tenant's failure must not truncate the sweep: every tenant after it in
    // the ordering would otherwise pay for a fault that is not theirs, and the
    // response would still read as a completed run.
    mockAgentsQuery
      .mockRejectedValueOnce(new Error('agents query blew up'))  // t1
      .mockResolvedValueOnce({ rows: [{ id: 'ag-3' }] });        // t2

    const res = await request(app()).post('/api/internal/performance-snapshot-tick');

    expect(res.status).toBe(200);
    expect(res.body.tenants).toBe(2);
    expect(res.body.failed).toBe(1);
    expect(res.body.ok).toBe(1);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });
});
