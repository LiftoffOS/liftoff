// The OAuth transactions — unit tests over a scripted client.
//
// What a mocked client can show is the statement SEQUENCE, which is the lock
// order: the tier-1 / tier-3 lock precedes every write it guards, every
// request-path write on a swept table carries its liveness predicate, and
// every outcome branch the routes used to script inline is reproduced here.
// The interleavings themselves are pinned on real Postgres by
// lock-order.integration.test.ts.

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { hashToken } from '../../tenant-members/tokens';
import { LIVE_PREDICATE } from '../grant-lifecycle';
import {
  approveConsentTx,
  approveDeviceCodeTx,
  deprovisionClientTx,
  redeemAuthorizationCodeTx,
  redeemDeviceCodeTx,
  refreshTx,
  revokeTokenTx,
} from '../transactions';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const RESOURCE = 'https://api-test.example.com/mcp';
const CLIENT_ID = 'liftoff_oc_abc123';
const GRANT_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';
const ANCHOR_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function scopedClient(): { client: PoolClient; query: jest.Mock; sqls: () => string[] } {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  return {
    client: { query } as unknown as PoolClient,
    query,
    sqls: () => query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ')),
  };
}

const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const RETIRE_SEQUENCE = [
  "UPDATE oauth_grants SET status = 'revoked'",
  'UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()',
  'UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL AND expires_at > NOW()',
  "UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW() WHERE id = $1 AND status = 'active' AND deleted_at IS NULL",
  'UPDATE person_agent_assignments SET deleted_at = NOW() WHERE agent_id = $1',
];

function expectRetireAt(sqls: string[], index: number): void {
  for (let i = 0; i < RETIRE_SEQUENCE.length; i++) {
    expect(sqls[index + i]).toContain(RETIRE_SEQUENCE[i]);
  }
}

// ── revokeTokenTx ─────────────────────────────────────────────────────

describe('revokeTokenTx', () => {
  const identified = { rows: [{ grant_id: GRANT_ID, mcp_token_id: ANCHOR_ID }] };
  const args = { tokenHash: 'hash', clientId: CLIENT_ID, hint: undefined as string | undefined };

  it('identifies the hinted table first, bound to the presenting client, and answers unidentified with no lock', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await revokeTokenTx(client, { ...args, hint: 'access_token' })).toEqual({ identified: false });
    const s = sqls();
    expect(s).toHaveLength(2);
    expect(s[0]).toContain('FROM oauth_access_tokens t');
    expect(s[1]).toContain('FROM oauth_refresh_tokens t');
    expect(s.every((q) => q.includes('t.token_hash = $1 AND g.client_id = $2'))).toBe(true);
    expect(s.some((q) => q.includes('FOR UPDATE'))).toBe(false);

    query.mockClear();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await revokeTokenTx(client, args);
    expect(sqls()[0]).toContain('FROM oauth_refresh_tokens t');
  });

  it('locks the grant before marking, marks only a live token, and keeps the grant while a live refresh token remains', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce(identified)                              // identify (refresh first)
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] }) // grant FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })               // mark
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });          // a live refresh token remains
    expect(await revokeTokenTx(client, args)).toEqual({ identified: true, retired: false });
    const s = sqls();
    expect(s[1]).toContain('SELECT status, tenant_id FROM oauth_grants WHERE id = $1 FOR UPDATE');
    expect(query.mock.calls[1][1]).toEqual([GRANT_ID]);
    expect(s[2]).toBe('UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()');
    expect(s[3]).toContain("SELECT 1 FROM oauth_refresh_tokens WHERE grant_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > NOW() LIMIT 1");
    expect(s).toHaveLength(4);
  });

  it('retires the family when no live refresh token remains (Muse: access, then refresh)', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce(identified)
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });                           // none live
    expect(await revokeTokenTx(client, { ...args, hint: 'refresh_token' })).toEqual({ identified: true, retired: true });
    const s = sqls();
    expectRetireAt(s, 4);
    expect(query.mock.calls[4][1]).toEqual([GRANT_ID]);
    expect(query.mock.calls[7][1]).toEqual([ANCHOR_ID]);
    expect(s).toHaveLength(9);
  });

  it('an expired presented refresh token marks nothing (rowCount 0) and still runs the decision, which retires', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce(identified)                              // identify has no expiry predicate
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })               // mark misses: expired
      .mockResolvedValueOnce({ rows: [] });                           // no live refresh token
    expect(await revokeTokenTx(client, args)).toEqual({ identified: true, retired: true });
    const s = sqls();
    expect(s[0]).not.toContain('expires_at');
    expectRetireAt(s, 4);
  });

  it('an access token is marked in its own table and the decision reads the refresh table', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [] })                            // refresh table: no
      .mockResolvedValueOnce(identified)                              // access table: yes
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await revokeTokenTx(client, args)).toEqual({ identified: true, retired: false });
    const s = sqls();
    expect(s[3]).toContain('UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE token_hash = $1');
    expect(s[4]).toContain('FROM oauth_refresh_tokens WHERE grant_id = $1');
  });

  it('a grant that is no longer active is marked and not decided on', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce(identified)
      .mockResolvedValueOnce({ rows: [{ status: 'revoked', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await revokeTokenTx(client, args)).toEqual({ identified: true, retired: false });
    expect(sqls()).toHaveLength(3);
  });
});

