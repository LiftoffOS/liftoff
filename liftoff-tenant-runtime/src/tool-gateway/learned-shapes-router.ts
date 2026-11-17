// The override surface for learned response shapes.
//
// The gateway observes which paths of a read carry ids, because `returnsIds`
// cannot be derived from an input schema — nothing about a tool's arguments
// says what its response holds. An observed path lands ACCEPTED, typed by the
// read tool's own catalog entry: there was nothing left for a person to judge
// about it, and a queue of them reached nobody (208 proposals accumulated
// overnight, once). What a person can still do is REJECT one — a path that
// turns out to be noise — and a rejection is sticky: re-observing the path
// does not resurrect it. `/pending` lists rows written before acceptance was
// automatic and not yet re-observed; it empties on its own.
//
// Mounted the way the HITL routes are: called cross-service by the control
// plane on behalf of an authenticated reviewer. tenantId comes from the request
// context, never the body, so a reviewer cannot decide another workspace's
// proposals.

import { Router, type Request, type Response } from 'express';
import { pendingShapes, decideShape } from './learned-shapes-store';
import { logger } from '../infrastructure/logging';

export const learnedShapesRouter = Router();

/** What is waiting, most-observed first. */
learnedShapesRouter.get('/pending', async (req: Request, res: Response) => {
  const tenantId = (req as Request & { ctx?: { tenantId?: string } }).ctx?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenant context required' });
  try {
    const rawLimit = Number(req.query.limit ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 200;
    const shapes = await pendingShapes(tenantId, limit);
    return res.json({
      // The count is what makes a proposal judgeable: a path seen once may be a
      // fluke, a path seen a thousand times is the tool's shape.
      proposals: shapes.map((s) => ({
        connectorType: s.connectorType,
        actionType: s.actionType,
        path: s.path,
        observedCount: s.observedCount,
        serverAlias: s.serverAlias,
      })),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId }, 'learned_shapes_pending_failed');
    return res.status(500).json({ error: 'could not read proposals' });
  }
});

/** Accept or reject one proposal. An accepted path becomes a declaration the
 *  gate reads on the next cache refresh. */
learnedShapesRouter.post('/decide', async (req: Request, res: Response) => {
  const tenantId = (req as Request & { ctx?: { tenantId?: string } }).ctx?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenant context required' });

  const { connectorType, actionType, path, status, entityType, decidedBy, serverAlias } = req.body as {
    connectorType?: string; actionType?: string; path?: string;
    status?: string; entityType?: string; decidedBy?: string; serverAlias?: string;
  };
  if (!connectorType || !actionType || !path || !decidedBy) {
    return res.status(400).json({ error: 'connectorType, actionType, path and decidedBy are required' });
  }
  if (status !== 'accepted' && status !== 'rejected') {
    return res.status(400).json({ error: "status must be 'accepted' or 'rejected'" });
  }

  try {
    const changed = await decideShape({
      tenantId, connectorType, actionType, path, status, entityType, decidedBy, serverAlias: serverAlias ?? '',
    });
    if (!changed) return res.status(404).json({ error: 'no such proposal' });
    logger.info(
      { tenantId, connectorType, actionType, path, status, decidedBy },
      'learned_shape_decided',
    );
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId }, 'learned_shapes_decide_failed');
    return res.status(500).json({ error: 'could not record the decision' });
  }
});
