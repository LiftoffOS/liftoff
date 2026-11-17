/**
 * A spend signal arms a cost pass that reads only the feed its spend lands in.
 *
 * The runtime feeds are served by the tenant runtime's agent-service, which
 * bills by the instance. When every signal armed one pass over every feed,
 * this service's own model calls woke agent-service for 19 workspaces' feeds
 * while nothing ran there, every hour anything was spent anywhere.
 */
const mockArmWatch = jest.fn();
jest.mock('../../infrastructure/maintenance-tasks', () => ({
  armWatch: (...a: unknown[]) => mockArmWatch(...a),
  armDue: jest.fn(),
}));

import { armCostIngest, TARGETS } from '../maintenance-targets';

const ingestArm = () => mockArmWatch.mock.calls.find(([kind]) => String(kind).startsWith('cost-ingest'));

beforeEach(() => mockArmWatch.mockReset());

it("reads only this service's own usage log for its own model calls", () => {
  armCostIngest('platform');
  const [kind, target] = ingestArm()!;
  expect(kind).toBe('cost-ingest-platform');
  expect(target).toEqual({ ...TARGETS.costIngest, body: { sources: ['platformLlm'] } });
});

it("reads only developer-proxy's feed for its poke", () => {
  armCostIngest('developer-proxy');
  const [kind, target] = ingestArm()!;
  expect(kind).toBe('cost-ingest-developer-proxy');
  expect(target.body).toEqual({ sources: ['developer_proxy'] });
});

it("reads one workspace's runtime-side feeds when its run finished, as its own task", () => {
  armCostIngest({ tenantId: 't-1' });
  const [kind, target] = ingestArm()!;
  // Named per workspace: two workspaces' runs in one bucket are two passes,
  // not one pass that silently drops the second workspace's scope.
  expect(kind).toBe('cost-ingest-tenant-t-1');
  expect(target.body).toEqual({ sources: ['runtime', 'sandbox', 'usageLedger', 'governance'], tenantId: 't-1' });
  expect(target.body.sources).not.toContain('platformLlm');
});

it('arms the vendor spend monitor with every signal', () => {
  for (const source of ['platform', 'developer-proxy', { tenantId: 't-1' }] as const) {
    mockArmWatch.mockReset();
    armCostIngest(source);
    expect(mockArmWatch).toHaveBeenCalledWith('vendor-spend-monitor', TARGETS.vendorSpendMonitor, expect.any(Number));
  }
});