// ── redeemAuthorizationCodeTx ─────────────────────────────────────────

describe('redeemAuthorizationCodeTx', () => {
  const VERIFIER = 'a'.repeat(43);
  const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');
  const args = { codeHash: 'code-hash', clientId: CLIENT_ID, redirectUri: 'http://localhost:7777/callback', resource: RESOURCE, verifier: VERIFIER };
  const codeRow = (overrides: Record<string, unknown> = {}) => ({
    code_hash: 'code-hash', grant_id: GRANT_ID, tenant_id: TENANT_ID, redirect_uri: args.redirectUri,
    code_challenge: CHALLENGE, resource: RESOURCE, expires_at: future(), used_at: null,
    client_id: CLIENT_ID, grant_status: 'active', ...overrides,
  });

  it('identifies, locks the grant, re-reads under the lock, marks used (live only) and mints', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [codeRow()] });
    const out = await redeemAuthorizationCodeTx(client, args);
    expect('tokens' in out && out.tokens.accessRaw).toMatch(/^liftoff_oat_/);
    const s = sqls();
    expect(s[0]).toBe('SELECT grant_id FROM oauth_authorization_codes WHERE code_hash = $1');
    expect(s[1]).toContain('FROM oauth_grants WHERE id = $1 FOR UPDATE');
    expect(query.mock.calls[1][1]).toEqual([GRANT_ID]);
    expect(s[2]).toContain('FROM oauth_authorization_codes c JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = $1');
    expect(s[2]).not.toContain('FOR UPDATE');
    expect(s[3]).toBe('UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code_hash = $1 AND expires_at > NOW()');
    expect(s[4]).toContain('INSERT INTO oauth_access_tokens');
    expect(s[5]).toContain('INSERT INTO oauth_refresh_tokens');
    expect(query.mock.calls[5][1][3]).toBe(CLIENT_ID);
    expect(s).toHaveLength(6);
  });

  it('an unknown code answers invalid_grant before any lock', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await redeemAuthorizationCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(1);
  });

  // NOW() is the transaction's start and the recheck ran on the application
  // clock: a code that lapsed between the two is not marked, and nothing is
  // minted for it.
  it('a mark that misses (the code lapsed under the lock) answers invalid_grant and mints nothing', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [codeRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await redeemAuthorizationCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(4);
  });

  it.each([
    ['used', { used_at: past() }],
    ['expired', { expires_at: past() }],
    ['another client', { client_id: 'liftoff_oc_other' }],
    ['a retired grant', { grant_status: 'revoked' }],
    ['a redirect_uri mismatch', { redirect_uri: 'http://localhost:1/other' }],
    ['a resource mismatch', { resource: 'https://other.example/mcp' }],
    ['a PKCE mismatch', { code_challenge: 'nope' }],
  ])('the recheck refuses %s with invalid_grant and burns nothing', async (_label, over) => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [codeRow(over)] });
    expect(await redeemAuthorizationCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(3);
  });

  it('a code gone by the re-read answers what the recheck says', async () => {
    const { client, query } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await redeemAuthorizationCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
  });
});

