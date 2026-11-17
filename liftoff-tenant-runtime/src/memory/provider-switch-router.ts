// HTTP wrapper for the embedding provider-switch operation.
//
// Mounted at /api/internal/embedding-provider-switch — internal-only,
// SA-gated by Cloud Run IAM (same boundary as the existing
// internal-cron-handler routes).
//
// Body: { newProvider: 'openai' | 'google' | 'voyage' }

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { switchEmbeddingProvider, ProviderSwitchError } from './provider-switch';
import { log } from '../infrastructure/logging';

const router = Router();

const schema = z.object({
  newProvider: z.enum(['openai', 'google', 'voyage']),
});

router.post('/embedding-provider-switch', async (req: Request, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
  }

  try {
    const result = await switchEmbeddingProvider(parsed.data.newProvider);
    return res.json(result);
  } catch (err) {
    if (err instanceof ProviderSwitchError) {
      log.error({ stage: err.stage, err: err.message }, 'provider-switch failed');
      return res.status(500).json({ error: err.message, stage: err.stage });
    }
    log.error({ err: (err as Error).message }, 'provider-switch unexpected error');
    return res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
