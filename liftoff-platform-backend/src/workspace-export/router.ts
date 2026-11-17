// GET /api/workspace-export?tenantId=<uuid>
//
// Order of operations: validate → authorize → advisory lock → rate limit →
// collect everything → build the zip buffer → headers → send. Any failure
// before headers is a JSON error `{ error, code, source? }`; nothing can fail
// after them, because the archive is a buffer by the time a header is set.
//
// Validation runs BEFORE authorization, on the mount. tenantAuthMiddleware
// resolves membership with whatever `?tenantId` holds: absent, it asks for
// the membership of `undefined` and answers 403 instead of the promised 400;
// malformed, the uuid column comparison raises 22P02 and answers 500. So
// index.ts mounts `requireTenantIdQuery` ahead of it. The full chain in
// production is the global Firebase authMiddleware on `/api` (401 whatever the
// query string) → requireTenantIdQuery (400) → tenantAuthMiddleware (403) →
// this router.
//
// Concurrency is a SESSION lock, not a transaction lock: pg_try_advisory_xact_lock
// is released when its statement's transaction ends, which outside an explicit
// transaction is the end of that one statement, so it would protect nothing.
// A session lock lives on the CONNECTION, and pooled connections are reused,
// so a lock that survived cleanup would make every later request on that
// connection see the workspace as EXPORT_IN_PROGRESS forever. The cleanup is
// therefore failure-safe: if the unlock throws or returns false, the client
// is released with an error so pg destroys the connection rather than
// returning it to the pool.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { RateLimiterPostgres, RateLimiterRes } from 'rate-limiter-flexible';
import type { PoolClient } from 'pg';
import { getPool } from '../infrastructure/database';
import { log, logAudit } from '../infrastructure/logging';
import { auditCtx } from '../infrastructure/audit-context';
import { buildWorkspaceExport } from './service';
import { ExportSourceUnavailableError, ExportTooLargeError } from './budget';

export const workspaceExportRouter = Router();

const tenantIdSchema = z.string().uuid();

/** 400 for a missing or malformed `tenantId`, before any membership lookup. */
export function requireTenantIdQuery(req: Request, res: Response, next: NextFunction): void {
  const raw = req.query.tenantId;
  if (raw === undefined || raw === '') {
    res.status(400).json({ error: 'tenantId is required', code: 'TENANT_ID_REQUIRED' });
    return;
  }
  if (typeof raw !== 'string' || !tenantIdSchema.safeParse(raw).success) {
    res.status(400).json({ error: 'tenantId must be a UUID', code: 'TENANT_ID_INVALID' });
    return;
  }
  next();
}

// Five exports per hour per person per workspace, shared across instances
// through the same Postgres-backed limiter billing uses (table
// rate_limiter_billing_internal, migration 172: a generic key/points/expire
// table; the key prefix keeps this surface's counts apart). express-rate-limit's
// default store is per instance and is not used.
const EXPORTS_PER_HOUR = 5;
let _rateLimiter: RateLimiterPostgres | null = null;
function getRateLimiter(): RateLimiterPostgres {
  if (!_rateLimiter) {
    _rateLimiter = new RateLimiterPostgres({
      storeClient: getPool(),
      points: EXPORTS_PER_HOUR,
      duration: 60 * 60,
      tableName: 'rate_limiter_billing_internal',
      tableCreated: true,
      keyPrefix: 'workspace_export',
    });
  }
  return _rateLimiter;
}

const LOCK_KEY_SQL = `hashtextextended('workspace-export:' || $1, 0)`;

