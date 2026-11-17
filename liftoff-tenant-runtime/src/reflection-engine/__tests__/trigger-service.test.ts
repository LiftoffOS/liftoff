// Reflection Trigger Service — Phase 5 unit tests
//
// Phase 5 introduces a new trigger type, 'flagged_feedback', for late
// rejection feedback submitted via /api/hitl-enforcement/late-feedback.
// These tests cover the new onLateFeedbackFlagged() method on the trigger
// service plus a sanity check that the existing trigger methods still
// route through enqueueWithQuotaManagement when shouldTriggerReflection
// passes the threshold check.

import { ReflectionTriggerService } from '../trigger-service';

jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueReflectionJob: jest.fn().mockResolvedValue('mock-task-name'),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { enqueueReflectionJob } from '../../infrastructure/cloud-tasks';

const mockEnqueueReflectionJob = enqueueReflectionJob as jest.MockedFunction<
  typeof enqueueReflectionJob
>;

const TENANT_ID = 'tenant-phase5-001';
const AGENT_ID = 'agent-phase5-001';
const FEEDBACK_ID = 'feedback-abc-123';

function buildService(overrides: {
  shouldTrigger?: { shouldTrigger: boolean; reason?: string };
  quotaRemaining?: { daily: number; concurrent: number };
} = {}): ReflectionTriggerService {
  const service = new ReflectionTriggerService();
  const shouldTrigger = overrides.shouldTrigger ?? { shouldTrigger: true };
  const quota = overrides.quotaRemaining ?? { daily: 5, concurrent: 3 };

  (service as any).reflectionService = {
    shouldTriggerReflection: jest.fn().mockResolvedValue(shouldTrigger),
    getQuotaStatus: jest.fn().mockResolvedValue({
      tenantId: TENANT_ID,
      dailyRunsLimit: 10,
      dailyRunsUsed: 0,
      dailyRunsRemaining: quota.daily,
      weeklyAgentRunsLimit: 5,
      weeklyAgentRunsUsed: 0,
      weeklyAgentRunsRemaining: 5,
      maxConcurrentJobs: 3,
      currentConcurrentJobs: 0,
      concurrentJobsRemaining: quota.concurrent,
    }),
    incrementQuotaOnEnqueue: jest.fn().mockResolvedValue(undefined),
  };

  return service;
}

describe('ReflectionTriggerService — onLateFeedbackFlagged', () => {
  beforeEach(() => {
    mockEnqueueReflectionJob.mockClear();
  });

  it('enqueues a flagged_feedback reflection job when shouldTriggerReflection passes', async () => {
    const service = buildService();

    await service.onLateFeedbackFlagged(AGENT_ID, TENANT_ID, FEEDBACK_ID);

    expect(
      (service as any).reflectionService.shouldTriggerReflection,
    ).toHaveBeenCalledWith(AGENT_ID, TENANT_ID, 'flagged_feedback');
    expect(mockEnqueueReflectionJob).toHaveBeenCalledTimes(1);
    // Phase 5 gap fix: the enqueue now carries { feedbackId } as metadata
    // so the reflection run can hoist the exact triggering row.
    expect(mockEnqueueReflectionJob).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      'flagged_feedback',
      { feedbackId: FEEDBACK_ID },
    );
  });

  it('does not enqueue when shouldTriggerReflection rejects (threshold not met)', async () => {
    const service = buildService({
      shouldTrigger: {
        shouldTrigger: false,
        reason: 'Only 1 flagged feedback in last 7 days, need 2',
      },
    });

    await service.onLateFeedbackFlagged(AGENT_ID, TENANT_ID, FEEDBACK_ID);

    expect(
      (service as any).reflectionService.shouldTriggerReflection,
    ).toHaveBeenCalled();
    expect(mockEnqueueReflectionJob).not.toHaveBeenCalled();
  });

  it('skips enqueue when daily reflection quota is exhausted', async () => {
    const service = buildService({ quotaRemaining: { daily: 0, concurrent: 3 } });

    await service.onLateFeedbackFlagged(AGENT_ID, TENANT_ID, FEEDBACK_ID);

    expect(mockEnqueueReflectionJob).not.toHaveBeenCalled();
  });

  it('skips enqueue when concurrent jobs limit is reached', async () => {
    const service = buildService({ quotaRemaining: { daily: 5, concurrent: 0 } });

    await service.onLateFeedbackFlagged(AGENT_ID, TENANT_ID, FEEDBACK_ID);

    expect(mockEnqueueReflectionJob).not.toHaveBeenCalled();
  });

  it('carries feedbackId through to the Cloud Tasks payload as metadata', async () => {
    const service = buildService();

    await service.onLateFeedbackFlagged(AGENT_ID, TENANT_ID, FEEDBACK_ID);

    // Phase 5 gap fix: feedbackId is now plumbed through to
    // enqueueReflectionJob as metadata so the reflection run can anchor
    // on the specific triggering human_feedback row rather than guessing
    // from the general humanFeedback dump.
    expect(mockEnqueueReflectionJob).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      'flagged_feedback',
      { feedbackId: FEEDBACK_ID },
    );
  });
});
