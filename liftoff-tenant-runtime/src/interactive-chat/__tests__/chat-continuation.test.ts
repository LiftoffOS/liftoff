// The continuation of a chat turn a bound closed: the row and its task, the
// cancel a person's message makes, and the handoff in each ordering it has
// to be safe under — cancel before the claim; cancel between the claim and
// the lock; a newer person message; the lock busy, re-queued and retried,
// failed on the last delivery; and the run itself, as the person, with the
// note as its objective, its reply delivered to the thread and the next
// continuation chained only when the closing reply says the work goes on.

const repo = {
  insert: jest.fn(), updateCloudTaskName: jest.fn(), cancelByContextRefPrefix: jest.fn(),
  claimHitlForResume: jest.fn(), releaseResumeLease: jest.fn(), markWakeErrored: jest.fn(),
  getById: jest.fn(), markFiredUnderLease: jest.fn(),
};
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({ agentScheduledInvocationsRepo: repo }));
const enqueueMock = jest.fn();
jest.mock('../../infrastructure/cloud-tasks', () => ({ enqueueAgentExecution: (...a: unknown[]) => enqueueMock(...a) }));
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: jest.fn() }) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const executeTaskMock = jest.fn();
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { executeTask: (...a: unknown[]) => executeTaskMock(...a) },
}));
const hasUserMessageAfterMock = jest.fn();
jest.mock('../../invocations/service', () => ({
  invocationsService: { hasUserMessageAfter: (...a: unknown[]) => hasUserMessageAfterMock(...a) },
}));
const tryAcquireLockMock = jest.fn();
const releaseLockMock = jest.fn(async () => undefined);
jest.mock('../locks', () => ({
  tryAcquireLock: (...a: unknown[]) => tryAcquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...(a as [])),
  LockServiceUnavailableError: class LockServiceUnavailableError extends Error {},
}));
const closingVerdictMock = jest.fn();
jest.mock('../closing-reply', () => ({
  requestClosingReplyWithVerdict: (...a: unknown[]) => closingVerdictMock(...a),
  trimActivityDigest: (t: string | null) => t ?? '(no transcript for this turn)',
}));
const settleWakeMock = jest.fn(async () => ({ delivered: true }));
jest.mock('../../platform-callback/client', () => ({
  settleWakeViaCallback: (...a: unknown[]) => settleWakeMock(...(a as [])),
}));
jest.mock('../../agent-execution/delegated-agents', () => ({
  listDelegatedAgentIds: jest.fn(async () => ['mate-1']),
}));

import {
  CHAT_CONTINUATION_NOTE,
  CHAT_CONTINUATION_MAX_DELIVERIES,
  cancelChatContinuations,
  chatContinuationContextRef,
  isLastChatContinuationDelivery,
  runChatContinuationTask,
  scheduleChatContinuation,
  scheduleBackgroundWork,
  backgroundWorkContextRef,
  type ChatContinuationPayload,
  type BackgroundWorkPayload,
} from '../chat-continuation';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const THREAD = '7b9d446d-2f0e-4a44-9c1e-2b7a5f0c1d33';
const RUNTIME_AGENT = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';
const INTERNAL_AGENT = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';
const ROW = '0d6d2f0e-6c1a-4b3e-9c7d-1a2b3c4d5e6f';
const ORIGIN_TURN = '9f1c2b3a-4d5e-4f60-8a71-2b3c4d5e6f70';

const payload: ChatContinuationPayload = {
  kind: 'chat-continuation', threadId: THREAD, runtimeAgentId: RUNTIME_AGENT, internalAgentId: INTERNAL_AGENT,
  originTurnId: ORIGIN_TURN, originMessage: 'Summarise every thread.', ordinal: 1,
  senderUserId: 'u1', senderAccountId: 'acc-1', reason: 'limit_reached', scheduledAt: '2026-09-22T12:00:00.000Z',
};
const claimedRow = { id: ROW, lease_token: 'lease-1', workflow_resume_payload: payload };

beforeEach(() => {
  jest.clearAllMocks();
  repo.insert.mockResolvedValue({ id: ROW });
  repo.updateCloudTaskName.mockResolvedValue(undefined);
  repo.cancelByContextRefPrefix.mockResolvedValue([]);
  repo.claimHitlForResume.mockResolvedValue(claimedRow);
  repo.releaseResumeLease.mockResolvedValue(true);
  repo.markWakeErrored.mockResolvedValue(true);
  repo.getById.mockResolvedValue({ id: ROW, status: 'resume_inflight' });
  repo.markFiredUnderLease.mockResolvedValue(true);
  enqueueMock.mockResolvedValue({ taskName: 'task-1', scheduleKey: 'k', contextRef: 'c' });
  hasUserMessageAfterMock.mockResolvedValue(false);
  tryAcquireLockMock.mockResolvedValue({ tenantId: TENANT, threadId: THREAD, invocationId: 'x', abortController: new AbortController(), heartbeatTask: null, consecutiveFailures: 0, released: false });
  executeTaskMock.mockResolvedValue({ success: true, terminalState: 'success', output: 'The rest of the summaries.', toolCallsExecuted: 3, reasoningSteps: 3 });
  closingVerdictMock.mockResolvedValue(null);
});

