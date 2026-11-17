/**
 * R5 Fix 9: DELETE /api/interactive-chat/:agentId/threads/:threadId/workspace
 *
 * - Service auth (X-Service-Auth)
 * - Tenant ownership verification (x-tenant-id middleware)
 * - UUID validation
 * - Path traversal guard (UUID-constrained path construction)
 * - DB-backed per-tenant rate limit (10/min, workspace_delete_events table)
 * - Cloud Run ingress=internal (not public)
 * - scrubLogger for audit trail
 */
import { promises as fs } from 'fs';
import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Pool } from 'pg';
import { scrubLogger } from '../observability/scrub-logger';
import { CHAT_WORKSPACE_ROOT } from '../agent-execution/engine/workspace-reaper';
import { getManagedSecret } from '../infrastructure/secret-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE_LIMIT_PER_MIN = 10;

interface TenantCtx {
  tenantId: string;
}
interface ReqWithCtx extends Request {
  ctx?: TenantCtx;
}

function assertServiceAuth(req: Request): void {
  const provided = req.headers['x-service-auth'];
  const expected = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');
  if (!expected) throw new Error('service token not configured');
  if (typeof provided !== 'string' || provided !== expected) {
    const err = new Error('missing or invalid service auth') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
}

async function checkRateLimit(pool: Pool, tenantId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Cleanup rows older than 25h (bounded growth)
    await client.query(
      `DELETE FROM workspace_delete_events
       WHERE tenant_id = $1 AND deleted_at < NOW() - INTERVAL '25 hours'`,
      [tenantId],
    );
    const countResult = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM workspace_delete_events
       WHERE tenant_id = $1 AND deleted_at > NOW() - INTERVAL '1 minute'`,
      [tenantId],
    );
    const n = parseInt(countResult.rows[0]?.n ?? '0', 10);
    if (n >= RATE_LIMIT_PER_MIN) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`INSERT INTO workspace_delete_events (tenant_id) VALUES ($1)`, [tenantId]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // swallow
    }
    throw err;
  } finally {
    client.release();
  }
}

export function buildWorkspaceDeleteRouter(pool: Pool): Router {
  const router = Router();

  router.delete(
    '/api/interactive-chat/:agentId/threads/:threadId/workspace',
    async (req: ReqWithCtx, res: Response, next: NextFunction) => {
      try {
        assertServiceAuth(req);

        const tenantId = req.ctx?.tenantId;
        if (!tenantId || !UUID_RE.test(tenantId)) {
          return res.status(400).json({ error: 'invalid tenant context' });
        }

        const { threadId, agentId } = req.params;
        if (!UUID_RE.test(threadId) || !UUID_RE.test(agentId)) {
          return res.status(400).json({ error: 'invalid UUID params' });
        }

        const allowed = await checkRateLimit(pool, tenantId);
        if (!allowed) {
          return res.status(429).json({ error: 'rate limited' });
        }

        // Construct workspace path from validated UUIDs only — no user input in path.
        const wsPath = path.join(CHAT_WORKSPACE_ROOT, tenantId, threadId);
        const canonical = path.resolve(wsPath);
        if (!canonical.startsWith(path.resolve(CHAT_WORKSPACE_ROOT) + path.sep)) {
          return res.status(400).json({ error: 'path traversal' });
        }

        await fs.rm(canonical, { recursive: true, force: true });
        scrubLogger.info({ event: 'workspace_deleted', tenantId, threadId });
        return res.status(204).send();
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode ?? 500;
        if (code !== 401) {
          scrubLogger.error({
            event: 'chat_turn_failed',
            error: (err as Error).message,
            stage: 'workspace_delete',
          });
        }
        if (res.headersSent) return next(err);
        return res.status(code).json({ error: (err as Error).message });
      }
    },
  );

  return router;
}
