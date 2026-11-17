import {
  validateCrossServiceAuth,
  buildCrossServiceHeaders,
  type CrossServiceAuthOptions,
  type OidcPayload,
  type OidcVerifier,
} from './cross-service-auth.js';

function makeVerifier(payload: OidcPayload | Error): OidcVerifier {
  return {
    verify: jest.fn(async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    }),
  };
}

function baseOptions(overrides: Partial<CrossServiceAuthOptions> = {}): CrossServiceAuthOptions {
  return {
    calleeId: 'billing',
    expectedAudience: 'https://billing-abc.run.app',
    expectedIssuer: 'https://accounts.google.com',
    allowedCallerServiceAccounts: ['platform-backend@example-project.iam.gserviceaccount.com'],
    secretLookup: async (id) => (id === 'billing' ? 'secret-billing' : null),
    oidcVerifier: makeVerifier({
      iss: 'https://accounts.google.com',
      aud: 'https://billing-abc.run.app',
      sub: '1',
      email: 'platform-backend@example-project.iam.gserviceaccount.com',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
    }),
    ...overrides,
  };
}

describe('validateCrossServiceAuth', () => {
  it('accepts valid X-Service-Auth + OIDC', async () => {
    const outcome = await validateCrossServiceAuth(
      { 'x-service-auth': 'secret-billing', authorization: 'Bearer tok' },
      baseOptions(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.payload?.aud).toBe('https://billing-abc.run.app');
  });

  it('rejects when X-Service-Auth is missing', async () => {
    const outcome = await validateCrossServiceAuth(
      { authorization: 'Bearer tok' },
      baseOptions(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'missing_service_token' });
  });

  it('rejects when X-Service-Auth is wrong', async () => {
    const outcome = await validateCrossServiceAuth(
      { 'x-service-auth': 'wrong', authorization: 'Bearer tok' },
      baseOptions(),
    );
    expect(outcome.reason).toBe('wrong_service_token');
  });

  it('rejects when OIDC aud mismatches (cross-service replay)', async () => {
    const verifier = makeVerifier({
      iss: 'https://accounts.google.com',
      aud: 'https://billing-xyz.run.app', // token minted for a different callee
      sub: '1',
      email: 'platform-backend@example-project.iam.gserviceaccount.com',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
    });
    // The verifier implementation would typically throw on aud mismatch,
    // but belt-and-suspenders we check again in validateCrossServiceAuth.
    const outcome = await validateCrossServiceAuth(
      { 'x-service-auth': 'secret-billing', authorization: 'Bearer tok' },
      baseOptions({ oidcVerifier: verifier }),
    );
    expect(outcome.reason).toBe('wrong_audience');
  });

  it('rejects when verifier throws (invalid token)', async () => {
    const verifier = makeVerifier(new Error('signature fail'));
    const outcome = await validateCrossServiceAuth(
      { 'x-service-auth': 'secret-billing', authorization: 'Bearer tok' },
      baseOptions({ oidcVerifier: verifier }),
    );
    expect(outcome.reason).toBe('invalid_oidc');
  });

  it('rejects when caller SA is not allowlisted', async () => {
    const outcome = await validateCrossServiceAuth(
      { 'x-service-auth': 'secret-billing', authorization: 'Bearer tok' },
      baseOptions({ allowedCallerServiceAccounts: ['other-service@example-project.iam.gserviceaccount.com'] }),
    );
    expect(outcome.reason).toBe('unexpected_caller');
  });

  it('rejects when secret is unconfigured', async () => {
    const outcome = await validateCrossServiceAuth(
      { 'x-service-auth': 'anything', authorization: 'Bearer tok' },
      baseOptions({ secretLookup: async () => null }),
    );
    expect(outcome.reason).toBe('secret_unconfigured');
  });
});

describe('buildCrossServiceHeaders', () => {
  it('returns both X-Service-Auth and Bearer OIDC', async () => {
    const headers = await buildCrossServiceHeaders({
      calleeId: 'billing',
      calleeAudience: 'https://billing-abc.run.app',
      secretLookup: async () => 'secret-billing',
      tokenFactory: { forAudience: async () => 'id-token' },
    });
    expect(headers).toEqual({
      'x-service-auth': 'secret-billing',
      authorization: 'Bearer id-token',
    });
  });

  it('throws when the callee secret is not configured', async () => {
    await expect(
      buildCrossServiceHeaders({
        calleeId: 'billing',
        calleeAudience: 'https://x',
        secretLookup: async () => null,
        tokenFactory: { forAudience: async () => 't' },
      }),
    ).rejects.toThrow(/no secret configured/);
  });
});
