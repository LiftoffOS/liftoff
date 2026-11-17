// The sweep route answers whatever the run does. A rejection it does not catch
// leaves the response unsent, and the scheduler that called it reads a request
// timeout fifteen minutes later instead of a failure it could act on.

const mockProbeAllBindings = jest.fn();
jest.mock('../../connectors/binding-probe', () => ({
  probeAllBindings: (...a: unknown[]) => mockProbeAllBindings(...a),
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

describe('POST /api/internal/connector-binding-probe', () => {
  it('returns the run statistics', async () => {
    mockProbeAllBindings.mockResolvedValueOnce({ probed: 3, ok: 2, failed: 1 });

    const res = await request(app()).post('/api/internal/connector-binding-probe');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ probed: 3, ok: 2, failed: 1 });
  });

  it('answers 500 when the run throws, rather than leaving the request open', async () => {
    mockProbeAllBindings.mockRejectedValueOnce(new Error('insert violates foreign key constraint'));

    const res = await request(app()).post('/api/internal/connector-binding-probe');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'connector binding probe failed' });
  });
});
