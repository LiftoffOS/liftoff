import { Request, Response } from 'express';

// Mock dependencies
jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  log: { error: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
}));

const mockListPersonnel = jest.fn();
const mockUpdateAssignments = jest.fn();

jest.mock('../service', () => ({
  personAssignmentsService: {
    listPersonnelWithAssignments: (...args: unknown[]) => mockListPersonnel(...args),
    updateAssignmentsForPerson: (...args: unknown[]) => mockUpdateAssignments(...args),
  },
}));

jest.mock('../../infrastructure/middleware', () => ({
  tenantAuthMiddleware: () => (_req: Request, _res: Response, next: () => void) => next(),
}));

import { personAssignmentsRouter } from '../router';

function createMockReqRes(overrides: {
  method?: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
}) {
  const req = {
    method: overrides.method || 'GET',
    query: overrides.query || {},
    params: overrides.params || {},
    body: overrides.body || {},
    uid: 'test-user-id',
    ctx: { tenantId: 'test-tenant' },
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;

  return { req, res };
}

// Get the route handlers from the router
function getRouteHandler(method: string, path: string) {
  const stack = (personAssignmentsRouter as any).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path) {
      const routeMethod = method.toLowerCase();
      for (const routeLayer of layer.route.stack) {
        if (routeLayer.method === routeMethod) {
          // Return the last handler (after middleware)
          const handlers = layer.route.stack.filter(
            (l: any) => l.method === routeMethod
          );
          return handlers[handlers.length - 1].handle;
        }
      }
    }
  }
  return null;
}

describe('personAssignmentsRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /personnel', () => {
    it('returns 400 when tenantId is missing', async () => {
      const handler = getRouteHandler('GET', '/personnel');
      const { req, res } = createMockReqRes({ query: {} });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'tenantId required' });
    });

    it('returns personnel list with valid tenantId', async () => {
      mockListPersonnel.mockResolvedValueOnce([{ accountId: 'a1', firstName: 'Jane' }]);
      const handler = getRouteHandler('GET', '/personnel');
      const { req, res } = createMockReqRes({ query: { tenantId: 'test-tenant' } });

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        personnel: [{ accountId: 'a1', firstName: 'Jane' }],
      });
      expect(mockListPersonnel).toHaveBeenCalledWith('test-tenant');
    });
  });

  describe('PUT /:accountId', () => {
    const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
    const AGENT_ID = '00000000-0000-0000-0000-000000000100';

    it('returns 400 when tenantId is missing', async () => {
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        params: { accountId: ACCOUNT_ID },
        body: { assignments: [] },
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'tenantId required' });
    });

    it('returns 400 for invalid request body (missing assignments)', async () => {
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        query: { tenantId: 'test-tenant' },
        params: { accountId: ACCOUNT_ID },
        body: {},
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Validation failed' })
      );
    });

    it('returns 400 for invalid agentId (non-UUID)', async () => {
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        query: { tenantId: 'test-tenant' },
        params: { accountId: ACCOUNT_ID },
        body: { assignments: [{ agentId: 'not-a-uuid', agentType: 'internal' }] },
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for invalid agentType', async () => {
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        query: { tenantId: 'test-tenant' },
        params: { accountId: ACCOUNT_ID },
        body: { assignments: [{ agentId: AGENT_ID, agentType: 'unknown' }] },
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('accepts valid assignments and returns success', async () => {
      mockUpdateAssignments.mockResolvedValueOnce({ added: 1, removed: 0 });
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        query: { tenantId: 'test-tenant' },
        params: { accountId: ACCOUNT_ID },
        body: { assignments: [{ agentId: AGENT_ID, agentType: 'internal' }] },
      });

      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true, added: 1, removed: 0 });
    });

    it('returns 404 when person not found', async () => {
      mockUpdateAssignments.mockRejectedValueOnce(
        Object.assign(new Error('Person not found in tenant'), { statusCode: 404 })
      );
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        query: { tenantId: 'test-tenant' },
        params: { accountId: ACCOUNT_ID },
        body: { assignments: [] },
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 400 for invalid agent references', async () => {
      mockUpdateAssignments.mockRejectedValueOnce(
        Object.assign(new Error('Invalid internal agent IDs'), { statusCode: 400 })
      );
      const handler = getRouteHandler('PUT', '/:accountId');
      const { req, res } = createMockReqRes({
        query: { tenantId: 'test-tenant' },
        params: { accountId: ACCOUNT_ID },
        body: { assignments: [{ agentId: AGENT_ID, agentType: 'internal' }] },
      });

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('middleware wiring', () => {
    it('has tenantAuthMiddleware on both routes', () => {
      const stack = (personAssignmentsRouter as any).stack;
      // Each route should have at least 2 layers (middleware + handler)
      for (const layer of stack) {
        if (layer.route) {
          expect(layer.route.stack.length).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });
});