describe('queueing the continuation', () => {
  it('writes the row on the thread, for the person, keyed by thread, origin and ordinal, then the task to the resume receiver named after the row', async () => {
    const id = await scheduleChatContinuation({
      tenantId: TENANT, runtimeAgentId: RUNTIME_AGENT, internalAgentId: INTERNAL_AGENT, threadId: THREAD,
      originTurnId: ORIGIN_TURN, originMessage: 'Summarise every thread.', ordinal: 1,
      senderUserId: 'u1', senderAccountId: 'acc-1', scheduledByInvocationId: 'inv-0', reason: 'limit_reached',
    });
    expect(id).toBe(ROW);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, agentId: RUNTIME_AGENT, threadId: THREAD,
      contextRef: chatContinuationContextRef(THREAD, ORIGIN_TURN, 1),
      objective: 'chat-continuation', scheduledByInvocationId: 'inv-0',
      workflowResume: expect.objectContaining({ kind: 'chat-continuation', ordinal: 1, senderUserId: 'u1', senderAccountId: 'acc-1', originMessage: 'Summarise every thread.' }),
    }));
    expect(enqueueMock).toHaveBeenCalledWith(TENANT, RUNTIME_AGENT, expect.objectContaining({
      objective: 'chat-continuation', threadId: THREAD, triggeredBy: 'human', triggeredByUserId: 'u1',
      triggeredByLabel: 'chat_continuation:1', taskIdentity: ROW, receiverPath: '/api/tasks/resume-execution',
      // Its own queue: a continuation retries because the conversation is
      // busy, which agent-tasks' five attempts would give up on.
      queue: 'chat-continuations',
      receiverBody: { tenantId: TENANT, agentId: RUNTIME_AGENT, invocationId: 'inv-0', workflowResume: { scheduledInvocationId: ROW, kind: 'chat-continuation' } },
    }));
    expect(repo.insert.mock.invocationCallOrder[0]).toBeLessThan(enqueueMock.mock.invocationCallOrder[0]);
    expect(repo.updateCloudTaskName).toHaveBeenCalledWith(ROW, 'task-1');
  });

  it('the sixth is not queued, and a scheduling failure is reported rather than thrown', async () => {
    const base = {
      tenantId: TENANT, runtimeAgentId: RUNTIME_AGENT, internalAgentId: INTERNAL_AGENT, threadId: THREAD,
      originTurnId: ORIGIN_TURN, originMessage: 'x', scheduledByInvocationId: 'inv-0', reason: 'limit_reached' as const,
    };
    expect(await scheduleChatContinuation({ ...base, ordinal: 6 })).toBeNull();
    expect(repo.insert).not.toHaveBeenCalled();
    enqueueMock.mockRejectedValue(new Error('queue down'));
    expect(await scheduleChatContinuation({ ...base, ordinal: 5 })).toBeNull();
  });

  it("a person's message cancels every continuation queued for the thread", async () => {
    repo.cancelByContextRefPrefix.mockResolvedValue([{ id: ROW }, { id: 'row-2' }]);
    expect(await cancelChatContinuations(TENANT, THREAD)).toBe(2);
    expect(repo.cancelByContextRefPrefix).toHaveBeenCalledWith(TENANT, `chat-continuation:${THREAD}:`);
  });

  it('reads the last delivery off the retry count against the queue', () => {
    expect(isLastChatContinuationDelivery(undefined)).toBe(false);
    expect(isLastChatContinuationDelivery('0')).toBe(false);
    expect(isLastChatContinuationDelivery(String(CHAT_CONTINUATION_MAX_DELIVERIES - 1))).toBe(true);
  });
});

