// A run that outgrows one invocation continues in the next one.
//
// The wall clock is two ceilings wearing one hat: it stops a runaway, and it
// stops work that is simply longer than a single invocation. Only the second is
// a false positive, and it is the common one. Treating it as a failure loses
// everything the run did and tells the person nothing, which is how a sixteen-
// step workflow asked for on demand died at step 8 with an empty thread.
//
// So the ceiling now parks the run at a step boundary and schedules it to pick
// up. These tests hold the two properties that makes safe: the runaway half of
// the ceiling survives as a bound on the CHAIN, and a continuation that was not
// actually scheduled is never reported as one.

const insert = jest.fn().mockResolvedValue({ id: 'sched-1' });
const updateCloudTaskName = jest.fn().mockResolvedValue(undefined);
const enqueueAgentExecution = jest.fn().mockResolvedValue({
  taskName: 'projects/p/locations/l/queues/q/tasks/t', scheduleKey: '', contextRef: null,
});

jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    insert: (...a: unknown[]) => insert(...a),
    updateCloudTaskName: (...a: unknown[]) => updateCloudTaskName(...a),
  },
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...a: unknown[]) => enqueueAgentExecution(...a),
}));

import {
  assessContinuation,
  scheduleRunContinuation,
  type RunContinuationPayload,
} from '../handlers/run-continuation-handler';
import { MAX_RUN_CONTINUATIONS, MAX_CONTINUATION_TOOL_CALLS } from '../constants';

const payload: RunContinuationPayload = {
  kind: 'run-continuation',
  workflowId: 'wf-1',
  taskId: 'task-1',
  resumeAtStepId: 's8',
  stepOutput: { watchlist: ['acme', 'globex'] },
  objective: 'Produce the weekly competitive digest',
  inputData: { _continuationDepth: 1, _continuationToolCalls: 60 },
  perStepRecoveries: { s3: 1 },
  totalRecoveries: 1,
  recoveryHistory: [{ stepId: 's3', anomalyKind: 'tool_timeout', decision: 'retry', kind: 'fresh' }],
  continuationDepth: 1,
  cumulativeToolCalls: 60,
  threadId: 'thread-1',
};

beforeEach(() => {
  insert.mockClear().mockResolvedValue({ id: 'sched-1' });
  updateCloudTaskName.mockClear();
  enqueueAgentExecution.mockClear().mockResolvedValue({
    taskName: 'projects/p/locations/l/queues/q/tasks/t', scheduleKey: '', contextRef: null,
  });
});

describe('what bounds a run once the wall clock stops being a hard stop', () => {
  // THE BOUND IS THE SPEND, and it was duration.
  //
  // These three cases asserted a six-continuation depth cap and a cumulative
  // tool-call ceiling as the answer to "how long may a run take". They were
  // the right shape for a ceiling that had to be a number and the wrong
  // question: a run doing the work it was asked to do is behaving correctly at
  // any length, and stopping it threw away eleven minutes of research and told
  // the person their report could not be produced.
  //
  // The full contract — admission first, then progress, then the operator
  // backstops — is in `handlers/__tests__/continuation-cap-is-the-spend.test.ts`.
  // What stays here is that this module still ASKS, and still refuses when the
  // answer is no.
  const allowed = () => Promise.resolve({ allowed: true as const });

  it('lets ordinary long work continue, however long', async () => {
    expect(await assessContinuation({ admit: allowed, depth: 1, cumulativeToolCalls: 60 }))
      .toMatchObject({ ok: true });
    // Past every bound the old depth cap imposed.
    expect(await assessContinuation({ admit: allowed, depth: 50, cumulativeToolCalls: 50_000 }))
      .toMatchObject({ ok: true });
  });

  it('stops when the workspace cannot pay, and says so in the money authority’s words', async () => {
    // "You are out of Operating Units" is actionable; "we stopped it after an
    // hour" is not, and was what a person used to be told.
    const verdict = await assessContinuation({
      admit: () => Promise.resolve({
        allowed: false as const, reason: 'billing_suspended',
        detail: 'Tenant is suspended for billing', quotaType: 'billing_suspended',
      } as never),
      depth: 1, cumulativeToolCalls: 10,
    });
    expect(verdict.ok).toBe(false);
    expect((verdict as { error: string }).error).toContain('suspended for billing');
  });

  it('keeps the operator backstops available, unset by default', async () => {
    // They are no longer the product's answer, but an environment may still
    // impose one. Unset, they do not bound a progressing run at all.
    expect(MAX_RUN_CONTINUATIONS).toBe(Number.POSITIVE_INFINITY);
    expect(MAX_CONTINUATION_TOOL_CALLS).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('scheduling the continuation', () => {
  it('fires immediately, because the run is not waiting for anything', async () => {
    // Unlike a delay step, nothing is being waited ON. The only reason for a new
    // invocation is a fresh ceiling, so a minimum delay would be dead time a
    // person spends staring at a thread.
    const before = Date.now();
    await scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload });
    const firesAt: Date = insert.mock.calls[0][0].firesAt;
    expect(firesAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(firesAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('carries the state on the ROW and only ids in the task', async () => {
    // A carried stepOutput can be large and a Cloud Task body cannot.
    await scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload });

    const persisted = insert.mock.calls[0][0].workflowResume as RunContinuationPayload;
    expect(persisted.stepOutput).toEqual(payload.stepOutput);
    expect(persisted.objective).toBe(payload.objective);
    expect(persisted.perStepRecoveries).toEqual({ s3: 1 });

    const body = enqueueAgentExecution.mock.calls[0][2].receiverBody as {
      workflowResume: Record<string, unknown>;
    };
    expect(body.workflowResume).toEqual({ scheduledInvocationId: 'sched-1', kind: 'run-continuation' });
    expect(JSON.stringify(body)).not.toContain('watchlist');
  });

  it('resumes AT the step that was about to run, not after it', async () => {
    // The ceiling is checked at the top of the step loop, so the cut is between
    // two steps: the cursor is the step that had not started. Resuming one step
    // later would silently skip it.
    await scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload });
    expect((insert.mock.calls[0][0].workflowResume as RunContinuationPayload).resumeAtStepId)
      .toBe('s8');
  });

  it('targets the resume receiver the delay rail already uses', async () => {
    await scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload });
    expect(enqueueAgentExecution.mock.calls[0][2].receiverPath).toBe('/api/tasks/resume-execution');
  });

  it('answers null rather than throwing when it cannot schedule', async () => {
    // The caller's fallback is the behaviour we already had. A failure to
    // schedule must not also destroy the error the run was going to return.
    enqueueAgentExecution.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload }),
    ).resolves.toBeNull();
  });

  it('answers null when the row cannot be written', async () => {
    insert.mockRejectedValueOnce(new Error('db down'));
    await expect(
      scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload }),
    ).resolves.toBeNull();
  });
});

describe('two runs of the same workflow do not collide', () => {
  it('names the task after the scheduled row, not the step', async () => {
    // The default task name is built from (agent, minute, contextRef). Two runs
    // of one workflow parking at the same step in the same minute would share
    // it, and one continuation would quietly not be scheduled.
    await scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-1', payload });
    expect(enqueueAgentExecution.mock.calls[0][2].taskIdentity).toBe('sched-1');
  });

  it('keys the context ref to the run', async () => {
    await scheduleRunContinuation({ tenantId: 't', agentId: 'a', invocationId: 'inv-9', payload });
    expect(insert.mock.calls[0][0].contextRef).toContain('inv-9');
  });
});
