// LiftoffScore read router.
//
// Mounted at /api/score in src/index.ts behind
// tenantAuthMiddleware('viewAuditLogs'), which verifies the caller is a member
// of the tenant and holds a role that permits it (owner and admin true, member
// false in src/tenant-members/types.ts ROLE_PERMISSIONS). That middleware is
// the only place req.ctx.tenantId is set from a verified membership, so this
// router reads the tenant from there and never from a caller-supplied header.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { LIFTOFF_SCORE_PERIODS } from './service';
import { log } from '../infrastructure/logging';
import { getLiftoffScore } from './service';

export const liftoffScoreRouter = Router();

// Constrained to the presets resolveTimeRange actually knows. It throws on
// anything else, and an unrecognised period is a caller error, not a 500.
const querySchema = z.object({
  tenantId: z.string().uuid(),
  period: z.enum(LIFTOFF_SCORE_PERIODS).default('this_month'),
});

liftoffScoreRouter.get('/', async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
  }

  // tenantAuthMiddleware resolved tenantId from the query string and then
  // verified membership against it before setting req.ctx.tenantId. Reading
  // the verified value keeps the two from drifting.
  const verifiedTenantId = req.ctx?.tenantId;
  if (!verifiedTenantId || verifiedTenantId !== parsed.data.tenantId) {
    return res.status(403).json({ error: 'Not a member of this tenant' });
  }

  try {
    const payload = await getLiftoffScore(verifiedTenantId, parsed.data.period);
    return res.json(payload);
  } catch (error) {
    log.error(
      { tenantId: verifiedTenantId, error: (error as Error).message },
      'score: failed to build payload',
    );
    return res.status(500).json({ error: 'Failed to build LiftoffScore' });
  }
});
