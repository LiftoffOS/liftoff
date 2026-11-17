// Capability Tokens — one-use, scoped, short-lived provisioning authority tokens.
//
// A capability token is minted at approve-time and handed to the HRBP provisioner.
// The provisioner burns it at the start of the run, proving it was invoked by a
// legitimate approval flow and not by a replay or rogue caller.
//
// Storage: capability_tokens table (migration 006).
// HMAC-SHA256 of the raw hex token is stored — the raw token is never persisted.

import { createHmac, randomBytes } from 'node:crypto';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';

function getSecret(): string {
  return loadConfig().CAPABILITY_TOKEN_SECRET;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Mint a one-use capability token for the given plan / tenant / scope.
 *
 * Generates 32 random bytes as the raw token (hex), computes an HMAC-SHA256
 * hash, persists the hash to the DB, and returns the raw token to the caller.
 * The raw token is never stored — only the hash.
 *
 * @param planId     UUID of the workforce plan being approved.
 * @param tenantId   UUID of the tenant that owns the plan.
 * @param accountId  UUID of the account that approved the plan.
 * @param scope      Arbitrary scope string (e.g. `hrbp.provision.<planId>`).
 * @param ttlSeconds Token lifetime in seconds (default 3600).
 * @returns          The raw hex token. Pass this to the provisioner.
 */
export async function mintCapabilityToken(
  planId: string,
  tenantId: string,
  accountId: string,
  scope: string,
  ttlSeconds = 3600,
): Promise<string> {
  const secret = getSecret();
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHmac('sha256', secret).update(rawToken).digest('hex');

  const pool = getPool();
  await pool.query(
    `INSERT INTO capability_tokens
       (plan_id, tenant_id, account_id, scope, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::interval)`,
    [planId, tenantId, accountId, scope, tokenHash, String(ttlSeconds)],
  );

  return rawToken;
}

/**
 * Validate and atomically consume (burn) a capability token.
 *
 * Computes the HMAC of `rawToken` and attempts to mark the matching DB row
 * as used in a single UPDATE … RETURNING query. If no row is updated (token
 * not found, wrong plan/tenant/scope, already used, or expired) throws an
 * error with `code: 'CAPABILITY_TOKEN_INVALID'`.
 *
 * @throws {{ code: 'CAPABILITY_TOKEN_INVALID'; message: string }}
 */
export async function validateAndBurnCapabilityToken(
  rawToken: string,
  planId: string,
  tenantId: string,
  scope: string,
): Promise<void> {
  const secret = getSecret();
  const tokenHash = createHmac('sha256', secret).update(rawToken).digest('hex');

  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `UPDATE capability_tokens
        SET used_at = NOW()
      WHERE token_hash = $1
        AND plan_id    = $2
        AND tenant_id  = $3
        AND scope      = $4
        AND used_at   IS NULL
        AND expires_at > NOW()
      RETURNING id`,
    [tokenHash, planId, tenantId, scope],
  );

  if (result.rowCount === 0) {
    const err = new Error('Capability token is invalid, already used, or expired') as Error & {
      code: string;
    };
    err.code = 'CAPABILITY_TOKEN_INVALID';
    throw err;
  }
}

/**
 * Delete expired tokens that have also been used. Returns the number of rows
 * deleted. Safe to call on a periodic schedule (e.g. daily cron).
 */
export async function pruneExpiredCapabilityTokens(): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM capability_tokens
      WHERE expires_at < NOW()
        AND used_at IS NOT NULL`,
  );
  return result.rowCount ?? 0;
}
