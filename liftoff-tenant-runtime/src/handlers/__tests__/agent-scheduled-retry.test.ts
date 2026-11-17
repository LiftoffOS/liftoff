// A transient provider failure asks Cloud Tasks to deliver again.
//
// The adapter turns an SDK throw into a completion event with outcome:'error',
// which RETURNS rather than throws, so this handler answered 200 and Cloud Tasks
// marked the task done. A 429 therefore ended a scheduled run permanently and
// the only recovery was a human clicking "Run again" — which mints a fresh
// scheduleKey and cold-starts the work from the beginning.
//
// Everything a redelivery needs already existed. The missing wire was the status
// code, and that is what this pins: which failure classes hand the task back,
// which do not, and that the routine breaker is not fed by a retry.

const executeTask = jest.fn();
const recordRoutineOutcome = jest.fn();
const query = jest.fn();
const connect = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({
    query: (...a: unknown[]) => query(...a),
    connect: (...a: unknown[]) => connect(...a),
  }),
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/oidc', () => ({ verifyOidcToken: jest.fn().mockResolvedValue(true) }));
jest.mock('../../infrastructure/safe-trace-context', () => ({ setTraceContext: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { executeTask: (...a: unknown[]) => executeTask(...a) },
}));
jest.mock('../../scheduling/routine-failure-state', () => ({
  recordRoutineOutcome: (...a: unknown[]) => recordRoutineOutcome(...a),
}));
jest.mock('../../invocations/service', () => ({ invocationsService: {} }));

import express from 'express';
import request from 'supertest';
import { cloudTasksHandler } from '../cloud-tasks-handler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', cloudTasksHandler);
  return app;
}

/** The route holds a dedicated connection for the advisory lock. Grant the lock
 *  and report an ACTIVE agent whose canonical status agrees, so the request
 *  reaches the execute step. */
function grantLockAndActiveAgent() {
  const client = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      if (/SELECT a\.lifecycle/.test(sql)) {
        return { rows: [{ lifecycle: 'ACTIVE', canonical_status: 'active', internal_agent_id: 'ia-1' }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  connect.mockResolvedValue(client);
  return client;
}

const PAYLOAD = {
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  agentId: '00000000-0000-0000-0000-0000000000bb',
  workflowId: '00000000-0000-0000-0000-0000000000cc',
  taskId: '00000000-0000-0000-0000-0000000000dd',
  objective: 'sweep the inbox',
  triggeredByLabel: 'companion:morning-sweep',
};

function post() {
  return request(makeApp()).post('/api/tasks/agent-scheduled').send(PAYLOAD);
}

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  grantLockAndActiveAgent();
});

describe('POST /api/tasks/agent-scheduled — retryable provider failures', () => {
  it.each([
    'provider_capacity',
    'provider_server_error',
    'provider_network',
    'context_overflow',
  ])('returns 500 so Cloud Tasks redelivers: %s', async (failureClass) => {
    executeTask.mockResolvedValue({
      success: false, failureClass, error: 'boom', toolCallsExecuted: 0, reasoningSteps: 0,
    });
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body).toEqual(expect.objectContaining({ retryable: true, failureClass }));
  });

  it.each([
    // Retrying these re-sends the same rejected credential or spends against the
    // same empty balance.
    'provider_auth',
    'provider_quota',
    // Deterministic, deliberate, or a budget decision.
    'validation',
    'task_failed',
    'recovery_declined',
    'limit_reached',
    'agent_declined',
    'timeout',
    // The agent is working; hammering the lock does not make it finish sooner.
    'agent_busy',
    'admission_denied',
    'lifecycle_not_active',
  ])('still returns 200 for: %s', async (failureClass) => {
    executeTask.mockResolvedValue({
      success: false, failureClass, error: 'boom', toolCallsExecuted: 0, reasoningSteps: 0,
    });
    const res = await post();
    expect(res.status).toBe(200);
  });

  it('returns 200 on success', async () => {
    executeTask.mockResolvedValue({ success: true, toolCallsExecuted: 2, reasoningSteps: 3 });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
  });

  it('returns 200 on an unclassified failure — no class is not a licence to retry', async () => {
    executeTask.mockResolvedValue({
      success: false, error: 'boom', toolCallsExecuted: 0, reasoningSteps: 0,
    });
    const res = await post();
    expect(res.status).toBe(200);
  });

  // The retry and the class filter are load-bearing for each other precisely
  // here: recordRoutineOutcome runs BEFORE the 500, so without the filter every
  // retry attempt would count a routine failure and reach the agent-pausing
  // threshold FASTER than before the retry existed.
  it('hands the class to the routine breaker, which is what stops a retry counting', async () => {
    executeTask.mockResolvedValue({
      success: false, failureClass: 'provider_capacity', error: 'overloaded',
      toolCallsExecuted: 0, reasoningSteps: 0,
    });
    await post();
    expect(recordRoutineOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ failureClass: 'provider_capacity', success: false }),
    );
  });
});
