// Invariant computed-metric poller tests.
//
// An invariant asserts a predicate that should ALWAYS hold. The poller must:
//   - ESCALATE to a human (not fire the agent) on the satisfied→violated edge,
//   - NOT re-escalate while it stays violated,
//   - re-arm when it returns to satisfied,
//   - append EVERY check to the goal_ledger (satisfied and violated),
//   - treat NULL last_filter_passed as satisfied so a first-check violation
//     still escalates.

const mockListDue = jest.fn();
const mockMarkPolled = jest.fn().mockResolvedValue(undefined);
const mockMarkError = jest.fn().mockResolvedValue(undefined);
const mockAppendLedger = jest.fn().mockResolvedValue(undefined);
const mockFire = jest.fn().mockResolvedValue(undefined);
const mockEscalate = jest.fn().mockResolvedValue('esc-1');
const mockEvaluate = jest.fn();
const mockExecute = jest.fn().mockResolvedValue({ result: { value: 50 } });
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [{ connector_id: 'conn-1' }] });

jest.mock('../repository', () => ({
  reactiveSubscriptionRepo: {
    listDueComputedMetric: (...a: unknown[]) => mockListDue(...a),
    markPolled: (...a: unknown[]) => mockMarkPolled(...a),
    markError: (...a: unknown[]) => mockMarkError(...a),
    appendGoalLedger: (...a: unknown[]) => mockAppendLedger(...a),
  },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute }),
}));
jest.mock('../fire', () => ({ fireAgentForSubscription: (...a: unknown[]) => mockFire(...a) }));
jest.mock('../invariant', () => ({ escalateInvariantViolation: (...a: unknown[]) => mockEscalate(...a) }));
jest.mock('../predicate-evaluator', () => ({ evaluate: (...a: unknown[]) => mockEvaluate(...a) }));
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockPoolQuery }) }));
jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { runComputedMetricPollingCycle } from '../computed-metric-poller';

// `filter` here asserts the condition that should hold; `evaluate` is mocked so
// the test controls whether the invariant is satisfied on this poll.
function invariantSub(lastFilterPassed: boolean | null) {
  return {
    id: 's1', tenantId: 't1', agentId: 'a1',
    label: 'error-rate-under-threshold',
    objective: 'Keep error rate below 100',
    source: { kind: 'computed_metric', mode: 'invariant', connectorRef: 'c', fn: 'f', extractPath: 'value', args: {} },
    filter: { op: 'lt', path: 'value', value: 100 },
    lastFilterPassed,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMarkPolled.mockResolvedValue(undefined);
  mockAppendLedger.mockResolvedValue(undefined);
  mockEscalate.mockResolvedValue('esc-1');
  mockExecute.mockResolvedValue({ result: { value: 50 } });
  mockPoolQuery.mockResolvedValue({ rows: [{ connector_id: 'conn-1' }] });
});

describe('invariant computed-metric poller', () => {
  it('escalates exactly once on the satisfied→violated edge and never fires an agent', async () => {
    mockListDue.mockResolvedValue([invariantSub(true)]); // prior poll: satisfied
    mockEvaluate.mockReturnValue(false);                 // now: predicate does NOT hold => violated

    const r = await runComputedMetricPollingCycle();

    expect(mockEscalate).toHaveBeenCalledTimes(1);
    expect(mockFire).not.toHaveBeenCalled();             // invariant never fires the agent
    expect(r.escalated).toBe(1);
    expect(r.matched).toBe(0);
    // ledger row: violated, escalated true, carries the escalation id
    expect(mockAppendLedger).toHaveBeenCalledWith(expect.objectContaining({
      subscriptionId: 's1', tenantId: 't1', agentId: 'a1',
      status: 'violated', escalated: true, escalationId: 'esc-1', value: 50,
    }));
    // re-arm state recorded: satisfied=false
    expect(mockMarkPolled).toHaveBeenCalledWith('s1', 50, false);
  });

  it('does NOT re-escalate while the invariant stays violated (already violated)', async () => {
    mockListDue.mockResolvedValue([invariantSub(false)]); // prior poll: violated
    mockEvaluate.mockReturnValue(false);                  // still violated

    const r = await runComputedMetricPollingCycle();

    expect(mockEscalate).not.toHaveBeenCalled();          // <- no spam on a held violation
    expect(r.escalated).toBe(0);
    // still appends a ledger row so the breach history is continuous
    expect(mockAppendLedger).toHaveBeenCalledWith(expect.objectContaining({
      status: 'violated', escalated: false, escalationId: null,
    }));
  });

  it('re-arms when the invariant returns to satisfied (records satisfied, no escalation)', async () => {
    mockListDue.mockResolvedValue([invariantSub(false)]); // prior poll: violated
    mockEvaluate.mockReturnValue(true);                   // now: satisfied again

    const r = await runComputedMetricPollingCycle();

    expect(mockEscalate).not.toHaveBeenCalled();
    expect(r.escalated).toBe(0);
    expect(mockAppendLedger).toHaveBeenCalledWith(expect.objectContaining({
      status: 'satisfied', escalated: false, escalationId: null,
    }));
    expect(mockMarkPolled).toHaveBeenCalledWith('s1', 50, true); // re-armed
  });

  it('escalates again after a re-arm (satisfied→violated once more)', async () => {
    mockListDue.mockResolvedValue([invariantSub(true)]); // re-armed to satisfied
    mockEvaluate.mockReturnValue(false);                 // violated again

    await runComputedMetricPollingCycle();

    expect(mockEscalate).toHaveBeenCalledTimes(1);
  });

  it('escalates on a first-check violation (last_filter_passed NULL treated as satisfied)', async () => {
    mockListDue.mockResolvedValue([invariantSub(null)]); // never evaluated
    mockEvaluate.mockReturnValue(false);                 // first observation is a violation

    const r = await runComputedMetricPollingCycle();

    expect(mockEscalate).toHaveBeenCalledTimes(1);
    expect(r.escalated).toBe(1);
  });

  it('records a satisfied ledger row and does not escalate while the invariant holds', async () => {
    mockListDue.mockResolvedValue([invariantSub(true)]);
    mockEvaluate.mockReturnValue(true); // holds

    await runComputedMetricPollingCycle();

    expect(mockEscalate).not.toHaveBeenCalled();
    expect(mockAppendLedger).toHaveBeenCalledWith(expect.objectContaining({
      status: 'satisfied', escalated: false,
    }));
  });

  it('does not touch the opportunity fire path for invariants', async () => {
    mockListDue.mockResolvedValue([invariantSub(true)]);
    mockEvaluate.mockReturnValue(false);

    await runComputedMetricPollingCycle();

    expect(mockFire).not.toHaveBeenCalled();
  });
});
