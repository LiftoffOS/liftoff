// Phase 0t — HTTP middleware wrapping `withIdempotency` for the
// mutating endpoints HRBP (workforce-service) will call during plan
// provisioning. Short-circuits when no `Idempotency-Key` header is
// present so callers that don't use the feature are unaffected.
//
// Semantics (plan 0t):
//   - Duplicate key + same body hash → replay byte-identically with
//     `X-Liftoff-Idempotent-Replay: true`.
//   - Duplicate key + different body hash → 422 Unprocessable Entity.
//   - New key → execute handler; capture status/body/headers; persist
//     with 24-hour TTL.
//
// The store is the `idempotency_keys` table (migration 032 + 128).

import { createHash } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { getPool, withTenantScope } from './database'

const IDEMPOTENCY_HEADER = 'idempotency-key'
const REPLAY_HEADER = 'x-idempotent-replay'

export interface IdempotencyMiddlewareOptions {
  /** Stable endpoint identifier, e.g. `POST /api/internal-agents`. */
  endpoint: string
  /** Request → tenantId. Defaults to `req.ctx?.tenantId` when present. */
  extractTenantId?: (req: Request) => string | null
  /** Request → userId. Nullable. Defaults to `req.ctx?.userId`. */
  extractUserId?: (req: Request) => string | null
}

interface StoredEntry {
  request_hash: string
  response_status: number | null
  response_body: unknown
  response_headers: Record<string, string> | null
}

/**
 * Express middleware. Uses pg_advisory_xact_lock to serialize concurrent
 * requests with the same idempotency key (prevents TOCTOU).
 */
export function withIdempotencyMiddleware(options: IdempotencyMiddlewareOptions) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const raw = req.headers[IDEMPOTENCY_HEADER]
    const idempotencyKey = Array.isArray(raw) ? raw[0] : raw
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return next()
    }

    const tenantId = (options.extractTenantId ?? defaultTenantId)(req)
    if (!tenantId) {
      res.status(400).json({
        error: 'idempotency_requires_tenant',
        message: 'Idempotency-Key can only be used on tenant-scoped requests',
      })
      return
    }
    const userId = (options.extractUserId ?? defaultUserId)(req)
    const requestHash = hashBody(req.body)

    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // RLS: scope this own-transaction to the tenant before the idempotency_keys
      // read/write (FORCE-safe; transaction-local).
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId])
      const lockKey = `${tenantId}:${idempotencyKey}:${options.endpoint}`
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey])

      const existing = await client.query<StoredEntry>(
        `SELECT request_hash, response_status, response_body, response_headers
         FROM idempotency_keys
         WHERE tenant_id = $1 AND key = $2 AND endpoint = $3 AND expires_at > NOW()`,
        [tenantId, idempotencyKey, options.endpoint],
      )

      if (existing.rows.length > 0) {
        const row = existing.rows[0]
        if (row.request_hash !== requestHash) {
          await client.query('ROLLBACK')
          res.status(422).json({
            error: 'idempotency_key_conflict',
            message: 'Same Idempotency-Key used with a different request body',
          })
          return
        }
        await client.query('COMMIT')
        if (row.response_headers) {
          for (const [name, value] of Object.entries(row.response_headers)) {
            res.setHeader(name, value)
          }
        }
        res.setHeader(REPLAY_HEADER, 'true')
        res.status(row.response_status ?? 200).json(row.response_body)
        return
      }

      // ── New key: capture response, persist after handler completes ──
      await client.query('COMMIT')
      client.release()

      const captured = wrapResponseForCapture(res)
      // On `finish`, record the captured response. Only success + 4xx
      // responses are cached; 5xx is treated as transient and allowed
      // to retry.
      res.on('finish', () => {
        const status = captured.status ?? 200
        if (status >= 500) return
        void persistIdempotencyKey({
          tenantId,
          key: idempotencyKey,
          endpoint: options.endpoint,
          userId,
          requestHash,
          responseStatus: status,
          responseBody: captured.body,
          responseHeaders: captured.headers,
        })
      })
      next()
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore */
      }
      next(err)
    }
  }
}

interface CapturedResponse {
  status: number | null
  body: unknown
  headers: Record<string, string>
}

function wrapResponseForCapture(res: Response): CapturedResponse {
  const captured: CapturedResponse = { status: null, body: null, headers: {} }

  const originalStatus = res.status.bind(res)
  res.status = (code: number) => {
    captured.status = code
    return originalStatus(code)
  }

  const originalJson = res.json.bind(res)
  res.json = (body: unknown) => {
    captured.body = body
    // Snapshot the current header state — getHeaders() is the public
    // API that returns {name: value}.
    const hdrs = res.getHeaders()
    for (const [k, v] of Object.entries(hdrs)) {
      if (typeof v === 'string') captured.headers[k] = v
      else if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') captured.headers[k] = v[0]
      else if (typeof v === 'number') captured.headers[k] = String(v)
    }
    return originalJson(body)
  }

  return captured
}

interface PersistParams {
  tenantId: string
  key: string
  endpoint: string
  userId: string | null
  requestHash: string
  responseStatus: number
  responseBody: unknown
  responseHeaders: Record<string, string>
}

async function persistIdempotencyKey(p: PersistParams): Promise<void> {
  try {
    await withTenantScope(p.tenantId, (client) => client.query(
      `INSERT INTO idempotency_keys (
         tenant_id, key, endpoint, request_hash, user_id,
         response_status, response_body, response_headers
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, key, endpoint) DO NOTHING`,
      [
        p.tenantId,
        p.key,
        p.endpoint,
        p.requestHash,
        p.userId,
        p.responseStatus,
        p.responseBody === null ? null : JSON.stringify(p.responseBody),
        JSON.stringify(p.responseHeaders),
      ],
    ))
  } catch {
    // Swallow — persistence is best-effort; client already received a
    // response. Failure to cache just means the next identical request
    // re-executes the handler.
  }
}

function hashBody(body: unknown): string {
  const normalized = body === undefined ? '' : JSON.stringify(body)
  return createHash('sha256').update(normalized).digest('hex')
}

function defaultTenantId(req: Request): string | null {
  const ctx = (req as Request & { ctx?: { tenantId?: string } }).ctx
  return ctx?.tenantId ?? null
}

function defaultUserId(req: Request): string | null {
  const ctx = (req as Request & { ctx?: { userId?: string } }).ctx
  return ctx?.userId ?? null
}
