// Canonical agent state for tenant-runtime's reconciler.
//
// Tenant-runtime polls this every ~5 minutes (per its own Cloud Scheduler) to
// heal cache drift in cached_internal_agents and to ensure each ACTIVE agent
// with a cron trigger has a corresponding ENABLED Cloud Scheduler job. This
// endpoint is the source of truth — it queries internal_agents under tenant
// scope and returns the minimal projection the reconciler needs.
//
// Auth: shared bearer in X-Service-Auth (TENANT_RUNTIME_SERVICE_TOKEN, the
// default for verifyServiceAuth). Same secret tenant-runtime already uses
// for its other PB callbacks.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { internalAgentService } from './service';
import { buildInternalAgentEventPayload } from './event-payload';

export const canonicalAgentRuntimeRouter = Router();

const svcAuth = verifyServiceAuth(); // defaults to TENANT_RUNTIME_SERVICE_TOKEN

const querySchema = z.object({
  tenantId: z.string().uuid(),
});

interface CanonicalAgentRow {
  id: string;
  role: string;
  messaging_nickname: string | null;
  status: string;
  current_version: number;
  trigger_config: Record<string, unknown> | null;
  integrations: unknown[] | null;
}

export interface CanonicalAgent {
  id: string;
  role: string;
  messagingNickname: string | null;
  status: string; // 'draft' | 'active' | 'paused' | 'archived' in practice but not constrained by the DB; callers should narrow defensively
  currentVersion: number;
  triggerConfig: {
    type?: string;
    cronExpr?: string;
    timezone?: string;
    eventTopic?: string;
  } | null;
  integrations: unknown[];
}

// GET /api/internal/agent-runtime/canonical-agents?tenantId=<uuid>
canonicalAgentRuntimeRouter.get('/canonical-agents', svcAuth, async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', details: parsed.error.errors });
  }
  const { tenantId } = parsed.data;

  try {
    const rows = await withTenantScope(tenantId, async (c) => {
      const r = await c.query<CanonicalAgentRow>(
        `SELECT id,
                role,
                messaging_nickname,
                status,
                current_version,
                trigger_config,
                integrations
           FROM internal_agents
          WHERE tenant_id = $1
            AND deleted_at IS NULL`,
        [tenantId],
      );
      return r.rows;
    });

    const agents: CanonicalAgent[] = rows.map((r) => ({
      id: r.id,
      role: r.role,
      messagingNickname: r.messaging_nickname,
      status: (r.status as CanonicalAgent['status']),
      currentVersion: r.current_version,
      triggerConfig: (r.trigger_config as CanonicalAgent['triggerConfig']) ?? null,
      integrations: r.integrations ?? [],
    }));

    return res.json({ agents });
  } catch (err) {
    log.error({ tenantId, err: (err as Error).message }, '/canonical-agents failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/internal/agent-runtime/canonical-agents/:internalAgentId/full?tenantId=<uuid>
//
// Returns the FULL event-payload-equivalent shape for one internal agent —
// matches what the `tenant.internal_agent.created` Pub/Sub event would have
// carried. Tenant-runtime's reconciler calls this ONLY in the self-heal path
// where the local mapping is missing (i.e., the original event was lost
// to DLQ exhaustion, subscriber crash mid-handler, schema-drift skip, etc.).
//
// Returned via buildInternalAgentEventPayload so reconciler's INSERT logic
// stays byte-identical to the event subscriber's INSERT — single source of
// truth for the agent-creation payload shape.
const fullParamsSchema = z.object({
  internalAgentId: z.string().uuid(),
});

canonicalAgentRuntimeRouter.get(
  '/canonical-agents/:internalAgentId/full',
  svcAuth,
  async (req: Request, res: Response) => {
    const params = fullParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: 'invalid_params', details: params.error.errors });
    }
    const query = querySchema.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ error: 'invalid_query', details: query.error.errors });
    }

    try {
      const agent = await internalAgentService.getById(
        params.data.internalAgentId,
        query.data.tenantId,
      );
      if (!agent) {
        return res.status(404).json({ error: 'not_found' });
      }
      const payload = await buildInternalAgentEventPayload(
        agent,
        'tenant.internal_agent.created',
      );
      return res.json({ payload });
    } catch (err) {
      log.error(
        {
          tenantId: query.data.tenantId,
          internalAgentId: params.data.internalAgentId,
          err: (err as Error).message,
        },
        '/canonical-agents/:id/full failed',
      );
      return res.status(500).json({ error: 'internal_error' });
    }
  },
);

// POST /canonical-agents/:internalAgentId/pause
//
// The runtime asks the control plane to stop an agent. It is deliberately the
// SAME `updateStatus` the dashboard's Pause button calls, because the agent's
// status is the only thing that stops an agent — the runtime must never reach
// around it and pause Cloud Scheduler jobs directly.
//
// A stop the operator cannot see is a stop they cannot undo. The status column
// shows Paused, Resume sets it back to active, and the reconciler follows the
// status in both directions; nothing here records a second piece of state that
// Resume would fail to clear.
const pauseParamsSchema = z.object({
  internalAgentId: z.string().uuid(),
});

const pauseBodySchema = z.object({
  tenantId: z.string().uuid(),
});

canonicalAgentRuntimeRouter.post(
  '/canonical-agents/:internalAgentId/pause',
  svcAuth,
  async (req: Request, res: Response) => {
    const params = pauseParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({ error: 'invalid_params', details: params.error.errors });
    }
    const body = pauseBodySchema.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'invalid_body', details: body.error.errors });
    }

    try {
      const updated = await internalAgentService.updateStatus(
        params.data.internalAgentId,
        body.data.tenantId,
        'paused',
      );
      if (!updated) {
        return res.status(404).json({ error: 'not_found' });
      }
      log.warn(
        {
          tenantId: body.data.tenantId,
          internalAgentId: params.data.internalAgentId,
          metric: 'agent.paused_by_runtime',
        },
        'agent paused at the runtime request — visible in the status column, cleared by Resume',
      );
      return res.json({ status: updated.status });
    } catch (err) {
      log.error(
        {
          tenantId: body.data.tenantId,
          internalAgentId: params.data.internalAgentId,
          err: (err as Error).message,
        },
        '/canonical-agents/:id/pause failed',
      );
      return res.status(500).json({ error: 'internal_error' });
    }
  },
);
