// First-scheduled-run health — the Platform Backend consumer.
//
// Cutover completing does not mean imported recurring work has succeeded. A
// routine that silently fails after cutover is the worst possible first
// impression for a switcher, and today nothing in the control plane can see it:
// there is no per-routine terminal health signal, and the billing-oriented
// `invocation.completed` event does not report a terminal OUTCOME (a stalled
// run never publishes it at all).
//
// So the Tenant Runtime carries the migration routine reference through
// scheduled execution and reports the FIRST terminal outcome here. This module
// is that endpoint.
//
// ADR-039 is load-bearing on this boundary: the delivery must carry
// `internalAgentId`, and a payload carrying only a runtime-space agent id is
// REJECTED rather than translated. The control plane inventing a local
// translation between the two id spaces is exactly what the ADR forbids, and a
// wrong-space id matches zero rows with no error — so a "successful" write that
// silently updated nothing is the failure this rejection prevents.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { sourceMigrationService } from './service';

export const sourceMigrationsInternalRouter = Router();

/** Service auth, matching the other TR → PB internal routes. */
function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env.TENANT_RUNTIME_SERVICE_TOKEN || process.env.WORKFORCE_SERVICE_TOKEN;
  if (!expected) {
    res.status(500).json({ error: 'Service authentication not configured' });
    return;
  }
  const ok =
    token &&
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }
  next();
}

const firstRunSchema = z.object({
  tenantId: z.string().uuid(),
  /** The stable reference the migration stamped onto the imported routine. */
  routineRef: z.string().min(1).max(512),
  /** internal_agents.id. NOT the Tenant Runtime's agents.id. */
  internalAgentId: z.string().uuid(),
  outcome: z.enum(['succeeded', 'failed']),
  /** Non-secret category only — never a message from a customer's run. */
  errorCategory: z.string().max(64).optional(),
  occurredAt: z.string().datetime().optional(),
});

sourceMigrationsInternalRouter.post(
  '/first-run',
  serviceAuth,
  async (req: Request, res: Response) => {
    // A payload that names a runtime-space agent id instead of an
    // internal_agents id is refused outright. Resolving it here would be the
    // local translation ADR-039 forbids, and the silent failure mode (zero rows
    // matched, no error) is precisely why.
    if (req.body && req.body.agentId !== undefined && req.body.internalAgentId === undefined) {
      return res.status(400).json({
        error:
          'Payload carries a runtime-space agentId. Send internalAgentId; the control ' +
          'plane does not translate between agent id spaces.',
        errorCode: 'wrong_agent_id_space',
      });
    }

    const parsed = firstRunSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const { tenantId, routineRef, outcome, errorCategory, occurredAt } = parsed.data;

    try {
      // First write wins and a duplicate delivery is a no-op: `recorded` is
      // false when the routine had already reported, which is the normal case
      // for every run after the first.
      const recorded = await sourceMigrationService.recordFirstRun(tenantId, routineRef, {
        status: outcome,
        errorCategory: errorCategory ?? null,
        occurredAt: occurredAt ? new Date(occurredAt) : undefined,
      });

      log.info(
        { tenantId, routineRef, outcome, recorded },
        'source-migrations: first scheduled-run outcome received',
      );

      return res.json({ recorded });
    } catch (err) {
      log.error(
        { error: (err as Error).message, tenantId, routineRef },
        'source-migrations: failed to record first scheduled-run outcome',
      );
      return res.status(500).json({ error: 'Failed to record first-run outcome' });
    }
  },
);
