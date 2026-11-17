// Cloud Tasks dispatcher — hitl-approved / hitl-rejected / hitl-expiry kinds.
//
// Verifies the wiring
// §9: when the approval router (or the 24h timer) fires a Cloud Task with
// workflowResume.kind ∈ {'hitl-approved','hitl-rejected'}, the handler
// invokes `agentExecutionService.resumeFromHitlApproval`. When kind is
// 'hitl-expiry', it invokes `finalizeHitlExpired`. Routes for delay /
// clarification-answered / clarification-expiry must not regress.

const resumeFromHitlApprovalMock = jest.fn();
const resumeFromClarificationAnswerMock = jest.fn();
const resumeWorkflowMock = jest.fn();
const finalizeHitlExpiredMock = jest.fn();

jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: {
    resumeFromHitlApproval: (...a: unknown[]) => resumeFromHitlApprovalMock(...a),
    resumeFromClarificationAnswer: (...a: unknown[]) => resumeFromClarificationAnswerMock(...a),
    resumeWorkflow: (...a: unknown[]) => resumeWorkflowMock(...a),
  },
}));

jest.mock('../../agent-execution/hitl-expiry-helpers', () => ({
  finalizeHitlExpired: (...a: unknown[]) => finalizeHitlExpiredMock(...a),
}));

jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    markFiredByInvocationId: jest.fn().mockResolvedValue(0),
    markClarificationFired: jest.fn().mockResolvedValue(undefined),
    // The expiry path's own transitions (migration 419): status and outcome in
    // one statement, so the generic operations above are not taught either.
    markClarificationExpiredById: jest.fn().mockResolvedValue(1),
    markClarificationExpiredByInvocationId: jest.fn().mockResolvedValue(0),
    markErrored: jest.fn().mockResolvedValue(undefined),
    releaseFailedClarificationResume: jest.fn().mockResolvedValue({ released: true, exhausted: false }),
    getById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/safe-trace-context', () => ({ setTraceContext: jest.fn() }));
jest.mock('../../infrastructure/oidc', () => ({ verifyOidcToken: jest.fn().mockResolvedValue(true) }));
jest.mock('../../infrastructure/database', () => ({ getPoolForService: jest.fn() }));
const createEscalationMock = jest.fn().mockResolvedValue('esc-1');
jest.mock('../../agent-execution/engine/escalation-helper', () => ({
  createEscalation: (...a: unknown[]) => createEscalationMock(...a),
}));
import express from 'express';
import request from 'supertest';
import { cloudTasksHandler } from '../cloud-tasks-handler';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', cloudTasksHandler);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('Cloud Tasks /resume-execution — HITL kinds', () => {
  it('kind="hitl-approved" routes to resumeFromHitlApproval with scheduledInvocationId', async () => {
    resumeFromHitlApprovalMock.mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });
    const app = makeApp();
    const res = await request(app).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'hitl-approved', scheduledInvocationId: 'sched-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    expect(res.body.kind).toBe('hitl-approved');
    expect(resumeFromHitlApprovalMock).toHaveBeenCalledTimes(1);
    expect(resumeFromHitlApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentId: 'a1' }),
      'sched-1',
    );
  });

  it('kind="hitl-rejected" also routes to resumeFromHitlApproval (decision read from approval row)', async () => {
    resumeFromHitlApprovalMock.mockResolvedValue({ success: false, error: 'rejected', toolCallsExecuted: 0, reasoningSteps: 0 });
    const app = makeApp();
    const res = await request(app).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'hitl-rejected', scheduledInvocationId: 'sched-2' },
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('hitl-rejected');
    expect(resumeFromHitlApprovalMock).toHaveBeenCalledWith(expect.any(Object), 'sched-2');
  });

  it('kind="hitl-expiry" routes to finalizeHitlExpired with scheduledInvocationId', async () => {
    finalizeHitlExpiredMock.mockResolvedValue({ expired: true });
    const app = makeApp();
    const res = await request(app).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'hitl-expiry', scheduledInvocationId: 'sched-3' },
    });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('hitl-expiry');
    expect(res.body.expired).toBe(true);
    expect(finalizeHitlExpiredMock).toHaveBeenCalledWith({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      scheduledInvocationId: 'sched-3',
    });
  });

  it('kind="hitl-expiry" with a decided-but-unfired pause RECOVERS via resumeFromHitlApproval', async () => {
    // The operator decided before expiry but the resume task was never
    // delivered; finalizeHitlExpired signals recovery instead of expiring.
    finalizeHitlExpiredMock.mockResolvedValue({ expired: false, reason: 'decided_pending_resume' });
    resumeFromHitlApprovalMock.mockResolvedValue({ success: true, toolCallsExecuted: 1, reasoningSteps: 1 });
    const app = makeApp();
    const res = await request(app).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'hitl-expiry', scheduledInvocationId: 'sched-3b' },
    });
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    expect(resumeFromHitlApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentId: 'a1', invocationId: 'inv1' }),
      'sched-3b',
    );
  });

  it('kind="clarification-answered" continues to route to resumeFromClarificationAnswer (no regression)', async () => {
    resumeFromClarificationAnswerMock.mockResolvedValue({ success: true, toolCallsExecuted: 0, reasoningSteps: 0 });
    const app = makeApp();
    const res = await request(app).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'clarification-answered', scheduledInvocationId: 'sched-4', userAnswer: 'yes' },
    });
    expect(res.status).toBe(200);
    expect(resumeFromClarificationAnswerMock).toHaveBeenCalled();
    expect(resumeFromHitlApprovalMock).not.toHaveBeenCalled();
  });
});

