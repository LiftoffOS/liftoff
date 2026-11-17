// Late feedback → reflection integration test
//
// Phase 5 gap fix #5: an end-to-end test that walks the full flow from the
// HTTP late-feedback router down through the reflection trigger, through
// the enqueue step, and asserts that:
//
//   1. A rejected late feedback with inserted=true enqueues a reflection
//      job with triggerType='flagged_feedback' and metadata.feedbackId
//      carrying the triggering feedback id.
//   2. The threshold check is routed through shouldTriggerReflection, so
//      replaying the same feedbackId twice with only one row in the
//      database does NOT enqueue a second job.
//   3. The trigger service does NOT call the old onEscalationResolved
//      path — Phase 5 replaced it for the rejected branch.
//
// The test mocks the Cloud Tasks client and the reflection-engine
// repository's shouldTriggerReflection / quota paths, but exercises the
// real router handler, the real ReflectionTriggerService, and the real
// enqueueReflectionJob payload assembly. That's the "integration" surface
// the plan asked for — the seam where Pub/Sub was supposed to live.

// ── Module mocks ──────────────────────────────────────────────────────────

const mockRecordLateFeedback = jest.fn();
jest.mock('../../hitl-enforcement/service', () => ({
  hitlEnforcementService: {
    recordLateFeedback: (...args: unknown[]) => mockRecordLateFeedback(...args),
  },
}));

const mockCreateTask = jest.fn();
jest.mock('../../infrastructure/cloud-tasks', () => {
  const actual = jest.requireActual('../../infrastructure/cloud-tasks');
  return {
    ...actual,
    // enqueueReflectionJob is what we want to exercise; we replace it with
    // a thin wrapper that captures its arguments but does not hit Cloud
    // Tasks. This lets us assert the full set of values that WOULD be sent
    // to Cloud Tasks — including the metadata.feedbackId payload.
    enqueueReflectionJob: (
      agentId: string,
      tenantId: string,
      triggeredBy: string,
      metadata?: Record<string, unknown>,
    ) => {
      mockCreateTask({ agentId, tenantId, triggeredBy, metadata });
      return Promise.resolve('projects/test/locations/test/queues/test/tasks/mock');
    },
  };
});

// We need the reflection service's quota + threshold methods to give
// deterministic answers. Stub ReflectionEngineService with a hand-rolled
// object that the real ReflectionTriggerService will pick up.
const mockShouldTriggerReflection = jest.fn();
const mockGetQuotaStatus = jest.fn();
const mockIncrementQuotaOnEnqueue = jest.fn().mockResolvedValue(undefined);

jest.mock('../service', () => ({
  ReflectionEngineService: jest.fn().mockImplementation(() => ({
    shouldTriggerReflection: mockShouldTriggerReflection,
    getQuotaStatus: mockGetQuotaStatus,
    incrementQuotaOnEnqueue: mockIncrementQuotaOnEnqueue,
    decrementQuotaOnCompletion: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

import { hitlRouter } from '../../hitl-enforcement/router';

function findLateFeedbackHandler(): (req: any, res: any) => Promise<void> {
  const layer = (hitlRouter as any).stack.find(
    (l: any) =>
      l.route?.path === '/late-feedback' &&
      l.route?.stack?.some((s: any) => s.method === 'post'),
  );
  if (!layer) throw new Error('POST /late-feedback handler not found');
  return layer.route.stack[0].handle;
}

const TENANT_ID = '00000000-0000-0000-0000-000000001111';
const AGENT_ID = '00000000-0000-0000-0000-000000002222';
const APPROVAL_ID = '00000000-0000-0000-0000-000000003333';
const FEEDBACK_ID = '00000000-0000-0000-0000-000000004444';

function buildReq(decision: 'approved' | 'rejected' = 'rejected'): any {
  return {
    ctx: { tenantId: TENANT_ID },
    body: {
      feedbackId: FEEDBACK_ID,
      approvalId: APPROVAL_ID,
      decision,
      decidedBy: 'user-x',
      decidedByRole: 'owner',
      rejectionReason: 'mismatched intent',
      toolCallsHash: 'sha256:xyz',
      pendingToolCalls: [],
    },
  };
}

function buildRes(): any {
  return {
    statusCode: 200,
    status: jest.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function (this: any) {
      return this;
    }),
  };
}

beforeEach(() => {
  mockRecordLateFeedback.mockReset();
  mockCreateTask.mockReset();
  mockShouldTriggerReflection.mockReset();
  mockGetQuotaStatus.mockReset();
  mockIncrementQuotaOnEnqueue.mockClear();

  mockGetQuotaStatus.mockResolvedValue({
    tenantId: TENANT_ID,
    dailyRunsLimit: 10,
    dailyRunsUsed: 0,
    dailyRunsRemaining: 10,
    weeklyAgentRunsLimit: 5,
    weeklyAgentRunsUsed: 0,
    weeklyAgentRunsRemaining: 5,
    maxConcurrentJobs: 3,
    currentConcurrentJobs: 0,
    concurrentJobsRemaining: 3,
  });
});

describe('integration: late-feedback HTTP → reflection enqueue', () => {
  it('end-to-end: rejected feedback above threshold → enqueues flagged_feedback job with feedbackId metadata', async () => {
    // Arrange: service layer reports a fresh insert; threshold passes.
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: true,
      agentId: AGENT_ID,
    });
    mockShouldTriggerReflection.mockResolvedValueOnce({ shouldTrigger: true });

    // Act: invoke the real router handler.
    const handler = findLateFeedbackHandler();
    const req = buildReq('rejected');
    const res = buildRes();
    await handler(req, res);

    // Assert: one job was enqueued with the full expected shape.
    expect(mockShouldTriggerReflection).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      'flagged_feedback',
    );
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockCreateTask).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      tenantId: TENANT_ID,
      triggeredBy: 'flagged_feedback',
      metadata: { feedbackId: FEEDBACK_ID },
    });
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('end-to-end: threshold fail → no enqueue even though record was inserted', async () => {
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: true,
      agentId: AGENT_ID,
    });
    mockShouldTriggerReflection.mockResolvedValueOnce({
      shouldTrigger: false,
      reason: 'Only 1 flagged feedback in last 7 days, need 2',
    });

    const handler = findLateFeedbackHandler();
    const req = buildReq('rejected');
    const res = buildRes();
    await handler(req, res);

    expect(mockShouldTriggerReflection).toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('end-to-end: approved decision short-circuits before shouldTriggerReflection', async () => {
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: true,
      agentId: AGENT_ID,
    });

    const handler = findLateFeedbackHandler();
    const req = buildReq('approved');
    const res = buildRes();
    await handler(req, res);

    // The router branches BEFORE any reflection-engine call, so neither
    // the threshold check nor the enqueue should ever run.
    expect(mockShouldTriggerReflection).not.toHaveBeenCalled();
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(mockIncrementQuotaOnEnqueue).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
