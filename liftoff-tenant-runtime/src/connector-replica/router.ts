// Internal API for the workspace data landscape.
//
// All routes require service auth — the assertEveryRouteHasAuthAnnotation boot
// check enforces this at startup.
//
// Mount at /api/internal/data-landscape in src/index.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { log } from '../infrastructure/logging';
import { getDataLandscape, renderLandscapeBlock } from './landscape-service';
import { pruneOldRunTotals } from '../agent-execution/blast-radius-store';

export const dataLandscapeRouter = Router();

dataLandscapeRouter.use(requireServiceAuth());

// ---------------------------------------------------------------------------
// POST /maintenance/prune-blast-radius
//
// Blast-radius counters are only interesting while their run is live. One row
// per invocation with no sweep is a slow leak rather than a failure, which is
// the kind nobody notices until the table is large.
//
// Mirrors the connector-content expiry maintenance route, and is driven the
// same way.
// ---------------------------------------------------------------------------
dataLandscapeRouter.post('/maintenance/prune-blast-radius', async (req: Request, res: Response) => {
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      olderThanHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
  }

  const deletedCount = await pruneOldRunTotals(parsed.data.tenantId, parsed.data.olderThanHours);
  return res.status(200).json({ deletedCount });
});

// ---------------------------------------------------------------------------
// GET /
//
// What this workspace's data looks like. Local reads only — no vendor call, no
// quota consumed.
//
// `knowledgeItems` may be supplied by the caller. The control plane owns that
// table and is the main caller here, so it passes the number it already has
// rather than having us ask it back — which would nest a timeout inside a
// timeout. Omitted, the runtime falls back to its own cached count.
// ---------------------------------------------------------------------------
dataLandscapeRouter.get('/', async (req: Request, res: Response) => {
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      knowledgeItems: z.coerce.number().int().min(0).optional(),
      /** Ask for the prompt-ready rendering alongside the structured shape. */
      render: z.coerce.boolean().optional(),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
  }

  try {
    // `knowledgeItems` is forwarded ONLY when the caller actually sent it.
    //
    // `?? null` here would turn "the caller said nothing" into "the caller
    // explicitly said unknown", and the service reads an explicit null as
    // authoritative — so the runtime's own cached count would never be
    // consulted and every caller that omits the param would be told the
    // knowledge base is unknown, forever. The distiller passes the number and
    // was fine; everything else was not.
    const landscape = await getDataLandscape({
      tenantId: parsed.data.tenantId,
      ...(parsed.data.knowledgeItems !== undefined
        ? { knowledgeItems: parsed.data.knowledgeItems }
        : {}),
    });
    return res.status(200).json(
      parsed.data.render ? { ...landscape, rendered: renderLandscapeBlock(landscape) } : landscape,
    );
  } catch (err) {
    log.error(
      { err: (err as Error).message, tenantId: parsed.data.tenantId },
      'data-landscape read failed',
    );
    return res.status(500).json({ error: 'Internal server error' });
  }
});
