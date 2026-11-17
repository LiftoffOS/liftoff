// Harvest Service Internal Router
//
// Internal API endpoints used by liftoff-harvest-service:
//   GET /api/internal/tenants/:tenantId/features/harvest
//     → { enabled: boolean }  (TENANT-OPT-001 per-tenant killswitch)
//   GET /api/internal/connectors/:connectorId/tenant
//     → { tenantId: string }  (SEC-001 connector-ownership validation)
//
// Auth: HARVEST_SERVICE_TOKEN via X-Service-Auth header (timing-safe).
// Mounted BEFORE authMiddleware in index.ts.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getConnectorOwner } from '../connectors/connector-service-client';

export const harvestInternalRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  if (!serviceToken) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }

  const expected = process.env.HARVEST_SERVICE_TOKEN;
  if (!expected) {
    res.status(503).json({ error: 'Harvest service not configured' });
    return;
  }

  let matched = false;
  try {
    matched =
      Buffer.byteLength(serviceToken) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expected));
  } catch {
    matched = false;
  }

  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }

  next();
}

// GET /api/internal/tenants/:tenantId/features/harvest
harvestInternalRouter.get('/tenants/:tenantId/features/harvest', serviceAuth, async (req: Request, res: Response, next: (err?: unknown) => void) => {
  const { tenantId } = req.params;
  if (!UUID_RE.test(tenantId)) {
    res.status(400).json({ error: 'Invalid tenantId' });
    return;
  }

  try {
    const result = await getPool().query<{ harvest_enabled: boolean }>(
      'SELECT harvest_enabled FROM tenants WHERE id = $1',
      [tenantId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json({ enabled: result.rows[0].harvest_enabled });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'harvest features lookup failed');
    next(err);
  }
});

// GET /api/internal/tenants/:tenantId/runtime-url
//   → { url: string }
//
// harvest-service resolves the per-tenant runtime base URL (memory-client
// `resolveRuntimeUrl`) so it can erase connector-scoped memories in the tenant
// runtime on a `connector.deleted` event.
//
// Contract: harvest nacks on ANY non-200 (its connector.deleted handler treats
// them all as retryable), and the outbox-ack reconciler keeps republishing the
// event until harvest acknowledges — so a 404 here poison-loops the
// subscription indefinitely. This endpoint must therefore resolve a URL for
// every EXISTING tenant. tenants.runtime_url may legitimately be NULL
// (shared-hosting tenants provisioned while SHARED_RUNTIME_URL was unset), so
// resolution goes through resolveRuntimeBaseUrl, which falls back to the
// TENANT_RUNTIME_URL env — the same convention as every other runtime-URL
// consumer in this repo. 404 is reserved for a genuinely unknown tenant; the
// existence check stays here because resolveRuntimeBaseUrl env-falls-back even
// for tenant ids that do not exist.
harvestInternalRouter.get('/tenants/:tenantId/runtime-url', serviceAuth, async (req: Request, res: Response, next: (err?: unknown) => void) => {
  const { tenantId } = req.params;
  if (!UUID_RE.test(tenantId)) {
    res.status(400).json({ error: 'Invalid tenantId' });
    return;
  }

  try {
    const result = await getPool().query<{ runtime_url: string | null }>(
      'SELECT runtime_url FROM tenants WHERE id = $1',
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    const { resolveRuntimeBaseUrl } = await import('../connectors/tenant-runtime-url');
    res.json({ url: await resolveRuntimeBaseUrl(tenantId) });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'runtime-url lookup failed');
    next(err);
  }
});

// GET /api/internal/connectors/:connectorId/tenant
harvestInternalRouter.get('/connectors/:connectorId/tenant', serviceAuth, async (req: Request, res: Response, next: (err?: unknown) => void) => {
  const { connectorId } = req.params;
  if (!UUID_RE.test(connectorId)) {
    res.status(400).json({ error: 'Invalid connectorId' });
    return;
  }

  try {
    // Ask connector-service, which owns connector rows. This used to read the
    // local `connectors` table, which has held only pre-cutover rows since
    // Phase 2a (INV-PB-012): every connector created after it resolved to
    // "not found" here, and harvest nacks on any non-200, so a live connector
    // looked deleted and its message retried until it aged out.
    const owner = await getConnectorOwner(connectorId);
    if (!owner) {
      res.status(404).json({ error: 'Connector not found' });
      return;
    }
    res.json({ tenantId: owner.tenantId });
  } catch (err) {
    log.error({ error: (err as Error).message, connectorId }, 'connector tenant lookup failed');
    next(err);
  }
});

// GET /harvest/enabled-tenants
// Returns all tenant IDs where harvest_enabled = true and status = 'active'.
// Used by harvest-service's monthly re-harvest Cloud Run Job.
harvestInternalRouter.get(
  '/harvest/enabled-tenants',
  serviceAuth,
  async (req: Request, res: Response, next: (err?: unknown) => void) => {
    try {
      const result = await getPool().query<{ id: string }>(
        `SELECT id FROM tenants WHERE harvest_enabled = true AND status = 'active'`,
      );
      res.json({ tenantIds: result.rows.map((r) => r.id) });
    } catch (err) {
      log.error({ error: (err as Error).message }, 'harvest enabled-tenants lookup failed');
      next(err);
    }
  },
);
