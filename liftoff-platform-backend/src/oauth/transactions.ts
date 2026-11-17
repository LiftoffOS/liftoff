// The OAuth transactions: every path that writes a grant or anything a grant
// owns, as one function per path, each following the lock discipline in the
// header of grant-lifecycle.ts. The routes keep parsing, the RFC error
// bodies and the client `last_used_at` stamp (which runs after commit, on
// the pool); each calls one function here inside its own scope.
//
// Paths that start from a credential follow one pattern: identify without
// locks → lock the grant (tier 3) → re-read the credential → recheck every
// condition → act. A recheck that disagrees with the identify answers what
// the recheck says: the row the identify saw may have been rotated, revoked
// or retired by the transaction that held the lock first.
//
// Every request-path lock and write on a swept table carries its liveness
// predicate (tokens and codes `expires_at > NOW()`, consent requests
// LIVE_PREDICATE), so a sweep statement and a request statement never wait
// on each other. A write that decides an outcome (a code marked used, a
// refresh token tombstoned, a device code consumed or approved) is checked
// by its rowCount: NOW() is the transaction's start and the recheck ran
// against the application clock, so a row that lapsed between the two
// answers as expired rather than issuing anything.

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { hashToken } from '../tenant-members/tokens';
import { log } from '../infrastructure/logging';
import { parseGrantTypes, usesDeviceGrant } from './client-grants';
import { LIVE_PREDICATE, ensureGrant, lockActiveGrants, retireGrantFamily } from './grant-lifecycle';
import type { GrantSubject } from './grant-lifecycle';

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;              // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;          // 30 days
const REFRESH_REUSE_GRACE_MS = 30 * 1000;                       // concurrent-loser window

// Documented tradeoff (plan Phase 3): a genuinely stolen-and-replayed
// refresh token inside the 30-second grace escapes family revocation once;
// accepted because the alternative falsely logs out legitimate concurrent
// refreshes, and the attacker still needs the token within 30 s of rotation.

export type MintedTokens = { accessRaw: string; refreshRaw: string };
export type CodeOutcome = { error: 'invalid_grant' } | { tokens: MintedTokens };
export type RefreshOutcome = { error: 'invalid_grant' } | { theft: true } | { tokens: MintedTokens };
// RFC 8628 §3.5: the errors a polling client continues through
// (authorization_pending, slow_down) and the ones that end the session.
export type DeviceOutcome =
  | { error: 'invalid_grant' | 'unauthorized_client' | 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' }
  | { tokens: MintedTokens };
export type RevokeOutcome = { identified: false } | { identified: true; retired: boolean };
export type DeprovisionOutcome = { authorized: false } | { authorized: true; grants: number };

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function mintTokenPair(): {
  accessRaw: string; accessHash: string; refreshRaw: string; refreshHash: string;
  accessExpires: Date; refreshExpires: Date;
} {
  const accessRaw = `liftoff_oat_${crypto.randomBytes(32).toString('base64url')}`;
  const refreshRaw = `liftoff_ort_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    accessRaw,
    accessHash: hashToken(accessRaw),
    refreshRaw,
    refreshHash: hashToken(refreshRaw),
    accessExpires: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refreshExpires: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  };
}

type TokenPair = ReturnType<typeof mintTokenPair>;

/** Insert a minted access + refresh pair for a grant, under its lock. */
async function insertTokenPair(
  client: PoolClient,
  pair: TokenPair,
  grantId: string,
  tenantId: string,
  clientId: string,
  resource: string,
): Promise<MintedTokens> {
  await client.query(
    `INSERT INTO oauth_access_tokens (token_hash, grant_id, tenant_id, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [pair.accessHash, grantId, tenantId, resource, pair.accessExpires],
  );
  await client.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, grant_id, tenant_id, client_id, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [pair.refreshHash, grantId, tenantId, clientId, resource, pair.refreshExpires],
  );
  return { accessRaw: pair.accessRaw, refreshRaw: pair.refreshRaw };
}

/** The tier-3 lock, returning what the state machines read off the grant. */
async function lockGrant(
  client: PoolClient,
  grantId: string,
): Promise<{ status: string; tenantId: string } | null> {
  const r = await client.query(
    `SELECT status, tenant_id FROM oauth_grants WHERE id = $1 FOR UPDATE`,
    [grantId],
  );
  if (r.rows.length === 0) return null;
  return { status: r.rows[0].status as string, tenantId: r.rows[0].tenant_id as string };
}

