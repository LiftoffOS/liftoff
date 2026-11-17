// HITL approvals router.
//
// Split out from the old combined hitlRouter. Carries the approval-queue
// surface (list, detail, approve, reject) and the pending-count helper.
// Mounted in server.ts at `/api/governance/approvals`.
//
// Service-to-service routes called by Platform Backend's
// connectors/tenant-runtime-client.ts on behalf of an authenticated end user
// hitting the /review page on the React app. Platform Backend handles user
// authentication; this router trusts:
//   - tenantId from req.ctx (populated by upstream middleware from
//     x-tenant-id header)
//   - decidedBy / decidedByRole from the request body (Platform Backend
//     forwards the authenticated user's identity)
//
// Late feedback lives in a SEPARATE router mounted at
// `/api/governance/late-feedback` — see late-feedback-router.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { hitlEnforcementService } from './service';
import { log } from '../infrastructure/logging';
import { withTenantScope } from '../infrastructure/database';

export const approvalsRouter = Router();

// ── Validation schemas ──────────────────────────────────────────────────

const approveBodySchema = z.object({
  decidedBy: z.string().min(1),
  decidedByRole: z.string().min(1),
  alwaysApply: z.boolean().optional(),
});

const rejectBodySchema = z.object({
  decidedBy: z.string().min(1),
  decidedByRole: z.string().min(1),
  rejectionReason: z.string().max(1000).optional(),
  alwaysApply: z.boolean().optional(),
});

// DELETE /api/governance/approvals/approval-policies
// Removes a standing (tenant, agent, gate_reason) approval policy (e.g. revoking an
// auto-approve). 204 on delete, 404 if absent.
const deletePolicySchema = z.object({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  gateReason: z.string().min(1),
});
approvalsRouter.delete('/approval-policies', async (req: Request, res: Response) => {
  const parsed = deletePolicySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
  }
  const { tenantId, agentId, gateReason } = parsed.data;
  const deleted = await withTenantScope(tenantId, (client) =>
    client.query(
      `DELETE FROM hitl_approval_policies WHERE tenant_id = $1 AND agent_id = $2 AND gate_reason = $3`,
      [tenantId, agentId, gateReason],
    ),
  );
  if ((deleted.rowCount ?? 0) === 0) {
    return res.status(404).json({ error: 'policy_not_found' });
  }
  return res.status(204).end();
});

const createApprovalBodySchema = z.object({
  tenantId: z.string().uuid(),
  workflowId: z.string().uuid().optional().nullable(),
  taskId: z.string().uuid().optional().nullable(),
  agentId: z.string().uuid().optional().nullable(),
  hitlLevel: z.number().int().min(1).max(5),
  pendingToolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
  })),
  reason: z.string().min(1).max(2000),
  idempotencyKey: z.string().max(255).optional().nullable(),
});

// ── Routes ──────────────────────────────────────────────────────────────
//
// Specific paths first (pending-count) before the bare list / `:id` routes
// so Express doesn't match a static segment as a wildcard.

// GET /api/governance/approvals/pending-count
// Returns the count of pending approvals for the tenant.
approvalsRouter.get('/pending-count', async (req: Request, res: Response) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const count = await hitlEnforcementService.getPendingApprovalCount(tenantId);
    res.json({ count });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get pending approval count');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/governance/approvals
// Create a new HITL approval request. Called by tenant-runtime (service-to-service)
// when a snapshot capture fails and human approval is required before proceeding.
// Unlike other routes, tenantId comes from the request body (not req.ctx) because
// the tenant-runtime passes tenant context in the payload rather than headers.
approvalsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parseResult = createApprovalBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const { tenantId, workflowId, taskId, agentId, hitlLevel, pendingToolCalls, reason, idempotencyKey } = parseResult.data;

    const approval = await hitlEnforcementService.createApprovalRequest({
      tenantId,
      workflowId: workflowId as string,
      taskId: taskId as string,
      agentId: agentId as string,
      hitlLevel,
      pendingToolCalls,
      reason,
      idempotencyKey: idempotencyKey ?? undefined,
    });

    log.info({
      approvalId: approval.id,
      tenantId,
      hitlLevel,
    }, 'HITL approval request created via API');

    res.status(201).json(approval);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to create HITL approval request');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/governance/approvals?cursor=&limit=
// List pending approvals for the tenant.
approvalsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const cursor = req.query.cursor as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const result = await hitlEnforcementService.listPendingApprovals(tenantId, { cursor, limit });

    res.json({
      approvals: result.approvals,
      nextCursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to list HITL approvals');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/governance/approvals/approval-policies?tenantId=&agentId=&gateReason=
// Look up a standing approval policy for a (tenant, agent, gate_reason) triple.
// Called by tenant-runtime's governance client before creating a new gate.
// Returns the policy object or null (404) if none exists or it has expired.
approvalsRouter.get('/approval-policies', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const gateReason = req.query.gateReason as string | undefined;

    if (!tenantId || !agentId || !gateReason) {
      return res.status(400).json({ error: 'tenantId, agentId, and gateReason are required' });
    }

    const policy = await hitlEnforcementService.getApprovalPolicy(tenantId, agentId, gateReason);
    if (!policy) {
      return res.status(404).json({ error: 'No policy found' });
    }
    res.json(policy);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get approval policy');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/governance/approvals/approval-policies — upsert a standing policy.
// Called by tenant-runtime's RPC handler when alwaysApply=true on an approval resolution.
approvalsRouter.post('/approval-policies', async (req: Request, res: Response) => {
  try {
    const { tenantId, agentId, gateReason, decision, createdBy, expiresAt, actionClasses } = req.body as {
      tenantId?: string;
      agentId?: string;
      gateReason?: string;
      decision?: 'approved' | 'rejected';
      createdBy?: string;
      expiresAt?: string;
      actionClasses?: string[] | null;
    };

    if (!tenantId || !agentId || !gateReason || !decision || !createdBy) {
      return res.status(400).json({ error: 'tenantId, agentId, gateReason, decision, and createdBy are required' });
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
    }
    if (actionClasses !== undefined && actionClasses !== null &&
        (!Array.isArray(actionClasses) || !actionClasses.every((c) => typeof c === 'string'))) {
      return res.status(400).json({ error: 'actionClasses must be an array of strings' });
    }

    await hitlEnforcementService.upsertApprovalPolicy({
      tenantId,
      agentId,
      gateReason,
      decision,
      createdBy,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      actionClasses: actionClasses ?? null,
    });
    res.status(201).json({ success: true });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to upsert approval policy');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/governance/approvals/:id
// Fetch one approval, with tenant isolation enforced after the lookup.
approvalsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? req.ctx?.tenantId;
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

// POST /api/governance/approvals/:id/approve
approvalsRouter.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? req.ctx?.tenantId;
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

    const approval = await hitlEnforcementService.approveRequest({
      approvalId: id,
      decision: 'approved',
      decidedBy: parseResult.data.decidedBy,
      decidedByRole: parseResult.data.decidedByRole,
      alwaysApply: parseResult.data.alwaysApply,
    });

    log.info({
      approvalId: id,
      tenantId,
      decidedBy: parseResult.data.decidedBy,
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

// POST /api/governance/approvals/:id/reject
approvalsRouter.post('/:id/reject', async (req: Request, res: Response) => {
  try {
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? req.ctx?.tenantId;
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

    const approval = await hitlEnforcementService.rejectRequest({
      approvalId: id,
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
