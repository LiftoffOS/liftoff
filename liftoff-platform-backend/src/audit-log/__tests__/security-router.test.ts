// Phase 3 security-events router unit tests.

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

import { securityEventRouter } from '../security-router';
import type { Request, Response } from 'express';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>;
  };
}

function findHandler(method: string, path: string) {
  const stack = (securityEventRouter as unknown as { stack: RouteLayer[] }).stack;
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
    body: { type: 'account.password_changed' },
    headers: {},
    ip: '127.0.0.1',
    ctx: { tenantId: undefined, userId: 'fb-uid' },
    ...overrides,
  } as unknown as Request;
}

const noop = () => undefined;

describe('security-events router', () => {
  beforeEach(() => {
    mockGetByFirebaseUid.mockReset();
    mockPoolQuery.mockReset();
    mockLogAudit.mockReset();
    mockResolveAuditActor.mockReset();
    mockVerifyAccountInTenant.mockReset();
  });

  it('returns 401 when unauthenticated (no req.user)', async () => {
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({ user: undefined });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 400 for unknown event type', async () => {
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({ body: { type: 'not.an.event' } });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 401 when fallback actor resolution fails (no account)', async () => {
    mockResolveAuditActor.mockResolvedValueOnce(null);
    const handler = findHandler('POST', '/security-events');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(401);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('attributes to primary tenant when none supplied', async () => {
    mockResolveAuditActor.mockResolvedValueOnce({
      accountId: 'acc-1',
      primaryTenantId: 'tenant-1',
    });
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({
      body: { type: 'account.mfa_enrolled', metadata: { factor: 'totp' } },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'account.mfa_enrolled',
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'acc-1' }),
      expect.objectContaining({
        resourceType: 'account',
        resourceId: 'acc-1',
        newState: { factor: 'totp' },
      }),
    );
  });

  it('emits audit with tenant_id=undefined when user has no tenant membership (caller still authenticated)', async () => {
    mockResolveAuditActor.mockResolvedValueOnce({
      accountId: 'acc-1',
      primaryTenantId: null,
    });
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({ body: { type: 'account.password_changed' } });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'account.password_changed',
      expect.objectContaining({ tenantId: undefined, userId: 'acc-1' }),
      expect.any(Object),
    );
  });

  it('attributes to the explicit tenantId when supplied and membership verified', async () => {
    mockVerifyAccountInTenant.mockResolvedValueOnce({ accountId: 'acc-1' });
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({
      body: {
        type: 'account.password_changed',
        tenantId: '11111111-1111-1111-1111-111111111111',
      },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(204);
    expect(mockLogAudit).toHaveBeenCalledWith(
      'account.password_changed',
      expect.objectContaining({
        tenantId: '11111111-1111-1111-1111-111111111111',
        userId: 'acc-1',
      }),
      expect.any(Object),
    );
  });

  it('returns 403 when user supplies a tenantId they are not a member of', async () => {
    mockVerifyAccountInTenant.mockResolvedValueOnce(null);
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({
      body: {
        type: 'account.password_changed',
        tenantId: '22222222-2222-2222-2222-222222222222',
      },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(403);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 400 when metadata exceeds 8 KB', async () => {
    const big = 'x'.repeat(9000);
    const handler = findHandler('POST', '/security-events');
    const req = makeReq({
      body: { type: 'account.password_changed', metadata: { big } },
    });
    const res = makeRes();
    await handler(req, res, noop);
    expect(res.statusCode).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
