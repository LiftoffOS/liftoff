// The closure job is reachable at the path its Cloud Scheduler entry targets.
//
// `recordSuggestionOutcome` has had its columns since migration 063 and zero
// callers, so nothing has ever judged whether a refinement helped. Giving it an
// endpoint is only half a fix — an endpoint nobody calls is the same orphan one
// level up. The other half is the scheduler entry, and this test pins the
// contract between them: the route exists, on THIS router (the one the r5
// scheduler jobs reach), at the path the terraform names.

const mockRunClosure = jest.fn();

jest.mock('../../jobs/reflection-outcome-closure', () => ({
  runReflectionOutcomeClosure: (...a: unknown[]) => mockRunClosure(...a),
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn() }),
  getPoolForService: () => ({ query: jest.fn() }),
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
});

describe('POST /api/internal/reflection-outcome-closure', () => {
  it('runs the closure job and returns its counts', async () => {
    mockRunClosure.mockResolvedValue({
      assessed: 3, improved: 1, degraded: 1, noChange: 1, insufficientData: 0,
    });

    const res = await request(app()).post('/api/internal/reflection-outcome-closure');

    expect(res.status).toBe(200);
    expect(mockRunClosure).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      assessed: 3, improved: 1, degraded: 1, noChange: 1, insufficientData: 0,
    });
  });

  // A run that judged nothing is the normal state most of the time — there is
  // usually no suggestion past its settle window. It must read as a healthy
  // run, because the absence of this line is what the health signal watches for.
  it('reports a run that had nothing to judge as a success', async () => {
    mockRunClosure.mockResolvedValue({
      assessed: 0, improved: 0, degraded: 0, noChange: 0, insufficientData: 0,
    });

    const res = await request(app()).post('/api/internal/reflection-outcome-closure');

    expect(res.status).toBe(200);
    expect(res.body.assessed).toBe(0);
  });
});
