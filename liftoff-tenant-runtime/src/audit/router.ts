// Audit Log Router
// Per implementation plan: Phase 6 Audit Logs

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { listAuditLogs, getAuditLog } from './service';
import { requireServiceAuth } from '../security/service-auth';

export const auditRouter = Router();

// Both routes are service-to-service reads. The runtime carries no end-user
// identity — `req.ctx` holds tenant, trace and agent ids only — so a role check
// here could never resolve a caller; the shared service token is the boundary
// that actually exists, matching the other internal routers.
auditRouter.use(requireServiceAuth());

// Query schema
const listAuditQuery = z.object({
  internal_agent_id: z.string().uuid().optional(),
  thread_id: z.string().uuid().optional(),
  invocation_id: z.string().uuid().optional(),
  action: z.string().optional(),
  outcome: z.enum(['success', 'error', 'gated']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/audit-logs - List audit logs
auditRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    // Parse and validate query params
    const parsed = listAuditQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
    }

    const result = await listAuditLogs(tenantId, {
      internalAgentId: parsed.data.internal_agent_id,
      threadId: parsed.data.thread_id,
      invocationId: parsed.data.invocation_id,
      action: parsed.data.action,
      outcome: parsed.data.outcome,
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      to: parsed.data.to ? new Date(parsed.data.to) : undefined,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/audit-logs/:id - Get single audit log entry
auditRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const auditLog = await getAuditLog(req.params.id, tenantId);

    if (!auditLog) {
      return res.status(404).json({ error: 'Audit log entry not found' });
    }

    res.json(auditLog);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
