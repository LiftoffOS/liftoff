import {
  extractBearerToken,
  verifyGoogleOidcToken,
  setOidcVerifierClientForTests,
  resetOidcVerifierClientForTests,
} from '../oidc-verifier';

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    ['BEARER   abc  ', 'abc'],
    ['Bearer\tabc', 'abc'],
  ])('extracts %p', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });

  it.each([
    [undefined],
    [''],
    ['abc.def'],
    ['Basic dXNlcjpwYXNz'],
    ['Bearer '],
    ['Bearer    '],
  ])('rejects %p', (header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('verifyGoogleOidcToken', () => {
  afterEach(() => {
    resetOidcVerifierClientForTests();
  });

  // Minimal OAuth2Client test-double: only the methods the verifier calls.
  function makeStubClient(verifyImpl: (opts: { idToken: string; audience: unknown }) => Promise<{ getPayload(): unknown }>) {
    return { verifyIdToken: verifyImpl } as unknown as Parameters<typeof setOidcVerifierClientForTests>[0];
  }

  it('accepts a token signed for the expected audience and allowed email', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com',
          email_verified: true,
          aud: 'https://tool-gateway-service-xxxx-uw.a.run.app',
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      })),
    );

    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'https://tool-gateway-service-xxxx-uw.a.run.app',
      allowedEmails: ['YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com'],
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a token whose email is not in the allow-list', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'other-sa@example-project.iam.gserviceaccount.com',
          email_verified: true,
        }),
      })),
    );

    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'https://tool-gateway-service-xxxx-uw.a.run.app',
      allowedEmails: ['YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com'],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'oidc_email_not_allowed: other-sa@example-project.iam.gserviceaccount.com',
    });
  });

  it('rejects a token with unverified email by default', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com',
          email_verified: false,
        }),
      })),
    );

    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'aud',
      allowedEmails: ['YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com'],
    });

    expect(result).toEqual({ ok: false, reason: 'oidc_email_not_verified' });
  });

  it('rejects a token with an unexpected issuer', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'https://some-other-idp.com',
          email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com',
          email_verified: true,
        }),
      })),
    );

    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'aud',
      allowedEmails: ['YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/oidc_unexpected_issuer/);
    }
  });

  it('returns a reason string when verifyIdToken throws (bad signature, etc.)', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => {
        throw new Error('Invalid token signature');
      }),
    );

    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'aud',
      allowedEmails: ['a@b.com'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/oidc_verify_failed.*Invalid token signature/);
    }
  });

  it('returns a reason string when the payload is empty', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({ getPayload: () => null })),
    );

    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'aud',
      allowedEmails: ['a@b.com'],
    });

    expect(result).toEqual({ ok: false, reason: 'oidc_payload_missing' });
  });

  it('accepts accounts.google.com (non-https) issuer', async () => {
    setOidcVerifierClientForTests(
      makeStubClient(async () => ({
        getPayload: () => ({
          iss: 'accounts.google.com',
          email: 'a@b.com',
          email_verified: true,
        }),
      })),
    );
    const result = await verifyGoogleOidcToken('fake-jwt', {
      audience: 'aud',
      allowedEmails: ['a@b.com'],
    });
    expect(result.ok).toBe(true);
  });
});
