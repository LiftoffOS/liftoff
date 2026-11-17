// Internal Agent Oversight Router
// Per implementation plan: Phase 1.7 API Endpoints
// Per Phase 0.2: SE-002, SE-007, TE-002, BE-P2-001 - Tenant verification

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { oversightService } from './service';
import { logAudit } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantRuntimeClient, type QueueItem, type QueueWindow } from '../connectors/tenant-runtime-client';
import { lateFeedbackService } from '../hitl-late-feedback';
import { canApproveHitl } from '../tenant-members/permissions';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import type { Actor } from '../workspace-actions/actor';
import {
  answerClarification,
  declineClarification,
  decideReview,
  type ReviewDecisionRefusal,
} from '../workspace-actions/review';

export const oversightRouter = Router();
const accountService = new AccountService();

// Hard 15-second deadline on every oversight route. The pending-count endpoint
// calls tenant runtime with a 10 s fetch timeout; this outer gate ensures the
// HTTP response is always sent even if something else hangs unexpectedly.
oversightRouter.use((_req: Request, res: Response, next: NextFunction) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timed out' });
    }
  }, 15_000);
  res.on('finish', () => clearTimeout(timer));
  next();
});

/**
 * Middleware to verify tenant membership for HITL endpoints that use tenantId as query param
 * Per SE-007: HITL approval GET endpoints missing tenant check
 */
async function verifyHitlTenantMembership(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      res.status(400).json({ error: 'tenantId query parameter required' });
      return;
    }

    // Get user account from Firebase UID
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(401).json({ error: 'Account not found' });
      return;
    }

    // Verify tenant membership
    const { tenantMembersService } = await import('../tenant-members/service');
    const membership = await tenantMembersService.getMembership(tenantId, account.id);

    if (!membership) {
      res.status(403).json({ error: 'Not a member of this tenant' });
      return;
    }

    // Attach to request for downstream use
    (req as any).membership = membership;
    (req as any).actorAccountId = account.id;
    (req as any).tenantId = tenantId;

    next();
  } catch (error) {
    next(error);
  }
}

/** The actor verifyHitlTenantMembership established, for the clarification
 *  routes: membership and role were read by that middleware on this request. */
function hitlActor(req: Request): Actor {
  const membership = (req as unknown as { membership: { role: Actor['role'] } }).membership;
  return {
    tenantId: (req as unknown as { tenantId: string }).tenantId,
    accountId: (req as unknown as { actorAccountId: string }).actorAccountId,
    role: membership.role,
    displayName: '',
    surface: 'dashboard',
  };
}

// Validation schemas
const updateOversightSchema = z.object({
  autonomy: z.enum(['autonomous', 'balanced', 'controlled']).optional(),
  escalation: z.enum(['exceptions', 'important', 'sensitive']).optional(),
  sensitiveWork: z.object({
    customerCommunication: z.boolean().optional(),
    financialActions: z.boolean().optional(),
    dataChanges: z.boolean().optional(),
    externalPublishing: z.boolean().optional(),
    hiringDecisions: z.boolean().optional(),
  }).optional(),
  communication: z.enum(['draft', 'auto', 'review']).optional(),
});

const rollbackSchema = z.object({
  version: z.number().int().min(1),
});

const approvalNoteSchema = z.string().max(8000).optional();

// Tool arguments the reviewer rewrote, keyed by pending tool call id. Each
// value is a whole input rather than a patch: an edit REPLACES the call's
// arguments, which is what lets a reviewer take a recipient off a thread and
// not merely add one.
const editedToolInputsSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .optional();

const lateFeedbackSchema = z.object({
  decision: z.enum(['would_approve', 'would_reject']),
  reason: z.string().max(2048).optional(),
});

// Rate limit: 10 requests per minute per user for late feedback
const lateFeedbackRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ctx?.userId || ipKeyGenerator(req.ip || 'unknown'),
  message: { error: 'Too many requests. Try again later.' },
});

// ── Queue query params ──────────────────────────────────────────────────
//
// Rejected at this edge rather than forwarded to the runtime, whose 400 would
// come back through the circuit breaker as a benign-looking empty queue.

const INVALID_PARAM = Symbol('invalid-param');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAgentIdParam(raw: unknown): string | undefined | typeof INVALID_PARAM {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) return INVALID_PARAM;
  return raw;
}

