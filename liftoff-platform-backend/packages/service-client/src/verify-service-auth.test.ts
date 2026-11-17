import type { Request, Response, NextFunction } from 'express';
import { verifyServiceAuth } from './verify-service-auth.js';

function buildCtx(headerValue: string | undefined) {
  const req = {
    headers: headerValue === undefined ? {} : { 'x-service-auth': headerValue },
  } as unknown as Request;

  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = {
    status: statusMock,
    json: jsonMock,
  } as unknown as Response;

  const next = jest.fn() as unknown as NextFunction;

  return { req, res, next, statusMock, jsonMock };
}

describe('verifyServiceAuth', () => {
  const ORIG_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  afterEach(() => {
    if (ORIG_TOKEN === undefined) {
      delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
    } else {
      process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIG_TOKEN;
    }
  });

  it('returns 500 when token env var is not configured', () => {
    delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
    const { req, res, next, statusMock, jsonMock } = buildCtx('anything');

    verifyServiceAuth()(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Service auth not configured' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when header is missing', () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'secret-token';
    const { req, res, next, statusMock, jsonMock } = buildCtx(undefined);

    verifyServiceAuth()(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Missing X-Service-Auth header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when header is empty string', () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'secret-token';
    const { req, res, next, statusMock, jsonMock } = buildCtx('');

    verifyServiceAuth()(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Missing X-Service-Auth header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token length differs from expected', () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'secret-token';
    const { req, res, next, statusMock, jsonMock } = buildCtx('secret-token-with-extra');

    verifyServiceAuth()(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid service token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token value is wrong', () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'secret-token';
    const { req, res, next, statusMock, jsonMock } = buildCtx('bogus-token0');

    verifyServiceAuth()(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: 'Invalid service token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when token matches', () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'secret-token';
    const { req, res, next, statusMock } = buildCtx('secret-token');

    verifyServiceAuth()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('respects custom tokenEnvVar option', () => {
    process.env.CUSTOM_TOKEN_VAR = 'custom-secret';
    const { req, res, next } = buildCtx('custom-secret');

    verifyServiceAuth({ tokenEnvVar: 'CUSTOM_TOKEN_VAR' })(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    delete process.env.CUSTOM_TOKEN_VAR;
  });
});