// ── POST /oauth/token — authorization_code ────────────────────────────

export async function redeemAuthorizationCodeTx(
  client: PoolClient,
  { codeHash, clientId, redirectUri, resource, verifier }: {
    codeHash: string; clientId: string; redirectUri: string; resource: string; verifier: string;
  },
): Promise<CodeOutcome> {
  const found = await client.query(
    `SELECT grant_id FROM oauth_authorization_codes WHERE code_hash = $1`,
    [codeHash],
  );
  if (found.rows.length === 0) return { error: 'invalid_grant' };

  await lockGrant(client, found.rows[0].grant_id as string);

  // Re-read under the lock and validate EVERY binding + PKCE; only then
  // mark used + mint. Any failure returns before the write, so the code is
  // NOT burned (v6 decision: no attempt counter).
  const r = await client.query(
    `SELECT c.code_hash, c.grant_id, c.tenant_id, c.redirect_uri, c.code_challenge, c.resource,
            c.expires_at, c.used_at, g.client_id, g.status AS grant_status
     FROM oauth_authorization_codes c
     JOIN oauth_grants g ON g.id = c.grant_id
     WHERE c.code_hash = $1`,
    [codeHash],
  );
  if (r.rows.length === 0) return { error: 'invalid_grant' };
  const row = r.rows[0];
  if (row.used_at !== null) return { error: 'invalid_grant' };
  if (new Date(row.expires_at as string) <= new Date()) return { error: 'invalid_grant' };
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (row.grant_status !== 'active') return { error: 'invalid_grant' };
  if (row.redirect_uri !== redirectUri) return { error: 'invalid_grant' };
  if (row.resource !== resource) return { error: 'invalid_grant' };
  if (s256(verifier) !== row.code_challenge) {
    // H5-style security log: PKCE mismatch on a real code.
    log.warn(
      { event: 'oauth_code_pkce_mismatch', clientId, tenantId: row.tenant_id },
      'PKCE verification failed on authorization-code redemption',
    );
    return { error: 'invalid_grant' };
  }

  const marked = await client.query(
    `UPDATE oauth_authorization_codes SET used_at = NOW() WHERE code_hash = $1 AND expires_at > NOW()`,
    [row.code_hash],
  );
  if ((marked.rowCount ?? 0) === 0) return { error: 'invalid_grant' };
  const tokens = await insertTokenPair(client, mintTokenPair(), row.grant_id as string, row.tenant_id as string, clientId, resource);
  return { tokens };
}

// ── POST /oauth/token — refresh_token ─────────────────────────────────

