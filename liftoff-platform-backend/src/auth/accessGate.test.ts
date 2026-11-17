// Access Gate Middleware Tests
// Per implementation plan 1f: test whitelisted/blocked endpoints, req.accessDecision

import { Request, Response, NextFunction } from 'express';
import { createMockAccount } from '../test-utils/mocks';
import { _setCachedDomains, _stopRefreshTimer } from '../config/allowedDomains';

// Mock AccountService before importing accessGate
const mockComputeAccess = jest.fn();
const mockGetByFirebaseUid = jest.fn();

jest.mock('../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    computeAccess: mockComputeAccess,
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));

jest.mock('../infrastructure/database');
jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    customers: { create: jest.fn(), update: jest.fn() },
    subscriptions: { create: jest.fn(), update: jest.fn(), cancel: jest.fn() },
  })),
}));
jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_mock'),
}));

import { accessGateMiddleware } from './accessGate';

function createMockReq(overrides: Partial<Request> & { path?: string } = {}): Request {
  const path = overrides.path || '/api/tenants';
  return {
    method: 'GET',
    path,
    originalUrl: path, // Express sets originalUrl to the full path
    user: { uid: 'test-uid', email: 'user@test.com', emailVerified: true },
    ...overrides,
  } as unknown as Request;
}

function createMockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('accessGateMiddleware', () => {
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    next = jest.fn();
    _setCachedDomains(['example.com']);
  });

  afterAll(() => {
    _stopRefreshTimer();
  });

  describe('whitelisted endpoints', () => {
    it('should pass through GET /api/accounts/me without checking access', async () => {
      const req = createMockReq({ method: 'GET', path: '/api/accounts/me' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(mockGetByFirebaseUid).not.toHaveBeenCalled();
    });

    it('should pass through POST /api/accounts without checking access', async () => {
      const req = createMockReq({ method: 'POST', path: '/api/accounts' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should pass through POST /api/invite-requests without checking access', async () => {
      const req = createMockReq({ method: 'POST', path: '/api/invite-requests' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('non-whitelisted endpoints', () => {
    it('should return 403 for non-granted user', async () => {
      const account = createMockAccount({ email: 'person@example.org' });
      mockGetByFirebaseUid.mockResolvedValue(account);
      mockComputeAccess.mockResolvedValue({ accessGranted: false, accessReason: null });

      const req = createMockReq({ path: '/api/tenants' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Access not granted' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should pass through for granted user', async () => {
      const account = createMockAccount({ email: 'user@example.com' });
      mockGetByFirebaseUid.mockResolvedValue(account);
      mockComputeAccess.mockResolvedValue({ accessGranted: true, accessReason: 'domain' });

      const req = createMockReq({ path: '/api/tenants' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should set req.accessDecision for downstream use', async () => {
      const account = createMockAccount({ email: 'user@example.com' });
      mockGetByFirebaseUid.mockResolvedValue(account);
      const decision = { accessGranted: true, accessReason: 'domain' as const };
      mockComputeAccess.mockResolvedValue(decision);

      const req = createMockReq({ path: '/api/tenants' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(req.accessDecision).toEqual(decision);
    });
  });

  describe('exact path matching', () => {
    beforeEach(() => {
      const account = createMockAccount({ email: 'person@example.org' });
      mockGetByFirebaseUid.mockResolvedValue(account);
      mockComputeAccess.mockResolvedValue({ accessGranted: false, accessReason: null });
    });

    it('should NOT whitelist GET /api/accounts/ (list all)', async () => {
      const req = createMockReq({ method: 'GET', path: '/api/accounts/' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should NOT whitelist GET /api/accounts/:id', async () => {
      const req = createMockReq({ method: 'GET', path: '/api/accounts/some-id' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should NOT whitelist PUT /api/accounts/me', async () => {
      const req = createMockReq({ method: 'PUT', path: '/api/accounts/me' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should NOT whitelist DELETE /api/accounts/:id', async () => {
      const req = createMockReq({ method: 'DELETE', path: '/api/accounts/some-id' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('edge cases', () => {
    it('should return 401 when no user on request', async () => {
      const req = createMockReq({ user: undefined, path: '/api/tenants' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should return 404 when account not found', async () => {
      mockGetByFirebaseUid.mockResolvedValue(null);

      const req = createMockReq({ path: '/api/tenants' });
      const res = createMockRes();

      await accessGateMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
