// GET /api/chat-threads — the caller's chat threads across every surface,
// newest activity first, for the "All" view of the web app's Chat History.
// Each thread carries its kind, and the team behind it on kind 'agent', so the
// client can route to the surface it lives on. See service.ts for the merge.
//
// Mounted below the global authMiddleware (index.ts), so req.ctx.userId is the
// verified Firebase UID. Membership is the gate; each surface then applies its
// own visibility rule.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { resolveCaller } from '../auth/resolve-caller';
import { log } from '../infrastructure/logging';
import { listAllChatThreads } from './service';

export const chatThreadsRouter = Router();

const listQuerySchema = z.object({
  tenantId: z.string().uuid(),
  // The updatedAt of the last thread on the previous page, exactly as this
  // route returned it.
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

chatThreadsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const parseResult = listQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    const { tenantId, cursor, limit } = parseResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }
    const { accountId, role } = resolution.caller;

    const result = await listAllChatThreads({ tenantId, accountId, role }, { cursor, limit });
    return res.json(result);
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to list chat threads across surfaces',
    );
    return res.status(500).json({ error: 'Failed to list threads' });
  }
});