describe('the handoff', () => {
  const task = (lastDelivery = false) => runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery });

  it('claim → the thread free → recheck → fired → run as the person with the note, deliver, and done', async () => {
    const outcome = await task();
    expect(outcome).toMatchObject({ status: 'done', continued: false });
    const order = [repo.claimHitlForResume, tryAcquireLockMock, repo.getById, hasUserMessageAfterMock, repo.markFiredUnderLease, executeTaskMock, settleWakeMock, releaseLockMock]
      .map((m) => m.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(executeTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, agentId: RUNTIME_AGENT, threadId: THREAD, objective: CHAT_CONTINUATION_NOTE,
      triggeredBy: 'human', triggeredByUserId: 'u1', senderAccountId: 'acc-1', triggeredByLabel: 'chat_continuation:1', bypassAgentLock: true,
    }));
    expect(hasUserMessageAfterMock).toHaveBeenCalledWith(THREAD, TENANT, new Date(payload.scheduledAt));
    // The reply posts into the thread as a continued run's does, keyed by the row.
    expect(settleWakeMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, wakeId: ROW, threadId: THREAD, agentId: RUNTIME_AGENT, replyText: 'The rest of the summaries.', delegatedTo: ['mate-1'],
    }));
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('cancel before the claim: nothing runs', async () => {
    repo.claimHitlForResume.mockResolvedValue(null);
    expect(await task()).toEqual({ status: 'noop', reason: 'not_pending' });
    expect(tryAcquireLockMock).not.toHaveBeenCalled();
    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('cancel between the claim and the lock: the recheck finds the row no longer ours', async () => {
    repo.getById.mockResolvedValue({ id: ROW, status: 'cancelled' });
    expect(await task()).toEqual({ status: 'noop', reason: 'not_claimed' });
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it('a newer person message: cancelled as superseded, the lock released', async () => {
    hasUserMessageAfterMock.mockResolvedValue(true);
    expect(await task()).toEqual({ status: 'cancelled', reason: 'superseded' });
    expect(repo.markWakeErrored).toHaveBeenCalledWith(ROW, 'lease-1', 'superseded');
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it('the lock busy: handed back to pending and retried; on the last delivery, failed (lock_busy)', async () => {
    tryAcquireLockMock.mockResolvedValue(null);
    expect(await task(false)).toEqual({ status: 'retry', reason: 'lock_busy' });
    expect(repo.releaseResumeLease).toHaveBeenCalledWith(ROW, 'lease-1', 'lock_busy', { deferred: true });
    expect(await task(true)).toEqual({ status: 'failed', reason: 'lock_busy' });
    expect(repo.markWakeErrored).toHaveBeenCalledWith(ROW, 'lease-1', 'lock_busy');
    expect(executeTaskMock).not.toHaveBeenCalled();
  });

  it('a run its bound closed: the closing reply with the verdict is appended and delivered, and [continue] chains the next on the same origin', async () => {
    executeTaskMock.mockResolvedValue({ success: false, terminalState: 'limit_reached', output: 'Eight more done.', error: 'max turns', toolCallsExecuted: 9, reasoningSteps: 9 });
    closingVerdictMock.mockResolvedValue({ text: 'Twenty of thirty are summarised; ten remain.', unfinished: true });
    const outcome = await task();
    expect(outcome).toMatchObject({ status: 'done', continued: true });
    expect(closingVerdictMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, agentId: INTERNAL_AGENT, threadId: THREAD, userMessage: 'Summarise every thread.', activityDigest: 'Eight more done.',
    }));
    expect(settleWakeMock).toHaveBeenCalledWith(expect.objectContaining({
      replyText: 'Eight more done.\n\nTwenty of thirty are summarised; ten remain.',
    }));
    // The next, after the reply is delivered, ordinal 2 on the same origin.
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      contextRef: chatContinuationContextRef(THREAD, ORIGIN_TURN, 2),
      workflowResume: expect.objectContaining({ ordinal: 2, originTurnId: ORIGIN_TURN, senderUserId: 'u1' }),
    }));
    expect(settleWakeMock.mock.invocationCallOrder[0]).toBeLessThan(repo.insert.mock.invocationCallOrder[0]);
  });

  it('a run its bound closed whose closing reply says [done] chains nothing; at the cap nothing is queued', async () => {
    executeTaskMock.mockResolvedValue({ success: false, terminalState: 'limit_reached', output: 'All done.', toolCallsExecuted: 9, reasoningSteps: 9 });
    closingVerdictMock.mockResolvedValue({ text: 'Every thread is summarised.', unfinished: false });
    expect(await task()).toMatchObject({ status: 'done', continued: false });
    expect(repo.insert).not.toHaveBeenCalled();

    repo.claimHitlForResume.mockResolvedValue({ ...claimedRow, workflow_resume_payload: { ...payload, ordinal: 5 } });
    closingVerdictMock.mockResolvedValue({ text: 'Still some left.', unfinished: true });
    expect(await task()).toMatchObject({ status: 'done', continued: false });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('a run that ended with no text of its own still says how it ended', async () => {
    executeTaskMock.mockResolvedValue({ success: false, terminalState: 'task_failed', error: 'the connector refused', toolCallsExecuted: 1, reasoningSteps: 1 });
    await task();
    const delivered = (settleWakeMock.mock.calls[0] as unknown as [{ replyText: string }])[0].replyText;
    expect(delivered).toContain('stopped before it could finish');
    expect(delivered).toContain('the connector refused');
  });
});

// Work a team set going and is not waiting for
//
// It rides the continuation's own rails, because a continuation already is
// what this needs: a durable row, a Cloud Task, the thread's lock, and a
// reply posted into the thread when it is done. Three things differ, and
// each is pinned here.
describe('background work a team set going', () => {
  const WORK_BRIEF = 'Read all three competitor pricing pages and say where we sit.';
  const backgroundPayload: BackgroundWorkPayload = {
    kind: 'background-work', threadId: THREAD, runtimeAgentId: RUNTIME_AGENT, internalAgentId: INTERNAL_AGENT,
    brief: WORK_BRIEF, senderUserId: 'u1', senderAccountId: 'acc-1', scheduledAt: '2026-09-22T12:00:00.000Z',
  };

  beforeEach(() => {
    repo.claimHitlForResume.mockResolvedValue({ id: ROW, lease_token: 'lease-1', workflow_resume_payload: backgroundPayload });
  });

  it('queues a durable row and a task, keyed outside the continuation prefix', async () => {
    const id = await scheduleBackgroundWork({
      tenantId: TENANT, runtimeAgentId: RUNTIME_AGENT, internalAgentId: INTERNAL_AGENT, threadId: THREAD,
      brief: WORK_BRIEF, senderAccountId: 'acc-1', scheduledByInvocationId: 'inv-1',
    });
    expect(id).toBe(ROW);
    const row = repo.insert.mock.calls[0][0];
    expect(row.contextRef.startsWith(backgroundWorkContextRef(THREAD))).toBe(true);
    // Not under the continuation prefix, which is what one message cancels.
    expect(row.contextRef.startsWith('chat-continuation:')).toBe(false);
    expect((row.workflowResume as BackgroundWorkPayload).brief).toBe(WORK_BRIEF);
    expect(enqueueMock.mock.calls[0][2].receiverBody.workflowResume.kind).toBe('background-work');
  });

  // A person writing supersedes a CONTINUATION: they moved on. It must not
  // supersede background work — they asked for it and then carried on
  // talking, and throwing it away because they spoke again would discard the
  // very thing they asked for.
  it('is not cancelled by the person writing again', async () => {
    hasUserMessageAfterMock.mockResolvedValue(true);
    const out = await runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery: false });
    expect(out.status).toBe('done');
    expect(hasUserMessageAfterMock).not.toHaveBeenCalled();
    expect(executeTaskMock).toHaveBeenCalled();
  });

  it('is beyond the reach of the cancel a person message makes', async () => {
    await cancelChatContinuations(TENANT, THREAD);
    const prefix = repo.cancelByContextRefPrefix.mock.calls[0][1] as string;
    expect(prefix.startsWith('chat-continuation:')).toBe(true);
    expect(backgroundWorkContextRef(THREAD).startsWith(prefix)).toBe(false);
  });

  it('runs the team\'s own brief as the objective, not the continuation note', async () => {
    await runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery: false });
    const task = executeTaskMock.mock.calls[0][0];
    expect(task.objective).toBe(WORK_BRIEF);
    expect(task.objective).not.toBe(CHAT_CONTINUATION_NOTE);
    expect(task.triggeredByLabel).toBe('background_work');
  });

  // Delivery is the push: the person asked for this and gets it without
  // asking again. It takes the thread's lock like any other run, so it
  // waits for the conversation to be free rather than landing on top of
  // somebody mid-sentence.
  it('posts what it found into the thread', async () => {
    await runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery: false });
    expect(settleWakeMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT, threadId: THREAD, wakeId: ROW, replyText: 'The rest of the summaries.',
    }));
  });

  it('waits for a busy conversation rather than talking over it', async () => {
    tryAcquireLockMock.mockResolvedValue(null);
    const out = await runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery: false });
    expect(out).toEqual({ status: 'retry', reason: 'lock_busy' });
    expect(executeTaskMock).not.toHaveBeenCalled();
    expect(settleWakeMock).not.toHaveBeenCalled();
  });

  // Nobody asked for a second helping, and the person can ask again.
  it('does not chain another piece of work', async () => {
    executeTaskMock.mockResolvedValue({ success: false, terminalState: 'limit_reached', output: 'got part way', toolCallsExecuted: 1, reasoningSteps: 1 });
    const out = await runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery: false });
    expect(out).toMatchObject({ status: 'done', continued: false });
    expect(closingVerdictMock).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('posts nothing when the work produced no answer, rather than an empty message', async () => {
    executeTaskMock.mockResolvedValue({ success: true, terminalState: 'success', output: '   ', toolCallsExecuted: 0, reasoningSteps: 1 });
    const out = await runChatContinuationTask({ tenantId: TENANT, scheduledInvocationId: ROW, lastDelivery: false });
    expect(out.status).toBe('done');
    expect(settleWakeMock).not.toHaveBeenCalled();
  });
});