function parseQueueWindowParam(raw: unknown): QueueWindow | undefined | typeof INVALID_PARAM {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'actionable' || raw === 'passed') return raw;
  return INVALID_PARAM;
}

/** Stamp each approval with whether it already carries late feedback, so the
 *  passed view can render an answered item as answered. */
async function decorateWithFeedbackState(
  tenantId: string,
  items: QueueItem[],
): Promise<QueueItem[]> {
  const approvalIds = items.filter((item) => item.kind === 'approval').map((item) => item.id);
  if (approvalIds.length === 0) return items;

  const answered = await lateFeedbackService.findApprovalIdsWithFeedback(tenantId, approvalIds);

  return items.map((item) =>
    item.kind === 'approval'
      ? { ...item, lateFeedbackSubmitted: answered.has(item.id) }
      : item,
  );
}

/**
 * Authorize a HITL approve/reject decision and resolve who is making it.
 *
 * Returns the identity to record, or null after having already answered the
 * request — callers must `return` on null.
 *
 * Both decision routes used to inline this, and both inlined it INSIDE
 * `if (approvalToCheck)`. `tenantRuntimeClient.getApproval` returns null for a
 * genuine 404 *and* as the circuit breaker's fallback when the runtime is
 * unreachable (`executeOrFallback(..., null)`), so whenever the runtime was
 * degraded both the membership check and the level check were skipped and the
 * decision was forwarded with `decidedByRole` defaulted to the literal 'user'.
 * Because `tenantId` arrives as a query parameter, that also let any
 * authenticated caller decide approvals in a tenant they do not belong to for
 * the duration of such a window. The read routes on this router have carried
 * `verifyHitlTenantMembership` since SE-007; these two writes never did.
 *
 * It lives here as one function rather than twice inline for the reason
 * `tenant-scoped-routers-guarded.test.ts` gives: a duplicated guard is how the
 * next author comes to write the route without one.
 */
