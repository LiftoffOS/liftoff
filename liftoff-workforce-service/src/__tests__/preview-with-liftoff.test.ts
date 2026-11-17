/**
 * The preview_with_liftoff tool.
 *
 * A call onto platform-backend and nothing more, so what is worth pinning is
 * the call: that the thread, the person and the task travel with it, that a
 * turn without a thread never creates a conversation, that the idempotent
 * "already exists" answer tells the model to reuse rather than apologise,
 * and that every failure comes back as something the model can say out loud
 * rather than a thrown error that kills the turn.
 */
import { resetConfigForTests } from '../infrastructure/config.js';
import { previewWithLiftoffTool } from '../workforce-plans/tools/preview-with-liftoff.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const ctx: WorkforcePlanToolContext = {
  tenantId: 'tenant-123',
  accountId: 'account-123',
  role: 'owner',
  threadId: 'thread-123',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('preview_with_liftoff', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    resetConfigForTests();
    process.env['PLATFORM_BACKEND_URL'] = 'http://localhost:3000';
    process.env['GCP_PROJECT_ID'] = 'test';
    process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
    process.env['WORKFORCE_SERVICE_TOKEN'] = 'test-service-auth';
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env['PLATFORM_BACKEND_URL'];
    delete process.env['GCP_PROJECT_ID'];
    delete process.env['DB_INSTANCE_CONNECTION_NAME'];
    delete process.env['WORKFORCE_SERVICE_TOKEN'];
    resetConfigForTests();
  });

  it('sends the tenant, the person, the thread and the task to platform-backend', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { liftoffThreadId: 'lt-1' }));

    const out = await previewWithLiftoffTool.execute(
      { task: 'Compile the weekly NBA news summary.', colleagueLabel: 'Chief AI Officer' },
      ctx,
    ) as { ok: boolean; message: string };

    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/ready in Liftoff/);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/internal/preview');
    expect((init.headers as Record<string, string>)['X-Service-Auth']).toBe('test-service-auth');
    expect(JSON.parse(init.body as string)).toEqual({
      tenantId: 'tenant-123',
      accountId: 'account-123',
      teamPlanThreadId: 'thread-123',
      taskContext: 'Compile the weekly NBA news summary.',
      colleagueLabel: 'Chief AI Officer',
    });
  });

  it('tells the model to reuse the conversation that already exists', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { liftoffThreadId: 'lt-1', existing: true }));

    const out = await previewWithLiftoffTool.execute(
      { task: 'The same task again.', colleagueLabel: 'Chief AI Officer' },
      ctx,
    ) as { ok: boolean; message: string };

    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/already exists/);
    expect(out.message).toMatch(/continue/i);
  });

  it('never creates a conversation on a turn without a thread', async () => {
    const out = await previewWithLiftoffTool.execute(
      { task: 'A task.', colleagueLabel: 'Chief AI Officer' },
      { ...ctx, threadId: undefined },
    ) as { ok: boolean; message: string };

    expect(out.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires a task in plain words', async () => {
    const out = await previewWithLiftoffTool.execute(
      { colleagueLabel: 'Chief AI Officer' },
      ctx,
    ) as { ok: boolean; message: string };

    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/task/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports an unreachable platform-backend as words, not a thrown error', async () => {
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const out = await previewWithLiftoffTool.execute(
      { task: 'A task.', colleagueLabel: 'Chief AI Officer' },
      ctx,
    ) as { ok: boolean; message: string };

    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/could not be created/i);
  });

  it('reports a non-2xx status as words, not a thrown error', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: 'boom' }));

    const out = await previewWithLiftoffTool.execute(
      { task: 'A task.', colleagueLabel: 'Chief AI Officer' },
      ctx,
    ) as { ok: boolean; message: string };

    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/could not be created/i);
  });
});
