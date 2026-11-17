// Workforce Plans Router
//
// REST endpoints for workforce plan CRUD and lifecycle transitions.
//
// Permission model:
//   - Reads (GET): any tenant member can list and view plans
//   - Mutations (POST/PATCH/DELETE): owner and admin only
//
// Lifecycle transitions throw WorkforcePlanLifecycleError on invalid state,
// which this router maps to HTTP 409. Not-found errors map to HTTP 404
// (intentionally indistinguishable from cross-tenant lookups so we never
// confirm the existence of foreign plan ids).
//
// Auth comes from trusted proxy headers set by PB:
//   x-tenant-id, x-account-id, x-tenant-role

import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { workforcePlanService } from './service.js';
import {
  WorkforcePlanLifecycleError,
  WorkforcePlanNotFoundError,
  type WorkforcePlanStatus,
} from './types.js';
import { log } from '../infrastructure/logging.js';
import { writeAuditLog } from './audit-log.js';
import { withTenantContext } from '../infrastructure/rls.js';

// ── Caller resolution ──────────────────────────────────────────────────

type TenantMemberRole = 'owner' | 'admin' | 'member' | 'viewer';

interface CallerContext {
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
}

function resolveCaller(request: FastifyRequest): CallerContext | null {
  const tenantId = request.headers['x-tenant-id'] as string | undefined;
  const accountId = request.headers['x-account-id'] as string | undefined;
  const role = request.headers['x-tenant-role'] as string | undefined;
  if (!tenantId || !accountId || !role) return null;
  return { tenantId, accountId, role: role as TenantMemberRole };
}

const PRIVILEGED_ROLES: ReadonlySet<TenantMemberRole> = new Set(['owner', 'admin']);

function canMutate(role: TenantMemberRole): boolean {
  return PRIVILEGED_ROLES.has(role);
}

// ── Validation schemas ─────────────────────────────────────────────────

const planIdParamSchema = z.object({
  planId: z.string().uuid(),
});

const agentSpecSchema = z.object({
  specId: z.string().min(1),
  name: z.string().min(1).max(200),
  agentType: z.enum(['agent', 'workflow']),
  department: z.string().max(200).optional(),
  roleSummary: z.string().min(1).max(2000),
  responsibilities: z.string().max(8000).optional(),
  additionalContext: z.string().max(8000).optional(),
  prose: z.record(z.string().max(8000)).optional(),
  connectors: z.array(z.string().max(100)).max(50).optional(),
  provisioningStatus: z.enum(['pending', 'provisioning', 'completed', 'failed']).optional(),
  internalAgentId: z.string().uuid().optional(),
  errorMessage: z.string().optional(),
});

const orgChartSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.string().optional(),
    department: z.string().optional(),
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    label: z.string().optional(),
  })),
});

const createPlanBodySchema = z.object({
  title: z.string().max(500).nullish(),
  agents: z.array(agentSpecSchema).max(50).optional(),
  orgChart: orgChartSchema.nullish(),
  threadId: z.string().uuid().nullish(),
});

const instructionsMdBodySchema = z.object({
  instructionsMd: z.string().max(100000).nullable(),
});

const updatePlanBodySchema = z.object({
  title: z.string().max(500).nullish(),
  agents: z.array(agentSpecSchema).max(50).optional(),
  orgChart: orgChartSchema.nullish(),
  threadId: z.string().uuid().nullish(),
});