/** The expiry timer is created when the run parks and nothing cancels it when
 *  the ask is settled. Until these guards, every answered or declined
 *  clarification still ran the whole expiry path an hour later and filed
 *  "expired without answer" against a question that had been answered — and
 *  because workflow_escalations dedups on (tenant, agent, kind) while one is
 *  open, a false record could absorb a real one. */
describe('Cloud Tasks /resume-execution — clarification-expiry only expires unsettled asks', () => {
   
  const { agentScheduledInvocationsRepo } = require('../../scheduling/agent-scheduled-invocations-repo');

  it('does nothing when the row has already moved off pending', async () => {
    agentScheduledInvocationsRepo.getById.mockResolvedValueOnce({ id: 'sched-9', status: 'fired' });

    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'clarification-expiry', scheduledInvocationId: 'sched-9' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expired: false, reason: 'already_settled' });
    expect(agentScheduledInvocationsRepo.markClarificationExpiredByInvocationId).not.toHaveBeenCalled();
    expect(agentScheduledInvocationsRepo.markFiredByInvocationId).not.toHaveBeenCalled();
  });

  it('does nothing when no pending row remains and the task carried no row id', async () => {
    // The only signal available on this path: the UPDATE matches 'pending'
    // alone, so zero rows means somebody settled it.
    agentScheduledInvocationsRepo.markClarificationExpiredByInvocationId.mockResolvedValueOnce(0);

    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'clarification-expiry' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expired: false, reason: 'already_settled' });
  });
});

