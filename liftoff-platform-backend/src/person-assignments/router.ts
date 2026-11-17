import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { personAssignmentsService } from './service';
import { log, logAudit } from '../infrastructure/logging';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { withIdempotencyMiddleware } from '../infrastructure/idempotency-middleware';

export const personAssignmentsRouter = Router();

const updateAssignmentsSchema = z.object({
  assignments: z.array(z.object({
    agentId: z.string().uuid(),
    agentType: z.enum(['internal', 'external']),
  })).max(100),
});

// GET /api/person-assignments/personnel — List all personnel with assignments
personAssignmentsRouter.get(
  '/personnel',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId required' });
      }

      const personnel = await personAssignmentsService.listPersonnelWithAssignments(tenantId);
      res.json({ personnel });
    } catch (error) {
      log.error({ error }, 'Failed to list personnel with assignments');
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// PUT /api/person-assignments/:accountId — Replace all assignments for a person
personAssignmentsRouter.put(
  '/:accountId',
  tenantAuthMiddleware('manageAssignments'),
  withIdempotencyMiddleware({ endpoint: 'PUT /api/person-assignments/:accountId' }),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const { accountId } = req.params;

      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId required' });
      }

      const parseResult = updateAssignmentsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
      }

      const { assignments } = parseResult.data;
      // tenantAuthMiddleware resolves the Firebase uid to an account id and
      // attaches it as `actorAccountId`; `uid` is never set on the request, so
      // this read used to yield undefined and the `|| ''` fallback sent an empty
      // string into `created_by UUID REFERENCES accounts(id)` — Postgres 22P02,
      // surfaced to the person as "update assignment failed". The column is
      // nullable, so an unresolved actor is null, never a placeholder string.
      const createdBy = ((req as any).actorAccountId as string | undefined) ?? null;

      const result = await personAssignmentsService.updateAssignmentsForPerson(
        tenantId,
        accountId,
        assignments,
        createdBy
      );

      logAudit('person_assignment.updated', (req as any).ctx, {
        accountId,
        tenantId,
        assignmentsCount: assignments.length,
        added: result.added,
        removed: result.removed,
      });

      res.json({ success: true, ...result });
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      if (err.statusCode === 404) {
        return res.status(404).json({ error: err.message });
      }
      if (err.statusCode === 400) {
        return res.status(400).json({ error: err.message });
      }
      log.error({ error }, 'Failed to update person assignments');
      res.status(500).json({ error: err.message });
    }
  }
);
