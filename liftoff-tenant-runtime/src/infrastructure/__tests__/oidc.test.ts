import { jest } from '@jest/globals';

// The shared OIDC verifier delegates to OAuth2Client.verifyIdToken. We mock
// that single API so the SA-allowlist matrix is exercised deterministically
// without real Google key fetches.

const verifyIdTokenMock = jest.fn<(req: { idToken: string; audience: string }) => Promise<{ getPayload: () => { iss: string; email: string } | null }>>();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: verifyIdTokenMock,
  })),
}));

jest.mock('../logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../runtime-env', () => ({
  getTenantRuntimeUrl: () => 'https://tr.example',
}));

import type { Request } from 'express';
import { verifyOidcToken } from '../oidc';

function reqWith(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

function mockPayload(payload: { iss: string; email: string } | null) {
  verifyIdTokenMock.mockResolvedValueOnce({ getPayload: () => payload });
}

beforeEach(() => {
  verifyIdTokenMock.mockReset();
});

describe('verifyOidcToken', () => {
  it('rejects when authorization header missing', async () => {
    const res = await verifyOidcToken({ headers: {} } as Request);
    expect(res).toBe(false);
  });

  it('rejects when authorization header is not Bearer', async () => {
    const res = await verifyOidcToken({ headers: { authorization: 'Basic xxx' } } as unknown as Request);
    expect(res).toBe(false);
  });

  it('rejects when payload is null', async () => {
    mockPayload(null);
    const res = await verifyOidcToken(reqWith('tok'));
    expect(res).toBe(false);
  });

  it('rejects when issuer is not Google', async () => {
    mockPayload({ iss: 'https://evil.example', email: 'whatever@example.com' });
    const res = await verifyOidcToken(reqWith('tok'));
    expect(res).toBe(false);
  });

  it('accepts when issuer is accounts.google.com and no allowlist', async () => {
    mockPayload({ iss: 'https://accounts.google.com', email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com' });
    const res = await verifyOidcToken(reqWith('tok'));
    expect(res).toBe(true);
  });

  it('accepts when SA matches the allowlist', async () => {
    mockPayload({ iss: 'accounts.google.com', email: 'allowed-sa@example-project.iam.gserviceaccount.com' });
    const res = await verifyOidcToken(reqWith('tok'), {
      allowedServiceAccounts: ['allowed-sa@example-project.iam.gserviceaccount.com', 'second-sa@example-project.iam.gserviceaccount.com'],
    });
    expect(res).toBe(true);
  });

  it('rejects when SA is not in the allowlist (no dev bypass)', async () => {
    mockPayload({ iss: 'accounts.google.com', email: 'other-sa@example-project.iam.gserviceaccount.com' });
    const res = await verifyOidcToken(reqWith('tok'), {
      allowedServiceAccounts: ['allowed-sa@example-project.iam.gserviceaccount.com'],
    });
    expect(res).toBe(false);
  });

  it('allows mismatched SA when allowDevBypass is true', async () => {
    mockPayload({ iss: 'accounts.google.com', email: 'other-sa@example-project.iam.gserviceaccount.com' });
    const res = await verifyOidcToken(reqWith('tok'), {
      allowedServiceAccounts: ['allowed-sa@example-project.iam.gserviceaccount.com'],
      allowDevBypass: true,
    });
    expect(res).toBe(true);
  });

  it('falls through to issuer-only when allowedServiceAccounts is empty after filter', async () => {
    // All entries are undefined/null/empty → filtered list is empty → no SA check.
    mockPayload({ iss: 'accounts.google.com', email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com' });
    const res = await verifyOidcToken(reqWith('tok'), {
      allowedServiceAccounts: [undefined, null, ''],
    });
    expect(res).toBe(true);
  });

  it('falls through to issuer-only when allowedServiceAccounts is omitted entirely', async () => {
    mockPayload({ iss: 'accounts.google.com', email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com' });
    const res = await verifyOidcToken(reqWith('tok'));
    expect(res).toBe(true);
  });

  it('rejects when verifyIdToken throws (e.g. expired token)', async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error('Token used too late'));
    const res = await verifyOidcToken(reqWith('tok'));
    expect(res).toBe(false);
  });
});
