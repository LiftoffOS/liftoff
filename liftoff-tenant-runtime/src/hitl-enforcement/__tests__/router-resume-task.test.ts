// HITL approval router — approve/reject enqueue resume Cloud Task.
//
// the operator clicks Approve or Reject via
// `POST /api/hitl-enforcement/approvals/:id/{approve,reject}`, the
// router looks up the matching hitl_approval pause row via
// `findHitlPauseForApproval` and fires a Cloud Task with
// `kind: 'hitl-approved' | 'hitl-rejected'`. The Cloud Tasks handler
// (`cloud-tasks-hitl.test.ts`) covers the rest of the chain.
//
// When no pause row exists (interactive chat or external-agent flow —
// those approvals are synchronous and don't pause), the enqueue is
// skipped without error.

const findHitlPauseForApprovalMock = jest.fn();
const approveRequestMock = jest.fn();
const rejectRequestMock = jest.fn();
const getApprovalRequestMock = jest.fn();
const enqueueResumeForHitlMock = jest.fn();

jest.mock('../service', () => ({
  hitlEnforcementService: {
    findHitlPauseForApproval: (...a: unknown[]) => findHitlPauseForApprovalMock(...a),
    approveRequest: (...a: unknown[]) => approveRequestMock(...a),
    rejectRequest: (...a: unknown[]) => rejectRequestMock(...a),
    getApprovalRequest: (...a: unknown[]) => getApprovalRequestMock(...a),
    recordLateFeedback: jest.fn(),
    listPendingItemsForTenant: jest.fn(),
    getPendingItemsCount: jest.fn(),
  },
}));

jest.mock('../../scheduling/hitl-resume-helpers', () => ({
  enqueueResumeForHitl: (...a: unknown[]) => enqueueResumeForHitlMock(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/database', () => ({ pool: { query: jest.fn().mockResolvedValue({ rows: [] }) } }));
jest.mock('../../agent-execution/run-state/service', () => ({
  agentRunStateService: {
    load: jest.fn().mockResolvedValue(null),
    appendItem: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../../reflection-engine/trigger-service', () => ({ reflectionTriggerService: {} }));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { hitlRouter } from '../router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { ctx?: { tenantId: string } }, _res: Response, next: NextFunction) => {
    req.ctx = { tenantId: 't1' };
    next();
  });
  app.use('/api/hitl-enforcement', hitlRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  getApprovalRequestMock.mockResolvedValue({ id: 'appr-1', tenantId: 't1', status: 'pending' });
  approveRequestMock.mockResolvedValue({ id: 'appr-1', decision: 'approved', status: 'approved' });
  rejectRequestMock.mockResolvedValue({ id: 'appr-1', decision: 'rejected', status: 'rejected' });
});

describe('POST /approvals/:id/approve — enqueues hitl-approved resume task', () => {
  it('enqueues with kind="hitl-approved" when a matching pause row exists', async () => {
    findHitlPauseForApprovalMock.mockResolvedValue({
      id: 'sched-1', tenantId: 't1', agentId: 'a1',
      threadId: 'thread-1', scheduledByInvocationId: 'inv-1',
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/hitl-enforcement/approvals/appr-1/approve')
      .send({ decidedBy: 'user-1', decidedByRole: 'admin' });
    expect(res.status).toBe(200);
    expect(enqueueResumeForHitlMock).toHaveBeenCalledTimes(1);
    expect(enqueueResumeForHitlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1', agentId: 'a1',
        scheduledRowId: 'sched-1',
        scheduledByInvocationId: 'inv-1',
        kind: 'hitl-approved',
      }),
    );
  });

  it('does NOT enqueue when no pause row exists (interactive chat flow)', async () => {
    findHitlPauseForApprovalMock.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/hitl-enforcement/approvals/appr-1/approve')
      .send({ decidedBy: 'user-1', decidedByRole: 'admin' });
    expect(res.status).toBe(200);
    expect(enqueueResumeForHitlMock).not.toHaveBeenCalled();
  });
});

describe('POST /approvals/:id/reject — enqueues hitl-rejected resume task', () => {
  it('enqueues with kind="hitl-rejected" when a matching pause row exists', async () => {
    findHitlPauseForApprovalMock.mockResolvedValue({
      id: 'sched-2', tenantId: 't1', agentId: 'a1',
      threadId: 'thread-1', scheduledByInvocationId: 'inv-1',
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/hitl-enforcement/approvals/appr-1/reject')
      .send({ decidedBy: 'user-1', decidedByRole: 'admin', rejectionReason: 'wrong recipient', rejectionCategory: 'wrong_recipient' });
    expect(res.status).toBe(200);
    expect(enqueueResumeForHitlMock).toHaveBeenCalledTimes(1);
    expect(enqueueResumeForHitlMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1', agentId: 'a1', scheduledRowId: 'sched-2',
        kind: 'hitl-rejected',
      }),
    );
  });

  it('does NOT enqueue when no pause row exists', async () => {
    findHitlPauseForApprovalMock.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/hitl-enforcement/approvals/appr-1/reject')
      .send({ decidedBy: 'user-1', decidedByRole: 'admin', rejectionReason: 'wrong recipient', rejectionCategory: 'wrong_recipient' });
    expect(res.status).toBe(200);
    expect(enqueueResumeForHitlMock).not.toHaveBeenCalled();
  });
});