// ── refreshTx ─────────────────────────────────────────────────────────

describe('refreshTx', () => {
  const args = { tokenHash: 'refresh-hash', clientId: CLIENT_ID, resource: RESOURCE };
  const refreshRow = (overrides: Record<string, unknown> = {}) => ({
    token_hash: 'refresh-hash', grant_id: GRANT_ID, tenant_id: TENANT_ID, client_id: CLIENT_ID, resource: RESOURCE,
    expires_at: future(), rotated_at: null, revoked_at: null, grant_status: 'active', mcp_token_id: ANCHOR_ID, ...overrides,
  });

  it('rotates: identify, lock, re-read, tombstone the presented (live) row naming its successor, insert the pair', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [refreshRow()] });
    const out = await refreshTx(client, args);
    expect('tokens' in out && out.tokens.refreshRaw).toMatch(/^liftoff_ort_/);
    const s = sqls();
    expect(s[0]).toBe('SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = $1');
    expect(s[1]).toContain('FROM oauth_grants WHERE id = $1 FOR UPDATE');
    expect(s[2]).toContain('FROM oauth_refresh_tokens rt JOIN oauth_grants g ON g.id = rt.grant_id WHERE rt.token_hash = $1');
    expect(s[2]).not.toContain('FOR UPDATE');
    expect(s[3]).toBe('UPDATE oauth_refresh_tokens SET rotated_at = NOW(), replaced_by_hash = $2 WHERE token_hash = $1 AND expires_at > NOW()');
    expect(query.mock.calls[3][1][0]).toBe('refresh-hash');
    expect(query.mock.calls[3][1][1]).toBe(hashToken((out as { tokens: { refreshRaw: string } }).tokens.refreshRaw));
    expect(s[4]).toContain('INSERT INTO oauth_access_tokens');
    expect(s[5]).toContain('INSERT INTO oauth_refresh_tokens');
    // The successor row is the one the tombstone names.
    expect(query.mock.calls[5][1][0]).toBe(query.mock.calls[3][1][1]);
    expect(s).toHaveLength(6);
  });

  it('a tombstone that misses (the token lapsed under the lock) answers invalid_grant and mints nothing', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [refreshRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await refreshTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(4);
  });

  it('grace-window reuse (concurrent loser) answers invalid_grant with NO revocation', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [refreshRow({ rotated_at: new Date(Date.now() - 5_000).toISOString() })] });
    expect(await refreshTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(3);
  });

  it('stale replay retires the ENTIRE family under the grant lock (grant + tokens + anchor + assignment)', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [refreshRow({ rotated_at: new Date(Date.now() - 120_000).toISOString() })] });
    expect(await refreshTx(client, args)).toEqual({ theft: true });
    const s = sqls();
    expectRetireAt(s, 3);
    expect(query.mock.calls[3][1]).toEqual([GRANT_ID]);
    expect(query.mock.calls[6][1]).toEqual([ANCHOR_ID]);
    expect(s).toHaveLength(8);
  });

  it.each([
    ['revoked', { revoked_at: past() }],
    ['expired', { expires_at: past() }],
    ['another client', { client_id: 'liftoff_oc_other' }],
    ['a resource mismatch', { resource: 'https://other.example/mcp' }],
    ['a retired grant', { grant_status: 'revoked' }],
  ])('the recheck refuses %s with invalid_grant and writes nothing', async (_label, over) => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [refreshRow(over)] });
    expect(await refreshTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(3);
  });

  it('an unknown token answers invalid_grant before any lock', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await refreshTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(1);
  });
});