export async function refreshTx(
  client: PoolClient,
  { tokenHash, clientId, resource }: { tokenHash: string; clientId: string; resource: string },
): Promise<RefreshOutcome> {
  const found = await client.query(
    `SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  if (found.rows.length === 0) return { error: 'invalid_grant' };

  await lockGrant(client, found.rows[0].grant_id as string);

  const r = await client.query(
    `SELECT rt.token_hash, rt.grant_id, rt.tenant_id, rt.client_id, rt.resource,
            rt.expires_at, rt.rotated_at, rt.revoked_at,
            g.status AS grant_status, g.mcp_token_id
     FROM oauth_refresh_tokens rt
     JOIN oauth_grants g ON g.id = rt.grant_id
     WHERE rt.token_hash = $1`,
    [tokenHash],
  );
  if (r.rows.length === 0) return { error: 'invalid_grant' };
  const row = r.rows[0];
  if (row.revoked_at !== null) return { error: 'invalid_grant' };
  if (new Date(row.expires_at as string) <= new Date()) return { error: 'invalid_grant' };
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (row.resource !== resource) return { error: 'invalid_grant' };
  if (row.grant_status !== 'active') return { error: 'invalid_grant' };

  if (row.rotated_at !== null) {
    const rotatedMs = Date.now() - new Date(row.rotated_at as string).getTime();
    if (rotatedMs <= REFRESH_REUSE_GRACE_MS) {
      // Concurrent-loser: the winner already holds the successor.
      // invalid_grant with NO revocation — the parallel-refresh test
      // depends on this branch.
      return { error: 'invalid_grant' };
    }
    // Stale replay = theft. Retire the grant row itself + all tokens + the
    // anchor (v5 blocker 4: without the grant status flip, re-consent
    // would reuse the compromised grant).
    await retireGrantFamily(client, { grantId: row.grant_id as string, anchorId: row.mcp_token_id as string });
    return { theft: true };
  }

  // Rotate: tombstone the presented token, naming its successor (the
  // tombstone is retained until its ORIGINAL expires_at — the sweep deletes
  // only rows an hour past expiry), then insert the successor pair. A
  // tombstone that misses is a token that lapsed since the recheck: nothing
  // is minted for it.
  const pair = mintTokenPair();
  const tombstoned = await client.query(
    `UPDATE oauth_refresh_tokens SET rotated_at = NOW(), replaced_by_hash = $2 WHERE token_hash = $1 AND expires_at > NOW()`,
    [row.token_hash, pair.refreshHash],
  );
  if ((tombstoned.rowCount ?? 0) === 0) return { error: 'invalid_grant' };
  const tokens = await insertTokenPair(client, pair, row.grant_id as string, row.tenant_id as string, clientId, resource);
  return { tokens };
}

// ── POST /oauth/token — device_code (RFC 8628) ────────────────────────

const DEVICE_ROW_SQL = `SELECT d.device_code_hash, d.client_id, d.status, d.grant_id, d.resource, d.expires_at,
                               d.interval_seconds, d.last_polled_at, c.grant_types
                        FROM oauth_device_codes d
                        JOIN oauth_clients c ON c.client_id = d.client_id
                        WHERE d.device_code_hash = $1`;

export async function redeemDeviceCodeTx(
  client: PoolClient,
  { deviceCodeHash, clientId }: { deviceCodeHash: string; clientId: string },
): Promise<DeviceOutcome> {
  const found = await client.query(
    `SELECT status, grant_id FROM oauth_device_codes WHERE device_code_hash = $1`,
    [deviceCodeHash],
  );
  if (found.rows.length === 0) return { error: 'invalid_grant' };

  // An approved code is a grant-owned row: lock the grant (tier 3) and
  // re-read the code without a lock of its own. A code still pending is a
  // tier-2 row: lock it, a LIVE one only, so the lock never meets the sweep
  // on a row dead for an hour; a dead row is re-read without a lock, so the
  // state machine still answers its terminal state (RFC 8628 §3.5) and
  // writes nothing on the way.
  //
  // The pending branch never climbs to the grant. The code changes tier at
  // approval, and a poll that identified it as pending before the approval
  // committed holds it afterwards as a tier-2 lock on what is now a row the
  // grant owns; a poll that identified it as approved holds the grant and
  // writes that row without a lock of its own. Climbing here would hold the
  // owned row while wanting the grant, against the grant held while wanting
  // the row: a deadlock. A code found approved under the row lock is
  // answered authorization_pending, and the tool's next poll takes the grant
  // path.
  const grantPath = found.rows[0].status === 'approved' && Boolean(found.rows[0].grant_id);
  let grant: { status: string; tenantId: string } | null = null;
  let r;
  if (grantPath) {
    grant = await lockGrant(client, found.rows[0].grant_id as string);
    r = await client.query(DEVICE_ROW_SQL, [deviceCodeHash]);
  } else {
    r = await client.query(`${DEVICE_ROW_SQL} AND d.expires_at > NOW() FOR UPDATE OF d`, [deviceCodeHash]);
    if (r.rows.length === 0) {
      r = await client.query(DEVICE_ROW_SQL, [deviceCodeHash]);
    }
  }
  if (r.rows.length === 0) return { error: 'invalid_grant' };
  const row = r.rows[0];
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (!usesDeviceGrant(parseGrantTypes(row.grant_types))) return { error: 'unauthorized_client' };
  if (row.status === 'consumed') return { error: 'invalid_grant' };
  // expires_in is the lifetime of both codes, so an approval nobody
  // redeemed inside it is over as well. Terminal (RFC 8628 §3.5), so it is
  // answered before any bookkeeping write.
  if (new Date(row.expires_at as string) <= new Date()) return { error: 'expired_token' };

  // Polled faster than the interval: the interval grows by five seconds
  // (RFC 8628 §3.5) and the poll is answered slow_down.
  const now = Date.now();
  const lastPolled = row.last_polled_at ? new Date(row.last_polled_at as string).getTime() : null;
  if (lastPolled !== null && now - lastPolled < (row.interval_seconds as number) * 1000) {
    await client.query(
      `UPDATE oauth_device_codes SET last_polled_at = NOW(), interval_seconds = interval_seconds + 5 WHERE device_code_hash = $1 AND expires_at > NOW()`,
      [row.device_code_hash],
    );
    return { error: 'slow_down' };
  }
  await client.query(
    `UPDATE oauth_device_codes SET last_polled_at = NOW() WHERE device_code_hash = $1 AND expires_at > NOW()`,
    [row.device_code_hash],
  );

  if (row.status === 'pending') return { error: 'authorization_pending' };
  if (row.status === 'denied') return { error: 'access_denied' };
  // Approved since the identify: minted on the next poll, under the grant.
  if (!grantPath) return { error: 'authorization_pending' };
  if (!grant || grant.status !== 'active') return { error: 'invalid_grant' };

  const consumed = await client.query(
    `UPDATE oauth_device_codes SET status = 'consumed' WHERE device_code_hash = $1 AND expires_at > NOW()`,
    [row.device_code_hash],
  );
  if ((consumed.rowCount ?? 0) === 0) return { error: 'expired_token' };
  const tokens = await insertTokenPair(client, mintTokenPair(), row.grant_id as string, grant.tenantId, clientId, row.resource as string);
  return { tokens };
}

// ── POST /oauth/revoke (RFC 7009) ─────────────────────────────────────

/**
 * Mark the presented token revoked if it is live, and — decided under the
 * grant lock — retire the grant family when no live refresh token remains,
 * since a grant that can no longer mint is a connection that is over. The
 * identify and the decision run whatever the presented token's expiry: an
 * expired refresh token still names its grant.
 */
export async function revokeTokenTx(
  client: PoolClient,
  { tokenHash, clientId, hint }: { tokenHash: string; clientId: string; hint: string | undefined },
): Promise<RevokeOutcome> {
  // Hinted table first, then the other. Revocation only applies when the
  // token's grant belongs to the presenting client.
  const tables = hint === 'access_token'
    ? ['oauth_access_tokens', 'oauth_refresh_tokens']
    : ['oauth_refresh_tokens', 'oauth_access_tokens'];
  let identified: { table: string; grantId: string; anchorId: string } | null = null;
  for (const table of tables) {
    const r = await client.query(
      `SELECT t.grant_id, g.mcp_token_id
       FROM ${table} t
       JOIN oauth_grants g ON g.id = t.grant_id
       WHERE t.token_hash = $1 AND g.client_id = $2`,
      [tokenHash, clientId],
    );
    if (r.rows.length > 0) {
      identified = { table, grantId: r.rows[0].grant_id as string, anchorId: r.rows[0].mcp_token_id as string };
      break;
    }
  }
  if (!identified) return { identified: false };

  const grant = await lockGrant(client, identified.grantId);
  await client.query(
    `UPDATE ${identified.table} SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [tokenHash],
  );
  if (!grant || grant.status !== 'active') return { identified: true, retired: false };

  const live = await client.query(
    `SELECT 1 FROM oauth_refresh_tokens
     WHERE grant_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [identified.grantId],
  );
  if (live.rows.length > 0) return { identified: true, retired: false };

  await retireGrantFamily(client, { grantId: identified.grantId, anchorId: identified.anchorId });
  return { identified: true, retired: true };
}

// ── The two approvals ─────────────────────────────────────────────────

/**
 * Consent-page approval: the grant, then the authorization code under its
 * lock. `null` when the client has been deprovisioned (nothing issued).
 */
export async function approveConsentTx(
  client: PoolClient,
  { subject, codeHash, redirectUri, codeChallenge, resource, expiresAt }: {
    subject: GrantSubject; codeHash: string; redirectUri: string; codeChallenge: string; resource: string; expiresAt: Date;
  },
): Promise<string | null> {
  const grantId = await ensureGrant(client, subject);
  if (!grantId) return null;
  await client.query(
    `INSERT INTO oauth_authorization_codes (code_hash, grant_id, tenant_id, redirect_uri, code_challenge, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [codeHash, grantId, subject.tenantId, redirectUri, codeChallenge, resource, expiresAt],
  );
  return grantId;
}

export interface DeviceApproval {
  clientName: string;
  resource: string;
  workspaceName: string | null;
}

/**
 * /activate approval, in ascending tiers: a lock-free read names the client;
 * tier 1 holds its registration FOR SHARE; tier 2 locks the pending code and
 * rechecks it is the same client's; tier 3 builds or reuses the grant
 * (`ensureGrant`); then the code is flipped under both locks. `null` on any
 * miss, which the route answers as a vanished pending code.
 */
export async function approveDeviceCodeTx(
  client: PoolClient,
  { userCode, tenantId, accountId }: { userCode: string; tenantId: string; accountId: string },
): Promise<DeviceApproval | null> {
  const pending = await client.query(
    `SELECT client_id FROM oauth_device_codes WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()`,
    [userCode],
  );
  if (pending.rows.length === 0) return null;
  const clientId = pending.rows[0].client_id as string;

  const registration = await client.query(
    `SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL FOR SHARE`,
    [clientId],
  );
  if (registration.rows.length === 0) return null;

  const claimed = await client.query(
    `SELECT device_code_hash, client_id, client_name, resource FROM oauth_device_codes
     WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
     FOR UPDATE`,
    [userCode],
  );
  if (claimed.rows.length === 0 || claimed.rows[0].client_id !== clientId) return null;
  const row = claimed.rows[0];

  const grantId = await ensureGrant(client, {
    tenantId,
    accountId,
    clientId,
    clientName: row.client_name as string,
    resource: row.resource as string,
  });
  if (!grantId) return null;

  const flipped = await client.query(
    `UPDATE oauth_device_codes SET status = 'approved', grant_id = $2 WHERE device_code_hash = $1 AND expires_at > NOW()`,
    [row.device_code_hash, grantId],
  );
  // A code that lapsed under the lock is answered as a vanished pending
  // code; the grant stays, as it does after a consent approval whose code
  // is never redeemed, and the next approval reuses it.
  if ((flipped.rowCount ?? 0) === 0) return null;
  const workspace = await client.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  return {
    clientName: row.client_name as string,
    resource: row.resource as string,
    workspaceName: (workspace.rows[0]?.name as string | undefined) ?? null,
  };
}

// ── DELETE /oauth/register/:client_id (RFC 7592) ──────────────────────

function hashesMatch(stored: string, presented: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A DCR client deprovisions its own registration, in ascending tiers: the
 * client row FOR UPDATE (tier 1) — and the registration token compared
 * under it, so an unauthorised call writes nothing; its live pending rows
 * closed (tier 2); every active grant locked in id order and retired
 * (tier 3); the row soft-deleted with its token cleared. This is the client
 * operator's own act, bound to one client_id by the 256-bit secret issued
 * only at registration (INV-PB-014). A CIMD client cannot be deprovisioned:
 * its client_id is a URL shared by every user of the tool.
 */
export async function deprovisionClientTx(
  client: PoolClient,
  { clientId, bearerHash }: { clientId: string; bearerHash: string },
): Promise<DeprovisionOutcome> {
  const registration = await client.query(
    `SELECT registration_access_token_hash FROM oauth_clients
     WHERE client_id = $1 AND deleted_at IS NULL AND client_type = 'dcr'
     FOR UPDATE`,
    [clientId],
  );
  const stored = registration.rows[0]?.registration_access_token_hash as string | null | undefined;
  if (!stored || !hashesMatch(stored, bearerHash)) return { authorized: false };

  await client.query(
    `UPDATE oauth_authorization_requests r SET consumed_at = NOW()
     WHERE r.client_id = $1 AND r.consumed_at IS NULL AND ${LIVE_PREDICATE}`,
    [clientId],
  );
  await client.query(
    `UPDATE oauth_device_codes SET status = 'denied'
     WHERE client_id = $1 AND status = 'pending' AND expires_at > NOW()`,
    [clientId],
  );

  const grants = await lockActiveGrants(client, { clientId });
  for (const family of grants) {
    await retireGrantFamily(client, family);
  }

  await client.query(
    `UPDATE oauth_clients SET deleted_at = NOW(), registration_access_token_hash = NULL WHERE client_id = $1`,
    [clientId],
  );
  return { authorized: true, grants: grants.length };
}
