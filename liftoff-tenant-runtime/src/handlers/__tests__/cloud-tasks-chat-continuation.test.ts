// Cloud Tasks dispatcher — the chat-continuation kind. The route hands the
// delivery to the continuation module with its place in the queue, answers a
// retryable status when the module asks for a retry (the thread was busy),
// and 200 for every final outcome so the queue does not re-drive a row that
// is done, cancelled or failed.

const runChatContinuationTaskMock = jest.fn();
jest.mock('../../interactive-chat/chat-continuation', () => ({
  runChatContinuationTask: (...a: unknown[]) => runChatContinuationTaskMock(...a),
  isLastChatContinuationDelivery: (h: string | undefined) => h === '4',
  CLOUD_TASKS_RETRY_COUNT_HEADER: 'x-cloudtasks-taskretrycount',
}));
jest.mock('../../agent-execution/service', () => ({ agentExecutionService: {} }));
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({ agentScheduledInvocationsRepo: {} }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/safe-trace-context', () => ({ setTraceContext: jest.fn() }));
jest.mock('../../infrastructure/oidc', () => ({ verifyOidcToken: jest.fn().mockResolvedValue(true) }));
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { cloudTasksHandler } from '../cloud-tasks-handler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', cloudTasksHandler);
  return app;
}

const body = {
  tenantId: 't1', agentId: 'a1', invocationId: 'inv-origin',
  workflowResume: { kind: 'chat-continuation', scheduledInvocationId: 'row-1' },
};

beforeEach(() => jest.clearAllMocks());

describe('Cloud Tasks /resume-execution — chat-continuation', () => {
  it('hands the delivery to the module with the row and whether this is the last delivery, and answers 200 done', async () => {
    runChatContinuationTaskMock.mockResolvedValue({ status: 'done', invocationId: 'inv-1', continued: false });
    const res = await request(makeApp()).post('/api/tasks/resume-execution')
      .set('x-cloudtasks-taskretrycount', '4').send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resumed: true, kind: 'chat-continuation', status: 'done' });
    expect(runChatContinuationTaskMock).toHaveBeenCalledWith({ tenantId: 't1', scheduledInvocationId: 'row-1', lastDelivery: true });
  });

  it('a busy thread is a retryable status; a cancelled or failed row is 200', async () => {
    runChatContinuationTaskMock.mockResolvedValue({ status: 'retry', reason: 'lock_busy' });
    const retry = await request(makeApp()).post('/api/tasks/resume-execution').send(body);
    expect(retry.status).toBe(503);
    expect(runChatContinuationTaskMock).toHaveBeenLastCalledWith(expect.objectContaining({ lastDelivery: false }));

    runChatContinuationTaskMock.mockResolvedValue({ status: 'cancelled', reason: 'superseded' });
    const cancelled = await request(makeApp()).post('/api/tasks/resume-execution').send(body);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ resumed: false, status: 'cancelled', reason: 'superseded' });

    runChatContinuationTaskMock.mockResolvedValue({ status: 'failed', reason: 'lock_busy' });
    const failed = await request(makeApp()).post('/api/tasks/resume-execution').send(body);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ resumed: false, status: 'failed' });
  });

  it('a thrown continuation is a 500 so the queue retries it', async () => {
    runChatContinuationTaskMock.mockRejectedValue(new Error('boom'));
    const res = await request(makeApp()).post('/api/tasks/resume-execution').send(body);
    expect(res.status).toBe(500);
  });
});
