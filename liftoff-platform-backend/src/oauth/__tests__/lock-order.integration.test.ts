// The lock discipline, on real Postgres (INV-PB-014).
//
// A mocked client can show the statement sequence; only Postgres can show
// what two transactions do to each other. These run the REAL transaction
// functions on two or more connections against the migrated test database,
// with explicit BEGIN / COMMIT, and pin the interleavings the reviews named:
// the ascending tiers (client → pending rows → grant), the id-ordered
// multi-row grant lock, and the live/dead split between the request paths
// and the sweep.
//
// Stepwise cases start A through its real function without committing, start
// B, assert B is still pending after 300 ms, commit A, await B, commit B, and
// assert the final rows. The ring and the sweep cases run with real
// concurrency, twenty iterations on fresh seeds.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npm run test:integration -- src/oauth
//
// CI does not run the integration config; this file runs locally before a
// commit that touches these paths (docs/invariants.md, INV-PB-014).

import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { hashToken } from '../../tenant-members/tokens';
import { LIVE_PREDICATE, retireGrantFamily } from '../grant-lifecycle';
import {
  approveDeviceCodeTx,
  deprovisionClientTx,
  redeemAuthorizationCodeTx,
  redeemDeviceCodeTx,
  refreshTx,
  revokeTokenTx,
} from '../transactions';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const RESOURCE = 'https://api-test.example.com/mcp';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REDIRECT_URI = 'http://localhost:7777/callback';
const VERIFIER = 'a'.repeat(43);
const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');
const PENDING_WINDOW_MS = 300;

// The two pending-row inserts, as the routes issue them (pinned there by
// authorization-server-router.test.ts and device-router.test.ts).
const AUTHORIZE_INSERT = `INSERT INTO oauth_authorization_requests
     (request_id, client_id, redirect_uri, state, code_challenge, resource, scope)
   SELECT $1, c.client_id, $3, $4, $5, $6, 'mcp'
   FROM oauth_clients c WHERE c.client_id = $2 AND c.deleted_at IS NULL FOR SHARE`;
const DEVICE_AUTHORIZATION_INSERT = `INSERT INTO oauth_device_codes
     (device_code_hash, user_code, client_id, client_name, scope, resource, interval_seconds, expires_at)
   SELECT $1, $2, c.client_id, c.client_name, 'mcp', $4, $5, NOW() + ($6::int * INTERVAL '1 second')
   FROM oauth_clients c WHERE c.client_id = $3 AND c.deleted_at IS NULL FOR SHARE`;
// The consent park (consent-router.ts parkRequest).
const PARK_UPDATE = `UPDATE oauth_authorization_requests r
   SET parked_for_onboarding_at = COALESCE(r.parked_for_onboarding_at, NOW())
   WHERE r.request_id = $1 AND r.consumed_at IS NULL AND ${LIVE_PREDICATE}
   RETURNING r.request_id`;