// ── redeemDeviceCodeTx ────────────────────────────────────────────────

describe('redeemDeviceCodeTx', () => {
  const args = { deviceCodeHash: 'device-hash', clientId: CLIENT_ID };
  const deviceRow = (overrides: Record<string, unknown> = {}) => ({
    device_code_hash: 'device-hash', client_id: CLIENT_ID, status: 'pending', grant_id: null, resource: RESOURCE,
    expires_at: future(), interval_seconds: 5, last_polled_at: null, grant_types: ['refresh_token', DEVICE_GRANT], ...overrides,
  });

  it('a pending code: identify, lock the device row (tier 2), stamp the poll (live only), authorization_pending', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [deviceRow()] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'authorization_pending' });
    const s = sqls();
    expect(s[0]).toBe('SELECT status, grant_id FROM oauth_device_codes WHERE device_code_hash = $1');
    expect(s[1]).toContain('JOIN oauth_clients c ON c.client_id = d.client_id WHERE d.device_code_hash = $1 AND d.expires_at > NOW() FOR UPDATE OF d');
    expect(s[2]).toBe('UPDATE oauth_device_codes SET last_polled_at = NOW() WHERE device_code_hash = $1 AND expires_at > NOW()');
    expect(s).toHaveLength(3);
    expect(s.some((q) => q.includes('oauth_grants'))).toBe(false);
  });

  it('an approved code: identify, lock the GRANT (tier 3), re-read the code without a lock of its own, mint, consume', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'approved', grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'approved', grant_id: GRANT_ID })] });
    const out = await redeemDeviceCodeTx(client, args);
    expect('tokens' in out && out.tokens.accessRaw).toMatch(/^liftoff_oat_/);
    const s = sqls();
    expect(s[1]).toContain('FROM oauth_grants WHERE id = $1 FOR UPDATE');
    expect(query.mock.calls[1][1]).toEqual([GRANT_ID]);
    expect(s[2]).toContain('WHERE d.device_code_hash = $1');
    expect(s[2]).not.toContain('FOR UPDATE');
    expect(s[3]).toContain('SET last_polled_at = NOW() WHERE device_code_hash = $1 AND expires_at > NOW()');
    expect(s[4]).toBe("UPDATE oauth_device_codes SET status = 'consumed' WHERE device_code_hash = $1 AND expires_at > NOW()");
    expect(s[5]).toContain('INSERT INTO oauth_access_tokens');
    expect(query.mock.calls[5][1][2]).toBe(TENANT_ID);
    expect(s[6]).toContain('INSERT INTO oauth_refresh_tokens');
    expect(s).toHaveLength(7);
  });

  it('a consume that misses (the code lapsed under the lock) answers expired_token and mints nothing', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'approved', grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'approved', grant_id: GRANT_ID })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // poll stamp
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // consume misses
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'expired_token' });
    expect(sqls().some((q) => q.startsWith('INSERT'))).toBe(false);
  });

  // The code changed tier at approval: a poll that identified it as pending
  // and locked it afterwards holds a row the grant now owns. It never climbs
  // to the grant (that is the deadlock lock-order.integration.test.ts case 10
  // reproduces); it stamps the poll and answers pending, and the tool's next
  // poll takes the grant path.
  it('a code approved between the identify and the row lock is answered authorization_pending under the row lock, and the grant is never locked after the row', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'approved', grant_id: GRANT_ID })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'authorization_pending' });
    const s = sqls();
    expect(s[1]).toContain('FOR UPDATE OF d');
    expect(s[2]).toBe('UPDATE oauth_device_codes SET last_polled_at = NOW() WHERE device_code_hash = $1 AND expires_at > NOW()');
    expect(s).toHaveLength(3);
    expect(s.some((q) => q.includes('FROM oauth_grants'))).toBe(false);
    expect(s.some((q) => q.startsWith('INSERT'))).toBe(false);
  });

  it('an expired code answers expired_token with NO write, even when approved', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'approved', grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'active', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'approved', grant_id: GRANT_ID, expires_at: past(), last_polled_at: new Date(Date.now() - 1000).toISOString() })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'expired_token' });
    expect(sqls().some((q) => q.startsWith('UPDATE') || q.startsWith('INSERT'))).toBe(false);
  });

  it('a consumed-and-expired code still answers invalid_grant (consumed is checked first)', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'consumed', grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [] })   // the live-only lock misses a dead row
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'consumed', grant_id: GRANT_ID, expires_at: past() })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls().some((q) => q.includes('UPDATE oauth_device_codes'))).toBe(false);
  });

  // A pending code dead for an hour is what the sweep deletes; a lock on it
  // would wait on the sweep (and the sweep on it). The tier-2 lock takes a
  // live row only; a dead one is re-read without a lock and answered.
  it('an expired pending code is never locked: the live-only lock misses, the lock-free re-read answers expired_token, nothing written', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [deviceRow({ expires_at: past() })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'expired_token' });
    const s = sqls();
    expect(s[1]).toContain('AND d.expires_at > NOW() FOR UPDATE OF d');
    expect(s[2]).toContain('WHERE d.device_code_hash = $1');
    expect(s[2]).not.toContain('FOR UPDATE');
    expect(s).toHaveLength(3);
  });

  it('answers slow_down and grows the interval by five seconds when polled inside the interval', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ last_polled_at: new Date(Date.now() - 1000).toISOString() })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'slow_down' });
    expect(sqls()[2]).toBe('UPDATE oauth_device_codes SET last_polled_at = NOW(), interval_seconds = interval_seconds + 5 WHERE device_code_hash = $1 AND expires_at > NOW()');
  });

  it('answers access_denied for a denied code, after the poll stamp', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'denied', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'denied' })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'access_denied' });
    expect(sqls()[2]).toContain('SET last_polled_at = NOW()');
  });

  it('refuses a code of another client and a client not registered for the device grant, before any write', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ client_id: 'liftoff_oc_other' })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(2);

    query.mockClear();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'pending', grant_id: null }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ grant_types: ['authorization_code', 'refresh_token'] })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'unauthorized_client' });
    expect(sqls()).toHaveLength(2);
  });

  it('refuses an approved code whose grant was retired meanwhile, and an unknown code before any lock', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ status: 'approved', grant_id: GRANT_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'revoked', tenant_id: TENANT_ID }] })
      .mockResolvedValueOnce({ rows: [deviceRow({ status: 'approved', grant_id: GRANT_ID })] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls().some((q) => q.includes('INSERT INTO oauth_access_tokens'))).toBe(false);

    query.mockClear();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await redeemDeviceCodeTx(client, args)).toEqual({ error: 'invalid_grant' });
    expect(sqls()).toHaveLength(1);
  });
});

