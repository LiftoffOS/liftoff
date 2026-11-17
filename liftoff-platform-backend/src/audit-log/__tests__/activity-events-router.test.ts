// Phase 3 activity-events router unit tests.

const mockGetByFirebaseUid = jest.fn();
const mockPoolQuery = jest.fn();
const mockLogAudit = jest.fn();
const mockResolveAuditActor = jest.fn();
const mockVerifyAccountInTenant = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

jest.mock('../../infrastructure/audit-context', () => ({
  resolveAuditActor: (...args: unknown[]) => mockResolveAuditActor(...args),
  verifyAccountInTenant: (...args: unknown[]) => mockVerifyAccountInTenant(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
}));

import { activityEventsRouter } from '../activity-events-router';
import type { Request, Response } from 'express';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>;
  };
}

function findHandler(method: string, path: string) {
  const stack = (activityEventsRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`route ${method} ${path} not found`);
}

function makeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {
    status(code: number) {
      this.statusCode = code;
      return this as Response;
    },
    json(payload: unknown) {
      this.body = payload;
      return this as Response;
    },
    end() {
      return this as Response;
    },
  };
  return res as Response & { statusCode?: number; body?: unknown };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { uid: 'fb-uid' },
    body: { type: 'activity.filter_applied' },
    headers: {},
    ip: '127.0.0.1',
    ctx: { tenantId: undefined, userId: 'fb-uid' },
    ...overrides,
  } as unknown as Request;
}

const noop = () => undefined;

describe('activity-events router', () => {
  beforeEach(() => {
    mockGetByFirebaseUid.mockReset();
    mockPoolQuery.mockReset();
    mockLogAudit.mockReset();
    mockResolveAuditActor.mockReset();
    mockVerifyAccountInTenant.mockReset();
  });

  it('returns 401 when unauthenticated', async () => {
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({ user: undefined });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for unknown event type', async () => {
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({ body: { type: 'activity.not_a_real_event' } });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(400);
  });

  it('returns 204 + audit when actor resolved via primary tenant fallback', async () => {
    mockResolveAuditActor.mockResolvedValueOnce({
      accountId: 'acc-1',
      primaryTenantId: 'tenant-1',
    });
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({
      body: {
        type: 'activity.details_viewed',
        resourceId: 'log-42',
        params: { agentId: 'a-1', action: 'tool.call' },
      },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'activity.details_viewed',
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'acc-1' }),
      expect.objectContaining({
        resourceType: 'activity_log',
        resourceId: 'log-42',
        newState: { agentId: 'a-1', action: 'tool.call' },
      }),
    );
  });

  it('returns 403 when explicit tenantId membership is not verified', async () => {
    mockVerifyAccountInTenant.mockResolvedValueOnce(null);
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({
      body: {
        type: 'activity.search_performed',
        tenantId: '11111111-1111-1111-1111-111111111111',
        params: { query: 'invoice' },
      },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(403);
  });

  it('attributes to explicit tenantId when membership is verified', async () => {
    mockVerifyAccountInTenant.mockResolvedValueOnce({ accountId: 'acc-1' });
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({
      body: {
        type: 'activity.search_performed',
        tenantId: '11111111-1111-1111-1111-111111111111',
        params: { query: 'invoice' },
      },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'activity.search_performed',
      expect.objectContaining({
        tenantId: '11111111-1111-1111-1111-111111111111',
        userId: 'acc-1',
      }),
      expect.any(Object),
    );
  });

  it('defaults resourceId to "list" when omitted', async () => {
    mockResolveAuditActor.mockResolvedValueOnce({
      accountId: 'acc-1',
      primaryTenantId: 'tenant-1',
    });
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({
      body: { type: 'activity.search_performed', params: { query: 'invoice' } },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(mockLogAudit.mock.calls[0][2].resourceId).toBe('list');
  });

  it('returns 400 when params exceed 4 KB', async () => {
    const big = 'x'.repeat(5000);
    const handler = findHandler('POST', '/activity-events');
    const req = makeReq({
      body: { type: 'activity.search_performed', params: { big } },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(400);
  });
});
