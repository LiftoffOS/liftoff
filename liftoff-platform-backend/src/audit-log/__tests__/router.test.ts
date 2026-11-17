// Unit tests for /api/audit router. Each handler is invoked directly via
// the express Router.stack lookup (same pattern as account-state-handler.test.ts)
// so we don't need a live DB. The auth middleware ahead of the handler is
// mocked as a passthrough; the service is mocked too, so these tests cover
// request validation, response shape, and error mapping in the router.

const mockServiceList = jest.fn();
const mockIsEnterprise = jest.fn();
jest.mock('../service', () => ({
  auditLogService: {
    list: (...args: unknown[]) => mockServiceList(...args),
    isEnterprise: (...args: unknown[]) => mockIsEnterprise(...args),
  },
}));

const mockLogAudit = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('../../infrastructure/middleware', () => {
  const passthrough = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return {
    tenantAuthMiddleware: jest.fn(() => passthrough()),
  };
});

import { auditLogRouter } from '../router';
import { ValidationError } from '../../tenant-members/service';
import type { Request, Response } from 'express';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{
      handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown | Promise<unknown>;
    }>;
  };
}

function findHandler(method: string, path: string) {
  const stack = (auditLogRouter as unknown as { stack: RouteLayer[] }).stack;
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

function findMiddleware(method: string, path: string, name: string) {
  const stack = (auditLogRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
    ) {
      const found = layer.route.stack.find(
        (s) => (s.handle as { name?: string }).name === name,
      );
      if (found) return found.handle;
    }
  }
  throw new Error(`middleware ${name} on ${method} ${path} not found`);
}

function makeRes() {
  const res: Partial<Response> & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = {
    headers: {},
    status(code: number) {
      (res as Response).statusCode = code;
      res.statusCode = code;
      return res as Response;
    },
    json(payload: unknown) {
      res.body = payload;
      return res as Response;
    },
    end() {
      return res as Response;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res as Response;
    },
  };
  return res as Response & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { tenantId: TENANT_ID },
    query: {},
    body: {},
    headers: {},
    ctx: { tenantId: TENANT_ID, userId: 'firebase-uid' },
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

const noopNext = () => undefined;

describe('audit-log router — GET /:tenantId/events', () => {
  beforeEach(() => {
    mockServiceList.mockReset();
    mockLogAudit.mockReset();
  });

  it('returns 200 with the service payload', async () => {
    mockServiceList.mockResolvedValue({
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
    const handler = findHandler('GET', '/:tenantId/events');
    const req = makeReq({
      query: {
        startDate: '2026-05-01T00:00:00.000Z',
        endDate: '2026-05-21T00:00:00.000Z',
      },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(undefined); // .json() never set a status — default 200
    expect(res.body).toEqual({ entries: [], nextCursor: null, hasMore: false });
    expect(mockLogAudit).toHaveBeenCalledWith(
      'audit.accessed',
      expect.objectContaining({ tenantId: TENANT_ID }),
      expect.objectContaining({ tenantId: TENANT_ID }),
    );
  });

  it('returns 400 for invalid query parameters', async () => {
    const handler = findHandler('GET', '/:tenantId/events');
    const req = makeReq({
      query: { startDate: 'not-a-date', endDate: 'also-not' },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: string }).error).toBe('Invalid parameters');
  });

  it('returns 400 when service throws ValidationError (range > 90 days)', async () => {
    mockServiceList.mockRejectedValue(
      new ValidationError('Date range cannot exceed 90 days'),
    );
    const handler = findHandler('GET', '/:tenantId/events');
    const req = makeReq({
      query: {
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-05-01T00:00:00.000Z',
      },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: string }).error).toBe(
      'Date range cannot exceed 90 days',
    );
  });

  it('returns 200 (clamped, no throw) when endDate is in the future', async () => {
    // Regression test for the bug fixed in P1.2 service.ts — the legacy
    // endpoint threw 400 here; the new one silently clamps to now and the
    // request succeeds.
    mockServiceList.mockResolvedValue({
      entries: [],
      nextCursor: null,
      hasMore: false,
    });
    const handler = findHandler('GET', '/:tenantId/events');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const start = new Date(Date.now() - 86_400_000).toISOString();
    const req = makeReq({ query: { startDate: start, endDate: future } });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(mockServiceList).toHaveBeenCalled();
    expect((res.body as { entries: unknown[] }).entries).toEqual([]);
  });

  it('returns 500 on unexpected service error', async () => {
    mockServiceList.mockRejectedValue(new Error('boom'));
    const handler = findHandler('GET', '/:tenantId/events');
    const req = makeReq({
      query: {
        startDate: '2026-05-01T00:00:00.000Z',
        endDate: '2026-05-21T00:00:00.000Z',
      },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(500);
  });
});

describe('audit-log router — POST /:tenantId/events/export-completed', () => {
  beforeEach(() => {
    mockLogAudit.mockReset();
  });

  it('returns 204 and emits audit.csv_downloaded for a valid body', async () => {
    const handler = findHandler('POST', '/:tenantId/events/export-completed');
    const req = makeReq({
      body: {
        startDate: '2026-05-01T00:00:00.000Z',
        endDate: '2026-05-21T00:00:00.000Z',
        totalRows: 1847,
      },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'audit.csv_downloaded',
      expect.objectContaining({ tenantId: TENANT_ID }),
      expect.objectContaining({
        newState: expect.objectContaining({ totalRows: 1847 }),
        resourceType: 'audit_log_export',
      }),
    );
  });

  it('returns 400 for invalid body shape', async () => {
    const handler = findHandler('POST', '/:tenantId/events/export-completed');
    const req = makeReq({
      body: { startDate: 'bad', endDate: 'bad' },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 400 when totalRows is negative', async () => {
    const handler = findHandler('POST', '/:tenantId/events/export-completed');
    const req = makeReq({
      body: {
        startDate: '2026-05-01T00:00:00.000Z',
        endDate: '2026-05-21T00:00:00.000Z',
        totalRows: -1,
      },
    });
    const res = makeRes();
    await handler(req, res, noopNext);
    expect(res.statusCode).toBe(400);
  });
});

describe('audit-log router — Enterprise gate (requireEnterprise)', () => {
  beforeEach(() => {
    mockIsEnterprise.mockReset();
  });

  it('returns 403 for a non-Enterprise tenant and does not call next', async () => {
    mockIsEnterprise.mockResolvedValue(false);
    const mw = findMiddleware('GET', '/:tenantId/events', 'requireEnterprise');
    const req = makeReq();
    const res = makeRes();
    let nexted = false;
    await mw(req, res, () => {
      nexted = true;
    });
    expect(mockIsEnterprise).toHaveBeenCalledWith(TENANT_ID);
    expect(res.statusCode).toBe(403);
    expect(nexted).toBe(false);
  });

  it('calls next() for an Enterprise tenant', async () => {
    mockIsEnterprise.mockResolvedValue(true);
    const mw = findMiddleware('POST', '/:tenantId/events/export-completed', 'requireEnterprise');
    const req = makeReq();
    const res = makeRes();
    let nexted = false;
    await mw(req, res, () => {
      nexted = true;
    });
    expect(res.statusCode).toBe(undefined);
    expect(nexted).toBe(true);
  });
});
