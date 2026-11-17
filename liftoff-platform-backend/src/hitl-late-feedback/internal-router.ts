// internal late-feedback flags endpoint for the tenant-runtime autonomy advisor.
//
// Mounted at /api/internal/late-feedback. Service-auth gated with the default
// TENANT_RUNTIME_SERVICE_TOKEN (the same shared bearer TR already uses for /api/internal/*).

import { Router, type Request, type Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { lateFeedbackRepository } from './repository';
import { log } from '../infrastructure/logging';

export const lateFeedbackInternalRouter = Router();

const svcAuth = verifyServiceAuth(); // defaults to TENANT_RUNTIME_SERVICE_TOKEN

// GET /api/internal/late-feedback/flags?tenantId&since[&agentId]
lateFeedbackInternalRouter.get('/flags', svcAuth, async (req: Request, res: Response) => {
  const tenantId = String(req.query.tenantId ?? '');
  const since = String(req.query.since ?? '');
  const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
  if (!tenantId || !since) {
    return res.status(400).json({ error: 'tenantId and since are required' });
  }
  try {
    const flags = await lateFeedbackRepository.listFlags(tenantId, since, agentId);
    return res.json({ flags });
  } catch (err) {
    log.error({ err: (err as Error).message, tenantId, agentId }, 'late-feedback flags query failed');
    return res.status(500).json({ error: 'flags_query_failed' });
  }
});
