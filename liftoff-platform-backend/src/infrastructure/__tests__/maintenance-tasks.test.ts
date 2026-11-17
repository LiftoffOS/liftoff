// Maintenance tasks replace the hourly Cloud Scheduler jobs, so a task must
// arrive exactly as the scheduler's request did: the same route, the
// scheduler SA's OIDC token, and the shared secret that route's own check
// expects. A duplicate name is
// the dedupe working, and an arming on a request path never throws.

const createTask = jest.fn();
const warn = jest.fn();

jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    queuePath: (p: string, l: string, q: string) => `projects/${p}/locations/${l}/queues/${q}`,
    createTask,
  })),
}));
jest.mock('../logging', () => ({ log: { warn, info: jest.fn(), error: jest.fn() } }));
jest.mock('../control-plane-url', () => ({ getBackendUrlOrNull: () => 'https://api.example.com' }));

import { enqueueMaintenanceTask, armMaintenance, armWatch, _resetArmedMemo } from '../maintenance-tasks';

const flush = () => new Promise((r) => setImmediate(r));
const SA = 'platform-backend@example-project.iam.gserviceaccount.com';

beforeEach(() => {
  createTask.mockReset().mockResolvedValue([{}]);
  warn.mockReset();
  _resetArmedMemo();
  Object.assign(process.env, {
    GCP_PROJECT_ID: 'example-control-prod',
    ENVIRONMENT: 'prod',
    CLOUD_SCHEDULER_SA_EMAIL: SA,
    PLATFORM_CALLBACK_TOKEN: 'callback-secret',
    TUNNEL_SERVICE_TOKEN: 'tunnel-secret',
  });
});

it('sends a route the scheduler identity and the callback secret', async () => {
  await enqueueMaintenanceTask({ name: 'watch-cost-ingest-1', path: '/api/internal/jobs/cost-attribution-ingest', auth: 'callback' });
  const { parent, task } = createTask.mock.calls[0][0];
  expect(parent).toBe('projects/example-control-prod/locations/us-west1/queues/maintenance-tasks-prod');
  expect(task.httpRequest.url).toBe('https://api.example.com/api/internal/jobs/cost-attribution-ingest');
  expect(task.httpRequest.headers['X-Service-Auth']).toBe('callback-secret');
  expect(task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: SA, audience: 'https://api.example.com' });
});

it('sends the tunnel secret to tunnel routes and no secret to OIDC-only routes', async () => {
  await enqueueMaintenanceTask({ name: 'a', path: '/api/internal/tunnels/sweep-pending', auth: 'tunnel' });
  await enqueueMaintenanceTask({ name: 'b', path: '/api/internal-agents/reconcile-runtime-state', auth: 'oidc' });
  expect(createTask.mock.calls[0][0].task.httpRequest.headers['X-Service-Auth']).toBe('tunnel-secret');
  expect(createTask.mock.calls[1][0].task.httpRequest.headers['X-Service-Auth']).toBeUndefined();
});

it('reads a duplicate name as already armed and throws anything else', async () => {
  createTask.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 6 }));
  await expect(enqueueMaintenanceTask({ name: 'n', path: '/p' })).resolves.toBe('already-armed');
  createTask.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 7 }));
  await expect(enqueueMaintenanceTask({ name: 'n', path: '/p' })).rejects.toThrow('denied');
});

it('does nothing without a scheduler identity to carry', async () => {
  delete process.env.CLOUD_SCHEDULER_SA_EMAIL;
  await expect(enqueueMaintenanceTask({ name: 'n', path: '/p' })).resolves.toBe('unconfigured');
  expect(createTask).not.toHaveBeenCalled();
});

it('arms without throwing, once per name, and logs a failure', async () => {
  createTask.mockRejectedValueOnce(new Error('unavailable'));
  expect(() => armMaintenance({ name: 'x', path: '/p' })).not.toThrow();
  await flush();
  expect(warn).toHaveBeenCalled();
  for (let i = 0; i < 20; i++) armWatch('cost-ingest', { path: '/p' }, 60_000);
  await flush();
  expect(createTask).toHaveBeenCalledTimes(2);
});
