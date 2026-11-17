// Maintenance tasks replace the hourly Cloud Scheduler jobs. What has to hold:
// a task reaches the same endpoint with the scheduler's OIDC identity, a
// duplicate name is success (that IS the dedupe), an arming on a hot path never
// throws and never repeats a round trip, and the two timing shapes land where
// they say.

const createTask = jest.fn();
const warn = jest.fn();

jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    queuePath: (p: string, l: string, q: string) => `projects/${p}/locations/${l}/queues/${q}`,
    createTask,
  })),
}));
jest.mock('../logging', () => ({ logger: { warn, info: jest.fn(), error: jest.fn() } }));

import {
  enqueueMaintenanceTask,
  armMaintenance,
  armWatch,
  armDue,
  WATCH_BUCKET_MS,
  _resetArmedMemo,
} from '../maintenance-tasks';

const ENV = {
  TENANT_ID: 'acme',
  ENVIRONMENT: 'prod',
  GCP_PROJECT_ID: 'tenant-acme-prod',
  CLOUD_SCHEDULER_SERVICE_ACCOUNT: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com',
  TENANT_RUNTIME_URL: 'https://agent-service-x.a.run.app',
  SANDBOX_EXECUTOR_URL: 'https://sandbox-executor-x.a.run.app',
};

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  createTask.mockReset().mockResolvedValue([{}]);
  warn.mockReset();
  _resetArmedMemo();
  Object.assign(process.env, ENV);
});

describe('enqueueMaintenanceTask', () => {
  it('aims at the endpoint on the maintenance queue with the scheduler identity', async () => {
    const at = new Date('2026-11-08T10:00:00.500Z');
    await expect(enqueueMaintenanceTask({
      path: '/api/internal/stalled-run-reconcile',
      name: 'watch-stalled-run-1:2',
      at,
      body: { a: 1 },
    })).resolves.toBe('enqueued');

    const { parent, task } = createTask.mock.calls[0][0];
    expect(parent).toBe('projects/tenant-acme-prod/locations/us-west1/queues/acme-maintenance-tasks-prod-v2');
    expect(task.name).toBe(`${parent}/tasks/watch-stalled-run-1-2`);
    expect(task.httpRequest.url).toBe('https://agent-service-x.a.run.app/api/internal/stalled-run-reconcile');
    expect(task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: ENV.CLOUD_SCHEDULER_SERVICE_ACCOUNT,
      audience: 'https://agent-service-x.a.run.app',
    });
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual({ a: 1 });
    expect(task.scheduleTime).toEqual({ seconds: Math.floor(at.getTime() / 1000), nanos: 500_000_000 });
  });

  it('targets sandbox-executor when asked', async () => {
    await enqueueMaintenanceTask({ path: '/api/v1/execution-environments/gc-sweep', name: 'n', target: 'sandbox-executor' });
    const { task } = createTask.mock.calls[0][0];
    expect(task.httpRequest.url).toBe('https://sandbox-executor-x.a.run.app/api/v1/execution-environments/gc-sweep');
    expect(task.httpRequest.oidcToken.audience).toBe('https://sandbox-executor-x.a.run.app');
  });

  it('reads a duplicate name as already armed', async () => {
    createTask.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 6 }));
    await expect(enqueueMaintenanceTask({ path: '/p', name: 'n' })).resolves.toBe('already-armed');
  });

  it('throws any other Cloud Tasks error', async () => {
    createTask.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 7 }));
    await expect(enqueueMaintenanceTask({ path: '/p', name: 'n' })).rejects.toThrow('denied');
  });

  it('does nothing where there is no queue to reach (local dev, tests)', async () => {
    delete process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT;
    await expect(enqueueMaintenanceTask({ path: '/p', name: 'n' })).resolves.toBe('unconfigured');
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe('armMaintenance', () => {
  it('never throws, and logs a failed arming', async () => {
    createTask.mockRejectedValueOnce(new Error('unavailable'));
    expect(() => armMaintenance({ path: '/p', name: 'n' })).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ task: 'n' }), expect.any(String));
  });

  it('makes one round trip per name per process', async () => {
    for (let i = 0; i < 50; i++) armMaintenance({ path: '/p', name: 'same' });
    await flush();
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failed arming', async () => {
    createTask.mockRejectedValueOnce(new Error('unavailable'));
    armMaintenance({ path: '/p', name: 'again' });
    await flush();
    armMaintenance({ path: '/p', name: 'again' });
    await flush();
    expect(createTask).toHaveBeenCalledTimes(2);
  });
});

describe('armWatch', () => {
  afterEach(() => jest.useRealTimers());

  it('fires at the first bucket boundary at least delayMs away, one task per bucket', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-08T10:03:00Z'), doNotFake: ['setImmediate'] });
    armWatch('stalled-run', '/api/internal/stalled-run-reconcile', { delayMs: 15 * 60 * 1000 });
    jest.setSystemTime(new Date('2026-11-08T10:04:00Z'));
    armWatch('stalled-run', '/api/internal/stalled-run-reconcile', { delayMs: 15 * 60 * 1000 });
    await flush();

    expect(createTask).toHaveBeenCalledTimes(1);
    const { task } = createTask.mock.calls[0][0];
    const bucket = Math.ceil((Date.parse('2026-11-08T10:03:00Z') + 15 * 60 * 1000) / WATCH_BUCKET_MS);
    expect(task.name).toMatch(new RegExp(`/tasks/watch-stalled-run-${bucket}$`));
    expect(task.scheduleTime.seconds * 1000).toBe(Date.parse('2026-11-08T10:20:00Z'));
  });
});

describe('armDue', () => {
  afterEach(() => jest.useRealTimers());

  it('fires at the due time, on the minute', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-08T10:00:00Z'), doNotFake: ['setImmediate'] });
    armDue('gmail-watch-rearm', '/api/internal/gmail-watch-rearm', new Date('2026-11-12T08:30:20Z'));
    await flush();
    const { task } = createTask.mock.calls[0][0];
    expect(task.scheduleTime.seconds * 1000).toBe(Date.parse('2026-11-12T08:31:00Z'));
  });

  it('turns an overdue time into the floor, not an immediate loop', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-08T10:00:00Z'), doNotFake: ['setImmediate'] });
    armDue('computed-metric', '/api/internal/computed-metric-poller', new Date('2026-11-01T00:00:00Z'), {
      minDelayMs: 60 * 60 * 1000,
    });
    await flush();
    const { task } = createTask.mock.calls[0][0];
    expect(task.scheduleTime.seconds * 1000).toBe(Date.parse('2026-11-08T11:00:00Z'));
  });
});
