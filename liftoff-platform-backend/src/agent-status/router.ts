// Agent Status Router (admin proxy)
//
// Mounts at /api/admin/agent-status. Forwards GET /:tenantId/:invocationId
// to tenant-runtime. Auth is handled by adminAuthMiddleware applied at the
// adminRouter level (see admin/router.ts:57). Tenant in path lets the auth
// layer verify role without a pre-auth resolve-invocation→tenant call;
// tenant-runtime re-verifies invocation ownership via X-Liftoff-Expected-Tenant.

import { Router, Request, Response } from 'express';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { log } from '../infrastructure/logging';

export const agentStatusRouter = Router();

agentStatusRouter.get('/:tenantId/:invocationId', async (req: Request, res: Response) => {
  const { tenantId, invocationId } = req.params;
  const format = (req.query.format === 'text' ? 'text' : 'json') as 'json' | 'text';

  try {
    const upstream = await tenantRuntimeClient.getAgentStatus({ tenantId, invocationId, format });
    if (upstream === null || upstream === undefined) {
      return res.status(404).json({ error: 'Invocation not found' });
    }

    if (format === 'text') {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.send(upstream);
    }
    return res.json(upstream);
  } catch (err) {
    log.error({ err, tenantId, invocationId }, 'agent-status proxy failed');
    return res.status(502).json({ error: (err as Error).message });
  }
});
