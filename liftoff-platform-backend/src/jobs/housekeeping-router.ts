// The two entry points of on-demand maintenance that are not themselves a
// maintenance job: the daily pass, and the "spend happened" poke from a
// service that cannot arm platform-backend's queue itself.

import { Router, type Request, type Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { validateServiceAuth } from './_serviceAuth';
import { enqueueDailyHousekeeping } from './housekeeping';
import { armCostIngest } from './maintenance-targets';
import { log } from '../infrastructure/logging';

export const housekeepingRouter = Router();

// POST /api/internal/jobs/housekeeping/daily — the one Cloud Scheduler job.
housekeepingRouter.post('/housekeeping/daily', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    res.json(await enqueueDailyHousekeeping());
  } catch (err) {
    log.error({ err: (err as Error).message }, 'daily housekeeping enqueue failed');
    res.status(500).json({ error: 'daily housekeeping enqueue failed' });
  }
});

// POST /api/internal/jobs/cost-attribution-ingest/soon
//
// developer-proxy records usage in its own database, which the cost pass reads
// over its feed; nothing in this service sees that spend happen. It calls this
// after recording usage, with the token it already sends to the audit-log
// route, and the cost pass is armed to read developer-proxy's feed.
housekeepingRouter.post(
  '/cost-attribution-ingest/soon',
  verifyServiceAuth(),
  (_req: Request, res: Response) => {
    armCostIngest('developer-proxy');
    res.status(202).json({ ok: true });
  },
);