// The sweep's OAuth statements (maintenance/expire-agent-messages.ts
// cleanup-oauth, pinned by src/maintenance/__tests__/cleanup-oauth.test.ts).
const SWEEP = [
  `DELETE FROM oauth_authorization_requests WHERE expires_at < NOW() - INTERVAL '1 hour' OR consumed_at < NOW() - INTERVAL '1 hour'`,
  `DELETE FROM oauth_authorization_codes WHERE expires_at < NOW() - INTERVAL '1 hour' OR used_at < NOW() - INTERVAL '1 hour'`,
  `DELETE FROM oauth_device_codes WHERE expires_at < NOW() - INTERVAL '1 hour'`,
  `DELETE FROM oauth_access_tokens WHERE expires_at < NOW() - INTERVAL '1 hour' OR revoked_at < NOW() - INTERVAL '7 days'`,
  `DELETE FROM oauth_refresh_tokens WHERE expires_at < NOW() - INTERVAL '1 hour' OR revoked_at < NOW() - INTERVAL '7 days'`,
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const minutesAhead = (m: number) => new Date(Date.now() + m * 60_000);

describeFn('oauth / the lock discipline on real Postgres', () => {
  let pool: Pool;
  // Everything seeded in one test, for its cleanup.
  const seeded = { tenants: [] as string[], accounts: [] as string[], clients: [] as string[] };

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const clientId of seeded.clients) {
        await c.query(`DELETE FROM oauth_device_codes WHERE client_id = $1`, [clientId]);
        await c.query(`DELETE FROM oauth_authorization_requests WHERE client_id = $1`, [clientId]);
      }
      for (const tenantId of seeded.tenants) {
        await c.query(`DELETE FROM oauth_refresh_tokens WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM oauth_access_tokens WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM oauth_authorization_codes WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM oauth_grants WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM person_agent_assignments WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM mcp_tokens WHERE tenant_id = $1`, [tenantId]);
        // The last-owner trigger fires on DELETE only: the seeded owner is
        // demoted first so the seed can go, whatever role the test user has.
        await c.query(`UPDATE tenant_members SET role = 'member' WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM tenant_members WHERE tenant_id = $1`, [tenantId]);
        await c.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
      }
      for (const clientId of seeded.clients) await c.query(`DELETE FROM oauth_clients WHERE client_id = $1`, [clientId]);
      for (const accountId of seeded.accounts) await c.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    seeded.tenants.length = 0;
    seeded.accounts.length = 0;
    seeded.clients.length = 0;
  });

  // ── Seeds ────────────────────────────────────────────────────────────

  async function seedAccount(c: PoolClient): Promise<string> {
    const id = crypto.randomUUID();
    await c.query(
      `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email)
       VALUES ($1, $2, 'Lock', 'Order', $3)`,
      [id, `lock-order-${id}`, `lock-order-${id.slice(0, 8)}@example.test`],
    );
    seeded.accounts.push(id);
    return id;
  }

  async function seedWorkspace(c: PoolClient, members: number): Promise<{ tenantId: string; ownerId: string; memberIds: string[]; memberRowIds: string[] }> {
    const ownerId = await seedAccount(c);
    const tenantId = crypto.randomUUID();
    await c.query(
      `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
       VALUES ($1, $2, 'Lock Order Workspace', 'standard', 'shared', 'active', 'completed')`,
      [tenantId, ownerId],
    );
    seeded.tenants.push(tenantId);
    await c.query(`INSERT INTO tenant_members (tenant_id, account_id, role) VALUES ($1, $2, 'owner')`, [tenantId, ownerId]);
    const memberIds: string[] = [];
    const memberRowIds: string[] = [];
    for (let i = 0; i < members; i++) {
      const accountId = await seedAccount(c);
      const r = await c.query(
        `INSERT INTO tenant_members (tenant_id, account_id, role) VALUES ($1, $2, 'member') RETURNING id`,
        [tenantId, accountId],
      );
      memberIds.push(accountId);
      memberRowIds.push(r.rows[0].id as string);
    }
    return { tenantId, ownerId, memberIds, memberRowIds };
  }

  async function seedClient(c: PoolClient): Promise<{ clientId: string; rat: string }> {
    const clientId = `liftoff_oc_${crypto.randomBytes(8).toString('hex')}`;
    const rat = `liftoff_rat_${crypto.randomBytes(32).toString('base64url')}`;
    await c.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, client_type, registration_access_token_hash)
       VALUES ($1, 'Lock Order Agent', $2, $3, 'dcr', $4)`,
      [clientId, JSON.stringify([{ uri: REDIRECT_URI, loopback_port_wildcard: true }]), JSON.stringify(['authorization_code', 'refresh_token', DEVICE_GRANT]), hashToken(rat)],
    );
    seeded.clients.push(clientId);
    return { clientId, rat };
  }

  async function seedGrant(c: PoolClient, tenantId: string, accountId: string, clientId: string): Promise<{ grantId: string; anchorId: string }> {
    const anchor = await c.query(
      `INSERT INTO mcp_tokens (tenant_id, account_id, token_hash, token_prefix, name, auth_kind)
       VALUES ($1, $2, NULL, NULL, 'Lock Order Agent', 'oauth') RETURNING id`,
      [tenantId, accountId],
    );
    const anchorId = anchor.rows[0].id as string;
    await c.query(
      `INSERT INTO person_agent_assignments (tenant_id, account_id, agent_id, agent_origin, created_by)
       VALUES ($1, $2, $3, 'external', $2)`,
      [tenantId, accountId, anchorId],
    );
    const grant = await c.query(
      `INSERT INTO oauth_grants (tenant_id, client_id, account_id, mcp_token_id, resource)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenantId, clientId, accountId, anchorId, RESOURCE],
    );
    return { grantId: grant.rows[0].id as string, anchorId };
  }

  async function seedStaticToken(c: PoolClient, tenantId: string, accountId: string): Promise<string> {
    const raw = `liftoff_mcp_${crypto.randomBytes(16).toString('hex')}`;
    const r = await c.query(
      `INSERT INTO mcp_tokens (tenant_id, account_id, token_hash, token_prefix, name, auth_kind)
       VALUES ($1, $2, $3, $4, 'Static', 'static') RETURNING id`,
      [tenantId, accountId, hashToken(raw), raw.slice(0, 16)],
    );
    return r.rows[0].id as string;
  }

  async function seedRefresh(
    c: PoolClient,
    g: { grantId: string; tenantId: string; clientId: string },
    over: { expiresAt?: Date; rotatedAt?: Date | null } = {},
  ): Promise<{ raw: string; hash: string }> {
    const raw = `liftoff_ort_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashToken(raw);
    await c.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, grant_id, tenant_id, client_id, resource, expires_at, rotated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hash, g.grantId, g.tenantId, g.clientId, RESOURCE, over.expiresAt ?? minutesAhead(60), over.rotatedAt ?? null],
    );
    return { raw, hash };
  }

  async function seedAccess(c: PoolClient, g: { grantId: string; tenantId: string }, over: { expiresAt?: Date } = {}): Promise<{ raw: string; hash: string }> {
    const raw = `liftoff_oat_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashToken(raw);
    await c.query(
      `INSERT INTO oauth_access_tokens (token_hash, grant_id, tenant_id, resource, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [hash, g.grantId, g.tenantId, RESOURCE, over.expiresAt ?? minutesAhead(60)],
    );
    return { raw, hash };
  }

  async function seedAuthCode(c: PoolClient, g: { grantId: string; tenantId: string }): Promise<{ raw: string; hash: string }> {
    const raw = `liftoff_ac_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashToken(raw);
    await c.query(
      `INSERT INTO oauth_authorization_codes (code_hash, grant_id, tenant_id, redirect_uri, code_challenge, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hash, g.grantId, g.tenantId, REDIRECT_URI, CHALLENGE, RESOURCE, minutesAhead(10)],
    );
    return { raw, hash };
  }

  async function seedDeviceCode(
    c: PoolClient,
    clientId: string,
    over: { status?: string; grantId?: string | null; expiresAt?: Date } = {},
  ): Promise<{ hash: string; userCode: string }> {
    const raw = `liftoff_dc_${crypto.randomBytes(32).toString('base64url')}`;
    const hash = hashToken(raw);
    const letters = 'BCDFGHJKLMNPQRSTVWXZ';
    let code = '';
    for (const b of crypto.randomBytes(8)) code += letters[b % letters.length];
    const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    await c.query(
      `INSERT INTO oauth_device_codes (device_code_hash, user_code, client_id, client_name, scope, resource, status, grant_id, expires_at)
       VALUES ($1, $2, $3, 'Lock Order Agent', 'mcp', $4, $5, $6, $7)`,
      [hash, userCode, clientId, RESOURCE, over.status ?? 'pending', over.grantId ?? null, over.expiresAt ?? minutesAhead(10)],
    );
    return { hash, userCode };
  }

  async function seedAuthRequest(c: PoolClient, clientId: string, over: { expiresAt?: Date; parkedAt?: Date | null } = {}): Promise<string> {
    const requestId = crypto.randomBytes(24).toString('base64url');
    await c.query(
      `INSERT INTO oauth_authorization_requests (request_id, client_id, redirect_uri, state, code_challenge, resource, scope, expires_at, parked_for_onboarding_at)
       VALUES ($1, $2, $3, NULL, $4, $5, 'mcp', $6, $7)`,
      [requestId, clientId, REDIRECT_URI, CHALLENGE, RESOURCE, over.expiresAt ?? minutesAhead(10), over.parkedAt ?? null],
    );
    return requestId;
  }

  // ── Readers ──────────────────────────────────────────────────────────

  const grantStatus = async (grantId: string) => (await pool.query(`SELECT status FROM oauth_grants WHERE id = $1`, [grantId])).rows[0]?.status as string | undefined;
  const anchorStatus = async (anchorId: string) => (await pool.query(`SELECT status, deleted_at FROM mcp_tokens WHERE id = $1`, [anchorId])).rows[0] as { status: string; deleted_at: Date | null };
  const refreshRow = async (hash: string) => (await pool.query(`SELECT revoked_at, rotated_at FROM oauth_refresh_tokens WHERE token_hash = $1`, [hash])).rows[0] as { revoked_at: Date | null; rotated_at: Date | null } | undefined;
  const accessRow = async (hash: string) => (await pool.query(`SELECT revoked_at FROM oauth_access_tokens WHERE token_hash = $1`, [hash])).rows[0] as { revoked_at: Date | null } | undefined;
  const clientRow = async (clientId: string) => (await pool.query(`SELECT deleted_at, registration_access_token_hash FROM oauth_clients WHERE client_id = $1`, [clientId])).rows[0] as { deleted_at: Date | null; registration_access_token_hash: string | null };
  const deviceStatus = async (hash: string) => (await pool.query(`SELECT status, grant_id FROM oauth_device_codes WHERE device_code_hash = $1`, [hash])).rows[0] as { status: string; grant_id: string | null } | undefined;
  const requestRow = async (requestId: string) => (await pool.query(`SELECT consumed_at, parked_for_onboarding_at FROM oauth_authorization_requests WHERE request_id = $1`, [requestId])).rows[0] as { consumed_at: Date | null; parked_for_onboarding_at: Date | null } | undefined;
  const grantsOf = async (clientId: string) => (await pool.query(`SELECT id, status FROM oauth_grants WHERE client_id = $1`, [clientId])).rows as Array<{ id: string; status: string }>;
  const tokensOf = async (grantId: string) => (await pool.query(`SELECT (SELECT COUNT(*)::int FROM oauth_access_tokens WHERE grant_id = $1) AS access, (SELECT COUNT(*)::int FROM oauth_refresh_tokens WHERE grant_id = $1) AS refresh`, [grantId])).rows[0] as { access: number; refresh: number };

  // ── The stepwise harness ─────────────────────────────────────────────

  /**
   * A runs on its own connection and holds its locks uncommitted; B starts on
   * another and must still be pending after the window; A commits; B
   * completes; B commits. `bAutocommit` runs B outside a transaction, as the
   * pending-row inserts run on the pool.
   */
  async function stepwise<A, B>(
    a: (c: PoolClient) => Promise<A>,
    b: (c: PoolClient) => Promise<B>,
    opts: { bAutocommit?: boolean } = {},
  ): Promise<{ a: A; b: B }> {
    const ca = await pool.connect();
    const cb = await pool.connect();
    try {
      await ca.query('BEGIN');
      const ra = await a(ca);
      if (!opts.bAutocommit) await cb.query('BEGIN');
      let settled: 'pending' | 'resolved' | 'rejected' = 'pending';
      const pb = b(cb).then(
        (v) => { settled = 'resolved'; return v; },
        (err) => { settled = 'rejected'; throw err; },
      );
      await sleep(PENDING_WINDOW_MS);
      expect(settled).toBe('pending');
      await ca.query('COMMIT');
      const rb = await pb;
      if (!opts.bAutocommit) await cb.query('COMMIT');
      return { a: ra, b: rb };
    } catch (err) {
      await ca.query('ROLLBACK').catch(() => undefined);
      await cb.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      ca.release();
      cb.release();
    }
  }

  async function seed<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  // ── 1. revoke ∥ revoke ───────────────────────────────────────────────

  it('1. two revocations of a grant\'s last two refresh tokens: the second waits on the grant, sees the first, and the family is retired once', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const { clientId } = await seedClient(c);
      const g = await seedGrant(c, ws.tenantId, ws.memberIds[0], clientId);
      const r1 = await seedRefresh(c, { ...g, tenantId: ws.tenantId, clientId });
      const r2 = await seedRefresh(c, { ...g, tenantId: ws.tenantId, clientId });
      return { ...ws, clientId, ...g, r1, r2 };
    });

    const { a, b } = await stepwise(
      (c) => revokeTokenTx(c, { tokenHash: s.r1.hash, clientId: s.clientId, hint: 'refresh_token' }),
      (c) => revokeTokenTx(c, { tokenHash: s.r2.hash, clientId: s.clientId, hint: 'refresh_token' }),
    );
    expect(a).toEqual({ identified: true, retired: false }); // r2 was still live
    expect(b).toEqual({ identified: true, retired: true });  // nothing live remained

    expect(await grantStatus(s.grantId)).toBe('revoked');
    expect((await anchorStatus(s.anchorId)).status).toBe('revoked');
    expect((await refreshRow(s.r1.hash))!.revoked_at).not.toBeNull();
    expect((await refreshRow(s.r2.hash))!.revoked_at).not.toBeNull();
  });

  // ── 2. DELETE ∥ device approval ──────────────────────────────────────

  it('2a. DELETE then device approval: the approval waits on the client row and finds it deleted; no grant is built', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const client = await seedClient(c);
      const code = await seedDeviceCode(c, client.clientId);
      return { ...ws, ...client, code };
    });

    const { a, b } = await stepwise(
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
      (c) => approveDeviceCodeTx(c, { userCode: s.code.userCode, tenantId: s.tenantId, accountId: s.memberIds[0] }),
    );
    expect(a).toEqual({ authorized: true, grants: 0 });
    expect(b).toBeNull();

    expect(await grantsOf(s.clientId)).toEqual([]);
    expect((await deviceStatus(s.code.hash))!.status).toBe('denied');
    expect((await clientRow(s.clientId)).deleted_at).not.toBeNull();
  });

  it('2b. device approval then DELETE: the DELETE waits on the client row, then retires the grant the approval built', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const client = await seedClient(c);
      const code = await seedDeviceCode(c, client.clientId);
      return { ...ws, ...client, code };
    });

    const { a, b } = await stepwise(
      (c) => approveDeviceCodeTx(c, { userCode: s.code.userCode, tenantId: s.tenantId, accountId: s.memberIds[0] }),
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
    );
    expect(a).toMatchObject({ clientName: 'Lock Order Agent', resource: RESOURCE });
    expect(b).toEqual({ authorized: true, grants: 1 });

    const grants = await grantsOf(s.clientId);
    expect(grants).toHaveLength(1);
    expect(grants[0].status).toBe('revoked');
    const device = (await deviceStatus(s.code.hash))!;
    expect(device.status).toBe('approved');
    expect(device.grant_id).toBe(grants[0].id);
    const anchor = (await pool.query(`SELECT mcp_token_id FROM oauth_grants WHERE id = $1`, [grants[0].id])).rows[0].mcp_token_id as string;
    expect((await anchorStatus(anchor)).status).toBe('revoked');
    expect((await clientRow(s.clientId)).deleted_at).not.toBeNull();
  });

  // ── 3. DELETE ∥ code redemption ──────────────────────────────────────

  it('3a. redemption then DELETE: the DELETE waits on the grant and revokes the tokens the redemption minted', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const client = await seedClient(c);
      const g = await seedGrant(c, ws.tenantId, ws.memberIds[0], client.clientId);
      const code = await seedAuthCode(c, { ...g, tenantId: ws.tenantId });
      return { ...ws, ...client, ...g, code };
    });

    const { a, b } = await stepwise(
      (c) => redeemAuthorizationCodeTx(c, { codeHash: s.code.hash, clientId: s.clientId, redirectUri: REDIRECT_URI, resource: RESOURCE, verifier: VERIFIER }),
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
    );
    expect('tokens' in a).toBe(true);
    expect(b).toEqual({ authorized: true, grants: 1 });

    const minted = (a as { tokens: { accessRaw: string; refreshRaw: string } }).tokens;
    expect((await accessRow(hashToken(minted.accessRaw)))!.revoked_at).not.toBeNull();
    expect((await refreshRow(hashToken(minted.refreshRaw)))!.revoked_at).not.toBeNull();
    expect(await grantStatus(s.grantId)).toBe('revoked');
  });

  it('3b. DELETE then redemption: the redemption waits on the grant, rechecks, answers invalid_grant and inserts nothing', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const client = await seedClient(c);
      const g = await seedGrant(c, ws.tenantId, ws.memberIds[0], client.clientId);
      const code = await seedAuthCode(c, { ...g, tenantId: ws.tenantId });
      return { ...ws, ...client, ...g, code };
    });

    const { a, b } = await stepwise(
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
      (c) => redeemAuthorizationCodeTx(c, { codeHash: s.code.hash, clientId: s.clientId, redirectUri: REDIRECT_URI, resource: RESOURCE, verifier: VERIFIER }),
    );
    expect(a).toEqual({ authorized: true, grants: 1 });
    expect(b).toEqual({ error: 'invalid_grant' });
    expect(await tokensOf(s.grantId)).toEqual({ access: 0, refresh: 0 });
    const code = (await pool.query(`SELECT used_at FROM oauth_authorization_codes WHERE code_hash = $1`, [s.code.hash])).rows[0];
    expect(code.used_at).toBeNull();
  });

  // ── 4. revoke ∥ stale replay ─────────────────────────────────────────

  it('4. a revocation and a stale replay on one grant: one retirement, and the replay answers invalid_grant rather than retiring again', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const { clientId } = await seedClient(c);
      const g = await seedGrant(c, ws.tenantId, ws.memberIds[0], clientId);
      const r0 = await seedRefresh(c, { ...g, tenantId: ws.tenantId, clientId }, { rotatedAt: minutesAgo(2) }); // the stale tombstone
      const r1 = await seedRefresh(c, { ...g, tenantId: ws.tenantId, clientId });                             // its live successor
      return { ...ws, clientId, ...g, r0, r1 };
    });

    const { a, b } = await stepwise(
      (c) => revokeTokenTx(c, { tokenHash: s.r1.hash, clientId: s.clientId, hint: 'refresh_token' }),
      (c) => refreshTx(c, { tokenHash: s.r0.hash, clientId: s.clientId, resource: RESOURCE }),
    );
    expect(a).toEqual({ identified: true, retired: true });
    expect(b).toEqual({ error: 'invalid_grant' });

    expect(await grantStatus(s.grantId)).toBe('revoked');
    expect((await anchorStatus(s.anchorId)).status).toBe('revoked');
    expect((await refreshRow(s.r0.hash))!.revoked_at).not.toBeNull();
    expect((await refreshRow(s.r1.hash))!.revoked_at).not.toBeNull();
    expect(await tokensOf(s.grantId)).toEqual({ access: 0, refresh: 2 });
  });

  // ── 5. DELETE ∥ refresh rotation ─────────────────────────────────────

  it('5a. rotation then DELETE: the DELETE waits on the grant and revokes the successor the rotation minted', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const client = await seedClient(c);
      const g = await seedGrant(c, ws.tenantId, ws.memberIds[0], client.clientId);
      const r1 = await seedRefresh(c, { ...g, tenantId: ws.tenantId, clientId: client.clientId });
      return { ...ws, ...client, ...g, r1 };
    });

    const { a, b } = await stepwise(
      (c) => refreshTx(c, { tokenHash: s.r1.hash, clientId: s.clientId, resource: RESOURCE }),
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
    );
    expect('tokens' in a).toBe(true);
    expect(b).toEqual({ authorized: true, grants: 1 });

    const successor = (a as { tokens: { refreshRaw: string } }).tokens.refreshRaw;
    expect((await refreshRow(hashToken(successor)))!.revoked_at).not.toBeNull();
    const presented = (await refreshRow(s.r1.hash))!;
    expect(presented.rotated_at).not.toBeNull();
    expect(presented.revoked_at).not.toBeNull();
    expect(await grantStatus(s.grantId)).toBe('revoked');
  });

  it('5b. DELETE then rotation: the rotation waits on the grant, rechecks, answers invalid_grant and mints nothing', async () => {
    const s = await seed(async (c) => {
      const ws = await seedWorkspace(c, 1);
      const client = await seedClient(c);
      const g = await seedGrant(c, ws.tenantId, ws.memberIds[0], client.clientId);
      const r1 = await seedRefresh(c, { ...g, tenantId: ws.tenantId, clientId: client.clientId });
      return { ...ws, ...client, ...g, r1 };
    });

    const { a, b } = await stepwise(
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
      (c) => refreshTx(c, { tokenHash: s.r1.hash, clientId: s.clientId, resource: RESOURCE }),
    );
    expect(a).toEqual({ authorized: true, grants: 1 });
    expect(b).toEqual({ error: 'invalid_grant' });
    expect(await tokensOf(s.grantId)).toEqual({ access: 0, refresh: 1 });
    expect((await refreshRow(s.r1.hash))!.rotated_at).toBeNull();
  });

  // ── 6. DELETE ∥ /oauth/authorize insert ──────────────────────────────

  it('6a. DELETE holds tier 1, the /oauth/authorize insert blocks, and inserts zero rows once the DELETE commits', async () => {
    const s = await seed(async (c) => ({ ...(await seedClient(c)) }));
    const requestId = crypto.randomBytes(24).toString('base64url');

    const { a, b } = await stepwise(
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
      (c) => c.query(AUTHORIZE_INSERT, [requestId, s.clientId, REDIRECT_URI, null, CHALLENGE, RESOURCE]),
      { bAutocommit: true },
    );
    expect(a).toEqual({ authorized: true, grants: 0 });
    expect(b.rowCount).toBe(0);
    expect(await requestRow(requestId)).toBeUndefined();
  });

  it('6b. /oauth/authorize insert then DELETE: the request is consumed by the DELETE', async () => {
    const s = await seed(async (c) => ({ ...(await seedClient(c)) }));
    const requestId = crypto.randomBytes(24).toString('base64url');
    const inserted = await pool.query(AUTHORIZE_INSERT, [requestId, s.clientId, REDIRECT_URI, null, CHALLENGE, RESOURCE]);
    expect(inserted.rowCount).toBe(1);

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) })).toEqual({ authorized: true, grants: 0 });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect((await requestRow(requestId))!.consumed_at).not.toBeNull();
  });

  // ── 7. DELETE ∥ /oauth/device_authorization insert ───────────────────

  it('7a. DELETE holds tier 1, the /oauth/device_authorization insert blocks, and inserts zero rows once the DELETE commits', async () => {
    const s = await seed(async (c) => ({ ...(await seedClient(c)) }));
    const hash = hashToken(`liftoff_dc_${crypto.randomBytes(32).toString('base64url')}`);

    const { a, b } = await stepwise(
      (c) => deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) }),
      (c) => c.query(DEVICE_AUTHORIZATION_INSERT, [hash, 'BCDF-GHJK', s.clientId, RESOURCE, 5, 600]),
      { bAutocommit: true },
    );
    expect(a).toEqual({ authorized: true, grants: 0 });
    expect(b.rowCount).toBe(0);
    expect(await deviceStatus(hash)).toBeUndefined();
  });

  it('7b. /oauth/device_authorization insert then DELETE: the pending code is denied by the DELETE', async () => {
    const s = await seed(async (c) => ({ ...(await seedClient(c)) }));
    const hash = hashToken(`liftoff_dc_${crypto.randomBytes(32).toString('base64url')}`);
    const inserted = await pool.query(DEVICE_AUTHORIZATION_INSERT, [hash, 'BCDF-GHJL', s.clientId, RESOURCE, 5, 600]);
    expect(inserted.rowCount).toBe(1);

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      expect(await deprovisionClientTx(c, { clientId: s.clientId, bearerHash: hashToken(s.rat) })).toEqual({ authorized: true, grants: 0 });
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect((await deviceStatus(hash))!.status).toBe('denied');
  });

  // ── 8. The ring ──────────────────────────────────────────────────────

  describe('8. the ring: two deprovisionings and two membership removals over four grants, with real concurrency', () => {
    // Membership removal runs through the repository's own withTenantScope,
    // so the application pool is pointed at the test database.
    let initDatabase: () => Promise<void>;
    let closePools: () => Promise<void>;
    let repository: { deleteMemberAndRevokeAccess(tenantId: string, memberId: string, accountId: string): Promise<{ tokens: number; grants: number }> };

    beforeAll(async () => {
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      process.env.DB_HOST = url.hostname;
      process.env.DB_PORT = url.port || '5432';
      process.env.DB_NAME = url.pathname.replace(/^\//, '');
      process.env.DB_USER = decodeURIComponent(url.username);
      process.env.DB_PASSWORD = decodeURIComponent(url.password) || 'unused';
      const database = await import('../../infrastructure/database');
      initDatabase = database.initDatabase;
      closePools = database.closePools;
      await initDatabase();
      const { TenantMembersRepository } = await import('../../tenant-members/repository');
      repository = new TenantMembersRepository();
    });

    afterAll(async () => {
      await closePools();
    });

    it('twenty iterations: no deadlock, all four grants retired exactly once, each removal counts its anchors plus its static tokens', async () => {
      for (let iteration = 0; iteration < 20; iteration++) {
        const s = await seed(async (c) => {
          const ws = await seedWorkspace(c, 2);
          const clientC = await seedClient(c);
          const clientD = await seedClient(c);
          const grants = [];
          for (const clientId of [clientC.clientId, clientD.clientId]) {
            for (const accountId of ws.memberIds) grants.push(await seedGrant(c, ws.tenantId, accountId, clientId));
          }
          const statics = [];
          for (const accountId of ws.memberIds) statics.push(await seedStaticToken(c, ws.tenantId, accountId));
          return { ...ws, clientC, clientD, grants, statics };
        });

        const deprovision = async (client: { clientId: string; rat: string }) => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const r = await deprovisionClientTx(c, { clientId: client.clientId, bearerHash: hashToken(client.rat) });
            await c.query('COMMIT');
            return r;
          } catch (err) {
            await c.query('ROLLBACK').catch(() => undefined);
            throw err;
          } finally {
            c.release();
          }
        };

        const results = await Promise.allSettled([
          deprovision(s.clientC),
          deprovision(s.clientD),
          repository.deleteMemberAndRevokeAccess(s.tenantId, s.memberRowIds[0], s.memberIds[0]),
          repository.deleteMemberAndRevokeAccess(s.tenantId, s.memberRowIds[1], s.memberIds[1]),
        ]);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(failures.map((f) => `${(f.reason as { code?: string }).code ?? ''} ${(f.reason as Error).message}`)).toEqual([]);
        for (const f of failures) expect((f.reason as { code?: string }).code).not.toBe('40P01');

        const [depC, depD, remA1, remA2] = results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [
          { authorized: boolean; grants?: number }, { authorized: boolean; grants?: number },
          { tokens: number; grants: number }, { tokens: number; grants: number },
        ];
        expect(depC.authorized && depD.authorized).toBe(true);
        // Every grant is retired by exactly one of the four: the id-ordered
        // lock hands each to whoever holds it, and a retired grant is no
        // longer active for the next.
        expect((depC.grants ?? 0) + (depD.grants ?? 0) + remA1.grants + remA2.grants).toBe(4);
        // A removal's token count is the anchors it retired itself plus the
        // person's one static token.
        expect(remA1.tokens).toBe(remA1.grants + 1);
        expect(remA2.tokens).toBe(remA2.grants + 1);

        for (const g of s.grants) {
          expect(await grantStatus(g.grantId)).toBe('revoked');
          expect((await anchorStatus(g.anchorId)).status).toBe('revoked');
        }
        for (const id of s.statics) expect((await anchorStatus(id)).status).toBe('revoked');
        expect((await clientRow(s.clientC.clientId)).deleted_at).not.toBeNull();
        expect((await clientRow(s.clientD.clientId)).deleted_at).not.toBeNull();
        const members = await pool.query(`SELECT account_id FROM tenant_members WHERE tenant_id = $1`, [s.tenantId]);
        expect(members.rows.map((r) => r.account_id)).toEqual([s.ownerId]);
      }
    }, 120_000);
  });

  // ── 9. Sweep ∥ request writes ────────────────────────────────────────

  it('9. the sweep and the request paths never wait on each other: twenty iterations, both holding orders', async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      const s = await seed(async (c) => {
        const ws = await seedWorkspace(c, 1);
        const { clientId } = await seedClient(c);
        const accountId = ws.memberIds[0];
        // A grant to retire: one access token dead for two hours, one live.
        const g1 = await seedGrant(c, ws.tenantId, accountId, clientId);
        const g1Dead = await seedAccess(c, { ...g1, tenantId: ws.tenantId }, { expiresAt: minutesAgo(120) });
        const g1Live = await seedAccess(c, { ...g1, tenantId: ws.tenantId });
        const g1Refresh = await seedRefresh(c, { ...g1, tenantId: ws.tenantId, clientId });
        // A second client's grant (one active grant per tuple) whose dead
        // refresh token is presented to /oauth/revoke while a live one keeps it.
        const other = await seedClient(c);
        const g2 = await seedGrant(c, ws.tenantId, accountId, other.clientId);
        const g2Dead = await seedRefresh(c, { ...g2, tenantId: ws.tenantId, clientId: other.clientId }, { expiresAt: minutesAgo(120) });
        const g2Live = await seedRefresh(c, { ...g2, tenantId: ws.tenantId, clientId: other.clientId });
        // A device code dead for two hours, and a live one.
        const codeDead = await seedDeviceCode(c, clientId, { expiresAt: minutesAgo(120) });
        const codeLive = await seedDeviceCode(c, clientId);
        // A consent request dead for two hours, and one parked ten minutes
        // ago that has since passed its own expiry (live by the park window).
        const requestDead = await seedAuthRequest(c, clientId, { expiresAt: minutesAgo(120) });
        const requestParked = await seedAuthRequest(c, clientId, { expiresAt: minutesAgo(5), parkedAt: minutesAgo(10) });
        return { ...ws, clientId, otherClientId: other.clientId, g1, g1Dead, g1Live, g1Refresh, g2, g2Dead, g2Live, codeDead, codeLive, requestDead, requestParked };
      });

      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      // A statement that waits on the held transaction would wait until it is
      // released, which only happens once every statement has resolved: the
      // window turns that hang into a named failure (and lets go of the hold).
      const timed = <T>(label: string, fn: () => Promise<T>): Promise<T> => {
        let timer: NodeJS.Timeout;
        const window = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            release();
            reject(new Error(`${label} waited ${PENDING_WINDOW_MS} ms on the other side (iteration ${iteration})`));
          }, PENDING_WINDOW_MS);
        });
        return Promise.race([fn(), window]).finally(() => clearTimeout(timer));
      };
      const inTx = async <T>(fn: (c: PoolClient) => Promise<T>, hold?: () => Promise<void>): Promise<T> => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const v = await fn(c);
          if (hold) await hold();
          await c.query('COMMIT');
          return v;
        } catch (err) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          c.release();
        }
      };

      const requestPaths = () => [
        timed('retire', () => inTx((c) => retireGrantFamily(c, s.g1))),
        timed('revoke', () => inTx((c) => revokeTokenTx(c, { tokenHash: s.g2Dead.hash, clientId: s.otherClientId, hint: 'refresh_token' }))),
        timed('poll', () => inTx((c) => redeemDeviceCodeTx(c, { deviceCodeHash: s.codeDead.hash, clientId: s.clientId }))),
        timed('park', () => pool.query(PARK_UPDATE, [s.requestParked])),
      ] as const;
      const sweep = () => inTx(async (c) => {
        for (const sql of SWEEP) await timed('sweep', () => c.query(sql));
      }, () => held);

      if (iteration % 2 === 0) {
        // The sweep holds its uncommitted deletes while the request paths run.
        const sweeping = sweep();
        await sleep(20);
        const [retired, revoked, polled, parked] = await Promise.all(requestPaths());
        release();
        await sweeping;
        expect(retired).toEqual({ anchorRetired: 1 });
        expect(revoked).toEqual({ identified: true, retired: false });
        expect(polled).toEqual({ error: 'expired_token' });
        expect(parked.rowCount).toBe(1);
      } else {
        // The request paths hold their uncommitted writes while the sweep runs.
        const holding = Promise.all([
          inTx((c) => retireGrantFamily(c, s.g1), () => held),
          inTx((c) => revokeTokenTx(c, { tokenHash: s.g2Dead.hash, clientId: s.otherClientId, hint: 'refresh_token' }), () => held),
          inTx((c) => redeemDeviceCodeTx(c, { deviceCodeHash: s.codeDead.hash, clientId: s.clientId }), () => held),
          inTx((c) => c.query(PARK_UPDATE, [s.requestParked]), () => held),
        ]);
        await sleep(20);
        await inTx(async (c) => {
          for (const sql of SWEEP) await timed('sweep', () => c.query(sql));
        });
        release();
        const [retired, revoked, polled, parked] = await holding;
        expect(retired).toEqual({ anchorRetired: 1 });
        expect(revoked).toEqual({ identified: true, retired: false });
        expect(polled).toEqual({ error: 'expired_token' });
        expect(parked.rowCount).toBe(1);
      }

      // The dead rows are gone.
      expect(await accessRow(s.g1Dead.hash)).toBeUndefined();
      expect(await refreshRow(s.g2Dead.hash)).toBeUndefined();
      expect(await deviceStatus(s.codeDead.hash)).toBeUndefined();
      expect(await requestRow(s.requestDead)).toBeUndefined();
      // The live rows were written.
      expect(await grantStatus(s.g1.grantId)).toBe('revoked');
      expect((await accessRow(s.g1Live.hash))!.revoked_at).not.toBeNull();
      expect((await refreshRow(s.g1Refresh.hash))!.revoked_at).not.toBeNull();
      expect(await grantStatus(s.g2.grantId)).toBe('active');
      expect((await refreshRow(s.g2Live.hash))!.revoked_at).toBeNull();
      expect((await deviceStatus(s.codeLive.hash))!.status).toBe('pending');
      // The parked request survives, its stamp kept.
      const parkedRow = (await requestRow(s.requestParked))!;
      expect(parkedRow.consumed_at).toBeNull();
      expect(parkedRow.parked_for_onboarding_at).not.toBeNull();
    }
  }, 120_000);

  // ── 10. Approval, then two polls on one code ─────────────────────────
  //
  // A device code changes tier at approval: pending it is a tier-2 row, approved
  // it is a row the grant owns. A poll that identified it as pending BEFORE the
  // approval committed locks it as a tier-2 row afterwards and finds it
  // approved; a poll that identified it as approved holds the grant and writes
  // the same row without a lock of its own. Were the first poll to climb to the
  // grant it would hold an owned row while wanting the grant, against a
  // transaction holding the grant while wanting the row: 40P01. The pending
  // branch therefore never climbs.

  /** The real client, with a hook awaited before each statement is issued. */
  function instrumented(real: PoolClient, before: (index: number, sql: string) => Promise<void> | void): PoolClient {
    let index = 0;
    const query = async (sql: unknown, params?: unknown[]) => {
      await before(index++, String(sql));
      return (real.query as (sql: unknown, params?: unknown[]) => Promise<unknown>)(sql, params);
    };
    return new Proxy(real, { get: (target, prop) => (prop === 'query' ? query : Reflect.get(target, prop)) }) as PoolClient;
  }

  it('10. a poll that saw the code pending and one that saw it approved, on one code: no deadlock, twenty iterations', async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      const s = await seed(async (c) => {
        const ws = await seedWorkspace(c, 1);
        const { clientId } = await seedClient(c);
        const code = await seedDeviceCode(c, clientId);
        return { ...ws, clientId, code };
      });

      const ca = await pool.connect();
      const cb = await pool.connect();
      const capp = await pool.connect();
      let approved: () => void = () => undefined;
      const approvalCommitted = new Promise<void>((resolve) => { approved = resolve; });
      let bIssuedItsWrite: () => void = () => undefined;
      const bWaitingOnTheRow = new Promise<void>((resolve) => { bIssuedItsWrite = resolve; });
      try {
        await ca.query('BEGIN');
        await cb.query('BEGIN');
        await capp.query('BEGIN');

        // A identifies the code as pending, then waits for the approval to
        // commit before locking the row (which it then finds approved), and
        // waits again before its next statement until B is blocked on the row.
        const a = redeemDeviceCodeTx(
          instrumented(ca, async (i) => {
            if (i === 1) await approvalCommitted;
            if (i === 2) await bWaitingOnTheRow;
          }),
          { deviceCodeHash: s.code.hash, clientId: s.clientId },
        );
        await sleep(20);
        expect(await approveDeviceCodeTx(capp, { userCode: s.code.userCode, tenantId: s.tenantId, accountId: s.memberIds[0] })).not.toBeNull();
        await capp.query('COMMIT');
        approved();
        await sleep(50);

        // B identifies the code as approved, locks the grant, re-reads the
        // row, and its bookkeeping write blocks on A's row lock.
        const b = redeemDeviceCodeTx(
          instrumented(cb, async (i, sql) => {
            if (i === 3) {
              expect(sql).toContain('UPDATE oauth_device_codes SET last_polled_at');
              setTimeout(bIssuedItsWrite, 150);
            }
          }),
          { deviceCodeHash: s.code.hash, clientId: s.clientId },
        );

        const ra = await a;
        await ca.query('COMMIT');
        const rb = await b;
        await cb.query('COMMIT');

        // A answers pending; the tool's next poll takes the grant path. B,
        // holding the grant, mints and consumes.
        expect(ra).toEqual({ error: 'authorization_pending' });
        expect('tokens' in rb).toBe(true);
        expect((await deviceStatus(s.code.hash))!.status).toBe('consumed');
      } catch (err) {
        await Promise.all([ca, cb, capp].map((c) => c.query('ROLLBACK').catch(() => undefined)));
        throw new Error(`iteration ${iteration}: ${(err as { code?: string }).code ?? ''} ${(err as Error).message}`);
      } finally {
        ca.release();
        cb.release();
        capp.release();
      }
    }
  }, 120_000);
});
