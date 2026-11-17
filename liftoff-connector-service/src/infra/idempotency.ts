// Phase 0t — idempotency store for liftoff-connector-service. Used by
// both the Connect-RPC interceptor (Execute / ExecuteBatch) and the
// REST middleware on OAuth start.

import { createHash } from 'node:crypto';
import { getPool } from '../db/pool.js';

export interface IdempotencyLookupInput {
  tenantId: string;
  userId: string | null;
  rpcName: string;
  key: string;
  requestHash: string;
}

export interface IdempotencyLookupResult<TBody = unknown> {
  hit: 'match' | 'conflict' | 'miss';
  responseStatus?: number;
  responseBody?: TBody;
  responseHeaders?: Record<string, string>;
}

export interface IdempotencyStoreInput<TBody = unknown> extends IdempotencyLookupInput {
  responseStatus: number;
  responseBody: TBody;
  responseHeaders?: Record<string, string>;
}

/**
 * Look up an existing idempotency row under an advisory lock, returning
 * one of three outcomes: match (replay), conflict (422), miss (caller
 * must execute handler + store).
 */
export async function lookupIdempotency<TBody = unknown>(
  input: IdempotencyLookupInput,
): Promise<IdempotencyLookupResult<TBody>> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${input.tenantId}:${input.key}:${input.rpcName}`,
    ]);
    const { rows } = await client.query<{
      request_hash: string;
      response_status: number | null;
      response_body: TBody | null;
      response_headers: Record<string, string> | null;
    }>(
      `SELECT request_hash, response_status, response_body, response_headers
       FROM idempotency_keys
       WHERE tenant_id = $1 AND key = $2 AND rpc_name = $3 AND expires_at > NOW()`,
      [input.tenantId, input.key, input.rpcName],
    );
    await client.query('COMMIT');

    if (rows.length === 0) return { hit: 'miss' };
    const row = rows[0];
    if (row.request_hash !== input.requestHash) return { hit: 'conflict' };
    return {
      hit: 'match',
      responseStatus: row.response_status ?? 200,
      responseBody: (row.response_body ?? undefined) as TBody,
      responseHeaders: row.response_headers ?? undefined,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function storeIdempotency<TBody = unknown>(
  input: IdempotencyStoreInput<TBody>,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO idempotency_keys (
       tenant_id, user_id, rpc_name, endpoint, key,
       request_hash, response_status, response_body, response_headers
     ) VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, key, rpc_name) DO NOTHING`,
    [
      input.tenantId,
      input.userId,
      input.rpcName,
      input.key,
      input.requestHash,
      input.responseStatus,
      input.responseBody === null ? null : JSON.stringify(input.responseBody),
      input.responseHeaders ? JSON.stringify(input.responseHeaders) : null,
    ],
  );
}

export function hashCanonicalJson(value: unknown): string {
  const normalized = value === undefined ? '' : JSON.stringify(value);
  return createHash('sha256').update(normalized).digest('hex');
}

/** Request fields that identify the CALL rather than the act: a caller mints
 *  a fresh trace id per attempt, and the key itself is the lookup, not the
 *  content. Hashing them made every retry a conflict, never a replay. */
const NON_SEMANTIC_REQUEST_FIELDS = new Set(['traceId', 'trace_id', 'idempotencyKey', 'idempotency_key']);

/**
 * The hash of what a request asks for, independent of how it was carried.
 * Keys are ordered so two encodings of one request agree.
 */
export function hashSemanticRequest(message: unknown): string {
  return createHash('sha256').update(canonicalize(message, true)).digest('hex');
}

function canonicalize(value: unknown, top: boolean): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v, false)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k, v]) => v !== undefined && !(top && NON_SEMANTIC_REQUEST_FIELDS.has(k)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, false)}`).join(',')}}`;
}

/** How long a claimed key may sit without a response before another caller
 *  may take it over — a caller that died mid-execution must not hold the key
 *  for the row's whole 24-hour life. */
export const IDEMPOTENCY_IN_FLIGHT_MS = 10 * 60_000;

export type IdempotencyClaim<TBody = unknown> =
  | { kind: 'owned' }
  | { kind: 'match'; responseStatus: number; responseBody: TBody; responseHeaders?: Record<string, string> }
  | { kind: 'conflict' }
  | { kind: 'in_flight' };