/** Hold the workspace's session lock for the length of `fn`, or answer 409. */
async function withWorkspaceLock<T>(
  tenantId: string,
  fn: () => Promise<T>,
): Promise<{ held: true; result: T } | { held: false }> {
  const client: PoolClient = await getPool().connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS locked`,
      [tenantId],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { held: false };
    return { held: true, result: await fn() };
  } finally {
    if (!locked) {
      client.release();
    } else {
      let releaseError: Error | undefined;
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          `SELECT pg_advisory_unlock(${LOCK_KEY_SQL}) AS unlocked`,
          [tenantId],
        );
        if (unlock.rows[0]?.unlocked !== true) {
          releaseError = new Error('workspace-export: advisory unlock returned false');
        }
      } catch (err) {
        releaseError = err instanceof Error ? err : new Error(String(err));
      }
      if (releaseError) {
        log.error({ err: releaseError.message, tenantId }, 'workspace-export: lock cleanup failed; destroying the connection');
        client.release(releaseError);
      } else {
        client.release();
      }
    }
  }
}

/** RFC 6266 / RFC 5987: an ASCII `filename=` and a UTF-8 `filename*=`. The
 *  name is built from a slug, so no path separator or control character can
 *  reach it; the ASCII fallback strips anything else regardless. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

workspaceExportRouter.get('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const verifiedTenantId = req.ctx?.tenantId;
  const actorAccountId = (req as unknown as { actorAccountId?: string }).actorAccountId;
  const membership = (req as unknown as { membership?: { role?: string } }).membership;
  if (!verifiedTenantId || verifiedTenantId !== tenantId || !actorAccountId || !membership?.role) {
    // tenantAuthMiddleware is the only thing that may set these; a router
    // reached without it answers as the middleware would.
    return res.status(403).json({ error: 'Not a member of this tenant', code: 'FORBIDDEN' });
  }
  const audit = auditCtx(req, { tenantId });
  const startedAt = Date.now();

  try {
    const outcome = await withWorkspaceLock(tenantId, async () => {
      try {
        await getRateLimiter().consume(`${tenantId}:${actorAccountId}`, 1);
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          res.setHeader('Retry-After', String(Math.ceil(err.msBeforeNext / 1000)));
          return { status: 429 as const };
        }
        throw err;
      }
      const asOf = new Date();
      const result = await buildWorkspaceExport({
        tenantId,
        actor: { accountId: actorAccountId, role: membership.role as string },
        asOf,
      });
      return { status: 200 as const, asOf, ...result };
    });

    if (!outcome.held) {
      logAudit('compliance.workspace_export_failed', audit, { code: 'EXPORT_IN_PROGRESS' });
      return res.status(409).json({ error: 'An export of this workspace is already in progress', code: 'EXPORT_IN_PROGRESS' });
    }
    if (outcome.result.status === 429) {
      logAudit('compliance.workspace_export_failed', audit, { code: 'RATE_LIMITED' });
      return res.status(429).json({ error: 'Too many exports; try again later', code: 'RATE_LIMITED' });
    }

    const { buffer, filename, counts, asOf } = outcome.result;
    logAudit('compliance.workspace_export_generated', audit, {
      asOf: asOf.toISOString(),
      counts,
      bytes: buffer.length,
      durationMs: Date.now() - startedAt,
    });

    // Abort is detected on the RESPONSE: the request stream closing says
    // nothing about whether the download completed.
    res.on('close', () => {
      if (!res.writableFinished) {
        logAudit('compliance.workspace_export_aborted', audit, { bytes: buffer.length });
      }
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200);
    return res.end(buffer);
  } catch (err) {
    if (err instanceof ExportTooLargeError) {
      logAudit('compliance.workspace_export_failed', audit, { code: 'EXPORT_TOO_LARGE' });
      return res.status(413).json({ error: err.message, code: 'EXPORT_TOO_LARGE' });
    }
    if (err instanceof ExportSourceUnavailableError) {
      log.error({ source: err.source, tenantId, err: (err as { cause?: unknown }).cause instanceof Error ? ((err as { cause?: Error }).cause as Error).message : undefined },
        'workspace-export: a source was unavailable');
      logAudit('compliance.workspace_export_failed', audit, { code: 'EXPORT_SOURCE_UNAVAILABLE', source: err.source });
      return res.status(503).json({
        error: 'A part of the workspace could not be read; try again shortly',
        code: 'EXPORT_SOURCE_UNAVAILABLE',
        source: err.source,
      });
    }
    log.error({ err: (err as Error).message, stack: (err as Error).stack, tenantId }, 'workspace-export: failed');
    logAudit('compliance.workspace_export_failed', audit, { code: 'INTERNAL' });
    return res.status(500).json({ error: 'Export failed', code: 'INTERNAL' });
  }
});