async function authorizeHitlDecision(
  req: Request,
  res: Response,
  tenantId: string,
  approvalId: string,
): Promise<Actor | null> {
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const decidedBy = account.id;

  // A readable approval authorizes against its own level. An UNREADABLE one
  // authorizes against level 1 — the stricter of the two — because we cannot
  // see what we would be deciding and must not assume the cheaper rule.
  // decideReview applies the same rule again against the approval it reads;
  // this pass exists so the route answers 403 before any runtime write.
  const approval = await tenantRuntimeClient.getApproval(tenantId, approvalId);
  const hitlLevel = (approval ? approval.hitlLevel || 2 : 1) as 1 | 2;

  const { tenantMembersService } = await import('../tenant-members/service');
  const membership = await tenantMembersService.getMembership(tenantId, decidedBy);
  if (!membership || !canApproveHitl(membership.role, hitlLevel)) {
    res.status(403).json({
      error: 'FORBIDDEN',
      message: `Level ${hitlLevel} HITL approvals require ${hitlLevel === 1 ? 'admin' : 'member'} role or higher`,
    });
    return null;
  }

  return {
    tenantId,
    accountId: decidedBy,
    role: membership.role,
    displayName: [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || account.email || '',
    surface: 'dashboard',
  };
}

/** The HitlError → status mapping the dashboard has always answered with,
 *  applied to a refusal from the shared decision function. */
function sendDecisionRefusal(res: Response, refusal: ReviewDecisionRefusal): Response {
  if (refusal.refused === 'forbidden') {
    return res.status(403).json({ error: 'FORBIDDEN', message: refusal.message });
  }
  if (refusal.refused === 'not_found' && !refusal.code) {
    return res.status(404).json({ error: 'Approval not found' });
  }
  return res.status(refusal.status ?? 409).json({
    error: refusal.code,
    // Also as `code`, which is the field the frontend's ApiError parses.
    // Sending it only as `error` meant ApiError.code came back undefined,
    // so callers could not tell ALREADY_DECIDED from any other failure and
    // fell back to a generic "Failed to approve request" — telling the
    // second person to try again on something a colleague had just done.
    // `error` stays for anything already reading it.
    code: refusal.code,
    message: refusal.message,
    ...(refusal.details || {}),
    lateFeedbackEndpoint: refusal.lateFeedbackEndpoint,
  });
}

// GET /api/internal-agent-oversight/hitl-approvals/pending-count
// Get pending HITL approval count for a tenant
// Per SE-007: Add tenant membership verification
oversightRouter.get('/hitl-approvals/pending-count', verifyHitlTenantMembership, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId as string;

    // Null when the tenant runtime could not be reached. That null travels to
    // the client on purpose: the UI renders "no number" rather than a zero it
    // would otherwise present as "nothing needs you".
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const counts = await tenantRuntimeClient.getPendingApprovalCount(tenantId, { agentId });

    // `count` repeats `total` so a client that predates the breakdown keeps
    // reading the number it already knows about.
    res.json(counts === null ? { count: null } : { count: counts.total, ...counts });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/internal-agent-oversight/hitl-approvals
// List HITL approvals with pagination
// Per SE-007: Add tenant membership verification
oversightRouter.get('/hitl-approvals', verifyHitlTenantMembership, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId as string;

    const cursor = req.query.cursor as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    // Validated here rather than forwarded blind: the runtime answers a bad
    // filter with a 400, which the circuit breaker would turn into an empty
    // queue, and an empty queue is exactly the wrong thing to show a person
    // who asked a question we could not parse.
    const agentId = parseAgentIdParam(req.query.agentId);
    if (agentId === INVALID_PARAM) {
      return res.status(400).json({ error: 'agentId must be a UUID' });
    }

    const queueWindow = parseQueueWindowParam(req.query.window);
    if (queueWindow === INVALID_PARAM) {
      return res.status(400).json({ error: "window must be 'actionable' or 'passed'" });
    }

    // The page and its counts come from the same runtime predicate, fetched
    // together. `total` used to be result.items.length — the size of the page
    // just fetched, which every client read as the size of the queue.
    const [result, counts] = await Promise.all([
      tenantRuntimeClient.listPendingApprovals(tenantId, { cursor, limit, agentId, window: queueWindow }),
      tenantRuntimeClient.getPendingApprovalCount(tenantId, { agentId }),
    ]);

    // The passed view offers each approval a late-feedback form, so it has to
    // say which ones were already answered. One query for the page, rather than
    // one per card or the discovery that comes from submitting.
    const items = queueWindow === 'passed'
      ? await decorateWithFeedbackState(tenantId, result.items)
      : result.items;

    // PR0: response key changes from `approvals` to discriminated `items`.
    return res.json({
      items,
      cursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
      // Null rather than a page length when the count is unknown: a made-up
      // total is what this change exists to remove.
      total: counts === null ? null : counts.total,
      counts,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agent-oversight/clarifications/:id/respond
// Operator answer to a pending clarification question (recovery LLM or Anchor intervention).
const clarificationRespondSchema = z.object({ response: z.string().min(1).max(8000) });

oversightRouter.post(
  '/clarifications/:id/respond',
  verifyHitlTenantMembership,
  async (req: Request, res: Response) => {
    try {
      const body = clarificationRespondSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'Validation failed', details: body.error.errors });
      }
      const result = await answerClarification(hitlActor(req), req.params.id, body.data.response);
      if ('refused' in result) {
        return res.status(result.refused === 'not_found' ? 404 : 409).json({ error: result.message });
      }
      return res.status(204).end();
    } catch (e) {
      const err = e as Error;
      return res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/internal-agent-oversight/clarifications/:id/decline
// The other half of answering: a person was asked and cannot answer, so the run
// resumes now instead of waiting out its window. The reason is optional, and is
// carried the way a rejection reason is — the learning loop reads it, the run
// does not wait on it.
const clarificationDeclineSchema = z.object({ reason: z.string().max(8000).optional() });

oversightRouter.post(
  '/clarifications/:id/decline',
  verifyHitlTenantMembership,
  async (req: Request, res: Response) => {
    try {
      const body = clarificationDeclineSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'Validation failed', details: body.error.errors });
      }
      const result = await declineClarification(hitlActor(req), req.params.id, body.data.reason);
      if ('refused' in result) {
        return res.status(result.refused === 'not_found' ? 404 : 409).json({ error: result.message });
      }
      return res.status(204).end();
    } catch (e) {
      const err = e as Error;
      return res.status(500).json({ error: err.message });
    }
  },
);

// The escalation-resolve route is deliberately gone. Escalations no longer
// reach the customer's review queue: a blocker someone in the workspace can
// clear parks the run as a clarification, and one only we can clear is an
// operator record. Nothing customer-facing had anything left to resolve, and
// the runtime keeps its own route for the operator surface.

// GET /api/internal-agent-oversight/hitl-approvals/:approvalId
// Get a single HITL approval
// Per SE-007: Add tenant membership verification
oversightRouter.get('/hitl-approvals/:approvalId', verifyHitlTenantMembership, async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).tenantId as string;

    const { approvalId } = req.params;
    const approval = await tenantRuntimeClient.getApproval(tenantId, approvalId);

    if (!approval) {
      return res.status(404).json({ error: 'Approval not found' });
    }

    res.json(approval);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agent-oversight/hitl-approvals/:approvalId/approve
// Approve a HITL request
// Requires admin role for Level 1 approvals
oversightRouter.post('/hitl-approvals/:approvalId/approve', verifyHitlTenantMembership, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const { approvalId } = req.params;
    const alwaysApply = req.body?.alwaysApply === true;

    // Why the approver said yes. Optional, and the mirror of the rejection
    // reason the reject route has always accepted — an approval used to reach
    // the learning loop with no explanation at all.
    const noteParse = approvalNoteSchema.safeParse(req.body?.approvalNote);
    if (!noteParse.success) {
      return res.status(400).json({ error: 'Validation failed', details: noteParse.error.errors });
    }
    const approvalNote = noteParse.data?.trim() || undefined;

    // What the reviewer changed before saying yes, keyed by pending tool call
    // id. Whole inputs, not patches, so a removal is expressible. The runtime
    // drops any key naming no pending call.
    const editsParse = editedToolInputsSchema.safeParse(req.body?.editedToolInputs);
    if (!editsParse.success) {
      return res.status(400).json({ error: 'Validation failed', details: editsParse.error.errors });
    }
    const editedToolInputs = editsParse.data;

    // Identity + authorization. Answers the request itself on failure.
    const actor = await authorizeHitlDecision(req, res, tenantId, approvalId);
    if (!actor) return;

    const result = await decideReview(actor, approvalId, 'approve', { alwaysApply, approvalNote, editedToolInputs });
    if ('refused' in result) return sendDecisionRefusal(res, result);
    return res.json(result.approval);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agent-oversight/hitl-approvals/:approvalId/reject
// Reject a HITL request
// Requires admin role for Level 1 approvals
oversightRouter.post('/hitl-approvals/:approvalId/reject', verifyHitlTenantMembership, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const { approvalId } = req.params;
    const { reason } = req.body ?? {};
    const alwaysApply = req.body?.alwaysApply === true;

    // Identity + authorization. Answers the request itself on failure.
    const actor = await authorizeHitlDecision(req, res, tenantId, approvalId);
    if (!actor) return;

    const result = await decideReview(actor, approvalId, 'reject', { alwaysApply, reason });
    if ('refused' in result) return sendDecisionRefusal(res, result);
    return res.json(result.approval);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agent-oversight/hitl-approvals/:approvalId/late-feedback
// Submit late feedback for an expired approval (for agent learning)
oversightRouter.post(
  '/hitl-approvals/:approvalId/late-feedback',
  lateFeedbackRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const { approvalId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId query parameter required' });
      }

      // 1. Authentication required
      const firebaseUid = req.ctx?.userId;
      if (!firebaseUid) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get user account
      const account = await accountService.getByFirebaseUid(firebaseUid);
      if (!account) {
        return res.status(401).json({ error: 'Account not found' });
      }
      const userId = account.id;

      // 2. Tenant isolation: Verify user belongs to tenant
      const { tenantMembersService } = await import('../tenant-members/service');
      const membership = await tenantMembersService.getMembership(tenantId, userId);
      if (!membership) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Access denied' });
      }

      // 3. Authorization: Verify user has approval permission (admin or owner)
      if (membership.role !== 'admin' && membership.role !== 'owner') {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Insufficient permissions' });
      }

      // 4. Validate input
      const parsed = lateFeedbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'INVALID_INPUT', details: parsed.error.errors });
      }

      // 5. Get approval, verify it exists and belongs to tenant
      const approval = await tenantRuntimeClient.getApproval(tenantId, approvalId);
      if (!approval) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Approval not found' });
      }

      // 6. Verify the decision window closed without a decision.
      //
      // "Expired" has to mean nobody answered, not merely that the clock ran
      // out: an approved or rejected approval whose expires_at has since slipped
      // by satisfied the old check, so this endpoint accepted "I would have
      // approved" for a request that was already approved, and fed that into
      // the reflection engine as if it were a missed decision.
      const isExpired = approval.status === 'expired'
        || (approval.status === 'pending' && new Date(approval.expiresAt) < new Date());
      if (!isExpired) {
        return res.status(400).json({
          error: 'NOT_EXPIRED',
          message: 'Late feedback can only be submitted for approvals where the decision window has passed',
        });
      }

      // 7. Check for existing feedback (idempotency: return existing if found)
      const existing = await lateFeedbackService.getByApprovalId(tenantId, approvalId);
      if (existing) {
        return res.status(200).json({
          id: existing.id,
          approvalId: existing.approvalId,
          decision: existing.decision,
          feedbackProvidedAt: existing.feedbackProvidedAt,
          alreadySubmitted: true,
        });
      }

      // 8. Store feedback
      const approvalForFeedback = {
        id: approval.id,
        agentId: approval.agentId,
        internalAgentId: 'internalAgentId' in approval ? (approval.internalAgentId as string | null) : null,
        workflowId: 'workflowId' in approval ? (approval.workflowId as string | null) : null,
        hitlLevel: approval.hitlLevel as 1 | 2,
        toolCallsHash: 'toolCallsHash' in approval ? (approval.toolCallsHash as string) : '',
        pendingToolCalls: approval.pendingToolCalls,
        reason: approval.reason,
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      };

      const feedback = await lateFeedbackService.submitLateFeedback({
        tenantId,
        approval: approvalForFeedback,
        decision: parsed.data.decision,
        decidedBy: userId,
        decidedByRole: membership.role,
        rejectionReason: parsed.data.reason,
      });

      // 9. Audit log
      logAudit('hitl.late_feedback', req.ctx, {
        tenantId,
        approvalId,
        decision: parsed.data.decision,
        userId,
      });

      return res.status(201).json({
        id: feedback.id,
        approvalId: feedback.approvalId,
        decision: feedback.decision,
        feedbackProvidedAt: feedback.feedbackProvidedAt,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
);

// GET /api/internal-agent-oversight/:tenantId
// Get tenant oversight settings
// Per SE-002: Add tenant verification with viewDashboard permission
oversightRouter.get('/:tenantId', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const actorId = (req as any).actorAccountId;

    const settings = await oversightService.getOrCreateOversightSettings(tenantId, actorId);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// PUT /api/internal-agent-oversight/:tenantId
// Update tenant oversight settings (requires tenant_admin)
// Per SE-002: Add tenant verification with editTeams permission
oversightRouter.put('/:tenantId', tenantAuthMiddleware('editTeams'), async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const actorId = (req as any).actorAccountId;

    // Validate input
    const parseResult = updateOversightSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const settings = await oversightService.updateOversightSettings(
      tenantId,
      parseResult.data,
      actorId
    );

    logAudit('oversight.updated', req.ctx, {
      tenantId,
      version: settings.currentVersion,
    });

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/internal-agent-oversight/:tenantId/versions
// Get oversight settings version history
// Per SE-002: Add tenant verification with viewDashboard permission
oversightRouter.get('/:tenantId/versions', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    const versions = await oversightService.getVersions(tenantId);
    res.json({ versions });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/internal-agent-oversight/:tenantId/versions/:version
// Get a specific version
// Per SE-002: Add tenant verification with viewDashboard permission
oversightRouter.get('/:tenantId/versions/:version', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const { tenantId, version: versionStr } = req.params;
    const version = parseInt(versionStr, 10);

    if (isNaN(version) || version < 1) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    const versionData = await oversightService.getVersion(tenantId, version);

    if (!versionData) {
      return res.status(404).json({ error: 'Version not found' });
    }

    res.json(versionData);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agent-oversight/:tenantId/rollback
// Rollback to a specific version (requires tenant_admin)
// Per SE-002: Add tenant verification with editTeams permission
oversightRouter.post('/:tenantId/rollback', tenantAuthMiddleware('editTeams'), async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const actorId = (req as any).actorAccountId;

    // Validate input
    const parseResult = rollbackSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const settings = await oversightService.rollbackToVersion(
      tenantId,
      parseResult.data.version,
      actorId
    );

    if (!settings) {
      return res.status(404).json({ error: 'Version not found' });
    }

    logAudit('oversight.rollback', req.ctx, {
      tenantId,
      targetVersion: parseResult.data.version,
      newVersion: settings.currentVersion,
    });

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
