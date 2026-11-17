// enqueueHrbpSpec contract test (PR 0.2):
//   - Cloud Tasks payload carries planId, runId, spec, approverAccountId
//   - Task name is deterministic per (planId, specId) so duplicate enqueues
//     dedupe naturally
//   - OIDC token's audience is the workforce-service URL
//   - ALREADY_EXISTS is swallowed (idempotent retry path)

import { resetConfigForTests } from '../infrastructure/config.js';

const createTask = jest.fn();
const queuePath = jest.fn().mockReturnValue('projects/p/locations/r/queues/workforce-hrbp-fanout-dev');

jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({ createTask, queuePath })),
}));

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.local';
  process.env['GCP_PROJECT_ID'] = 'test-project';
  process.env['GCP_REGION'] = 'us-west1';
  process.env['ENVIRONMENT'] = 'dev';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:region:instance';
  process.env['WORKFORCE_SERVICE_URL'] = 'https://workforce.example';
  process.env['WORKFORCE_SERVICE_ACCOUNT_EMAIL'] = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';
  createTask.mockReset();
});

describe('enqueueHrbpSpec', () => {
  it('creates a Cloud Task whose body carries planId/runId/spec/approverAccountId, with the OIDC audience set to WORKFORCE_SERVICE_URL', async () => {
    createTask.mockResolvedValueOnce([{ name: 'projects/p/.../tasks/hrbp-plan-1-spec-1' }]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueHrbpSpec } = require('../infrastructure/cloud-tasks.js');
    await enqueueHrbpSpec({
      tenantId: 'tenant-1',
      planId: 'plan-1',
      runId: 'run-1',
      spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
      approverAccountId: 'acct-1',
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    const task = createTask.mock.calls[0][0].task;
    // Scoped to the RUN, not the plan. A task name identifies one attempt at a
    // spec; keyed to the plan, a later deliberate attempt — a resume, or a
    // re-approval after reopen — rebuilds the earlier name and is dropped as a
    // duplicate instead of running.
    expect(task.name).toBe('projects/p/locations/r/queues/workforce-hrbp-fanout-dev/tasks/hrbp-run-1-spec-1');
    // The idempotency key is the opposite: it identifies the agent to create,
    // so it stays keyed to {planId, specId} across every attempt. That is what
    // stops a retry creating a second agent.
    expect(task.httpRequest.headers['X-Idempotency-Key']).toBe('hrbp-plan-1-spec-1');
    expect(task.httpRequest.url).toBe('https://workforce.example/api/tasks/hrbp-provision-spec');
    expect(task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com',
      audience: 'https://workforce.example',
    });
    const body = JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString());
    expect(body).toEqual({
      tenantId: 'tenant-1',
      planId: 'plan-1',
      runId: 'run-1',
      spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
      approverAccountId: 'acct-1',
    });
  });

  it('reports ALREADY_EXISTS as "not enqueued" rather than as a successful enqueue', async () => {
    createTask.mockRejectedValueOnce(new Error('5 ALREADY_EXISTS: Requested entity already exists'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueHrbpSpec } = require('../infrastructure/cloud-tasks.js');

    const result = await enqueueHrbpSpec({
      tenantId: 'tenant-1',
      planId: 'plan-1',
      runId: 'run-1',
      spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
      approverAccountId: 'acct-1',
    });

    // Distinct from the task name a real enqueue returns. A caller that cannot
    // tell the two apart counts dedup hits as work done and reports retries
    // that never happened.
    expect(result.enqueued).toBe(false);
    expect(result.taskName).toMatch(/hrbp-run-1-spec-1$/);
  });

  it('reports a real enqueue as enqueued', async () => {
    createTask.mockResolvedValueOnce([{ name: 'projects/p/.../tasks/hrbp-run-1-spec-1' }]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueHrbpSpec } = require('../infrastructure/cloud-tasks.js');

    const result = await enqueueHrbpSpec({
      tenantId: 'tenant-1',
      planId: 'plan-1',
      runId: 'run-1',
      spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
      approverAccountId: 'acct-1',
    });

    expect(result.enqueued).toBe(true);
  });

  it('gives two runs at the same spec two different task names', async () => {
    createTask.mockResolvedValue([{ name: 'x' }]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueHrbpSpec } = require('../infrastructure/cloud-tasks.js');
    const base = {
      tenantId: 'tenant-1',
      planId: 'plan-1',
      spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
      approverAccountId: 'acct-1',
    };

    await enqueueHrbpSpec({ ...base, runId: 'run-1' });
    await enqueueHrbpSpec({ ...base, runId: 'run-2' });

    const names = createTask.mock.calls.map(c => c[0].task.name);
    expect(names[0]).not.toBe(names[1]);
    // ...while the agent they would create stays the same one.
    const keys = createTask.mock.calls.map(c => c[0].task.httpRequest.headers['X-Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
  });

  it('rethrows non-ALREADY_EXISTS errors', async () => {
    createTask.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueHrbpSpec } = require('../infrastructure/cloud-tasks.js');
    await expect(
      enqueueHrbpSpec({
        tenantId: 'tenant-1',
        planId: 'plan-1',
        runId: 'run-1',
        spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
        approverAccountId: 'acct-1',
      }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('throws when WORKFORCE_SERVICE_URL is unset (fan-out cannot reach handler)', async () => {
    delete process.env['WORKFORCE_SERVICE_URL'];
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { enqueueHrbpSpec } = require('../infrastructure/cloud-tasks.js');
    await expect(
      enqueueHrbpSpec({
        tenantId: 'tenant-1',
        planId: 'plan-1',
        runId: 'run-1',
        spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
        approverAccountId: 'acct-1',
      }),
    ).rejects.toThrow(/WORKFORCE_SERVICE_URL is required/);
  });
});
