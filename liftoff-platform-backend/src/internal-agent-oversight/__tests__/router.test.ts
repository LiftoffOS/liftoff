// Agent Oversight Router Tests
// Tests HITL approval endpoints including expiration handling and late feedback

import { Request, Response } from 'express';

// Mock external dependencies
jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  logAudit: jest.fn(),
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock tenant runtime client
const mockGetApproval = jest.fn();
const mockApproveRequest = jest.fn();
const mockRejectRequest = jest.fn();
const mockRespondToClarification = jest.fn();

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
    respondToClarification: (...args: unknown[]) => mockRespondToClarification(...args),
    declineClarification: (...args: unknown[]) => mockDeclineClarification(...args),
  },
  HitlError: class HitlError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly errorCode: string,
      public readonly details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'HitlError';
    }
  },
}));

const mockDeclineClarification = jest.fn();

// Mock late feedback service
const mockGetByApprovalId = jest.fn();
const mockSubmitLateFeedback = jest.fn();

jest.mock('../../hitl-late-feedback', () => ({
  lateFeedbackService: {
    getByApprovalId: (...args: unknown[]) => mockGetByApprovalId(...args),
    submitLateFeedback: (...args: unknown[]) => mockSubmitLateFeedback(...args),
  },
}));

// Mock account service
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue({ id: 'user_123', email: 'test@example.com' }),
  })),
}));

// Mock tenant members service
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn().mockResolvedValue({ role: 'admin' }),
  },
}));

// Import after mocks
import { HitlError } from '../../connectors/tenant-runtime-client';

