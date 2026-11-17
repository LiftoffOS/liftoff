import { hashCanonicalJson } from './idempotency.js';

describe('hashCanonicalJson', () => {
  it('returns a stable hex sha256 for the same input', () => {
    const a = hashCanonicalJson({ x: 1, y: 'z' });
    const b = hashCanonicalJson({ x: 1, y: 'z' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(hashCanonicalJson({ x: 1 })).not.toBe(hashCanonicalJson({ x: 2 }));
  });

  it('handles undefined as empty string', () => {
    expect(hashCanonicalJson(undefined)).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ── The claim ────────────────────────────────────────────────────────────────
//
// Two properties the interceptor depends on. The hash covers what a request
// ASKS FOR, so a retry that carries a fresh trace id is the same request. And
// the row is the claim: whoever inserts it executes, and a concurrent miss is
// told to stand down rather than run the vendor call a second time.

const mockQuery = jest.fn();
jest.mock('../db/pool.js', () => ({
  getPool: async () => ({ query: (...a: unknown[]) => mockQuery(...a) }),
}));

import { hashSemanticRequest, claimIdempotency, completeIdempotency, releaseIdempotency } from './idempotency.js';

describe('hashSemanticRequest', () => {
  const base = { connectorId: 'c1', functionName: 'send_email', input: { to: 'a@x.com', subject: 's' } };

  it('ignores the trace id and the key itself, so a retry hashes the same', () => {
    const first = hashSemanticRequest({ ...base, traceId: 'trace-1', idempotencyKey: 'k' });
    const retry = hashSemanticRequest({ ...base, traceId: 'trace-2', idempotencyKey: 'k' });
    expect(first).toBe(retry);
  });

  it('does not depend on key order', () => {
    expect(hashSemanticRequest({ b: 1, a: { d: 2, c: 3 } })).toBe(hashSemanticRequest({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('still tells two requests apart', () => {
    expect(hashSemanticRequest(base)).not.toBe(hashSemanticRequest({ ...base, input: { ...base.input, subject: 'other' } }));
  });

  it('only strips tracing at the top level — a nested field of that name is content', () => {
    expect(hashSemanticRequest({ input: { traceId: 'x' } })).not.toBe(hashSemanticRequest({ input: { traceId: 'y' } }));
  });
});

describe('claimIdempotency', () => {
  const identity = { tenantId: 't1', userId: null, rpcName: 'Execute', key: 'cap:inv:op:args', requestHash: 'h1' };
  const row = (over: Record<string, unknown> = {}) => ({
    request_hash: 'h1', response_status: null, response_body: null, response_headers: null,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(), ...over,
  });

  beforeEach(() => { jest.clearAllMocks(); });

  it('the first caller owns the key with one INSERT and no lock held', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'i1' }] });
    await expect(claimIdempotency(identity)).resolves.toEqual({ kind: 'owned' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT (tenant_id, key, rpc_name) DO NOTHING');
    expect(mockQuery.mock.calls[0][0]).not.toContain('pg_advisory');
  });

  it('an answered key with the same request replays the stored response', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({ response_status: 200, response_body: { success: true, output: { id: 'm1' } } })] });
    await expect(claimIdempotency(identity)).resolves.toEqual({
      kind: 'match', responseStatus: 200, responseBody: { success: true, output: { id: 'm1' } }, responseHeaders: undefined,
    });
  });

  it('an answered key with a different request is a conflict', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({ request_hash: 'other', response_status: 200 })] });
    await expect(claimIdempotency(identity)).resolves.toEqual({ kind: 'conflict' });
  });

  it('a fresh claim held by someone else is in flight — the second caller does not run', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row()] });
    await expect(claimIdempotency(identity)).resolves.toEqual({ kind: 'in_flight' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('a claim past the in-flight window is taken over, conditionally', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({ created_at: new Date(Date.now() - 11 * 60_000).toISOString() })] })
      .mockResolvedValueOnce({ rows: [{ id: 'i1' }] });
    await expect(claimIdempotency(identity)).resolves.toEqual({ kind: 'owned' });
    expect(mockQuery.mock.calls[2][0]).toContain('response_status IS NULL');
    expect(mockQuery.mock.calls[2][0]).toContain("created_at < NOW()");
  });

  it('a stale claim two takers race for: the loser re-reads and stands down', async () => {
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row({ created_at: stale })] })
      .mockResolvedValueOnce({ rows: [] })            // UPDATE lost
      .mockResolvedValueOnce({ rows: [row()] });      // now fresh: the winner's
    await expect(claimIdempotency(identity)).resolves.toEqual({ kind: 'in_flight' });
  });

  it('completion records the response on the owned row only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await completeIdempotency({ ...identity, responseStatus: 200, responseBody: { ok: true } });
    expect(mockQuery.mock.calls[0][0]).toContain('response_status IS NULL');
    expect(mockQuery.mock.calls[0][1]).toEqual(['t1', 'cap:inv:op:args', 'Execute', 200, JSON.stringify({ ok: true }), null]);
  });

  it('release gives an unanswered claim back so a retry can run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await releaseIdempotency(identity);
    expect(mockQuery.mock.calls[0][0]).toContain('DELETE FROM idempotency_keys');
    expect(mockQuery.mock.calls[0][0]).toContain('response_status IS NULL');
  });
});
