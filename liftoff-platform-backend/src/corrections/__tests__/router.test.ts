// Correction Protocol Router Tests
// Integration tests for control plane API endpoints

import { Request, Response } from 'express';

// Create stable mock pool instance
const mockPoolQuery = jest.fn();
const mockPoolInstance = {
  query: mockPoolQuery,
};

// Mock external dependencies before importing modules
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPoolInstance),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logAudit: jest.fn(),
}));

// Mock correction service
const mockGetCorrectionOptions = jest.fn();
const mockRequestCorrection = jest.fn();
const mockRequestBulkCorrection = jest.fn();
const mockGetCorrectionHistory = jest.fn();
const mockGetCorrectionConfig = jest.fn();
const mockUpdateCorrectionConfig = jest.fn();
const mockGetCorrectionUsage = jest.fn();
const mockHandleCorrectionApproval = jest.fn();
const mockExpirePendingCorrections = jest.fn();

jest.mock('../service', () => ({
  correctionService: {
    getCorrectionOptions: (...args: unknown[]) => mockGetCorrectionOptions(...args),
    requestCorrection: (...args: unknown[]) => mockRequestCorrection(...args),
    requestBulkCorrection: (...args: unknown[]) => mockRequestBulkCorrection(...args),
    getCorrectionHistory: (...args: unknown[]) => mockGetCorrectionHistory(...args),
    getCorrectionConfig: (...args: unknown[]) => mockGetCorrectionConfig(...args),
    updateCorrectionConfig: (...args: unknown[]) => mockUpdateCorrectionConfig(...args),
    getCorrectionUsage: (...args: unknown[]) => mockGetCorrectionUsage(...args),
    handleCorrectionApproval: (...args: unknown[]) => mockHandleCorrectionApproval(...args),
    expirePendingCorrections: (...args: unknown[]) => mockExpirePendingCorrections(...args),
  },
}));

// Mock permissions
const mockCheckCorrectionConfigPermissions = jest.fn();

jest.mock('../permissions', () => ({
  checkCorrectionConfigPermissions: (...args: unknown[]) => mockCheckCorrectionConfigPermissions(...args),
}));

// Mock auth middleware
jest.mock('../../infrastructure/middleware', () => ({
  authMiddleware: (req: Request, res: Response, next: () => void) => {
    // Simulate authenticated user
    (req as any).user = { uid: 'firebase_user_123' };
    next();
  },
}));

// Mock AccountService to resolve Firebase UID → account UUID
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue({ id: 'account_uuid_123' }),
  })),
}));

// Mock tenant members service for IDOR protection checks
const mockGetMembership = jest.fn().mockResolvedValue({ role: 'member' });
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: (...args: unknown[]) => mockGetMembership(...args),
    hasPermission: jest.fn().mockReturnValue(true),
  },
}));

// Helper to create mock request
function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    params: {},
    query: { tenantId: 'tenant_123' },
    body: {},
    headers: {},
    user: { uid: 'firebase_user_123', emailVerified: true },
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

// Helper to get route handler from router
function getRouteHandler(
  router: any,
  path: string,
  method: 'get' | 'post' | 'put' | 'delete'
): ((...args: unknown[]) => unknown) | null {
  const layer = router.stack.find(
    (l: any) =>
      l.route?.path === path &&
      l.route?.methods?.[method]
  );
  if (!layer) return null;
  // Get the last handler (actual handler, not middleware)
  const routeStack = layer.route.stack;
  return routeStack[routeStack.length - 1].handle;
}

