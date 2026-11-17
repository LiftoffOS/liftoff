// Internal maintenance endpoints, driven by Cloud Scheduler (OIDC, verified by
// Cloud Run IAM at ingress). This replaces the in-process setInterval dedup GC,
// which required the instance to stay alive to hold the timer and so never ran
// at min-instances=0. A scheduler now wakes the service hourly, runs one GC
// pass, and the service scales back to zero.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { runGC } from '../dedup-gc';

const router = Router();

router.post('/dedup-gc', async (_req: Request, res: Response) => {
  try {
    await runGC();
    res.status(204).end();
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'dedup-gc endpoint failed');
    res.status(500).end();
  }
});

export default router;
