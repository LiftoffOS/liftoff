// Service-to-service router for tenant-runtime → platform-backend oversight
// reads. The user-facing router under /api/internal-agent-oversight is gated
// by tenantAuthMiddleware (Firebase/per-user auth); tenant-runtime can't
// authenticate as a human, so we expose a parallel service-auth surface here
// using the shared TENANT_RUNTIME_SERVICE_TOKEN.
//
// Why this exists: TR's hitl-enforcement was cache-only; on cache miss it
// returned null, and tool-interceptor.ts `if (!oversight) return toolCall`
// silently bypassed `communication: 'draft'`. The fix is to never let TR see
// a null result for a tenant that has settings in PB — make TR cache-aside
// against this endpoint as the authoritative source.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { oversightService } from './service';
import { logger } from '../infrastructure/logging';

export const oversightInternalRouter = Router();

const svcAuth = verifyServiceAuth(); // defaults to TENANT_RUNTIME_SERVICE_TOKEN

const paramSchema = z.object({
  tenantId: z.string().uuid(),
});

/**
 * GET /api/internal/oversight/:tenantId
 *
 * Returns the authoritative oversight settings for the tenant. If no row
 * exists yet, this lazily creates one with platform defaults (matching the
 * user-facing GET path's behavior via `getOrCreateOversightSettings`). This
 * keeps the contract simple for callers: a 200 always returns valid
 * settings — no null, no 404 for "never configured".
 */
oversightInternalRouter.get(
  '/:tenantId',
  svcAuth,
  async (req: Request, res: Response) => {
    const parsed = paramSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_tenant_id' });
    }
    const { tenantId } = parsed.data;
    try {
      const settings = await oversightService.getOrCreateOversightSettings(tenantId);
      return res.json(settings);
    } catch (err) {
      logger.error(
        { tenantId, err: (err as Error).message },
        'internal oversight GET failed',
      );
      return res.status(500).json({ error: 'internal_error' });
    }
  },
);
