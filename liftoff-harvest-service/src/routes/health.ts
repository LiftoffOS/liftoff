import { Router, Request, Response } from 'express';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/ready', async (_req: Request, res: Response) => {
  try {
    await getPool().query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'readiness check failed');
    res.status(503).json({ status: 'not_ready', error: (err as Error).message });
  }
});

export default router;
