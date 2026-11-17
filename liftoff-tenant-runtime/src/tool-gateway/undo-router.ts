// Operator surface for reverting an agent's write.
//
// Service auth only, and deliberately NOT reachable as an agent tool: a model
// that can see its own rollback stops treating destructive actions as
// expensive. The same reasoning keeps the sandbox checkpoint verbs off the
// model-facing catalog.
//
// Planning is separate from applying, and only planning exists here. An
// operator gets to read what the revert would do — and, more often, the honest
// reason it cannot be done — before anything writes.
//
// Mount at /api/internal/undo in src/index.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { log } from '../infrastructure/logging';
import { planUndo } from './undo-planner';
import { connectorManifestRepository } from '../connectors/manifest-repository';

export const undoRouter = Router();

// All routes on this router require service auth.
undoRouter.use(requireServiceAuth());

/** Map a ledger action's connector alias to its connector type, from the
 *  tenant's own manifests. The ledger stores the aliased tool name; the policy
 *  registry and the state fetcher both key on type.
 *
 *  A miss is a real answer, not an error: the connector may have been
 *  disconnected since the action ran, and an undo against a binding that no
 *  longer exists is exactly the thing to refuse. */
function connectorTypeResolver(tenantId: string): (alias: string) => Promise<string | null> {
  return async (alias: string) => {
    const manifest = await connectorManifestRepository.getManifestByAlias(tenantId, alias);
    return manifest?.connectorType ?? null;
  };
}

// ---------------------------------------------------------------------------
// GET /plan
//
// What reverting this ledger entry would do. Read-only: it reads the entry, the
// conflict policy, and the entity's CURRENT remote state, and writes nothing.
// ---------------------------------------------------------------------------
undoRouter.get('/plan', async (req: Request, res: Response) => {
  const parsed = z
    .object({
      tenantId: z.string().uuid(),
      auditLogId: z.string().uuid(),
    })
    .safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.issues });
  }

  try {
    const plan = await planUndo({
      tenantId: parsed.data.tenantId,
      auditLogId: parsed.data.auditLogId,
      resolveConnectorType: connectorTypeResolver(parsed.data.tenantId),
    });
    return res.status(200).json(plan);
  } catch (err) {
    log.error(
      { err: (err as Error).message, tenantId: parsed.data.tenantId, auditLogId: parsed.data.auditLogId },
      'undo plan failed',
    );
    return res.status(500).json({ error: 'Internal server error' });
  }
});