// ── approveConsentTx ──────────────────────────────────────────────────

describe('approveConsentTx', () => {
  const subject = { tenantId: TENANT_ID, accountId: ACCOUNT_ID, clientId: CLIENT_ID, clientName: 'Codex', resource: RESOURCE };
  const args = { subject, codeHash: 'code-hash', redirectUri: 'http://localhost:1/cb', codeChallenge: 'c', resource: RESOURCE, expiresAt: new Date(0) };

  it('runs ensureGrant (tier 1, then tier 3) and inserts the code under the grant lock', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })                                  // client FOR SHARE
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID, mcp_token_id: ANCHOR_ID, anchor_status: 'active', anchor_deleted_at: null, anchor_expires_at: future() }] }); // grant FOR UPDATE OF g
    expect(await approveConsentTx(client, args)).toBe(GRANT_ID);
    const s = sqls();
    expect(s[0]).toBe('SELECT deleted_at FROM oauth_clients WHERE client_id = $1 FOR SHARE');
    expect(s[1]).toContain('FOR UPDATE OF g');
    expect(s[2]).toContain('INSERT INTO oauth_authorization_codes');
    expect(query.mock.calls[2][1]).toEqual(['code-hash', GRANT_ID, TENANT_ID, 'http://localhost:1/cb', 'c', RESOURCE, new Date(0)]);
    expect(s).toHaveLength(3);
  });

  it('answers null with nothing else issued when the client has been deprovisioned', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [{ deleted_at: past() }] });
    expect(await approveConsentTx(client, args)).toBeNull();
    expect(sqls()).toHaveLength(1);
  });
});