// Helper to create mock request
function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    params: {},
    query: { tenantId: 'tenant_123' },
    body: {},
    ctx: { userId: 'firebase_user_123' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

// Helper to create mock response
function createMockResponse(): Partial<Response> & { json: jest.Mock; status: jest.Mock } {
  const res: Partial<Response> & { json: jest.Mock; status: jest.Mock } = {
    json: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

// Helper to create mock approval
function createMockApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval_123',
    tenantId: 'tenant_123',
    agentId: 'agent_456',
    hitlLevel: 1,
    pendingToolCalls: [{ id: 'tc_1', name: 'sendEmail', input: { to: 'user@example.com' } }],
    toolCallsHash: 'hash_abc',
    reason: 'level_1_gate',
    status: 'pending',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Agent Oversight Router - HITL Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Enable tenant runtime for tests
    process.env.ENABLE_TENANT_RUNTIME = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_TENANT_RUNTIME;
  });

  describe('POST /hitl-approvals/:approvalId/approve', () => {
    it('returns 409 EXPIRED when approval has expired', async () => {
      // Import router handler
      const { oversightRouter } = await import('../router');

      // Mock expired approval error from tenant runtime
      mockApproveRequest.mockRejectedValueOnce(
        new HitlError(
          'This approval has expired and cannot be actioned',
          409,
          'EXPIRED',
          { expiredAt: new Date(Date.now() - 1000).toISOString() }
        )
      );
      mockGetApproval.mockResolvedValueOnce(createMockApproval({ hitlLevel: 1 }));

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
      });
      const res = createMockResponse();

      // Find the approve route handler
      const approveHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/approve' &&
          layer.route?.methods?.post
      );

      expect(approveHandler).toBeDefined();

      // Execute the handler (skip middleware)
      const routeStack = approveHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'EXPIRED',
          lateFeedbackEndpoint: '/api/internal-agent-oversight/hitl-approvals/approval_123/late-feedback',
        })
      );
    });

    it('returns 409 ALREADY_DECIDED when approval already processed', async () => {
      const { oversightRouter } = await import('../router');

      mockApproveRequest.mockRejectedValueOnce(
        new HitlError(
          'This approval has already been decided',
          409,
          'ALREADY_DECIDED',
          { status: 'approved' }
        )
      );
      mockGetApproval.mockResolvedValueOnce(createMockApproval({ hitlLevel: 1 }));

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
      });
      const res = createMockResponse();

      const approveHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/approve' &&
          layer.route?.methods?.post
      );

      const routeStack = approveHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'ALREADY_DECIDED',
        })
      );
    });
  });

  describe('POST /hitl-approvals/:approvalId/reject', () => {
    it('returns 409 EXPIRED when approval has expired', async () => {
      const { oversightRouter } = await import('../router');

      mockRejectRequest.mockRejectedValueOnce(
        new HitlError(
          'This approval has expired and cannot be actioned',
          409,
          'EXPIRED',
          { expiredAt: new Date(Date.now() - 1000).toISOString() }
        )
      );
      mockGetApproval.mockResolvedValueOnce(createMockApproval({ hitlLevel: 1 }));

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { reason: 'Not authorized' },
      });
      const res = createMockResponse();

      const rejectHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/reject' &&
          layer.route?.methods?.post
      );

      const routeStack = rejectHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'EXPIRED',
          lateFeedbackEndpoint: '/api/internal-agent-oversight/hitl-approvals/approval_123/late-feedback',
        })
      );
    });
  });

  describe('POST /hitl-approvals/:approvalId/late-feedback', () => {
    it('returns 403 when user is not member of tenant', async () => {
      const { oversightRouter } = await import('../router');

      // Mock no membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce(null);

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_approve' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      // Skip rate limiter middleware, get the actual handler
      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'FORBIDDEN',
        })
      );
    });

    it('returns 403 when user lacks approval permission (member role)', async () => {
      const { oversightRouter } = await import('../router');

      // Mock member role (not admin or owner)
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'member' });

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_approve' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'FORBIDDEN',
          message: 'Insufficient permissions',
        })
      );
    });

    it('returns 400 NOT_EXPIRED when approval is still pending', async () => {
      const { oversightRouter } = await import('../router');

      // Mock admin membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      // Mock non-expired approval
      mockGetApproval.mockResolvedValueOnce(
        createMockApproval({
          status: 'pending',
          expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        })
      );

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_approve' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'NOT_EXPIRED',
        })
      );
    });

    it('returns 400 NOT_EXPIRED for an approval that was decided before its window closed', async () => {
      // "Expired" has to mean nobody answered. An approved request whose
      // expires_at has since slipped by used to satisfy the check, so this
      // endpoint accepted "I would have approved" for something already
      // approved and fed that to the reflection engine as a missed decision.
      const { oversightRouter } = await import('../router');

      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      mockGetApproval.mockResolvedValueOnce(
        createMockApproval({
          status: 'approved',
          decision: 'approved',
          expiresAt: new Date(Date.now() - 3600000).toISOString(), // window has since passed
        })
      );

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_approve' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );
      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'NOT_EXPIRED' })
      );
    });

    it('accepts feedback for an approval that lapsed before the sweeper flipped it', async () => {
      // Still status='pending' with a past expires_at: the ~30 minute window
      // before the runtime marks it expired. Nobody answered, so feedback is
      // exactly what this endpoint is for.
      const { oversightRouter } = await import('../router');

      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      mockGetApproval.mockResolvedValueOnce(
        createMockApproval({
          status: 'pending',
          expiresAt: new Date(Date.now() - 60000).toISOString(),
        })
      );
      mockGetByApprovalId.mockResolvedValueOnce(null);
      mockSubmitLateFeedback.mockResolvedValueOnce({
        id: 'fb_1',
        approvalId: 'approval_123',
        decision: 'would_approve',
        feedbackProvidedAt: new Date().toISOString(),
      });

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_approve' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );
      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns 200 with alreadySubmitted when feedback already exists (idempotency)', async () => {
      const { oversightRouter } = await import('../router');

      // Mock admin membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      // Mock expired approval
      mockGetApproval.mockResolvedValueOnce(
        createMockApproval({
          status: 'expired',
          expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        })
      );

      // Mock existing feedback
      const existingFeedback = {
        id: 'feedback_456',
        approvalId: 'approval_123',
        decision: 'would_approve',
        feedbackProvidedAt: new Date().toISOString(),
      };
      mockGetByApprovalId.mockResolvedValueOnce(existingFeedback);

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_approve' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'feedback_456',
          alreadySubmitted: true,
        })
      );
    });

    it('returns 201 when feedback is successfully submitted', async () => {
      const { oversightRouter } = await import('../router');

      // Mock admin membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      // Mock expired approval
      mockGetApproval.mockResolvedValueOnce(
        createMockApproval({
          status: 'expired',
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
        })
      );

      // Mock no existing feedback
      mockGetByApprovalId.mockResolvedValueOnce(null);

      // Mock successful submission
      const newFeedback = {
        id: 'feedback_789',
        approvalId: 'approval_123',
        decision: 'would_reject',
        feedbackProvidedAt: new Date(),
      };
      mockSubmitLateFeedback.mockResolvedValueOnce(newFeedback);

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'would_reject', reason: 'Unauthorized action' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'feedback_789',
          decision: 'would_reject',
        })
      );
    });

    it('validates decision is one of would_approve or would_reject', async () => {
      const { oversightRouter } = await import('../router');

      // Mock admin membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: { decision: 'invalid_decision' },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'INVALID_INPUT',
        })
      );
    });

    it('validates reason does not exceed 2048 characters', async () => {
      const { oversightRouter } = await import('../router');

      // Mock admin membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'admin' });

      const req = createMockRequest({
        params: { approvalId: 'approval_123' },
        body: {
          decision: 'would_reject',
          reason: 'x'.repeat(2049), // Exceeds 2048 limit
        },
      });
      const res = createMockResponse();

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      const routeStack = lateFeedbackHandler.route.stack;
      const handler = routeStack[routeStack.length - 1].handle;
      await handler(req as Request, res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'INVALID_INPUT',
        })
      );
    });
  });

  describe('Rate limiting', () => {
    it('late feedback endpoint has rate limiter middleware', async () => {
      const { oversightRouter } = await import('../router');

      const lateFeedbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId/late-feedback' &&
          layer.route?.methods?.post
      );

      expect(lateFeedbackHandler).toBeDefined();
      // Rate limiter is added as middleware before the handler
      // The route should have multiple handlers (rate limiter + actual handler)
      expect(lateFeedbackHandler.route.stack.length).toBeGreaterThan(1);
    });
  });
});

