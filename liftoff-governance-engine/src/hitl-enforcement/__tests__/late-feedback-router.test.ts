// Late Feedback Router — Phase 5 gap fix test
//
// Verifies the decision branching added in the Phase 5 merge:
//   - decision: 'rejected'  → reflectionTriggerService.onLateFeedbackFlagged is called
//   - decision: 'approved'  → NO reflection trigger fires (late approval is not a
//                             learning signal)
//   - result.inserted: false → NO trigger even on a rejected decision (duplicate
//                              retries from Platform Backend must not burn quota)
//
// The router lives in src/hitl-enforcement/late-feedback-router.ts and is
// mounted at /api/governance/late-feedback by server.ts. We pull the POST
// handler out of the router stack and invoke it with plain mock req/res
// objects — no Express app, no supertest dependency. This keeps the test
// focused on the branching decision without pulling in the full HTTP
// plumbing.

// Mock all downstream dependencies BEFORE importing the router so the
// module's closure sees our mocks.

const mockRecordLateFeedback = jest.fn();
jest.mock('../service', () => ({
  hitlEnforcementService: {
    recordLateFeedback: (...args: unknown[]) => mockRecordLateFeedback(...args),
  },
}));

const mockOnLateFeedbackFlagged = jest.fn();
const mockOnEscalationResolved = jest.fn();
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: {
    onLateFeedbackFlagged: (...args: unknown[]) =>
      mockOnLateFeedbackFlagged(...args),
    onEscalationResolved: (...args: unknown[]) =>
      mockOnEscalationResolved(...args),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { lateFeedbackRouter } from '../late-feedback-router';

// Express's Router exposes its registered handlers on a .stack. Each layer
// represents a registered route, and each route has its own sub-stack of
// middleware/handler functions. The POST handler is the only function on
// that sub-stack — the router itself is mounted at /api/governance/late-
// feedback in server.ts, so the internal route path is just '/'.
function findLateFeedbackHandler(): (
  req: any,
  res: any,
  next?: any,
) => Promise<void> {
  const layer = (lateFeedbackRouter as any).stack.find(
    (l: any) =>
      l.route?.path === '/' &&
      l.route?.stack?.some((s: any) => s.method === 'post'),
  );
  if (!layer) {
    throw new Error('POST / handler not found on lateFeedbackRouter');
  }
  return layer.route.stack[0].handle;
}

const TENANT_ID = '00000000-0000-0000-0000-000000000111';
const AGENT_ID = '00000000-0000-0000-0000-000000000222';
const APPROVAL_ID = '00000000-0000-0000-0000-000000000333';
const FEEDBACK_ID = '00000000-0000-0000-0000-000000000444';

function buildReq(overrides: { decision?: 'approved' | 'rejected' } = {}): any {
  return {
    ctx: { tenantId: TENANT_ID },
    body: {
      feedbackId: FEEDBACK_ID,
      approvalId: APPROVAL_ID,
      decision: overrides.decision ?? 'rejected',
      decidedBy: 'user-999',
      decidedByRole: 'owner',
      rejectionReason: 'Not relevant to my goal',
      toolCallsHash: 'sha256:abc',
      pendingToolCalls: [],
    },
  };
}

function buildRes(): { status: jest.Mock; json: jest.Mock; statusCode?: number } {
  const res: any = {
    statusCode: 200,
    status: jest.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function (this: any) {
      return this;
    }),
  };
  return res;
}

describe('POST /api/hitl-enforcement/late-feedback — decision branching', () => {
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(() => {
    mockRecordLateFeedback.mockReset();
    mockOnLateFeedbackFlagged.mockReset();
    mockOnEscalationResolved.mockReset();
    handler = findLateFeedbackHandler();
  });

  it('routes a fresh rejected decision to onLateFeedbackFlagged', async () => {
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: true,
      agentId: AGENT_ID,
    });
    mockOnLateFeedbackFlagged.mockResolvedValueOnce(undefined);

    const req = buildReq({ decision: 'rejected' });
    const res = buildRes();

    await handler(req, res);

    expect(mockRecordLateFeedback).toHaveBeenCalledTimes(1);
    expect(mockOnLateFeedbackFlagged).toHaveBeenCalledTimes(1);
    expect(mockOnLateFeedbackFlagged).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      FEEDBACK_ID,
    );
    // The old trigger method must NOT be called — approved vs rejected
    // branching is what Phase 5 was all about.
    expect(mockOnEscalationResolved).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('does NOT trigger reflection on a fresh approved decision', async () => {
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: true,
      agentId: AGENT_ID,
    });

    const req = buildReq({ decision: 'approved' });
    const res = buildRes();

    await handler(req, res);

    expect(mockRecordLateFeedback).toHaveBeenCalledTimes(1);
    expect(mockOnLateFeedbackFlagged).not.toHaveBeenCalled();
    expect(mockOnEscalationResolved).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('does NOT trigger reflection on a duplicate rejected retry (inserted=false)', async () => {
    // Platform Backend retries can hit us with the same feedbackId twice.
    // The service layer dedupes (inserted=false) and we must not re-enqueue
    // reflection jobs that burn daily quota on replay.
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: false,
      agentId: AGENT_ID,
    });

    const req = buildReq({ decision: 'rejected' });
    const res = buildRes();

    await handler(req, res);

    expect(mockRecordLateFeedback).toHaveBeenCalledTimes(1);
    expect(mockOnLateFeedbackFlagged).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('returns 404 and skips trigger when approval lookup fails (agentId=null)', async () => {
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: false,
      agentId: null,
    });

    const req = buildReq({ decision: 'rejected' });
    const res = buildRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockOnLateFeedbackFlagged).not.toHaveBeenCalled();
  });

  it('swallows trigger failures and still returns 200 to the caller', async () => {
    // If the reflection trigger throws (e.g. Cloud Tasks transient error),
    // the late-feedback row is still persisted. We must return success so
    // Platform Backend does not retry — the retry would only re-insert the
    // same feedback row (caught by the dedupe path above).
    mockRecordLateFeedback.mockResolvedValueOnce({
      inserted: true,
      agentId: AGENT_ID,
    });
    mockOnLateFeedbackFlagged.mockRejectedValueOnce(
      new Error('cloud tasks transient failure'),
    );

    const req = buildReq({ decision: 'rejected' });
    const res = buildRes();

    await handler(req, res);

    expect(mockOnLateFeedbackFlagged).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
