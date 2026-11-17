// src/infrastructure/idempotency.ts
import { getPool, withTenantScope } from './database'

export interface IdempotencyResult<T> {
  cached: boolean
  response: T
  status: number
}

/**
 * FIX: BE-002/SE-003 - Race condition prevention using advisory locks
 *
 * Uses pg_advisory_xact_lock to serialize concurrent requests with the same
 * idempotency key. This prevents the TOCTOU race where two concurrent requests
 * both pass the "check for existing" step and execute the operation.
 */
export async function withIdempotency<T>(
  tenantId: string,
  idempotencyKey: string,
  endpoint: string,
  requestHash: string,
  operation: () => Promise<{ status: number; body: T }>
): Promise<IdempotencyResult<T>> {
  const pool = getPool()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    // RLS: scope this own-transaction to the tenant before the idempotency_keys
    // read/write. FORCE-safe; set_config is transaction-local (not withTenantScope
    // because this owns the BEGIN + advisory lock).
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId])

    // 1. Acquire advisory lock on the idempotency key (blocks concurrent requests)
    // Use hashtext to convert the composite key to a bigint for pg_advisory_xact_lock
    const lockKey = `${tenantId}:${idempotencyKey}:${endpoint}`
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [lockKey]
    )

    // 2. Check for existing result (now safe - we hold the lock)
    const existing = await client.query(
      `SELECT response_status, response_body, request_hash FROM idempotency_keys
       WHERE tenant_id = $1 AND key = $2 AND endpoint = $3
       AND expires_at > NOW()`,
      [tenantId, idempotencyKey, endpoint]
    )

    if (existing.rows.length > 0) {
      // 3. Verify request hash matches (same key must have same payload)
      if (existing.rows[0].request_hash !== requestHash) {
        await client.query('ROLLBACK')
        throw new IdempotencyConflictError(
          'Idempotency key reused with different request body'
        )
      }

      await client.query('COMMIT')
      return {
        cached: true,
        response: existing.rows[0].response_body,
        status: existing.rows[0].response_status,
      }
    }

    // 4. No existing result - execute operation
    const result = await operation()

    // 5. Store result
    await client.query(
      `INSERT INTO idempotency_keys (tenant_id, key, endpoint, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, idempotencyKey, endpoint, requestHash, result.status, JSON.stringify(result.body)]
    )

    await client.query('COMMIT')

    return {
      cached: false,
      response: result.body,
      status: result.status,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

// ── Claim / settle ────────────────────────────────────────────────────────
//
// For an operation that must run at most once but must NOT hold a database
// transaction while it runs: a workspace action confirmed from chat, whose
// apply may be a server-side distil measured in minutes and may write to
// another service before it returns. withIdempotency above opens BEGIN and an
// advisory lock on one pooled connection before `operation()` and records the
// result only afterwards, so a long apply pins a connection and a crash after
// an external write leaves nothing to stop a replay.
//
// Two short statements on the same table instead. claim INSERTs the row with
// no response (its own scope; committed before the operation starts); a
// second claim of the same key finds the row and answers replay, conflict or
// unresolved. settle records the result. A crash between the two leaves the
// row unresolved, and unresolved is refused — fail closed: the operation can
// never re-execute on its own, and the row expires with the table's default.

export type IdempotencyClaim =
  | 'claimed'
  | { replay: { status: number; body: unknown } }
  | 'unresolved'
  | 'conflict'

export async function claimIdempotencyKey(
  tenantId: string,
  key: string,
  endpoint: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  return withTenantScope(tenantId, async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (tenant_id, key, endpoint, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, NULL, NULL)
       ON CONFLICT (tenant_id, key, endpoint) DO NOTHING
       RETURNING id`,
      [tenantId, key, endpoint, requestHash],
    )
    if (inserted.rows.length > 0) return 'claimed'
    const existing = await client.query(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys
       WHERE tenant_id = $1 AND key = $2 AND endpoint = $3`,
      [tenantId, key, endpoint],
    )
    const row = existing.rows[0] as
      | { request_hash: string; response_status: number | null; response_body: unknown }
      | undefined
    // The row vanished between the two statements (expiry cleanup): refusing
    // is the safe answer for this attempt.
    if (!row) return 'unresolved'
    if (row.request_hash !== requestHash) return 'conflict'
    if (row.response_status === null) return 'unresolved'
    return { replay: { status: row.response_status, body: row.response_body } }
  })
}

export async function settleIdempotencyKey(
  tenantId: string,
  key: string,
  endpoint: string,
  status: number,
  body: unknown,
): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE idempotency_keys SET response_status = $4, response_body = $5
     WHERE tenant_id = $1 AND key = $2 AND endpoint = $3 AND response_status IS NULL`,
    [tenantId, key, endpoint, status, JSON.stringify(body)],
  ))
}
