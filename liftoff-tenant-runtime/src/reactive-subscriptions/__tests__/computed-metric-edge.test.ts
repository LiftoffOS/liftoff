// Computed-metric edge-trigger tests.
//
// The poller must fire the agent only when the filter crosses false -> true,
// not on every poll while it stays true (level-trigger). markPolled always
// records the current filter state so the subscription re-arms.

const mockListDue = jest.fn();
const mockMarkPolled = jest.fn().mockResolvedValue(undefined);
const mockMarkError = jest.fn().mockResolvedValue(undefined);
const mockFire = jest.fn().mockResolvedValue(undefined);
const mockEvaluate = jest.fn();
const mockExecute = jest.fn().mockResolvedValue({ result: { value: 150 } });
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [{ id: 'conn-1' }] });

jest.mock('../repository', () => ({
  reactiveSubscriptionRepo: {
    listDueComputedMetric: (...a: unknown[]) => mockListDue(...a),
    markPolled: (...a: unknown[]) => mockMarkPolled(...a),
    markError: (...a: unknown[]) => mockMarkError(...a),
  },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute }),
}));
jest.mock('../fire', () => ({ fireAgentForSubscription: (...a: unknown[]) => mockFire(...a) }));
jest.mock('../predicate-evaluator', () => ({ evaluate: (...a: unknown[]) => mockEvaluate(...a) }));
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockPoolQuery }) }));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { runComputedMetricPollingCycle } from '../computed-metric-poller';

function sub(lastFilterPassed: boolean | null) {
  return {
    id: 's1', tenantId: 't1', agentId: 'a1',
    source: { kind: 'computed_metric', connectorRef: 'c', fn: 'f', extractPath: 'value', args: {} },
    filter: { op: 'gt', field: 'value', value: 100 }, // defined so `evaluate` is consulted
    lastFilterPassed,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMarkPolled.mockResolvedValue(undefined);
  mockExecute.mockResolvedValue({ result: { value: 150 } });
  mockPoolQuery.mockResolvedValue({ rows: [{ id: 'conn-1' }] });
});

describe('computed-metric edge-trigger', () => {
  it('fires on the first crossing (last_filter_passed NULL, filter true)', async () => {
    mockListDue.mockResolvedValue([sub(null)]);
    mockEvaluate.mockReturnValue(true);

    const r = await runComputedMetricPollingCycle();

    expect(mockFire).toHaveBeenCalledTimes(1);
    expect(r.matched).toBe(1);
    expect(mockMarkPolled).toHaveBeenCalledWith('s1', 150, true); // records new state
  });

  it('does NOT fire while the condition stays true (last_filter_passed already true)', async () => {
    mockListDue.mockResolvedValue([sub(true)]);
    mockEvaluate.mockReturnValue(true);

    const r = await runComputedMetricPollingCycle();

    expect(mockFire).not.toHaveBeenCalled(); // <-- the fix: no re-fire on a held condition
    expect(r.matched).toBe(0);
    expect(mockMarkPolled).toHaveBeenCalledWith('s1', 150, true);
  });

  it('re-arms when the condition goes back to false (records false, no fire)', async () => {
    mockListDue.mockResolvedValue([sub(true)]);
    mockEvaluate.mockReturnValue(false);

    await runComputedMetricPollingCycle();

    expect(mockFire).not.toHaveBeenCalled();
    expect(mockMarkPolled).toHaveBeenCalledWith('s1', 150, false); // re-armed for next crossing
  });

  it('fires again after a re-arm (last_filter_passed false, filter true)', async () => {
    mockListDue.mockResolvedValue([sub(false)]);
    mockEvaluate.mockReturnValue(true);

    await runComputedMetricPollingCycle();

    expect(mockFire).toHaveBeenCalledTimes(1);
  });
});
