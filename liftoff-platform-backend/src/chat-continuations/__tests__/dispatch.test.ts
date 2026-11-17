// The continuation's Cloud Task: its own queue, named by the row, a small
// first delay, the OIDC invoker, and the last-delivery test off the retry
// header against the queue's maxAttempts.

const mockCreateTask = jest.fn();
jest.mock('@google-cloud/tasks', () => ({
  CloudTasksClient: jest.fn().mockImplementation(() => ({
    queuePath: (project: string, location: string, queue: string) => `projects/${project}/locations/${location}/queues/${queue}`,
    createTask: (...args: unknown[]) => mockCreateTask(...args),
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

import {
  CONTINUATION_DISPATCH_DEADLINE_SECONDS,
  CONTINUATION_QUEUE_MAX_ATTEMPTS,
  CONTINUATION_SCHEDULE_DELAY_SECONDS,
  enqueueContinuationTask,
  isLastDelivery,
} from '../dispatch';

beforeEach(() => {
  mockCreateTask.mockReset().mockResolvedValue([{ name: 'task-1' }]);
  process.env.ENVIRONMENT = 'dev';
  process.env.MCP_CHAT_RUNS_INVOKER_SA = 'invoker@test.iam';
});

describe('enqueueContinuationTask', () => {
  it('creates the task on chat-continuations-{env}, named by the row, delayed a little, with the 600 s deadline and the invoker', async () => {
    const before = Math.floor(Date.now() / 1000);
    await enqueueContinuationTask('c1', 't1');
    const call = mockCreateTask.mock.calls[0][0] as { parent: string; task: Record<string, unknown> };
    expect(call.parent).toMatch(/\/queues\/chat-continuations-dev$/);
    expect(call.task.name).toBe(`${call.parent}/tasks/c1`);
    expect(call.task.dispatchDeadline).toEqual({ seconds: CONTINUATION_DISPATCH_DEADLINE_SECONDS });
    const scheduled = (call.task.scheduleTime as { seconds: number }).seconds;
    expect(scheduled).toBeGreaterThanOrEqual(before + CONTINUATION_SCHEDULE_DELAY_SECONDS);
    const http = call.task.httpRequest as { url: string; body: string; oidcToken: { serviceAccountEmail: string; audience: string } };
    expect(http.url).toBe('https://api-test.example.com/api/internal/mcp-chat-runs/continue');
    expect(JSON.parse(Buffer.from(http.body, 'base64').toString())).toEqual({ continuationId: 'c1', tenantId: 't1' });
    expect(http.oidcToken).toEqual({ serviceAccountEmail: 'invoker@test.iam', audience: 'https://api-test.example.com' });
  });
});

describe('isLastDelivery', () => {
  it('reads the retry-count header against the queue\'s maxAttempts', () => {
    expect(CONTINUATION_QUEUE_MAX_ATTEMPTS).toBe(20);
    expect(isLastDelivery(undefined)).toBe(false);
    expect(isLastDelivery('0')).toBe(false);
    expect(isLastDelivery('18')).toBe(false);
    expect(isLastDelivery('19')).toBe(true);
    expect(isLastDelivery(['19'])).toBe(true);
    expect(isLastDelivery('garbage')).toBe(false);
  });
});
