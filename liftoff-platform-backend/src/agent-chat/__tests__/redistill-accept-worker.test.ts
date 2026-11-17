// The redistill-accept worker: the background half of accepting a routine.
//
// What matters: only the queue (or the local secret) gets in; a malformed task
// is poison and is dropped with 200; success posts the confirmation exactly
// once across retries (the external_ref does the deduping) and pushes it to
// the channel; a failed redistill retries via 5xx until the last attempt,
// which posts the honest failure note instead of retrying forever.

import express from 'express';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRedistill = jest.fn();
jest.mock('../../internal-agents/redistill-service', () => ({
  redistillAgent: (...a: unknown[]) => mockRedistill(...a),
}));

const mockAppend = jest.fn();
jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockAppend(...a),
}));

const mockPush = jest.fn();
jest.mock('../out-of-turn-delivery', () => ({
  pushOutOfTurnMessage: (...a: unknown[]) => mockPush(...a),
}));

import { redistillAcceptWorkerRouter } from '../redistill-accept-worker';

const SECRET = 'worker-secret-under-test';
const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = '55555555-5555-5555-5555-555555555555';
const SUGGESTION = '66666666-6666-6666-6666-666666666666';
const THREAD = '77777777-7777-7777-7777-777777777777';

const TASK = {
  tenantId: TENANT,
  agentId: AGENT,
  suggestionId: SUGGESTION,
  threadId: THREAD,
  routineProse: 'Every Friday at 4pm, post the most urgent open item here.',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/chat-turns', redistillAcceptWorkerRouter);
  return app;
}

function post(
  app: express.Express,
  body: unknown,
  opts: { secret?: string; retryCount?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/chat-turns/redistill-accept`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.secret ? { 'x-internal-secret': opts.secret } : {}),
          ...(opts.retryCount !== undefined
            ? { 'X-CloudTasks-TaskRetryCount': String(opts.retryCount) }
            : {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
  mockRedistill.mockResolvedValue({});
  mockAppend.mockResolvedValue({});
  mockPush.mockResolvedValue({ channel: 'web', pushed: null });
});

afterAll(() => {
  delete process.env.INTERNAL_SERVICE_SECRET;
});

it('rejects a caller without the worker credential', async () => {
  const res = await post(buildApp(), TASK);
  expect(res.status).toBe(401);
  expect(mockRedistill).not.toHaveBeenCalled();
});

it('drops a malformed task with 200 so the queue never retries poison', async () => {
  const res = await post(buildApp(), { nope: true }, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ dropped: true });
  expect(mockRedistill).not.toHaveBeenCalled();
});

it('redistills scoped-first, confirms in-thread with the dedup ref, and pushes', async () => {
  const res = await post(buildApp(), TASK, { secret: SECRET });
  expect(res.status).toBe(200);
  // Scoped attempt carries derive-then-verify AND the triggers scope.
  expect(mockRedistill).toHaveBeenCalledTimes(1);
  expect(mockRedistill).toHaveBeenCalledWith(AGENT, TENANT, undefined, {
    expectedCadences: [{ prose: TASK.routineProse, cronExpr: '0 16 * * 5' }],
    scope: 'triggers',
  });

  const appendArgs = mockAppend.mock.calls[0];
  expect(appendArgs[1]).toBe(THREAD);
  expect(appendArgs[3]).toContain('The routine is live');
  expect(appendArgs[3]).toContain(TASK.routineProse);
  expect(appendArgs[12]).toBe(`suggestion-live:${SUGGESTION}`);
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD }));
});

it('a stop carries the removed line as a stoppedCadence the analyzer can enforce', async () => {
  const stopTask = {
    ...TASK,
    action: 'stop',
    targetLabel: 'friday most urgent item',
    routineProse: 'Stop the friday most urgent item routine; it must no longer run.',
    replacesProse: 'Every Friday at 10am, send a one line note with the most urgent open item.',
  };
  const res = await post(buildApp(), stopTask, { secret: SECRET });
  expect(res.status).toBe(200);
  // The removed line, not the stop sentence: it states the cadence the
  // trigger set must no longer contain.
  expect(mockRedistill).toHaveBeenCalledWith(AGENT, TENANT, undefined, {
    stoppedCadences: [{ prose: stopTask.replacesProse, cronExpr: '0 10 * * 5' }],
    scope: 'triggers',
  });
  expect(mockAppend.mock.calls[0][3]).toContain('stopped and removed from my schedule');
});

it('a stop without a removed line still states the stop, parsed from the stop sentence', async () => {
  const stopTask = {
    ...TASK,
    action: 'stop',
    routineProse: 'Stop the Every Friday at 10am, send a one line routine; it must no longer run.',
  };
  const res = await post(buildApp(), stopTask, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockRedistill).toHaveBeenCalledWith(AGENT, TENANT, undefined, {
    stoppedCadences: [{ prose: stopTask.routineProse, cronExpr: '0 10 * * 5' }],
    scope: 'triggers',
  });
});

it('an unparseable stop still reaches the model as prose, without a cron to enforce', async () => {
  const stopTask = {
    ...TASK,
    action: 'stop',
    routineProse: 'Stop the midweek material move check routine; it must no longer run.',
  };
  const res = await post(buildApp(), stopTask, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockRedistill).toHaveBeenCalledWith(AGENT, TENANT, undefined, {
    stoppedCadences: [{ prose: stopTask.routineProse }],
    scope: 'triggers',
  });
});

it('treats a duplicate confirmation as already delivered and does not push again', async () => {
  mockAppend.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
  const res = await post(buildApp(), TASK, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockPush).not.toHaveBeenCalled();
});

it('falls back to the full redistill when the scoped rebuild fails', async () => {
  mockRedistill
    .mockRejectedValueOnce(new Error('scoped path broke'))
    .mockResolvedValueOnce({});
  const res = await post(buildApp(), TASK, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockRedistill).toHaveBeenCalledTimes(2);
  const secondCall = mockRedistill.mock.calls[1];
  expect(secondCall[3]?.scope).toBeUndefined();
  expect(mockAppend).toHaveBeenCalled();
});

it('runs the FULL redistill for a task without routineProse (the CAIO prose path)', async () => {
  const caioTask = { tenantId: TENANT, agentId: AGENT };
  const res = await post(buildApp(), caioTask, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockRedistill).toHaveBeenCalledTimes(1);
  // No scope: a prose edit must regenerate everything together.
  expect(mockRedistill.mock.calls[0][3]?.scope).toBeUndefined();
  expect(mockAppend).not.toHaveBeenCalled();
});

it('answers 5xx when both the scoped and full redistills fail, so the queue retries', async () => {
  mockRedistill.mockRejectedValue(new Error('distill blew up'));
  const res = await post(buildApp(), TASK, { secret: SECRET, retryCount: 0 });
  expect(res.status).toBe(500);
  expect(mockAppend).not.toHaveBeenCalled();
});

it('posts the honest failure note on the last attempt and stops the queue', async () => {
  mockRedistill.mockRejectedValue(new Error('distill blew up'));
  const res = await post(buildApp(), TASK, { secret: SECRET, retryCount: 3 });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ gaveUp: true });

  const appendArgs = mockAppend.mock.calls[0];
  expect(appendArgs[3]).toContain('could not finish');
  expect(appendArgs[12]).toBe(`suggestion-failed:${SUGGESTION}`);
});