const listPlansQuerySchema = z.object({
  status: z.enum(['draft', 'pending_approval', 'approved', 'provisioning', 'completed', 'failed']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const rejectBodySchema = z.object({
  reason: z.string().min(1).max(2000),
});

// ── Route registration ─────────────────────────────────────────────────

export async function registerWorkforcePlanRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /workforce-plans ───────────────────────────────────────────────

  app.get('/workforce-plans', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const parseResult = listPlansQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: parseResult.error.errors });
      }
      const { status, cursor, limit } = parseResult.data;

      const result = await workforcePlanService.listPlans(caller.tenantId, {
        status: status as WorkforcePlanStatus | undefined,
        cursor,
        limit,
      });

      return reply.send(result);
    } catch (err) {
      log.error({ err }, 'Failed to list workforce plans');
      return reply.code(500).send({ error: 'Failed to list workforce plans' });
    }
  });

  // ── POST /workforce-plans ──────────────────────────────────────────────

  app.post('/workforce-plans', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions to create workforce plans' });
      }

      const parseResult = createPlanBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: parseResult.error.errors });
      }
      const { title, agents, orgChart, threadId } = parseResult.data;

      const plan = await workforcePlanService.createDraft({
        tenantId: caller.tenantId,
        accountId: caller.accountId,
        title,
        agents,
        orgChart,
        threadId,
      });

      void writeAuditLog('workforce_plans.created', { tenantId: caller.tenantId, accountId: caller.accountId }, {
        planId: plan.id,
        agentCount: plan.agents.length,
      });

      return reply.code(201).send({ plan });
    } catch (err) {
      log.error({ err }, 'Failed to create workforce plan');
      return reply.code(500).send({ error: 'Failed to create workforce plan' });
    }
  });

  // ── GET /workforce-plans/:planId ───────────────────────────────────────

  app.get('/workforce-plans/:planId', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const { planId } = paramsResult.data;

      const plan = await workforcePlanService.getPlan(planId, caller.tenantId);
      return reply.send({ plan });
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to get workforce plan');
      return reply.code(500).send({ error: 'Failed to get workforce plan' });
    }
  });

  // ── PATCH /workforce-plans/:planId/instructions-md ────────────────────
  //
  // Admin-only: set the workforce-plan-level CLAUDE.md that is intended to
  // apply to every agent provisioned from this plan. Phase 1 writes the DB
  // column but the helper in internal-agents/effective-instructions-md.ts
  // does not yet merge the plan layer because internal_agents has no FK back
  // to workforce_plans. Once that linkage exists the helper is the single
  // place to change; this column is ready.

  app.patch('/workforce-plans/:planId/instructions-md', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions to update workforce plans' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const bodyResult = instructionsMdBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: bodyResult.error.errors });
      }
      const { planId } = paramsResult.data;
      const { instructionsMd } = bodyResult.data;

      // withTenantContext, not the raw pool: workforce_plans' RLS policy reads
      // app.current_tenant_id, which a pool connection never sets, so on the
      // pool this UPDATE would match zero rows and the edit would come back to
      // the user as a 404 having saved nothing. INV-WF-001.
      const result = await withTenantContext(caller.tenantId, (client) => client.query(
        `UPDATE workforce_plans SET instructions_md = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL RETURNING id, instructions_md`,
        [instructionsMd, planId, caller.tenantId],
      ));

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }

      void writeAuditLog('workforce_plans.instructions_md_updated', { tenantId: caller.tenantId, accountId: caller.accountId }, {
        planId,
        length: instructionsMd?.length ?? 0,
      });

      return reply.send({ id: result.rows[0].id, instructionsMd: result.rows[0].instructions_md });
    } catch (err) {
      log.error({ err }, 'Failed to update workforce plan instructions_md');
      return reply.code(500).send({ error: 'Failed to update workforce plan instructions_md' });
    }
  });

  // ── PATCH /workforce-plans/:planId ────────────────────────────────────

  app.patch('/workforce-plans/:planId', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions to update workforce plans' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const bodyResult = updatePlanBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: bodyResult.error.errors });
      }
      const { planId } = paramsResult.data;
      const { title, agents, orgChart, threadId } = bodyResult.data;

      const plan = await workforcePlanService.updateDraft(planId, caller.tenantId, {
        title,
        agents,
        orgChart,
        threadId,
      });

      void writeAuditLog('workforce_plans.updated', { tenantId: caller.tenantId, accountId: caller.accountId }, {
        planId,
        revision: plan.revision,
      });

      return reply.send({ plan });
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to update workforce plan');
      return reply.code(500).send({ error: 'Failed to update workforce plan' });
    }
  });

  // ── POST /workforce-plans/:planId/submit ───────────────────────────────

  app.post('/workforce-plans/:planId/submit', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const { planId } = paramsResult.data;

      const plan = await workforcePlanService.submitForApproval(planId, caller.tenantId);
      void writeAuditLog('workforce_plans.submitted', { tenantId: caller.tenantId, accountId: caller.accountId }, { planId });
      return reply.send({ plan });
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to submit workforce plan');
      return reply.code(500).send({ error: 'Failed to submit workforce plan' });
    }
  });

  // ── POST /workforce-plans/:planId/approve ──────────────────────────────

  app.post('/workforce-plans/:planId/approve', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const { planId } = paramsResult.data;

      const plan = await workforcePlanService.approve(planId, caller.tenantId, caller.accountId);
      void writeAuditLog('workforce_plans.approved', { tenantId: caller.tenantId, accountId: caller.accountId }, {
        planId,
        approvedBy: caller.accountId,
      });

      // The run row and the per-spec Cloud Tasks fan-out live in
      // workforcePlanService.approve(), not here: this route is not the only
      // way a plan gets approved, and the CAIO's workforce_plan__approve tool
      // calls the service directly.
      return reply.send({ plan });
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to approve workforce plan');
      return reply.code(500).send({ error: 'Failed to approve workforce plan' });
    }
  });

  // ── POST /workforce-plans/:planId/reject ───────────────────────────────

  app.post('/workforce-plans/:planId/reject', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const bodyResult = rejectBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: bodyResult.error.errors });
      }
      const { planId } = paramsResult.data;
      const { reason } = bodyResult.data;

      const plan = await workforcePlanService.reject(planId, caller.tenantId, reason);
      void writeAuditLog('workforce_plans.rejected', { tenantId: caller.tenantId, accountId: caller.accountId }, { planId });
      return reply.send({ plan });
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to reject workforce plan');
      return reply.code(500).send({ error: 'Failed to reject workforce plan' });
    }
  });

  // ── POST /workforce-plans/:planId/reopen ───────────────────────────────

  app.post('/workforce-plans/:planId/reopen', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const { planId } = paramsResult.data;

      const plan = await workforcePlanService.reopen(planId, caller.tenantId);
      void writeAuditLog('workforce_plans.reopened', { tenantId: caller.tenantId, accountId: caller.accountId }, {
        planId,
        revision: plan.revision,
      });
      return reply.send({ plan });
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to reopen workforce plan');
      return reply.code(500).send({ error: 'Failed to reopen workforce plan' });
    }
  });

  // ── DELETE /workforce-plans/:planId ───────────────────────────────────

  app.delete('/workforce-plans/:planId', async (request, reply) => {
    try {
      const caller = resolveCaller(request);
      if (!caller) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      if (!canMutate(caller.role)) {
        return reply.code(403).send({ error: 'Insufficient permissions' });
      }

      const paramsResult = planIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ error: 'Validation failed', details: paramsResult.error.errors });
      }
      const { planId } = paramsResult.data;

      await workforcePlanService.softDelete(planId, caller.tenantId);
      void writeAuditLog('workforce_plans.deleted', { tenantId: caller.tenantId, accountId: caller.accountId }, { planId });
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof WorkforcePlanNotFoundError) {
        return reply.code(404).send({ error: 'Workforce plan not found' });
      }
      if (err instanceof WorkforcePlanLifecycleError) {
        return reply.code(409).send({ error: err.message, currentStatus: err.currentStatus, attempted: err.attempted });
      }
      log.error({ err }, 'Failed to delete workforce plan');
      return reply.code(500).send({ error: 'Failed to delete workforce plan' });
    }
  });
}