/**
 * Claim a key before executing, so that two concurrent misses cannot both run.
 *
 * The row IS the claim: an INSERT with no response is "being executed", and
 * the unique constraint decides who owns it. A caller that loses the insert
 * reads the row it lost to — a stored response replays, a different request
 * conflicts, a fresh claim is in flight, and a claim past the in-flight
 * window is taken over. No lock is held across the vendor call.
 */
export async function claimIdempotency<TBody = unknown>(
  input: IdempotencyLookupInput,
  inFlightMs = IDEMPOTENCY_IN_FLIGHT_MS,
): Promise<IdempotencyClaim<TBody>> {
  const pool = await getPool();
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (
       tenant_id, user_id, rpc_name, endpoint, key, request_hash
     ) VALUES ($1, $2, $3, $3, $4, $5)
     ON CONFLICT (tenant_id, key, rpc_name) DO NOTHING
     RETURNING id`,
    [input.tenantId, input.userId, input.rpcName, input.key, input.requestHash],
  );
  if (inserted.rows.length > 0) return { kind: 'owned' };

  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await pool.query<{
      request_hash: string;
      response_status: number | null;
      response_body: TBody | null;
      response_headers: Record<string, string> | null;
      created_at: string;
      expires_at: string;
    }>(
      `SELECT request_hash, response_status, response_body, response_headers, created_at, expires_at
       FROM idempotency_keys
       WHERE tenant_id = $1 AND key = $2 AND rpc_name = $3`,
      [input.tenantId, input.key, input.rpcName],
    );
    const row = rows[0];
    if (!row) {
      // Expired and swept between the insert and this read: claim again.
      const again = await pool.query(
        `INSERT INTO idempotency_keys (tenant_id, user_id, rpc_name, endpoint, key, request_hash)
         VALUES ($1, $2, $3, $3, $4, $5) ON CONFLICT (tenant_id, key, rpc_name) DO NOTHING RETURNING id`,
        [input.tenantId, input.userId, input.rpcName, input.key, input.requestHash],
      );
      if (again.rows.length > 0) return { kind: 'owned' };
      continue;
    }
    if (row.response_status !== null) {
      if (row.request_hash !== input.requestHash) return { kind: 'conflict' };
      return {
        kind: 'match',
        responseStatus: row.response_status,
        responseBody: (row.response_body ?? undefined) as TBody,
        responseHeaders: row.response_headers ?? undefined,
      };
    }
    // Pending. Fresh means someone is executing it now; stale means they died.
    const age = Date.now() - new Date(row.created_at).getTime();
    if (row.request_hash !== input.requestHash && age <= inFlightMs) return { kind: 'conflict' };
    if (age <= inFlightMs) return { kind: 'in_flight' };
    const taken = await pool.query(
      `UPDATE idempotency_keys
          SET request_hash = $4, user_id = $5, created_at = NOW(), expires_at = NOW() + INTERVAL '24 hours'
        WHERE tenant_id = $1 AND key = $2 AND rpc_name = $3
          AND response_status IS NULL
          AND created_at < NOW() - ($6 || ' milliseconds')::interval
        RETURNING id`,
      [input.tenantId, input.key, input.rpcName, input.requestHash, input.userId, String(inFlightMs)],
    );
    if (taken.rows.length > 0) return { kind: 'owned' };
  }
  return { kind: 'in_flight' };
}

/** Record the response on the row this caller owns. */
export async function completeIdempotency<TBody = unknown>(
  input: IdempotencyStoreInput<TBody>,
): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE idempotency_keys
        SET response_status = $4, response_body = $5, response_headers = $6
      WHERE tenant_id = $1 AND key = $2 AND rpc_name = $3 AND response_status IS NULL`,
    [
      input.tenantId,
      input.key,
      input.rpcName,
      input.responseStatus,
      input.responseBody === null ? null : JSON.stringify(input.responseBody),
      input.responseHeaders ? JSON.stringify(input.responseHeaders) : null,
    ],
  );
}

/** Give a claim back when execution threw: the act did not happen, and a
 *  retry with the same key must be able to run rather than wait out the
 *  in-flight window. */
export async function releaseIdempotency(input: IdempotencyLookupInput): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `DELETE FROM idempotency_keys
      WHERE tenant_id = $1 AND key = $2 AND rpc_name = $3 AND response_status IS NULL`,
    [input.tenantId, input.key, input.rpcName],
  );
}
