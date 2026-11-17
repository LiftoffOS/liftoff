// Phase 4 (plan §4c verification): `agent-service can call
// tool-gateway-service with valid OIDC token; unauthorized calls return
// 401`. These tests drive `requireServiceAuth({ acceptOidc: true })` through
// the Express request/response shape with a stubbed OAuth2Client — no
// network, no real tokens.

import type { Request, Response } from 'express';
import { requireServiceAuth } from '../service-auth';
import {
  setOidcVerifierClientForTests,
  resetOidcVerifierClientForTests,
} from '../oidc-verifier';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers, path: '/test' } as unknown as Request;
}

interface StubRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => StubRes;
  json: (body: unknown) => StubRes;
}

function makeRes(): StubRes {
  const res: StubRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function makeStubClient(verifyImpl: (opts: { idToken: string; audience: unknown }) => Promise<{ getPayload(): unknown }>) {
  return { verifyIdToken: verifyImpl } as unknown as Parameters<typeof setOidcVerifierClientForTests>[0];
}

const ALLOWED_SA = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';
const AUDIENCE = 'https://tool-gateway-service-xxxx-uw.a.run.app';

describe('requireServiceAuth — OIDC path (acceptOidc: true)', () => {
  const ORIGINAL_ENV = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  beforeEach(() => {
    // Set a shared-secret so the fallback path has SOMETHING to compare to —
    // most tests only exercise the OIDC path, but the setup mirrors prod.
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'correct-horse-battery-staple';
  });

  afterEach(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIGINAL_ENV;
    resetOidcVerifierClientForTests();
  });

  it('calls next() when OIDC verifies and email is allowed', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: ALLOWED_SA,
          email_verified: true,
        }),
      })),
    );
    const middleware = requireServiceAuth({
      acceptOidc: true,
      oidcAudience: AUDIENCE,
      allowedOidcEmails: [ALLOWED_SA],
    });

    const req = makeReq({ authorization: 'Bearer fake.jwt.token' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('falls back to X-Service-Auth when OIDC fails verification', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => {
        throw new Error('Invalid token signature');
      }),
    );
    const middleware = requireServiceAuth({
      acceptOidc: true,
      oidcAudience: AUDIENCE,
      allowedOidcEmails: [ALLOWED_SA],
    });

    const req = makeReq({
      authorization: 'Bearer bad.jwt.token',
      'x-service-auth': 'correct-horse-battery-staple',
    });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 when both OIDC and X-Service-Auth are missing/invalid', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => {
        throw new Error('bad sig');
      }),
    );
    const middleware = requireServiceAuth({
      acceptOidc: true,
      oidcAudience: AUDIENCE,
      allowedOidcEmails: [ALLOWED_SA],
    });

    const req = makeReq({ authorization: 'Bearer bad.jwt.token' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects an OIDC token whose email is not in the allow-list', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'other-sa@example-project.iam.gserviceaccount.com',
          email_verified: true,
        }),
      })),
    );
    const middleware = requireServiceAuth({
      acceptOidc: true,
      oidcAudience: AUDIENCE,
      allowedOidcEmails: [ALLOWED_SA],
    });

    const req = makeReq({ authorization: 'Bearer fake.jwt' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    // Falls through to shared-secret path, which also fails → 401.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('throws at construction when acceptOidc is true but oidcAudience is missing', () => {
    expect(() =>
      requireServiceAuth({
        acceptOidc: true,
        allowedOidcEmails: [ALLOWED_SA],
      }),
    ).toThrow(/oidcAudience/);
  });

  it('throws at construction when acceptOidc is true but allowedOidcEmails is missing', () => {
    expect(() =>
      requireServiceAuth({
        acceptOidc: true,
        oidcAudience: AUDIENCE,
      }),
    ).toThrow(/allowedOidcEmails/);
  });

  it('supports a function for oidcAudience (resolved per request)', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async ({ audience }) => {
        // Caller assertion: the middleware must pass the audience from the
        // resolver down to verifyIdToken.
        expect(audience).toBe(AUDIENCE);
        return {
          getPayload: () => ({
            iss: 'https://accounts.google.com',
            email: ALLOWED_SA,
            email_verified: true,
          }),
        };
      }),
    );
    const middleware = requireServiceAuth({
      acceptOidc: true,
      oidcAudience: () => AUDIENCE,
      allowedOidcEmails: [ALLOWED_SA],
    });

    const req = makeReq({ authorization: 'Bearer fake.jwt' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('supports a function for allowedOidcEmails (resolved per request)', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: ALLOWED_SA,
          email_verified: true,
        }),
      })),
    );
    const middleware = requireServiceAuth({
      acceptOidc: true,
      oidcAudience: AUDIENCE,
      allowedOidcEmails: () => [ALLOWED_SA],
    });

    const req = makeReq({ authorization: 'Bearer fake.jwt' });
    const res = makeRes();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireServiceAuth — shared-secret path (acceptOidc: false / default)', () => {
  const ORIGINAL_ENV = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  beforeEach(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'correct-horse-battery-staple';
  });

  afterEach(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIGINAL_ENV;
  });

  it('accepts matching X-Service-Auth', async () => {
    const middleware = requireServiceAuth();
    const req = makeReq({ 'x-service-auth': 'correct-horse-battery-staple' });
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects missing X-Service-Auth with 401', async () => {
    const middleware = requireServiceAuth();
    const req = makeReq({});
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects wrong X-Service-Auth with 401', async () => {
    const middleware = requireServiceAuth();
    const req = makeReq({ 'x-service-auth': 'wrong' });
    const res = makeRes();
    const next = jest.fn();
    await middleware(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
