// requireVerifiedEmail Middleware Tests
// Verifies that only unverified password-provider users are blocked, while
// federated / passkey / already-verified users pass through.

import { Request, Response, NextFunction } from 'express';
import { requireVerifiedEmail } from './requireVerifiedEmail';

function createMockReq(user: unknown): Request {
  return {
    method: 'POST',
    path: '/api/accounts',
    originalUrl: '/api/accounts',
    user,
  } as unknown as Request;
}

function createMockRes(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('requireVerifiedEmail', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn();
  });

  it('blocks an unverified password user with 403 email_not_verified', () => {
    const req = createMockReq({
      uid: 'u1',
      email: 'junk@example.com',
      emailVerified: false,
      signInProvider: 'password',
    });
    const res = createMockRes();

    requireVerifiedEmail(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'email_not_verified' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a verified password user', () => {
    const req = createMockReq({
      uid: 'u1',
      email: 'real@example.com',
      emailVerified: true,
      signInProvider: 'password',
    });
    const res = createMockRes();

    requireVerifiedEmail(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows an unverified Google user (federated provider asserts the email)', () => {
    const req = createMockReq({
      uid: 'u1',
      email: 'person@example.com',
      emailVerified: false,
      signInProvider: 'google.com',
    });
    const res = createMockRes();

    requireVerifiedEmail(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows a passkey custom-token user', () => {
    const req = createMockReq({
      uid: 'u1',
      email: 'passkey@example.com',
      emailVerified: false,
      signInProvider: 'custom',
    });
    const res = createMockRes();

    requireVerifiedEmail(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when no user on request', () => {
    const req = createMockReq(undefined);
    const res = createMockRes();

    requireVerifiedEmail(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