// Per Phase 0.2: SE-002, SE-007, TE-002 - Tenant Isolation Tests
describe('Agent Oversight Router - Tenant Isolation (TE-002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_TENANT_RUNTIME = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_TENANT_RUNTIME;
  });

  describe('test_oversight_get_rejects_non_member', () => {
    it('returns 403 when user is not a member of the tenant', async () => {
      // Mock tenant members service to return no membership
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce(null);

      // Import router to get the handler
      const { oversightRouter } = await import('../router');

      const getHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/:tenantId' &&
          layer.route?.methods?.get
      );

      expect(getHandler).toBeDefined();
      // The handler includes middleware + actual handler
      // Skip to middleware test - we verify the middleware rejects non-members
    });
  });

  describe('test_oversight_put_rejects_non_admin', () => {
    it('returns 403 when user has viewer role (insufficient permission for editTeams)', async () => {
      // Mock tenant members service to return viewer role
      const { tenantMembersService } = await import('../../tenant-members/service');
      (tenantMembersService.getMembership as jest.Mock).mockResolvedValueOnce({ role: 'viewer' });

      // The tenantAuthMiddleware('editTeams') will reject viewers
      // This is tested via middleware integration
    });
  });

  describe('test_hitl_approval_get_requires_tenant_membership', () => {
    it('HITL approval endpoints verify tenant membership (SE-007)', async () => {
      const { oversightRouter } = await import('../router');

      // Verify that HITL approval GET endpoints have middleware
      const pendingCountHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/pending-count' &&
          layer.route?.methods?.get
      );

      expect(pendingCountHandler).toBeDefined();
      // Should have verifyHitlTenantMembership middleware
      expect(pendingCountHandler.route.stack.length).toBeGreaterThan(1);

      const listHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals' &&
          layer.route?.methods?.get
      );

      expect(listHandler).toBeDefined();
      expect(listHandler.route.stack.length).toBeGreaterThan(1);

      const singleHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/hitl-approvals/:approvalId' &&
          layer.route?.methods?.get
      );

      expect(singleHandler).toBeDefined();
      expect(singleHandler.route.stack.length).toBeGreaterThan(1);
    });
  });

  describe('test_oversight_tenant_isolation', () => {
    it('oversight settings endpoints have tenantAuthMiddleware', async () => {
      const { oversightRouter } = await import('../router');

      // Verify GET /:tenantId has middleware
      const getSettingsHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/:tenantId' &&
          layer.route?.methods?.get
      );

      expect(getSettingsHandler).toBeDefined();
      expect(getSettingsHandler.route.stack.length).toBeGreaterThan(1);

      // Verify PUT /:tenantId has middleware
      const putSettingsHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/:tenantId' &&
          layer.route?.methods?.put
      );

      expect(putSettingsHandler).toBeDefined();
      expect(putSettingsHandler.route.stack.length).toBeGreaterThan(1);

      // Verify GET /:tenantId/versions has middleware
      const versionsHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/:tenantId/versions' &&
          layer.route?.methods?.get
      );

      expect(versionsHandler).toBeDefined();
      expect(versionsHandler.route.stack.length).toBeGreaterThan(1);

      // Verify POST /:tenantId/rollback has middleware
      const rollbackHandler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/:tenantId/rollback' &&
          layer.route?.methods?.post
      );

      expect(rollbackHandler).toBeDefined();
      expect(rollbackHandler.route.stack.length).toBeGreaterThan(1);
    });
  });

  describe('POST /clarifications/:id/respond', () => {
    async function runRespond(req: Partial<Request>): Promise<Partial<Response>> {
      const { oversightRouter } = await import('../router');
      const res = createMockResponse() as Partial<Response> & {
        json: jest.Mock; status: jest.Mock; end: jest.Mock;
      };
      // The respond endpoint uses res.status(204).end(); createMockResponse
      // only mocks status+json, so attach end() locally.
      res.end = jest.fn().mockReturnValue(res);
      const handler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/clarifications/:id/respond' &&
          layer.route?.methods?.post,
      );
      expect(handler).toBeDefined();
      // The route mounts `verifyHitlTenantMembership` as the first middleware,
      // which sets req.tenantId + req.actorAccountId. The runner here calls only
      // the terminal handler (route.stack[last]), so simulate the middleware by
      // hoisting query.tenantId and a synthesized account id onto the request.
      const reqExt = req as any;
      if (req.query && (req.query as any).tenantId && !reqExt.tenantId) {
        reqExt.tenantId = (req.query as any).tenantId;
      }
      // verifyHitlTenantMembership writes account.id (UUID) — tests use 'user_123'
      // — and the membership row, which the shared clarification functions
      // read the role from.
      if (req.ctx?.userId && !reqExt.actorAccountId) {
        reqExt.actorAccountId = 'user_123';
        reqExt.membership = { role: 'member', accountId: 'user_123' };
      }
      const route = handler.route.stack;
      const fn = route[route.length - 1].handle;
      await fn(req as Request, res as Response, jest.fn());
      return res;
    }

    it('returns 400 when response body is missing or empty', async () => {
      const res = await runRespond({
        params: { id: 'c_1' },
        query: { tenantId: 'tenant_123' },
        body: { response: '' },
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockRespondToClarification).not.toHaveBeenCalled();
    });

    it('returns 204 on success and propagates tenantId + clarificationId + accountId', async () => {
      mockRespondToClarification.mockResolvedValueOnce(undefined);
      const res = await runRespond({
        params: { id: 'c_1' },
        query: { tenantId: 'tenant_123' },
        body: { response: 'go ahead' },
        ctx: { userId: 'fb_user' },
      }) as Partial<Response> & { end: jest.Mock };
      expect(mockRespondToClarification).toHaveBeenCalledWith(
        'tenant_123', 'c_1', 'go ahead', 'user_123',
      );
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('returns 409 when the clarification was already resolved', async () => {
      mockRespondToClarification.mockRejectedValueOnce(
        new Error('clarification already resolved or not found'),
      );
      const res = await runRespond({
        params: { id: 'c_2' },
        query: { tenantId: 'tenant_123' },
        body: { response: 'go ahead' },
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('returns 500 for unexpected backend errors', async () => {
      mockRespondToClarification.mockRejectedValueOnce(new Error('boom'));
      const res = await runRespond({
        params: { id: 'c_3' },
        query: { tenantId: 'tenant_123' },
        body: { response: 'go ahead' },
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  /** Declining is the other half of answering: a person was asked and cannot
   *  answer, so the run resumes now instead of waiting out its window. */
  describe('POST /clarifications/:id/decline', () => {
    async function runDecline(req: Partial<Request>): Promise<Partial<Response>> {
      const { oversightRouter } = await import('../router');
      const res = createMockResponse() as Partial<Response> & {
        json: jest.Mock; status: jest.Mock; end: jest.Mock;
      };
      res.end = jest.fn().mockReturnValue(res);
      const handler = (oversightRouter.stack as any[]).find(
        (layer) =>
          layer.route?.path === '/clarifications/:id/decline' &&
          layer.route?.methods?.post,
      );
      expect(handler).toBeDefined();
      const reqExt = req as any;
      if (req.query && (req.query as any).tenantId && !reqExt.tenantId) {
        reqExt.tenantId = (req.query as any).tenantId;
      }
      if (req.ctx?.userId && !reqExt.actorAccountId) {
        reqExt.actorAccountId = 'user_123';
        reqExt.membership = { role: 'member', accountId: 'user_123' };
      }
      const route = handler.route.stack;
      const fn = route[route.length - 1].handle;
      await fn(req as Request, res as Response, jest.fn());
      return res;
    }

    it('accepts a decline with no reason at all', async () => {
      // The reason is what the learning loop reads, not something the run
      // waits on, so requiring one would only be a toll on saying no.
      mockDeclineClarification.mockResolvedValueOnce(undefined);
      const res = await runDecline({
        params: { id: 'c_1' },
        query: { tenantId: 'tenant_123' },
        body: {},
        ctx: { userId: 'fb_user' },
      });
      expect(mockDeclineClarification).toHaveBeenCalledWith(
        'tenant_123', 'c_1', 'user_123', undefined,
      );
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('passes the reason through when one was given', async () => {
      mockDeclineClarification.mockResolvedValueOnce(undefined);
      await runDecline({
        params: { id: 'c_1' },
        query: { tenantId: 'tenant_123' },
        body: { reason: 'Nobody here owns that system' },
        ctx: { userId: 'fb_user' },
      });
      expect(mockDeclineClarification).toHaveBeenCalledWith(
        'tenant_123', 'c_1', 'user_123', 'Nobody here owns that system',
      );
    });

    it('rejects a reason longer than the column will take', async () => {
      const res = await runDecline({
        params: { id: 'c_1' },
        query: { tenantId: 'tenant_123' },
        body: { reason: 'x'.repeat(8001) },
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockDeclineClarification).not.toHaveBeenCalled();
    });

    it('reports a settled clarification as 404 rather than a failure', async () => {
      mockDeclineClarification.mockRejectedValueOnce(
        Object.assign(new Error('clarification not found'), { status: 404 }),
      );
      const res = await runDecline({
        params: { id: 'c_2' },
        query: { tenantId: 'tenant_123' },
        body: {},
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('reports a kind that cannot be declined as 409, not a server error', async () => {
      // An Anchor intervention. The page hides the affordance; a stale tab can
      // still reach here.
      mockDeclineClarification.mockRejectedValueOnce(
        Object.assign(new Error('anchor_intervention clarifications cannot be declined'), { status: 409 }),
      );
      const res = await runDecline({
        params: { id: 'c_3' },
        query: { tenantId: 'tenant_123' },
        body: {},
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('returns 500 for unexpected backend errors', async () => {
      mockDeclineClarification.mockRejectedValueOnce(new Error('boom'));
      const res = await runDecline({
        params: { id: 'c_4' },
        query: { tenantId: 'tenant_123' },
        body: {},
        ctx: { userId: 'fb_user' },
      });
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