// ── approveDeviceCodeTx ───────────────────────────────────────────────

describe('approveDeviceCodeTx', () => {
  const args = { userCode: 'DMCD-XKPT', tenantId: TENANT_ID, accountId: ACCOUNT_ID };
  const CLAIMED = { device_code_hash: 'hash-1', client_id: CLIENT_ID, client_name: 'Codex', resource: RESOURCE };

  it('reads the client lock-free, holds it FOR SHARE (tier 1), locks the pending code (tier 2), ensureGrant (tier 3), flips the code', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT_ID }] })     // lock-free read
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })            // tier 1
      .mockResolvedValueOnce({ rows: [CLAIMED] })                      // tier 2
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })         // ensureGrant tier 1 (no-op re-lock)
      .mockResolvedValueOnce({ rows: [] })                             // ensureGrant tier 3: none
      .mockResolvedValueOnce({ rows: [{ id: ANCHOR_ID }] })            // anchor
      .mockResolvedValueOnce({ rows: [] })                             // assignment
      .mockResolvedValueOnce({ rows: [{ id: GRANT_ID }] })             // grant
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                // flip
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] });            // workspace
    expect(await approveDeviceCodeTx(client, args)).toEqual({ clientName: 'Codex', resource: RESOURCE, workspaceName: 'Acme' });
    const s = sqls();
    expect(s[0]).toBe("SELECT client_id FROM oauth_device_codes WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()");
    expect(s[1]).toBe('SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL FOR SHARE');
    expect(query.mock.calls[1][1]).toEqual([CLIENT_ID]);
    expect(s[2]).toContain("WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW() FOR UPDATE");
    expect(s[3]).toContain('FROM oauth_clients WHERE client_id = $1 FOR SHARE');
    expect(s[4]).toContain('FOR UPDATE OF g');
    expect(s[7]).toContain('INSERT INTO oauth_grants');
    expect(s[8]).toBe("UPDATE oauth_device_codes SET status = 'approved', grant_id = $2 WHERE device_code_hash = $1 AND expires_at > NOW()");
    expect(query.mock.calls[8][1]).toEqual(['hash-1', GRANT_ID]);
  });

  it('answers null when no pending code is live, before any lock', async () => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce({ rows: [] });
    expect(await approveDeviceCodeTx(client, args)).toBeNull();
    expect(sqls()).toHaveLength(1);
  });

  it('answers null when the client is deprovisioned, before the code lock', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT_ID }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await approveDeviceCodeTx(client, args)).toBeNull();
    expect(sqls()).toHaveLength(2);
  });

  it('answers null when the locked code is gone or belongs to a client other than the one held', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await approveDeviceCodeTx(client, args)).toBeNull();
    expect(sqls()).toHaveLength(3);

    query.mockClear();
    query
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ ...CLAIMED, client_id: 'liftoff_oc_other' }] });
    expect(await approveDeviceCodeTx(client, args)).toBeNull();
    expect(sqls()).toHaveLength(3);
  });

  it('a flip that misses (the code lapsed under the lock) answers null; the grant stays for the next approval to reuse', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [CLAIMED] })
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ grant_id: GRANT_ID, mcp_token_id: ANCHOR_ID, anchor_status: 'active', anchor_deleted_at: null, anchor_expires_at: future() }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // flip misses
    expect(await approveDeviceCodeTx(client, args)).toBeNull();
    const s = sqls();
    expect(s[5]).toContain("SET status = 'approved'");
    expect(s).toHaveLength(6);
  });

  it('answers null when ensureGrant finds the client deleted, without flipping the code', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [CLAIMED] })
      .mockResolvedValueOnce({ rows: [{ deleted_at: past() }] });
    expect(await approveDeviceCodeTx(client, args)).toBeNull();
    expect(sqls().some((q) => q.includes("SET status = 'approved'"))).toBe(false);
  });
});

