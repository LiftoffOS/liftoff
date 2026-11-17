// HITL Enforcement Router
//
// Service-to-service routes called by Platform Backend's
// connectors/tenant-runtime-client.ts on behalf of an authenticated end user
// hitting the /review page on the React app. Platform Backend handles user
// authentication; this router trusts:
//   - tenantId from req.ctx (populated by index.ts middleware from
//     x-tenant-id header)
//   - decidedBy / decidedByRole from the request body (Platform Backend
//     forwards the authenticated user's identity)
//
// These routes are listed in the kill-switch skipPaths in index.ts so they
// remain reachable when a tenant is suspended (read-only review still works).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { hitlEnforcementService, REVIEW_HISTORY_MAX_LIMIT, type QueueWindow } from './service';
import { reflectionTriggerService } from '../reflection-engine/trigger-service';
import { log } from '../infrastructure/logging';
import { resolveApprovalAndResume } from './resolve-and-resume';

export const hitlRouter = Router();

// ── Validation schemas ──────────────────────────────────────────────────

const approveBodySchema = z.object({
  decidedBy: z.string().min(1),
  decidedByRole: z.string().min(1),
  alwaysApply: z.boolean().optional(),
  // The counterpart to a rejection reason. Kept in step with the Connect
  // handler so the two entry points to the same decision cannot record
  // different things about it.
  approvalNote: z.string().max(8000).optional(),
  // The reviewer's rewritten arguments, keyed by pending tool call id. Values
  // are whole inputs, not patches: an edit REPLACES a call's arguments, so a
  // recipient can be removed and not merely added. Keys matching no pending
  // call are dropped when the decision is recorded.
  editedToolInputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

const rejectBodySchema = z.object({
  decidedBy: z.string().min(1),
  decidedByRole: z.string().min(1),
  rejectionReason: z.string().max(1000).optional(),
  alwaysApply: z.boolean().optional(),
});

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

// Sentinel for an agentId query param that was supplied but is not a UUID.
// Distinguishes "filter by nothing" (undefined) from "the caller asked for a
// filter we cannot honour", which is a 400 rather than a silent full listing.
const INVALID_AGENT_ID = Symbol('invalid-agent-id');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared by the listing and the count so both scope to an agent the same way. */
function parseAgentIdFilter(raw: unknown): string | undefined | typeof INVALID_AGENT_ID {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) return INVALID_AGENT_ID;
  return raw;
}

/** Which view of the queue was asked for. An unrecognised value is a 400, not a
 *  silent fallback to the default: a caller asking for a view we do not have
 *  should hear so rather than be handed a different one. */
function parseQueueWindow(raw: unknown): QueueWindow | undefined | typeof INVALID_WINDOW {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'actionable' || raw === 'passed') return raw;
  return INVALID_WINDOW;
}

const INVALID_WINDOW = Symbol('invalid-window');

// ── Routes ──────────────────────────────────────────────────────────────
//
// Specific paths first (pending-count, late-feedback) before /approvals so
// Express doesn't match a static segment as a wildcard. Within /approvals,
// the bare list route is registered before /:id to avoid the same trap.

