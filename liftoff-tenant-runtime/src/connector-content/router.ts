// Connector Content Router
//
// Internal API for searching, deleting, and maintaining the connector_content
// table. All routes require service auth — the assertEveryRouteHasAuthAnnotation
// boot check enforces this at startup.
//
// Mount at /api/internal/connector-content in src/index.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { searchConnectorContent, connectorContentCoverage } from './search-service';

export const connectorContentRouter = Router();

// All routes on this router require service auth.
connectorContentRouter.use(requireServiceAuth());

// ---------------------------------------------------------------------------
// GET /search
// ---------------------------------------------------------------------------
connectorContentRouter.get('/search', async (req: Request, res: Response) => {
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      query: z.string().min(1).max(10000),
      connectorType: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      agentId: z.string().uuid().optional(),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
  }

  try {
    const [results, coverage] = await Promise.all([
      searchConnectorContent({
        tenantId: parsed.data.tenantId,
        query: parsed.data.query,
        connectorType: parsed.data.connectorType,
        limit: parsed.data.limit,
        agentId: parsed.data.agentId,
      }),
      connectorContentCoverage(parsed.data.tenantId, parsed.data.connectorType),
    ]);
    res.json({ results, coverage });
  } catch (err) {
    log.error({ err }, 'connector-content search failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /
// Delete all rows for (tenant_id, connector_type)
// ---------------------------------------------------------------------------
connectorContentRouter.delete('/', async (req: Request, res: Response) => {
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      connectorType: z.string().min(1),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
  }

  try {
    // connector_content is FORCE RLS (372): off a scope the policy raises.
    const result = await withTenantScope(parsed.data.tenantId, (client) =>
      client.query(
        'DELETE FROM connector_content WHERE tenant_id = $1 AND connector_type = $2',
        [parsed.data.tenantId, parsed.data.connectorType],
      ),
    );
    res.json({ deletedCount: result.rowCount ?? 0 });
  } catch (err) {
    log.error({ err }, 'connector-content delete failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /maintenance/expire-connector-content
// Delete expired rows for a tenant in batches of 1000.
// ---------------------------------------------------------------------------
connectorContentRouter.post(
  '/maintenance/expire-connector-content',
  async (req: Request, res: Response) => {
    const parsed = z
      .object({ tenantId: z.string().uuid() })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
    }

    const { tenantId } = parsed.data;
    let totalDeleted = 0;

    try {
      while (true) {
        const result = await withTenantScope(tenantId, (client) =>
          client.query(
            `DELETE FROM connector_content
             WHERE id IN (
               SELECT id FROM connector_content
               WHERE tenant_id = $1 AND expires_at <= NOW()
               LIMIT 1000
             )`,
            [tenantId],
          ),
        );
        const deleted = result.rowCount ?? 0;
        totalDeleted += deleted;
        if (deleted === 0) break;
      }

      res.json({ deletedCount: totalDeleted });
    } catch (err) {
      log.error({ err, tenantId }, 'connector-content expire maintenance failed');
      res.status(500).json({ error: (err as Error).message });
    }
  },
);