// ── deprovisionClientTx ───────────────────────────────────────────────

describe('deprovisionClientTx', () => {
  const RAW = 'liftoff_rat_secret';
  const HASH = hashToken(RAW);
  const args = { clientId: CLIENT_ID, bearerHash: HASH };

  it('deprovisions in ascending tiers: client FOR UPDATE → pending rows → grants in id order → soft-delete', async () => {
    const { client, query, sqls } = scopedClient();
    query
      .mockResolvedValueOnce({ rows: [{ registration_access_token_hash: HASH }] })   // tier 1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                               // requests
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                               // device codes
      .mockResolvedValueOnce({ rows: [{ id: 'g1', mcp_token_id: 'a1' }, { id: 'g2', mcp_token_id: 'a2' }] }); // tier 3
    expect(await deprovisionClientTx(client, args)).toEqual({ authorized: true, grants: 2 });
    const s = sqls();
    expect(s[0]).toBe("SELECT registration_access_token_hash FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL AND client_type = 'dcr' FOR UPDATE");
    expect(s[1]).toBe(`UPDATE oauth_authorization_requests r SET consumed_at = NOW() WHERE r.client_id = $1 AND r.consumed_at IS NULL AND ${LIVE_PREDICATE}`);
    expect(s[2]).toBe("UPDATE oauth_device_codes SET status = 'denied' WHERE client_id = $1 AND status = 'pending' AND expires_at > NOW()");
    expect(s[3]).toBe("SELECT id, mcp_token_id FROM oauth_grants WHERE client_id = $1 AND status = 'active' ORDER BY id FOR UPDATE");
    expectRetireAt(s, 4);
    expect(query.mock.calls[4][1]).toEqual(['g1']);
    expect(query.mock.calls[7][1]).toEqual(['a1']);
    expectRetireAt(s, 9);
    expect(query.mock.calls[9][1]).toEqual(['g2']);
    expect(s[14]).toBe('UPDATE oauth_clients SET deleted_at = NOW(), registration_access_token_hash = NULL WHERE client_id = $1');
    expect(s).toHaveLength(15);
    for (const c of query.mock.calls) expect(c[1][0]).toBeDefined();
  });

  it.each([
    ['no such live DCR client', { rows: [] }],
    ['a NULL hash (registered before RFC 7592 existed)', { rows: [{ registration_access_token_hash: null }] }],
    ['a wrong token', { rows: [{ registration_access_token_hash: hashToken('liftoff_rat_other') }] }],
    ['a hash of another length', { rows: [{ registration_access_token_hash: 'short' }] }],
  ])('refuses %s with nothing written and no retire statement', async (_label, tier1) => {
    const { client, query, sqls } = scopedClient();
    query.mockResolvedValueOnce(tier1);
    expect(await deprovisionClientTx(client, args)).toEqual({ authorized: false });
    const s = sqls();
    expect(s).toHaveLength(1);
    expect(s[0]).toContain('FOR UPDATE');
  });
});