describe('Correction Router - Public User Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test_service_token';
  });

  afterEach(() => {
    delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  });

  describe('GET /audit-logs/:id/correction-options', () => {
    it('returns correction options for a valid audit log', async () => {
      const { correctionRouter } = await import('../router');

      mockGetCorrectionOptions.mockResolvedValueOnce({
        correctable: true,
        correctionType: 'archive',
        label: 'Archive issue',
        requiresApproval: false,
      });

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: { tenantId: 'tenant_123' },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correction-options', 'get');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockGetCorrectionOptions).toHaveBeenCalledWith('tenant_123', 'audit_log_123');
      expect(res.json).toHaveBeenCalledWith({
        correctable: true,
        correctionType: 'archive',
        label: 'Archive issue',
        requiresApproval: false,
      });
    });

    it('returns 400 when tenantId is missing', async () => {
      const { correctionRouter } = await import('../router');

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: {}, // No tenantId
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correction-options', 'get');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'tenantId is required' });
    });

    it('returns 500 on service error', async () => {
      const { correctionRouter } = await import('../router');

      mockGetCorrectionOptions.mockRejectedValueOnce(new Error('Database error'));

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: { tenantId: 'tenant_123' },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correction-options', 'get');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    });
  });

  describe('POST /audit-logs/:id/correct', () => {
    it('successfully requests a correction', async () => {
      const { correctionRouter } = await import('../router');

      mockRequestCorrection.mockResolvedValueOnce({
        success: true,
        correctionRequestId: 'req_123',
        status: 'requested',
      });

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: { tenantId: 'tenant_123' },
        body: { reason: 'User requested correction' },
        user: { uid: 'user_456', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correct', 'post');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockRequestCorrection).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        auditLogId: 'audit_log_123',
        reason: 'User requested correction',
        requestedBy: 'account_uuid_123',
      });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        correctionRequestId: 'req_123',
        status: 'requested',
      });
    });

    it('returns 400 when correction is ineligible', async () => {
      const { correctionRouter } = await import('../router');

      mockRequestCorrection.mockResolvedValueOnce({
        success: false,
        status: 'ineligible',
        error: 'Action cannot be corrected',
      });

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: { tenantId: 'tenant_123' },
        body: {},
        user: { uid: 'user_456', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correct', 'post');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 401 when user is not authenticated', async () => {
      const { correctionRouter } = await import('../router');

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: { tenantId: 'tenant_123' },
        body: {},
        user: undefined, // No authenticated user
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correct', 'post');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    });

    it('returns 400 on validation error', async () => {
      const { correctionRouter } = await import('../router');

      const req = createMockRequest({
        params: { id: 'audit_log_123' },
        query: { tenantId: 'tenant_123' },
        body: { reason: 'x'.repeat(1001) }, // Exceeds 1000 char limit
        user: { uid: 'user_456', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correct', 'post');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation failed',
        })
      );
    });
  });

  describe('POST /audit-logs/bulk-correct', () => {
    // Valid UUIDs for testing
    const validUuid1 = '550e8400-e29b-41d4-a716-446655440001';
    const validUuid2 = '550e8400-e29b-41d4-a716-446655440002';

    it('successfully requests bulk corrections', async () => {
      const { correctionRouter } = await import('../router');

      mockRequestBulkCorrection.mockResolvedValueOnce({
        results: [
          { auditLogId: validUuid1, status: 'requested', correctionRequestId: 'req_1' },
          { auditLogId: validUuid2, status: 'requested', correctionRequestId: 'req_2' },
        ],
        summary: { total: 2, requested: 2, ineligible: 0, errors: 0 },
      });

      const req = createMockRequest({
        query: { tenantId: 'tenant_123' },
        body: {
          auditLogIds: [validUuid1, validUuid2],
          reason: 'Batch correction',
        },
        user: { uid: 'user_456', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/bulk-correct', 'post');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockRequestBulkCorrection).toHaveBeenCalledWith(
        'tenant_123',
        'account_uuid_123',
        expect.objectContaining({
          auditLogIds: [validUuid1, validUuid2],
          reason: 'Batch correction',
        })
      );
      expect(res.status).toHaveBeenCalledWith(202);
    });

    it('returns 400 when exceeding maximum batch size', async () => {
      const { correctionRouter } = await import('../router');

      // Generate 51 valid UUIDs (exceeds 50 limit)
      const tooManyUuids = Array.from({ length: 51 }, (_, i) =>
        `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`
      );

      const req = createMockRequest({
        query: { tenantId: 'tenant_123' },
        body: {
          auditLogIds: tooManyUuids,
          reason: 'Batch correction',
        },
        user: { uid: 'user_456', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/bulk-correct', 'post');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation failed',
        })
      );
    });

    it('returns 429 on rate limit error', async () => {
      const { correctionRouter } = await import('../router');

      mockRequestBulkCorrection.mockRejectedValueOnce(new Error('Rate limit exceeded'));

      const req = createMockRequest({
        query: { tenantId: 'tenant_123' },
        body: {
          auditLogIds: [validUuid1],
          reason: 'Correction',
        },
        user: { uid: 'user_456', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/bulk-correct', 'post');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  describe('GET /audit-logs/:id/correction-history', () => {
    it('returns correction history for an audit log', async () => {
      const { correctionRouter } = await import('../router');

      const mockHistory = [
        {
          id: 'log_1',
          action: 'linear_create_issue',
          correctionOf: null,
          outcome: 'success',
          triggeredBy: 'user_123',
          createdAt: new Date(),
        },
        {
          id: 'log_2',
          action: 'linear_archive_issue',
          correctionOf: 'log_1',
          outcome: 'success',
          triggeredBy: 'user_456',
          createdAt: new Date(),
        },
      ];

      mockGetCorrectionHistory.mockResolvedValueOnce(mockHistory);

      const req = createMockRequest({
        params: { id: 'log_1' },
        query: { tenantId: 'tenant_123' },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/audit-logs/:id/correction-history', 'get');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockGetCorrectionHistory).toHaveBeenCalledWith('tenant_123', 'log_1');
      expect(res.json).toHaveBeenCalledWith({ history: mockHistory });
    });
  });
});

describe('Correction Router - Admin Configuration Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test_service_token';
  });

  describe('GET /tenants/:id/correction-config', () => {
    it('returns tenant correction config', async () => {
      const { correctionRouter } = await import('../router');

      const mockConfig = {
        tenantId: 'tenant_123',
        requireApprovalAll: true,
        autoApproveWindow: 300,
        requireOriginalActor: false,
      };

      mockGetCorrectionConfig.mockResolvedValueOnce(mockConfig);

      const req = createMockRequest({
        params: { id: 'tenant_123' },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/tenants/:id/correction-config', 'get');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockGetCorrectionConfig).toHaveBeenCalledWith('tenant_123');
      expect(res.json).toHaveBeenCalledWith(mockConfig);
    });

    it('returns default config when not configured', async () => {
      const { correctionRouter } = await import('../router');

      mockGetCorrectionConfig.mockResolvedValueOnce(null);

      const req = createMockRequest({
        params: { id: 'tenant_123' },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/tenants/:id/correction-config', 'get');
      await handler!(req as Request, res as Response);

      expect(res.json).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        requireApprovalAll: false,
        autoApproveWindow: null,
        requireOriginalActor: false,
      });
    });
  });

  describe('PUT /tenants/:id/correction-config', () => {
    it('updates tenant correction config with permission', async () => {
      const { correctionRouter } = await import('../router');

      mockCheckCorrectionConfigPermissions.mockResolvedValueOnce({ allowed: true });
      mockUpdateCorrectionConfig.mockResolvedValueOnce({
        tenantId: 'tenant_123',
        requireApprovalAll: true,
        autoApproveWindow: 600,
        requireOriginalActor: true,
      });

      const req = createMockRequest({
        params: { id: 'tenant_123' },
        body: {
          requireApprovalAll: true,
          autoApproveWindow: 600,
          requireOriginalActor: true,
        },
        user: { uid: 'admin_user', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/tenants/:id/correction-config', 'put');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockCheckCorrectionConfigPermissions).toHaveBeenCalledWith('tenant_123', 'account_uuid_123');
      expect(mockUpdateCorrectionConfig).toHaveBeenCalledWith('tenant_123', {
        requireApprovalAll: true,
        autoApproveWindow: 600,
        requireOriginalActor: true,
      });
    });

    it('returns 403 when user lacks permission', async () => {
      const { correctionRouter } = await import('../router');

      mockCheckCorrectionConfigPermissions.mockResolvedValueOnce({
        allowed: false,
        reason: 'Admin role required',
      });

      const req = createMockRequest({
        params: { id: 'tenant_123' },
        body: { requireApprovalAll: true },
        user: { uid: 'regular_user', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/tenants/:id/correction-config', 'put');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Admin role required' });
    });

    it('returns 400 on invalid autoApproveWindow', async () => {
      const { correctionRouter } = await import('../router');

      // Permission check must pass for validation to be reached
      mockCheckCorrectionConfigPermissions.mockResolvedValueOnce({ allowed: true });

      const req = createMockRequest({
        params: { id: 'tenant_123' },
        body: { autoApproveWindow: 100000 }, // Exceeds 86400 limit
        user: { uid: 'admin_user', emailVerified: true },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/tenants/:id/correction-config', 'put');
      await handler!(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Validation failed',
        })
      );
    });
  });

  describe('GET /tenants/:id/correction-usage', () => {
    it('returns correction usage stats', async () => {
      const { correctionRouter } = await import('../router');

      const mockUsage = {
        rateLimits: {
          maxPerMinute: 10,
          maxPerHour: 100,
          maxPerDay: 500,
        },
        currentUsage: {
          minute: 3,
          hour: 25,
          day: 150,
        },
        budget: {
          budgetLimit: 1000,
          budgetUsed: 250,
          budgetPeriod: 'monthly',
        },
      };

      mockGetCorrectionUsage.mockResolvedValueOnce(mockUsage);

      const req = createMockRequest({
        params: { id: 'tenant_123' },
      });
      const res = createMockResponse();

      const handler = getRouteHandler(correctionRouter, '/tenants/:id/correction-usage', 'get');
      expect(handler).toBeDefined();

      await handler!(req as Request, res as Response);

      expect(mockGetCorrectionUsage).toHaveBeenCalledWith('tenant_123');
      expect(res.json).toHaveBeenCalledWith(mockUsage);
    });
  });
});


describe('Correction Router - Rate Limiting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test_service_token';
  });

  it('correction endpoints have rate limiter middleware', async () => {
    const { correctionRouter } = await import('../router');

    // Check POST /audit-logs/:id/correct has rate limiter
    const correctRoute = correctionRouter.stack.find(
      (l: any) =>
        l.route?.path === '/audit-logs/:id/correct' &&
        l.route?.methods?.post
    );

    expect(correctRoute).toBeDefined();
    // Should have auth middleware + rate limiter + handler
    expect(correctRoute!.route!.stack.length).toBeGreaterThan(2);

    // Check POST /audit-logs/bulk-correct has rate limiter
    const bulkCorrectRoute = correctionRouter.stack.find(
      (l: any) =>
        l.route?.path === '/audit-logs/bulk-correct' &&
        l.route?.methods?.post
    );

    expect(bulkCorrectRoute).toBeDefined();
    expect(bulkCorrectRoute!.route!.stack.length).toBeGreaterThan(2);
  });

  it('read endpoints have read rate limiter middleware', async () => {
    const { correctionRouter } = await import('../router');

    // Check GET /audit-logs/:id/correction-options has rate limiter
    const optionsRoute = correctionRouter.stack.find(
      (l: any) =>
        l.route?.path === '/audit-logs/:id/correction-options' &&
        l.route?.methods?.get
    );

    expect(optionsRoute).toBeDefined();
    expect(optionsRoute!.route!.stack.length).toBeGreaterThan(2);

    // Check GET /audit-logs/:id/correction-history has rate limiter
    const historyRoute = correctionRouter.stack.find(
      (l: any) =>
        l.route?.path === '/audit-logs/:id/correction-history' &&
        l.route?.methods?.get
    );

    expect(historyRoute).toBeDefined();
    expect(historyRoute!.route!.stack.length).toBeGreaterThan(2);
  });
});

describe('Correction Router - Tenant Isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test_service_token';
  });

  it('all user endpoints require tenantId', async () => {
    const { correctionRouter } = await import('../router');

    // Test correction options endpoint
    const optionsHandler = getRouteHandler(correctionRouter, '/audit-logs/:id/correction-options', 'get');
    const req1 = createMockRequest({
      params: { id: 'log_1' },
      query: {}, // No tenantId
    });
    const res1 = createMockResponse();
    await optionsHandler!(req1 as Request, res1 as Response);
    expect(res1.status).toHaveBeenCalledWith(400);

    // Test correct endpoint
    const correctHandler = getRouteHandler(correctionRouter, '/audit-logs/:id/correct', 'post');
    const req2 = createMockRequest({
      params: { id: 'log_1' },
      query: {}, // No tenantId
      user: { uid: 'user_123', emailVerified: true },
    });
    const res2 = createMockResponse();
    await correctHandler!(req2 as Request, res2 as Response);
    expect(res2.status).toHaveBeenCalledWith(400);

    // Test bulk correct endpoint
    const bulkHandler = getRouteHandler(correctionRouter, '/audit-logs/bulk-correct', 'post');
    const req3 = createMockRequest({
      query: {}, // No tenantId
      body: { auditLogIds: ['log_1'] },
      user: { uid: 'user_123', emailVerified: true },
    });
    const res3 = createMockResponse();
    await bulkHandler!(req3 as Request, res3 as Response);
    expect(res3.status).toHaveBeenCalledWith(400);

    // Test correction history endpoint
    const historyHandler = getRouteHandler(correctionRouter, '/audit-logs/:id/correction-history', 'get');
    const req4 = createMockRequest({
      params: { id: 'log_1' },
      query: {}, // No tenantId
    });
    const res4 = createMockResponse();
    await historyHandler!(req4 as Request, res4 as Response);
    expect(res4.status).toHaveBeenCalledWith(400);
  });
});
