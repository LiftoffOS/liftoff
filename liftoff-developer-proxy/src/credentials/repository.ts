// Developer Proxy Credentials Repository
// Raw pg queries against developer_proxy_credentials and developer_proxy_usage_log.
// No RLS enforcement here — callers use withByokTenant() to set tenant context,
// except findByKeyHash which uses the raw pool (auth_lookup_bypass policy).

import type { Pool, PoolClient } from 'pg';

import type { ByokCredential } from './types.js';

// Last activity is DERIVED from the usage log rather than read off
// developer_proxy_credentials.last_used_at.
//
// The stored column is unreliable: a no-GUC
// `UPDATE ... SET last_used_at = NOW()` on the raw pool (as proxy/auth.ts would
// need) meets only the sole no-GUC policy on this table (auth_lookup_bypass,
// migration 005), which is declared FOR SELECT. Such an UPDATE matches zero
// rows — silently, since RLS filters rather than raising — so the column reads
// back "never used".
//
// developer_proxy_usage_log is the honest source: its reporter_bypass policy IS
// FOR ALL, which is why the hot-path usage insert in proxy/handler.ts succeeds.
// The lateral below is supported by idx_developer_proxy_usage_log_cred
// (credential_id, started_at) and runs only on the tenant-scoped read paths,
// never on the proxy hot path.
//
// No explicit tenant predicate is needed inside the lateral: these callers run
// under withByokUser/withByokTenant, so the usage_log user_isolation /
// tenant_admin policies already constrain it, and credential_id is a globally
// unique PK. Adding a redundant tenant_id filter would only cost the planner
// its index-backward-scan shortcut for MAX().
const LAST_ACTIVITY_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT MAX(started_at) AS last_activity_at
    FROM developer_proxy_usage_log
    WHERE credential_id = c.id
  ) u ON TRUE
`;

// GREATEST ignores NULLs (it returns NULL only when every argument is NULL), so
// this keeps whichever of the two is present: pre-cutover rows carry a real
// last_used_at that tools/migration/backfill.ts copied over, and post-cutover
// rows have only usage history.
const LAST_ACTIVITY_SELECT = `GREATEST(c.last_used_at, u.last_activity_at) AS effective_last_used_at`;

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function mapRow(row: Record<string, unknown>): ByokCredential {
  // Queries that join the usage log supply effective_last_used_at; the insert
  // and hot-path key lookup do not, and fall back to the stored column.
  const lastUsed = row.effective_last_used_at ?? row.last_used_at;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    userId: row.user_id as string,
    vendor: (row.vendor as string) ?? 'anthropic',
    keyPrefix: row.key_prefix as string,
    keyHint: row.key_hint as string,
    secretName: row.secret_name as string,
    label: (row.label as string) ?? '',
    status: row.status as string,
    lastUsedAt: lastUsed ? new Date(lastUsed as string) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export async function insertCredential(
  client: PoolClient,
  params: {
    id?: string;        // optional: supply to bind credential ID to Secret Manager path
    tenantId: string;
    userId: string;
    vendor: string;
    keyHash: string;
    keyPrefix: string;
    keyHint: string;
    secretName: string;
    label: string;
  },
): Promise<ByokCredential> {
  if (params.id) {
    const result = await client.query(
      `INSERT INTO developer_proxy_credentials
         (id, tenant_id, user_id, vendor, key_hash, key_prefix, key_hint, secret_name, label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        params.id,
        params.tenantId,
        params.userId,
        params.vendor,
        params.keyHash,
        params.keyPrefix,
        params.keyHint,
        params.secretName,
        params.label,
      ],
    );
    return mapRow(result.rows[0]);
  }

  const result = await client.query(
    `INSERT INTO developer_proxy_credentials
       (tenant_id, user_id, vendor, key_hash, key_prefix, key_hint, secret_name, label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      params.tenantId,
      params.userId,
      params.vendor,
      params.keyHash,
      params.keyPrefix,
      params.keyHint,
      params.secretName,
      params.label,
    ],
  );
  return mapRow(result.rows[0]);
}

// ---------------------------------------------------------------------------
// Hot path — uses raw pool, covered by auth_lookup_bypass RLS policy.
// ---------------------------------------------------------------------------

export async function findByKeyHash(pool: Pool, keyHash: string): Promise<ByokCredential | null> {
  const result = await pool.query(
    `SELECT * FROM developer_proxy_credentials WHERE key_hash = $1`,
    [keyHash],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Single credential lookup within tenant context
// ---------------------------------------------------------------------------

export async function findByIdForTenant(
  client: PoolClient,
  id: string,
  tenantId: string,
): Promise<ByokCredential | null> {
  const result = await client.query(
    `SELECT c.*, ${LAST_ACTIVITY_SELECT}
     FROM developer_proxy_credentials c
     ${LAST_ACTIVITY_LATERAL}
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [id, tenantId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// List all credentials for a tenant, optionally filtered by userId
// ---------------------------------------------------------------------------

export async function listByTenant(
  client: PoolClient,
  tenantId: string,
  userId?: string,
): Promise<ByokCredential[]> {
  if (userId) {
    const result = await client.query(
      `SELECT c.*, ${LAST_ACTIVITY_SELECT}
       FROM developer_proxy_credentials c
       ${LAST_ACTIVITY_LATERAL}
       WHERE c.tenant_id = $1 AND c.user_id = $2
       ORDER BY c.created_at DESC`,
      [tenantId, userId],
    );
    return result.rows.map(mapRow);
  }

  const result = await client.query(
    `SELECT c.*, ${LAST_ACTIVITY_SELECT}
     FROM developer_proxy_credentials c
     ${LAST_ACTIVITY_LATERAL}
     WHERE c.tenant_id = $1
     ORDER BY c.created_at DESC`,
    [tenantId],
  );
  return result.rows.map(mapRow);
}

// ---------------------------------------------------------------------------
// Revoke by id + tenant (returns true if a row was updated)
// ---------------------------------------------------------------------------

export async function revokeById(
  client: PoolClient,
  id: string,
  tenantId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE developer_proxy_credentials
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND status = 'active'
     RETURNING id`,
    [id, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

// The former updateLastUsed() helper is gone. It had no callers, and its
// no-GUC `UPDATE ... SET last_used_at = NOW()` could never have matched a row
// anyway (see the LAST_ACTIVITY_LATERAL note above). Last activity is derived
// from developer_proxy_usage_log on read.