// GET /api/hitl-enforcement/pending-count?agentId=
// Returns the count of everything in the tenant's review queue, bucketed by
// kind. `count` repeats `total` so a Platform Backend that predates the
// breakdown keeps working across the deploy gap.
hitlRouter.get('/pending-count', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const agentId = parseAgentIdFilter(req.query.agentId);
    if (agentId === INVALID_AGENT_ID) {
      return res.status(400).json({ error: 'agentId must be a UUID' });
    }

    const counts = await hitlEnforcementService.getPendingItemsCount(tenantId, { agentId });
    res.json({ count: counts.total, ...counts });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get pending approval count');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/hitl-enforcement/operator-records?status=&limit=
//
// B4: the operator view of `system_internal` escalations. These are the records
// only we can clear, and until now they were visible to nobody: they left the
// customer queue by design, and the internal dashboard reads the control-plane
// database and never calls the runtime. This is the read path that gives it
// somewhere to look, so the retention sweep is not the only thing that ever
// touches them.
hitlRouter.get('/operator-records', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    // An unrecognised status is a 400 rather than a silent "everything", for
    // the same reason the queue window is: a caller asking for a view we do not
    // have should hear so instead of being handed a different one.
    const rawStatus = req.query.status;
    if (rawStatus !== undefined && rawStatus !== '' && rawStatus !== 'pending' && rawStatus !== 'resolved') {
      return res.status(400).json({ error: "status must be 'pending' or 'resolved'" });
    }
    const status = rawStatus === 'pending' || rawStatus === 'resolved' ? rawStatus : undefined;

    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined || rawLimit === '' ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return res.status(400).json({ error: 'limit must be a positive integer' });
    }

    const records = await hitlEnforcementService.listOperatorRecords({ tenantId, status, limit });
    res.json({ records });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to list operator records');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/hitl-enforcement/late-feedback
//
// Receive late feedback for a HITL approval that already expired. The
// Platform Backend records the human decision in its own table first, then
// forwards it here with retry/backoff so we can persist it into
// human_feedback for the reflection engine to learn from.
//
// Idempotent on feedbackId (see migration 057). After a fresh write we
// fire reflectionTriggerService.onEscalationResolved so the learning loop
// runs if the agent's correction-density threshold is met. Duplicate
// retries are still answered with success: true so Platform Backend's
// retry queue clears.
hitlRouter.post('/late-feedback', async (req: Request, res: Response) => {
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

// ── Review history (the workspace export) ───────────────────────────────
//
// Every status, oldest first, keyset-paginated, bounded by the caller's
// `asOf`: the control plane's workspace export walks these two feeds to write
// review.json. Registered before /approvals/:id, like the other static paths.
// 400s mirror /approvals: an unparseable limit or a missing asOf is refused
// rather than defaulted, because a feed that silently took "no boundary"
// would hand the export rows created after the instant it stamped.

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const INVALID_HISTORY_QUERY = Symbol('invalid-history-query');

/** The three query parameters both history feeds take, validated the same way. */
function parseHistoryQuery(query: Request['query']):
  | { asOf: Date; cursor?: string; limit?: number }
  | { error: string; kind: typeof INVALID_HISTORY_QUERY } {
  const rawAsOf = query.asOf;
  if (typeof rawAsOf !== 'string' || !ISO_TIMESTAMP.test(rawAsOf) || Number.isNaN(Date.parse(rawAsOf))) {
    return { error: 'asOf must be an ISO 8601 timestamp', kind: INVALID_HISTORY_QUERY };
  }
  const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : undefined;
  let limit: number | undefined;
  if (query.limit !== undefined) {
    const parsed = parseInt(query.limit as string, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { error: 'limit must be a positive integer', kind: INVALID_HISTORY_QUERY };
    }
    limit = Math.min(parsed, REVIEW_HISTORY_MAX_LIMIT);
  }
  return { asOf: new Date(rawAsOf), cursor, limit };
}

// GET /api/hitl-enforcement/review-history/approvals?asOf=&cursor=&limit=
hitlRouter.get('/review-history/approvals', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }
    const parsed = parseHistoryQuery(req.query);
    if ('kind' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    const result = await hitlEnforcementService.listReviewHistoryApprovals(tenantId, parsed);
    res.json({ items: result.items, nextCursor: result.nextCursor });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to list approval history');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/hitl-enforcement/review-history/clarifications?asOf=&cursor=&limit=
hitlRouter.get('/review-history/clarifications', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }
    const parsed = parseHistoryQuery(req.query);
    if ('kind' in parsed) {
      return res.status(400).json({ error: parsed.error });
    }
    const result = await hitlEnforcementService.listReviewHistoryClarifications(tenantId, parsed);
    res.json({ items: result.items, nextCursor: result.nextCursor });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to list clarification history');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/hitl-enforcement/approvals/for-thread/:threadId?agentId=
// The actionable approval blocking one chat thread, or null. Registered before
// /approvals/:id so the static segment is not read as an id.
hitlRouter.get('/approvals/for-thread/:threadId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const { threadId } = req.params;
    if (!UUID_PATTERN.test(threadId)) {
      return res.status(400).json({ error: 'threadId must be a UUID' });
    }

    const agentId = parseAgentIdFilter(req.query.agentId);
    if (agentId === INVALID_AGENT_ID) {
      return res.status(400).json({ error: 'agentId must be a UUID' });
    }

    const approval = await hitlEnforcementService.findActionableApprovalForThread(
      tenantId, threadId, agentId,
    );
    res.json({ approval });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to look up thread approval');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/hitl-enforcement/approvals?cursor=&limit=&agentId=&window=
// List the tenant's review-queue items: approvals, clarification questions and
// escalations, newest first, keyset-paginated by `cursor`. `window=passed`
// returns the approvals whose decision window has closed instead.
hitlRouter.get('/approvals', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;

    // An unparseable limit reads as "no limit given" and takes the default,
    // rather than reaching the service as NaN.
    let limit: number | undefined;
    if (req.query.limit !== undefined) {
      const parsed = parseInt(req.query.limit as string, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = parsed;
    }

    const agentId = parseAgentIdFilter(req.query.agentId);
    if (agentId === INVALID_AGENT_ID) {
      return res.status(400).json({ error: 'agentId must be a UUID' });
    }

    const queueWindow = parseQueueWindow(req.query.window);
    if (queueWindow === INVALID_WINDOW) {
      return res.status(400).json({ error: "window must be 'actionable' or 'passed'" });
    }

    const result = await hitlEnforcementService.listPendingItemsForTenant(tenantId, {
      cursor, limit, agentId, window: queueWindow,
    });

    res.json({
      items: result.items,
      nextCursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to list HITL approvals');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/hitl-enforcement/approvals/:id
// Fetch one approval, with tenant isolation enforced after the lookup.
hitlRouter.get('/approvals/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const { id } = req.params;
    const approval = await hitlEnforcementService.getApprovalRequest(id);

    if (!approval) {
      return res.status(404).json({ error: 'Approval request not found' });
    }
    if (approval.tenantId !== tenantId) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    res.json(approval);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get HITL approval');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/hitl-enforcement/approvals/:id/approve
hitlRouter.post('/approvals/:id/approve', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const parseResult = approveBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const { id } = req.params;

    // Tenant isolation check before mutating.
    const existing = await hitlEnforcementService.getApprovalRequest(id);
    if (!existing || existing.tenantId !== tenantId) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    // Shared with the Connect-RPC resolveApproval handler: records the
    // decision, settles sandbox approvals, appends the decision to the typed
    // run transcript, and enqueues the resume task.
    const approval = await resolveApprovalAndResume({
      approvalId: id,
      tenantId,
      decision: 'approved',
      decidedBy: parseResult.data.decidedBy,
      decidedByRole: parseResult.data.decidedByRole,
      alwaysApply: parseResult.data.alwaysApply,
      approvalNote: parseResult.data.approvalNote,
      editedToolInputs: parseResult.data.editedToolInputs,
    });

    log.info({
      approvalId: id,
      tenantId,
      decidedBy: parseResult.data.decidedBy,
      noteProvided: !!parseResult.data.approvalNote?.trim(),
    }, 'HITL request approved via API');

    res.json(approval);
  } catch (error) {
    const message = (error as Error).message;

    if (message.includes('TAMPER_DETECTED')) {
      return res.status(409).json({
        error: 'TAMPER_DETECTED',
        message: 'The pending tool calls have been modified. Please refresh and try again.',
      });
    }
    if (message.includes('expired')) {
      return res.status(410).json({
        error: 'EXPIRED',
        message: 'This approval request has expired.',
      });
    }

    log.error({ error: message }, 'Failed to approve HITL request');
    res.status(500).json({ error: message });
  }
});

// POST /api/hitl-enforcement/approvals/:id/reject
hitlRouter.post('/approvals/:id/reject', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const parseResult = rejectBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const { id } = req.params;

    // Tenant isolation check before mutating.
    const existing = await hitlEnforcementService.getApprovalRequest(id);
    if (!existing || existing.tenantId !== tenantId) {
      return res.status(404).json({ error: 'Approval request not found' });
    }

    // Shared with the Connect-RPC resolveApproval handler. On resume the
    // rejection is injected as a tool_result error so the agent can adapt
    // (continue-and-adapt, bounded by recovery caps); falls back to a terminal
    // finalize when re-entry isn't possible.
    const approval = await resolveApprovalAndResume({
      approvalId: id,
      tenantId,
      decision: 'rejected',
      decidedBy: parseResult.data.decidedBy,
      decidedByRole: parseResult.data.decidedByRole,
      rejectionReason: parseResult.data.rejectionReason,
      alwaysApply: parseResult.data.alwaysApply,
    });

    log.info({
      approvalId: id,
      tenantId,
      decidedBy: parseResult.data.decidedBy,
      reason: parseResult.data.rejectionReason,
    }, 'HITL request rejected via API');

    res.json(approval);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to reject HITL request');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/hitl-enforcement/escalations/:id/resolve
// Operator marks a pending escalation resolved from the review queue. The
// pending row is also the dedup anchor (escalation-helper), so resolving is
// what re-arms notification: the next occurrence of the same blocker finds no
// open row, creates a fresh one, and notifies again.
const resolveEscalationBodySchema = z.object({
  resolvedBy: z.string().min(1).max(255),
});

/** Declining carries no answer, so the reason is optional in a way the answer
 *  path's `response` is not: the run resumes either way, and the text is only
 *  what the learning loop reads. */
const declineClarificationBodySchema = z.object({
  reason: z.string().max(8000).optional(),
  resolvedBy: z.string().min(1).max(255),
});

// POST /api/hitl-enforcement/clarifications/:id/decline
//
// The other half of answering. REST rather than a method on the Connect
// service because the run does not need a new contract to be told this — only
// different text — and a proto change would have to be generated and published
// before either side could ship.
hitlRouter.post('/clarifications/:id/decline', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }
    if (!UUID_PATTERN.test(req.params.id)) {
      return res.status(400).json({ error: 'clarificationId must be a UUID' });
    }
    const parseResult = declineClarificationBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid body', details: parseResult.error.issues });
    }

    await hitlEnforcementService.declineClarification({
      tenantId,
      clarificationId: req.params.id,
      reason: parseResult.data.reason,
      resolvedBy: parseResult.data.resolvedBy,
    });

    log.info({ clarificationId: req.params.id, tenantId }, 'Clarification declined via review queue');
    res.json({ id: req.params.id, status: 'declined' });
  } catch (error) {
    const message = (error as Error).message;
    // The same race the answer path has: somebody else answered it, or its
    // window closed, between the page rendering and this call.
    if (message.includes('already resolved or not found')) {
      return res.status(404).json({ error: 'Clarification not found' });
    }
    // Not a failure: this kind of ask has no decline. The page hides the
    // affordance, so reaching here means a stale tab or a direct call.
    if (message.includes('cannot be declined')) {
      return res.status(409).json({ error: message });
    }
    log.error({ error: message }, 'Failed to decline clarification');
    res.status(500).json({ error: message });
  }
});

hitlRouter.post('/escalations/:id/resolve', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }
    const parseResult = resolveEscalationBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Invalid body', details: parseResult.error.issues });
    }

    const resolved = await hitlEnforcementService.resolveEscalation({
      tenantId,
      escalationId: req.params.id,
      resolvedBy: parseResult.data.resolvedBy,
    });
    if (!resolved) {
      // Already resolved, wrong tenant, or a system_internal row — all read the
      // same from outside, and none should distinguish themselves to a caller.
      return res.status(404).json({ error: 'Escalation not found' });
    }

    log.info({ escalationId: req.params.id, tenantId, resolvedBy: parseResult.data.resolvedBy },
      'Escalation resolved via review queue');
    res.json({ id: req.params.id, status: 'resolved' });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to resolve escalation');
    res.status(500).json({ error: (error as Error).message });
  }
});
