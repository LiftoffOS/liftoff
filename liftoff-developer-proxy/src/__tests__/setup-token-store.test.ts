// Tests for the Postgres-backed setup-token store (credentials/service.ts).
// The store replaced a process-local Map so create/pending/bind/exchange survive
// deploys and work across instances. These tests mock the pool and assert the
// SQL contract: one-time-use exchange (DELETE ... RETURNING), TTL rejection,
// PKCE verification, and the latest-per-user pending lookup.

import { jest } from '@jest/globals';

interface QueryCall { sql: string; params: unknown[] }
let calls: QueryCall[] = [];
// Programmable per-call result queue; each query shifts the next result.
let results: Array<{ rows: unknown[]; rowCount: number }> = [];

jest.unstable_mockModule('../infrastructure/database.js', () => ({
  getPool: jest.fn(async () => ({
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return results.shift() ?? { rows: [], rowCount: 0 };
    }),
  })),
  closePool: jest.fn(),
  withByokTenant: jest.fn(),
  withByokUser: jest.fn(),
}));

const service = await import('../credentials/service.js');

beforeEach(() => {
  calls = [];
  results = [];
});

describe('getPendingSetupToken', () => {
  it('returns the latest unexpired token and sweeps expired rows', async () => {
    results = [
      { rows: [], rowCount: 0 }, // best-effort sweep DELETE
      { rows: [{ setup_token: 'tok_latest' }], rowCount: 1 }, // SELECT
    ];
    const token = await service.getPendingSetupToken('11111111-1111-1111-1111-111111111111', 'user-1');
    expect(token).toBe('tok_latest');
    expect(calls[0].sql).toMatch(/DELETE FROM developer_proxy_setup_tokens WHERE expires_at <= NOW\(\)/);
    expect(calls[1].sql).toMatch(/expires_at > NOW\(\)/);
    expect(calls[1].sql).toMatch(/ORDER BY created_at DESC/);
    expect(calls[1].params).toEqual(['11111111-1111-1111-1111-111111111111', 'user-1']);
  });

  it('returns null when no unexpired token exists', async () => {
    results = [{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }];
    expect(await service.getPendingSetupToken('t', 'u')).toBeNull();
  });
});

describe('exchangeSetupToken', () => {
  it('consumes the token exactly once via DELETE ... RETURNING and returns the key', async () => {
    results = [{
      rows: [{ full_key: 'liftoff_sk_abc', proxy_base_url: 'https://api.example.com/proxy', code_challenge: null, expired: false }],
      rowCount: 1,
    }];
    const out = await service.exchangeSetupToken('tok');
    expect(out).toEqual({ fullKey: 'liftoff_sk_abc', proxyBaseUrl: 'https://api.example.com/proxy' });
    expect(calls[0].sql).toMatch(/DELETE FROM developer_proxy_setup_tokens/);
    expect(calls[0].sql).toMatch(/RETURNING/);
  });

  it('returns null for an unknown token', async () => {
    results = [{ rows: [], rowCount: 0 }];
    expect(await service.exchangeSetupToken('missing')).toBeNull();
  });

  it('rejects an expired token even though the row was returned', async () => {
    results = [{
      rows: [{ full_key: 'k', proxy_base_url: 'u', code_challenge: null, expired: true }],
      rowCount: 1,
    }];
    expect(await service.exchangeSetupToken('tok')).toBeNull();
  });

  it('enforces PKCE when a code_challenge is bound', async () => {
    const codeVerifier = 'verifier-123';
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
    // Correct verifier passes.
    results = [{ rows: [{ full_key: 'k', proxy_base_url: 'u', code_challenge: challenge, expired: false }], rowCount: 1 }];
    expect(await service.exchangeSetupToken('tok', codeVerifier)).toEqual({ fullKey: 'k', proxyBaseUrl: 'u' });
    // Wrong verifier fails.
    results = [{ rows: [{ full_key: 'k', proxy_base_url: 'u', code_challenge: challenge, expired: false }], rowCount: 1 }];
    expect(await service.exchangeSetupToken('tok', 'wrong')).toBeNull();
    // Missing verifier fails.
    results = [{ rows: [{ full_key: 'k', proxy_base_url: 'u', code_challenge: challenge, expired: false }], rowCount: 1 }];
    expect(await service.exchangeSetupToken('tok')).toBeNull();
  });
});

describe('bindCodeChallenge', () => {
  it('binds when an unexpired row is updated', async () => {
    results = [{ rows: [], rowCount: 1 }];
    expect(await service.bindCodeChallenge('tok', 'challenge')).toBe(true);
    expect(calls[0].sql).toMatch(/UPDATE developer_proxy_setup_tokens/);
    expect(calls[0].sql).toMatch(/expires_at > NOW\(\)/);
  });

  it('returns false when no row matched (expired or missing)', async () => {
    results = [{ rows: [], rowCount: 0 }];
    expect(await service.bindCodeChallenge('tok', 'challenge')).toBe(false);
  });
});
