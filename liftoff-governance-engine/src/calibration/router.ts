// calibration cron router. Mounted at /api/governance/calibration (service-auth gated by
// the app-level verifyServiceAuth in server.ts). Cloud Scheduler POSTs /run weekly.

import { Router, Request, Response } from 'express';
import { runCalibrationSweep } from './service';
import { log } from '../infrastructure/logging';

export const calibrationRouter = Router();

// POST /api/governance/calibration/run — run the weekly sweep across all tenants + constants.
calibrationRouter.post('/run', async (_req: Request, res: Response) => {
  try {
    const summary = await runCalibrationSweep();
    return res.json({ status: 'completed', ...summary });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'calibration sweep failed');
    return res.status(500).json({ error: 'sweep_failed' });
  }
});
