// HITL late-feedback router.
//
// Split out from the old combined hitlRouter so server.ts can mount late
// feedback at `/api/governance/late-feedback` (plan convention) while the
// approvals routes stay nested under `/api/governance/approvals`.
//
// Receives late feedback for a HITL approval that already expired. The
// Platform Backend records the human decision in its own table first, then
// forwards it here with retry/backoff so we can persist it into
// human_feedback for the reflection engine to learn from.
//
// Idempotent on feedbackId (see migration 057). After a fresh write we fire
// reflectionTriggerService.onLateFeedbackFlagged so the learning loop runs
// if the agent's correction-density threshold is met. Duplicate retries are
// still answered with success: true so Platform Backend's retry queue clears.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { hitlEnforcementService } from './service';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import { log } from '../infrastructure/logging';

export const lateFeedbackRouter = Router();

const lateFeedbackBodySchema = z.object({
  feedbackId: z.string().min(1),
  approvalId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1),
  decidedByRole: z.string().min(1),
  rejectionReason: z.string().max(1000).optional(),
  toolCallsHash: z.string().min(1),
  pendingToolCalls: z.array(z.unknown()),
});

// POST /api/governance/late-feedback
lateFeedbackRouter.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const parseResult = lateFeedbackBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const { feedbackId, approvalId, decision, decidedBy, decidedByRole, rejectionReason } =
      parseResult.data;

    const result = await hitlEnforcementService.recordLateFeedback({
      feedbackId,
      tenantId,
      approvalId,
      decision,
      decidedBy,
      decidedByRole,
      rejectionReason,
    });

    // If the approval lookup failed (unknown id, or cross-tenant attempt
    // surfaced as unknown), respond with 404 — Platform Backend treats this
    // as a permanent failure and stops retrying.
    if (result.agentId === null) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    // Fire the reflection trigger only on a fresh insert. Duplicate retries
    // shouldn't re-enqueue reflection jobs and burn quota.
    //
    // Phase 5: Branch on decision. A late 'rejected' decision routes through
    // the new 'flagged_feedback' trigger which uses a lower threshold (2+
    // flags in 7 days) — late rejection is the strongest individual human
    // signal we get. A late 'approved' decision is not a learning signal
    // and does not enqueue reflection at all.
    if (result.inserted && decision === 'rejected') {
      try {
        await reflectionTriggerService.onLateFeedbackFlagged(
          result.agentId,
          tenantId,
          feedbackId,
        );
      } catch (triggerError) {
        // The feedback row is already persisted; reflection enqueue is
        // best-effort. Log and continue so we still return success and
        // don't trigger another full Platform Backend retry cycle.
        log.warn({
          event: 'hitl_late_feedback_reflection_trigger_failed',
          feedbackId,
          approvalId,
          tenantId,
          agentId: result.agentId,
          error: (triggerError as Error).message,
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to receive late feedback');
    res.status(500).json({ error: (error as Error).message });
  }
});
