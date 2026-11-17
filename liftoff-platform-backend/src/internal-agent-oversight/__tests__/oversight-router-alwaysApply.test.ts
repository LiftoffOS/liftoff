// Tests for the oversight router's alwaysApply wire-through. Covers:
//   - POST /approve with alwaysApply: true → forwards to tenantRuntimeClient.approveRequest
//   - POST /approve with no body → alwaysApply: false (default)
//   - POST /reject with alwaysApply: true + reason → forwards both
//   - audit log includes alwaysApply

import type { Request, Response } from 'express';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  logAudit: jest.fn(),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockGetApproval = jest.fn();
const mockApproveRequest = jest.fn();
const mockRejectRequest = jest.fn();

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getApproval: (...args: unknown[]) => mockGetApproval(...args),
    approveRequest: (...args: unknown[]) => mockApproveRequest(...args),
    rejectRequest: (...args: unknown[]) => mockRejectRequest(...args),
    getPendingApprovalCount: jest.fn().mockResolvedValue({
      total: 0,
      approvalsStandard: 0,
      approvalsCritical: 0,
      approvalsOther: 0,
      clarifications: 0,
        }),
    listPendingApprovals: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    respondToClarification: jest.fn().mockResolvedValue(undefined),
  },
  HitlError: class HitlError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly errorCode: string,
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'HitlError';
    }
  },
}));

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue({ id: 'user_123' }),
  })),
}));

jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn().mockResolvedValue({ role: 'admin' }),
  },
}));

import { oversightRouter } from '../router';
import { logAudit } from '../../infrastructure/logging';

function mockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    params: { approvalId: 'rev_1' },
    query: { tenantId: 'ten_1' },
    body: {},
    ctx: { userId: 'firebase_uid' },
    ...overrides,
  };
}

function mockRes(): Partial<Response> & { json: jest.Mock; status: jest.Mock } {
  const r: Partial<Response> & { json: jest.Mock; status: jest.Mock } = {
    json: jest.fn(),
    status: jest.fn(),
  };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}

type Layer = { route?: { path?: string; methods?: Record<string, boolean> }; handle: (req: unknown, res: unknown, next: unknown) => unknown };

function findHandler(method: 'post' | 'get', path: string): Layer['handle'] {
  const stack = (oversightRouter as any).stack as Layer[];
  const found = stack.find(
    (l) =>
      l.route?.path === path &&
      (l.route?.methods ?? {})[method],
  );
  if (!found || !found.route) throw new Error(`route ${method} ${path} not found`);
  // route.stack[last].handle is the user handler
  const routeStack = (found.route as any).stack as Array<{ handle: Layer['handle'] }>;
  return routeStack[routeStack.length - 1].handle;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetApproval.mockResolvedValue({
    id: 'rev_1',
    hitlLevel: 2,
    pendingToolCalls: [],
    status: 'pending',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  mockApproveRequest.mockResolvedValue({ id: 'rev_1', status: 'approved' });
  mockRejectRequest.mockResolvedValue({ id: 'rev_1', status: 'rejected' });
});

describe('POST /hitl-approvals/:approvalId/approve', () => {
  const handler = findHandler('post', '/hitl-approvals/:approvalId/approve');

  it('forwards alwaysApply: true to approveRequest', async () => {
    const req = mockReq({ body: { alwaysApply: true } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockApproveRequest).toHaveBeenCalledWith(
      'ten_1',
      'rev_1',
      'user_123',
      'admin',
      true,
      // approvalNote: absent here, and absent is not the empty string — a
      // silent approval must not write a blank memory entry.
      undefined,
      // editedToolInputs: absent, meaning the approver took the call as
      // proposed. An empty map here would read as an edit that changed nothing.
      undefined,
    );
  });

  it('defaults alwaysApply to false when missing', async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockApproveRequest).toHaveBeenCalledWith(
      'ten_1', 'rev_1', 'user_123', 'admin', false, undefined, undefined,
    );
  });

  it('forwards an approval note when the approver wrote one', async () => {
    // The counterpart to the rejection reason below: until this field existed,
    // half of every gate decision reached the agent's memory unexplained.
    const req = mockReq({ body: { approvalNote: 'Vendor already vetted' } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockApproveRequest).toHaveBeenCalledWith(
      'ten_1', 'rev_1', 'user_123', 'admin', false, 'Vendor already vetted', undefined,
    );
  });

  it('treats a whitespace-only note as no note', async () => {
    const req = mockReq({ body: { approvalNote: '   ' } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockApproveRequest).toHaveBeenCalledWith(
      'ten_1', 'rev_1', 'user_123', 'admin', false, undefined, undefined,
    );
  });

  it('forwards the arguments an approver rewrote before saying yes', async () => {
    // Approve-with-edits. The decision is still an approval; what changes is
    // WHICH arguments get dispatched, so this rides the approve call rather
    // than a third decision value.
    const req = mockReq({ body: { editedToolInputs: { 'tc-1': { body: 'their wording' } } } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockApproveRequest).toHaveBeenCalledWith(
      'ten_1', 'rev_1', 'user_123', 'admin', false, undefined,
      { 'tc-1': { body: 'their wording' } },
    );
  });

  it('refuses an edit payload that is not a map of inputs', async () => {
    // A string or an array would survive JSONB and fail much later, at
    // dispatch, with nothing left to point at.
    const req = mockReq({ body: { editedToolInputs: { 'tc-1': 'not an input' } } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockApproveRequest).not.toHaveBeenCalled();
  });

  it('rejects a note longer than the field will take', async () => {
    const req = mockReq({ body: { approvalNote: 'x'.repeat(8001) } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockApproveRequest).not.toHaveBeenCalled();
  });

  it('records alwaysApply in audit log', async () => {
    const req = mockReq({ body: { alwaysApply: true } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(logAudit).toHaveBeenCalledWith(
      'hitl.approved',
      expect.anything(),
      expect.objectContaining({ alwaysApply: true }),
    );
  });
});

describe('POST /hitl-approvals/:approvalId/reject', () => {
  const handler = findHandler('post', '/hitl-approvals/:approvalId/reject');

  it('forwards alwaysApply: true + reason to rejectRequest', async () => {
    const req = mockReq({ body: { reason: 'tone wrong', alwaysApply: true } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockRejectRequest).toHaveBeenCalledWith(
      'ten_1',
      'rev_1',
      'user_123',
      'admin',
      'tone wrong',
      true,
    );
  });

  it('defaults alwaysApply to false when not provided', async () => {
    const req = mockReq({ body: { reason: 'no' } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockRejectRequest).toHaveBeenCalledWith(
      'ten_1', 'rev_1', 'user_123', 'admin', 'no', false,
    );
  });

  it('handles missing body (req.body=undefined) gracefully', async () => {
    const req = mockReq({ body: undefined });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(mockRejectRequest).toHaveBeenCalledWith(
      'ten_1', 'rev_1', 'user_123', 'admin', undefined, false,
    );
  });

  it('records reason + alwaysApply in audit log', async () => {
    const req = mockReq({ body: { reason: 'x', alwaysApply: true } });
    const res = mockRes();
    await handler(req, res, jest.fn());

    expect(logAudit).toHaveBeenCalledWith(
      'hitl.rejected',
      expect.anything(),
      expect.objectContaining({ reason: 'x', alwaysApply: true }),
    );
  });
});