describe('Cloud Tasks /resume-execution — a failed clarification resume goes back in the queue', () => {
   
  const { agentScheduledInvocationsRepo } = require('../../scheduling/agent-scheduled-invocations-repo');

  it('releases the row to pending rather than marking it errored', async () => {
    // markErrored matches 'pending' only, and the row is 'resume_inflight' by
    // now — it did nothing, and the ask vanished from the queue for good.
    // Returning it to 'pending' lets the Cloud Tasks retry re-claim it and, if
    // the retries run out, puts the question back in front of a person.
    resumeFromClarificationAnswerMock.mockRejectedValueOnce(new Error('engine down'));

    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: {
        kind: 'clarification-answered', scheduledInvocationId: 'sched-10', userAnswer: 'the Q3 sheet',
      },
    });

    expect(res.status).toBe(500);
    expect(agentScheduledInvocationsRepo.releaseFailedClarificationResume)
      .toHaveBeenCalledWith('sched-10', 'engine down');
    expect(agentScheduledInvocationsRepo.markErrored).not.toHaveBeenCalled();
  });

  // A resume that returned success:false used to go out as 200 {resumed:true},
  // with the failure spread in two keys later. Cloud Tasks read that as
  // delivered and never came back, and the ask had already been consumed --
  // the answer was gone with nothing said in the thread.
  it('does not report a resume that returned success:false as a success', async () => {
    resumeFromClarificationAnswerMock.mockResolvedValueOnce({
      success: false,
      error: 'Agent abbb7a1c not ACTIVE; clarification resume skipped',
      toolCallsExecuted: 0,
      reasoningSteps: 0,
    });

    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: {
        kind: 'clarification-answered', scheduledInvocationId: 'sched-11', userAnswer: 'the Q3 sheet',
      },
    });

    expect(res.status).toBe(500);
    expect(res.body.resumed).toBe(false);
    expect(agentScheduledInvocationsRepo.releaseFailedClarificationResume)
      .toHaveBeenCalledWith('sched-11', 'Agent abbb7a1c not ACTIVE; clarification resume skipped');
  });

  // Once the attempt budget is spent the row is errored, not released. Retrying
  // forever would be worse than stopping: 'pending' is what the chat router
  // reads as "this message answers the pending question", so an ask that can
  // never resume would absorb every later message on the thread.
  it('stops the queue once the ask is exhausted, still without calling it resumed', async () => {
    resumeFromClarificationAnswerMock.mockResolvedValueOnce({
      success: false, error: 'agent gone', toolCallsExecuted: 0, reasoningSteps: 0,
    });
    agentScheduledInvocationsRepo.releaseFailedClarificationResume
      .mockResolvedValueOnce({ released: false, exhausted: true });

    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: {
        kind: 'clarification-answered', scheduledInvocationId: 'sched-12', userAnswer: 'the Q3 sheet',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(false);
    expect(res.body.exhausted).toBe(true);
  });
});

// ── clarification-expiry hands the escalation its identity as-is ────────────
//
// The escalation boundary resolves the workflow/task pair its rows require; the
// receiver's job is only to pass through what the task body carries — present
// or absent — never to mint at the call site, and never to send a blank.
describe('Cloud Tasks /resume-execution — clarification-expiry passes identity through', () => {
   
  const { agentScheduledInvocationsRepo } = require('../../scheduling/agent-scheduled-invocations-repo');
  const WF = '8d48512f-c961-4cee-87f2-a71e2664e8af';
  const TASK = 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9';

  beforeEach(() => {
    createEscalationMock.mockClear();
    agentScheduledInvocationsRepo.getById.mockResolvedValue({ id: 'sched-9', status: 'pending' });
    agentScheduledInvocationsRepo.markClarificationExpiredByInvocationId.mockResolvedValueOnce(1);
  });

  it('leaves the ids absent when the body carries none (no minting here)', async () => {
    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'clarification-expiry', scheduledInvocationId: 'sched-9' },
    });

    expect(res.status).toBe(200);
    expect(createEscalationMock).toHaveBeenCalledTimes(1);
    const ctx = createEscalationMock.mock.calls[0][0] as { workflowId?: string; taskId?: string };
    expect(ctx.workflowId).toBeUndefined();
    expect(ctx.taskId).toBeUndefined();
  });

  it('passes real ids from the body through, and treats a blank as absent', async () => {
    const res = await request(makeApp()).post('/api/tasks/resume-execution').send({
      tenantId: 't1', agentId: 'a1', invocationId: 'inv1',
      workflowResume: { kind: 'clarification-expiry', scheduledInvocationId: 'sched-9', workflowId: WF, taskId: '' },
    });

    expect(res.status).toBe(200);
    const ctx = createEscalationMock.mock.calls[0][0] as { workflowId?: string; taskId?: string };
    expect(ctx.workflowId).toBe(WF);
    expect(ctx.taskId).toBeUndefined();
  });
});
