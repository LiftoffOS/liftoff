// Internal Agents Router
// CRUD endpoints for internal agent management (UI: "Agents")

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { withNormalizedTier } from '../llm/types';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { requireSchedulerOidc } from '../infrastructure/scheduler-auth';
import { internalAgentService } from './service';
import { stripServiceAuthCreateBody } from './service-auth-create-guard';
import { distillInternalAgent } from './distill-service';
import { DistillationGraphNotConvergedError } from './distill-errors';
import { getDistillArtifact } from './distill-artifact-store';
import { checkAndIncrementChatRateLimit, type ChatRateLimitCaps } from '../common/chat-rate-limiter';
import { publishInternalAgentEvent } from './events';
import { validateIntegrationsArray, IntegrationValidationError } from './integration-validator';
import { RequiredConnectorMissingError } from './required-connector-guard';
import { buildInternalAgentEventPayload } from './event-payload';
import { mapInternalAgentRow, toClientAgent, toClientAgents, toClientVersion } from './row-mapper';
import { log, logAudit } from '../infrastructure/logging';
import { withIdempotency } from '../infrastructure/idempotency';
import { withIdempotencyMiddleware } from '../infrastructure/idempotency-middleware';
import { InternalAgentStatus, RecentlyViewedInternalAgentsResponse } from './types';
import { teamAttachmentsArraySchema } from './attachment-schema';
import { AccountService } from '../accounts/service';
import { AccountRepository } from '../accounts/repository';
import { applyAbsorption } from './absorption-apply';
import { fireAndForget } from '../shared/fire-and-forget';
import { attributeSessionToAgent } from '../llm/usage-tracker';
import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { checkExecutionAllowed } from '../billing/execution-guard';
import { webhookManagementRouter } from '../event-sources/routes';
import { resolveActor, PermissionDenied } from '../workspace-actions/actor';
import { parseLiftoffOriginHeader } from '../workspace-actions/origin-header';
import { applyTeamUpdate, isTeamUpdateRefusal } from '../workspace-actions/team-update';
import { teamUpdatePatchSchema } from '../workspace-actions/schemas';
import { ACTIVATION_LIMIT, setTeamStatus } from '../workspace-actions/team-status';
import { archiveTeam } from '../workspace-actions/team-archive';

// The fields a service caller may never set directly: every one is a
// distillation output, derived from the prose, and writing it by hand would
// let the prompt, the trigger and the workflow drift from the text that is
// supposed to produce them.
const SVC_PATCH_REJECTED_BY_NAME: ReadonlySet<string> = new Set([
  'triggerConfig', 'workflowSteps', 'systemPrompt', 'userInstructions', 'instructionsMd',
  'modelConfig', 'memoryScope', 'execConfig', 'capabilityTier', 'resultRules',
]);

export const internalAgentsRouter = Router();

// Per-agent inbound webhook management. Mounted as a sub-router so the
// :internalAgentId param is available via Router({ mergeParams: true }).
// Sits under the same Firebase-auth pipeline as the rest of internalAgentsRouter.
internalAgentsRouter.use('/:internalAgentId/webhook', webhookManagementRouter);

// Service-auth router for tenant-runtime to verify canonical agent status.
// Mounted BEFORE authMiddleware in index.ts (same pattern as entitlementsServiceRouter).
export const internalAgentsServiceRouter = Router();


// Service-auth GET for system-agent config consumed by workforce-service.
// Only returns rows with is_system=TRUE — system agents have tenant_id IS NULL
// so the tenant-scoped public GET handler cannot reach them. The returned shape
// is intentionally narrow (id, systemRole, systemPrompt, modelConfig) so it can
// never leak tenant data even if a tenant agent's id is supplied.
//
// Auth: shared `workforce-service-token` (env var WORKFORCE_SERVICE_TOKEN here,
// mirrored as WORKFORCE_SERVICE_TOKEN on the workforce-service Cloud Run via
// cloudbuild's --update-secrets). Same secret platform-backend already uses to
// gate /api/internal/agent-templates calls from workforce-service.
internalAgentsServiceRouter.get('/system/:internalAgentId', verifyServiceAuth({ tokenEnvVar: 'WORKFORCE_SERVICE_TOKEN' }), async (req, res) => {
  try {
    const { internalAgentId } = req.params;
    // System (is_system) agents are platform-level (may carry a NULL tenant_id)
    // and this endpoint has no tenant context — resolve by id under admin bypass.
    const result = await withAdminScope(
      { caller: 'internal-agents.router.systemAgentById', reason: 'fetch is_system agent config by id (no tenant context; system agents are platform-level)' },
      (client) => client.query(
        `SELECT id, system_role, system_prompt, model_config
           FROM internal_agents
          WHERE id = $1 AND is_system = TRUE AND deleted_at IS NULL`,
        [internalAgentId],
      ),
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'System agent not found' });
    }
    const row = result.rows[0];
    res.json({
      id: row.id,
      systemRole: row.system_role,
      systemPrompt: row.system_prompt,
      modelConfig: row.model_config && withNormalizedTier(row.model_config),
    });
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId }, 'Failed to fetch system agent config');
    res.status(500).json({ error: 'Internal error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Service-auth endpoints consumed by liftoff-workforce-service's HRBP loop.
// Mounted under /api/internal-agents/_svc/ so they don't conflict with the
// Firebase-gated /api/internal-agents routes that the UI uses, and so they
// short-circuit BEFORE authMiddleware fires.
//
// All three accept the shared workforce-service-token (env var
// WORKFORCE_SERVICE_TOKEN here, mirrored as WORKFORCE_SERVICE_TOKEN on
// the workforce-service Cloud Run via cloudbuild's --update-secrets).
// ────────────────────────────────────────────────────────────────────────────

const svcAuth = verifyServiceAuth({ tokenEnvVar: 'WORKFORCE_SERVICE_TOKEN' });

// POST /api/internal-agents/_svc/distill — HRBP teambuilder__distill.
internalAgentsServiceRouter.post('/_svc/distill', svcAuth, async (req, res) => {
  try {
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const { role, responsibilities, integrations, additionalContext, expectedCadences, templateId } = req.body ?? {};
    if (!role || !responsibilities) {
      return res.status(400).json({ error: 'role and responsibilities are required' });
    }
    // WS-5.1 — validate integrations on service-auth distill path too.
    if (Array.isArray(integrations) && integrations.length > 0) {
      try {
        await validateIntegrationsArray(integrations, { tenantId });
      } catch (err) {
        if (err instanceof IntegrationValidationError) {
          return res.status(400).json({ error: err.message, context: err.context });
        }
        throw err;
      }
    }
    const result = await distillInternalAgent({
      tenantId,
      role,
      responsibilities,
      integrations: integrations ?? [],
      additionalContext: additionalContext ?? null,
      // Forwarded, and load-bearing. A template carries obligations, authored
      // flows and tool notes that reach the output only when distillation knows
      // which template it is compiling. Dropped here, an HRBP-built hire from a
      // template silently gets none of them — and gets a plausible agent, so
      // nothing reports the loss. The Explore page's own distill route has
      // always sent it; this one is the same pipeline and needs the same input.
      ...(typeof templateId === 'string' && templateId.length > 0 ? { templateId } : {}),
      // Derive-then-verify passthrough: same contract the Firebase-gated
      // distill route accepts, so both doors to the pipeline can carry it.
      ...(Array.isArray(expectedCadences) && expectedCadences.length > 0
        ? { expectedCadences }
        : {}),
    });
    res.json(result);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'service-auth distill failed');
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/internal-agents/_svc — the CAIO's org__get_existing_structure.
//
// The Firebase-gated GET /api/internal-agents below cannot be reached with a
// service token, so service callers need their own list.
//
// Deliberately unpaginated and cost-free: the caller wants a roster, the 30-day
// cost rollup is a join it never reads, and a cursor loop lets a single failed
// page read as an empty org.
internalAgentsServiceRouter.get('/_svc', svcAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const agents = await internalAgentService.listAllByTenant(tenantId, { includeCosts: false });
    res.json({ agents, total: agents.length });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'service-auth agent list failed');
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/internal-agents/_svc — HRBP teambuilder__create.
// Service-auth callers cannot set modelConfig; tier='medium' is applied
// server-side. The same admin-gate behaviour as the UI POST path.
internalAgentsServiceRouter.post('/_svc', svcAuth, async (req, res) => {
  try {
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const body = stripServiceAuthCreateBody(req.body);
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
    const agent = await internalAgentService.create(
      tenantId,
      body as never, // CreateInternalAgentInput is internal; body has been schema-checked by the caller
      idempotencyKey,
      undefined,
      'create',
    );
    res.status(201).json({ agent });
  } catch (error) {
    // A template named a connector the hire did not bind. The person can
    // fix that on the tools step, so it is theirs to see, not a 500.
    if (error instanceof RequiredConnectorMissingError) {
      return res.status(422).json({ error: error.message, context: error.context });
    }
    log.error({ error: (error as Error).message }, 'service-auth create failed');
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/internal-agents/_svc/:id — HRBP provisioning__compensate.
internalAgentsServiceRouter.delete('/_svc/:internalAgentId', svcAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const ok = await internalAgentService.delete(req.params.internalAgentId, tenantId);
    if (!ok) return res.status(404).json({ error: 'agent not found' });
    res.status(204).send();
  } catch (error) {
    log.error({ error: (error as Error).message, internalAgentId: req.params.internalAgentId }, 'service-auth delete failed');
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/internal-agents/_svc/:internalAgentId/config?tenantId=…
//
// The CAIO's team__get_config: the full prose (the settings page's source
// fields) plus a trigger summary, so a change can be proposed against what
// the team member actually says and runs — never against a paraphrase.
internalAgentsServiceRouter.get('/_svc/:internalAgentId/config', svcAuth, async (req, res) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const agent = await internalAgentService.getById(req.params.internalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'No team member matches that id in this tenant.' });
    }
    const trigger = (agent.triggerConfig ?? null) as
      | (NonNullable<typeof agent.triggerConfig> & {
          companionCrons?: Array<{ label?: string; cronExpr?: string }>;
        })
      | null;
    return res.json({
      id: agent.id,
      role: agent.role,
      status: agent.status,
      responsibilities: agent.responsibilities,
      additionalContext: agent.additionalContext,
      trigger: trigger
        ? {
            type: trigger.type,
            cronExpr: trigger.cronExpr ?? null,
            companions: (trigger.companionCrons ?? []).map((c) => ({
              label: c.label ?? null,
              cronExpr: c.cronExpr ?? null,
            })),
          }
        : null,
    });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'service-auth config read failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// PATCH /api/internal-agents/_svc/:internalAgentId — the Chief AI Officer's
// team update.
//
// The same function the dashboard's Save calls (applyTeamUpdate), with the
// distil run SERVER-SIDE over the merged inputs before anything is written:
// a failed distil saves nothing, and a successful one lands as one version
// with source 'distill', exactly like Save (D4). The body may carry the same
// patch an assistant may send — prose, attachments, bindings, skill verbs,
// memory deletions, the customer-safe overrides — and still rejects, by
// name, the fields that are distillation outputs.
//
// The actor is the person the CAIO is speaking for, from the caller headers
// it sends (x-account-id; x-tenant-role is informational — membership is
// re-read here) plus x-origin when the CAIO turn itself came through
// a coding tool, so the audit row says so.
internalAgentsServiceRouter.patch('/_svc/:internalAgentId', svcAuth, async (req, res) => {
  try {
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rejected = Object.keys(body).filter((k) => SVC_PATCH_REJECTED_BY_NAME.has(k));
    if (rejected.length > 0) {
      return res.status(400).json({
        error: `Only prose fields may be updated here; rejected: ${rejected.join(', ')}. `
          + 'Everything else is a distillation output.',
      });
    }
    const { tenantId: _tenantId, ...patchBody } = body;
    const parsed = teamUpdatePatchSchema.safeParse(patchBody);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }
    const patch = parsed.data;
    if (Object.keys(patchBody).length === 0) {
      return res.status(400).json({
        error: 'Provide responsibilities and/or additionalContext.',
      });
    }
    if (typeof patch.responsibilities === 'string' && patch.responsibilities.trim().length === 0) {
      delete patch.responsibilities;
    }

    const accountId = req.headers['x-account-id'];
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return res.status(401).json({ error: 'x-account-id is required: the update is made as a person' });
    }
    const origin = parseLiftoffOriginHeader(req.headers['x-origin']);
    const actor = await resolveActor({ tenantId, accountId, surface: 'caio', ...(origin ?? {}) });
    if (!actor) {
      return res.status(403).json({ error: 'The person is not a member of this workspace' });
    }

    const result = await applyTeamUpdate(actor, req.params.internalAgentId, patch, { distill: 'server' });
    if (isTeamUpdateRefusal(result)) {
      switch (result.refused) {
        case 'not_found':
          return res.status(404).json({ error: 'No team member matches that id in this tenant.' });
        case 'validation':
          return res.status(400).json({ error: result.message, ...(result.context !== undefined ? { context: result.context } : {}) });
        case 'nickname_conflict':
          return res.status(409).json({ error: result.message, code: 'NICKNAME_CONFLICT' });
        case 'workflow_tampered':
          return res.status(409).json({ error: result.message, code: 'WORKFLOW_TAMPERED' });
        case 'distill_failed':
          // Nothing was written: the distil ran first and did not converge.
          return res.status(502).json({
            distilled: false,
            error: 'The team could not be rebuilt from the new text, so nothing was changed. Try again shortly.',
          });
      }
    }

    return res.json({
      distilled: true,
      agent: toClientAgent(result.agent),
      ...(result.memoryDeletionsFailed ? { memoryDeletionsFailed: result.memoryDeletionsFailed } : {}),
    });
  } catch (error) {
    if (error instanceof PermissionDenied) {
      return res.status(403).json({ error: error.message });
    }
    log.error({ error: (error as Error).message }, 'service-auth team update failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/internal-agents/_svc/redistill-all?tenantId=…
// Service-auth twin of /api/internal-agents/redistill-all. Same redistill-service
// path, no Firebase actor (actorId is undefined — the audit row will be
// attributed to the service caller via the standard audit context).
//
// MUST be declared BEFORE `/_svc/:internalAgentId/redistill` so Express matches
// "redistill-all" literally instead of treating it as :internalAgentId.
internalAgentsServiceRouter.post('/_svc/redistill-all', svcAuth, async (req, res) => {
  try {
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const dryRun = req.query.dryRun === 'true';
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    const { redistillAllAgents, RedistillTooManyAgentsError } = await import('./redistill-service');
    const run = async (): Promise<{ status: number; body: unknown }> => {
      try {
        const result = await redistillAllAgents(tenantId, undefined, { dryRun });
        return { status: 200, body: result };
      } catch (err) {
        if (err instanceof RedistillTooManyAgentsError) {
          return {
            status: 413,
            body: { error: err.message, code: 'TOO_MANY_AGENTS', agentCount: err.agentCount },
          };
        }
        throw err;
      }
    };

    if (idempotencyKey) {
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ tenantId, dryRun })).digest('hex');
      const wrapped = await withIdempotency(
        tenantId,
        idempotencyKey,
        'POST /api/internal-agents/_svc/redistill-all',
        requestHash,
        run,
      );
      if (wrapped.cached) res.setHeader('X-Idempotency-Replay', 'true');
      return res.status(wrapped.status).json(wrapped.response);
    }

    const out = await run();
    res.status(out.status).json(out.body);
  } catch (error) {
    log.error({ err: (error as Error).message, tenantId: req.query.tenantId }, 'service-auth redistill-all failed');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agents/_svc/:internalAgentId/redistill?tenantId=…
// Service-auth twin of /api/internal-agents/:id/redistill.
internalAgentsServiceRouter.post('/_svc/:internalAgentId/redistill', svcAuth, async (req, res) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    const { redistillAgent, RedistillNotFoundError } = await import('./redistill-service');
    const run = async (): Promise<{ status: number; body: unknown }> => {
      try {
        const updated = await redistillAgent(internalAgentId, tenantId, undefined);
        return { status: 200, body: updated };
      } catch (err) {
        if (err instanceof RedistillNotFoundError) {
          return { status: 404, body: { error: err.message } };
        }
        // The rebuild did not converge and was not applied: the agent keeps
        // its whole incumbent configuration. Named to the caller the way the
        // hire flow names it, so the two surfaces agree on what happened.
        if (err instanceof DistillationGraphNotConvergedError) {
          return {
            status: 422,
            body: { error: err.message, errorCode: 'graph_not_converged', rejections: err.reasons },
          };
        }
        throw err;
      }
    };

    if (idempotencyKey) {
      const requestHash = crypto.createHash('sha256')
        .update(JSON.stringify({ internalAgentId, tenantId }))
        .digest('hex');
      const wrapped = await withIdempotency(
        tenantId,
        idempotencyKey,
        'POST /api/internal-agents/_svc/:internalAgentId/redistill',
        requestHash,
        run,
      );
      if (wrapped.cached) res.setHeader('X-Idempotency-Replay', 'true');
      return res.status(wrapped.status).json(wrapped.response);
    }

    const out = await run();
    res.status(out.status).json(out.body);
  } catch (error) {
    log.error(
      { err: (error as Error).message, internalAgentId: req.params.internalAgentId, tenantId: req.query.tenantId },
      'service-auth redistill failed',
    );
    res.status(500).json({ error: (error as Error).message });
  }
});

// Observed outcomes for one agent, before and after a redistill. Counts only —
// the caller has already filtered provider outages and configured ceilings out
// of `agentQualityFailures`, because those say nothing about instructions we
// rewrote and rolling back on them would revert good work over someone else's
// incident.
const canaryWindowSchema = z.object({
  runs: z.number().int().min(0),
  agentQualityFailures: z.number().int().min(0),
  escalations: z.number().int().min(0),
  hitlRejections: z.number().int().min(0),
});

const redistillCanarySchema = z.object({
  before: canaryWindowSchema,
  after: canaryWindowSchema,
  /** The version to restore when the verdict is `rollback`. */
  fromVersion: z.number().int().min(1),
  /** Perform the rollback rather than only reporting the verdict. Defaults to
   *  false so evaluating is never accidentally destructive. */
  apply: z.boolean().optional().default(false),
  config: z.object({
    mdeMultiple: z.number().positive().optional(),
    posteriorThreshold: z.number().min(0).max(1).optional(),
    minAfterRuns: z.number().int().min(1).optional(),
  }).partial().optional(),
});

// POST /api/internal-agents/_svc/:internalAgentId/redistill-canary?tenantId=…
//
// Did a redistill make this agent worse? The caller supplies the observed
// before/after windows; this decides, and rolls the agent back to `fromVersion`
// when the evidence says so.
//
// The caller owns data collection deliberately. The runs live in the tenant
// runtime, the windows depend on how a wave was staged, and inventing a
// collection schedule here would bake one policy into the decision function.
//
// Only DETERMINISTIC signals reach this: agent-quality failure classes,
// escalations, HITL rejections. Provider outages and configured ceilings are
// filtered out before they get here, and judge scores never do — they flag for
// human review and were never built to gate.
internalAgentsServiceRouter.post('/_svc/:internalAgentId/redistill-canary', svcAuth, async (req, res) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const parsed = redistillCanarySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }

    const { evaluateRedistillCanary, DEFAULT_CANARY_CONFIG } = await import('./redistill-canary');
    const verdict = evaluateRedistillCanary(parsed.data.before, parsed.data.after, {
      ...DEFAULT_CANARY_CONFIG,
      ...(parsed.data.config ?? {}),
    });

    // `apply: false` is the default: an evaluation is not a rollback, and a
    // caller that only wants to look must not have to guess.
    if (verdict.decision !== 'rollback' || !parsed.data.apply) {
      return res.status(200).json({ verdict, rolledBack: false });
    }

    const restored = await internalAgentService.rollbackToVersion(
      internalAgentId,
      tenantId,
      parsed.data.fromVersion,
      undefined,
    );
    if (!restored) {
      return res.status(404).json({
        verdict,
        rolledBack: false,
        error: 'agent or version not found. The verdict stands, but nothing was reverted.',
      });
    }

    log.warn(
      {
        metric: 'redistill.canary.rolled_back',
        internalAgentId,
        tenantId,
        toVersion: parsed.data.fromVersion,
        newVersion: restored.currentVersion,
        posteriorProbability: verdict.posteriorProbability,
        beforeRate: verdict.beforeRate,
        afterRate: verdict.afterRate,
      },
      'redistill canary rolled an agent back',
    );

    return res.status(200).json({ verdict, rolledBack: true, agent: restored });
  } catch (error) {
    log.error(
      { err: (error as Error).message, internalAgentId: req.params.internalAgentId, tenantId: req.query.tenantId },
      'redistill canary failed',
    );
    res.status(500).json({ error: (error as Error).message });
  }
});

internalAgentsServiceRouter.get('/:internalAgentId/status', verifyServiceAuth(), async (req, res) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT status FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [req.params.internalAgentId, tenantId],
    ));
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'agent not found' });
    }
    res.json({ status: result.rows[0].status });
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId }, 'Failed to fetch canonical agent status');
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /internal-agents/reconcile-runtime-state
// Reconciler full pass (plan §6.4). Called by Cloud Scheduler every 5 min.
//
// Auth: platform-backend's Cloud Run service is deployed with
// invokers=["allUsers"] (see terraform/projects/platform-control/main.tf),
// so platform-level IAM does NOT gate the request. Application-level OIDC
// verification is required to prevent an unauthenticated caller from
// triggering a global cross-tenant fan-out (per-tenant runtime fetches,
// outbox enqueues, Pub/Sub publishes, custom-metric writes).
//
// Cloud Scheduler is configured with oidc_token{ service_account_email,
// audience } in the terraform — we verify the resulting bearer token here.
internalAgentsServiceRouter.post(
  '/reconcile-runtime-state',
  requireSchedulerOidc({
    // BACKEND_URL names the host this deployment serves its API on, so it
    // differs per deployment. If unset, FAIL the audience check rather than
    // silently falling back to the prod URL — a dev backend that quietly
    // accepts prod-minted tokens is a cross-environment trust bug.
    // requireSchedulerOidc treats an empty string as "configuration missing"
    // and returns 500 rather than authenticating.
    expectedAudience: () => process.env.BACKEND_URL ?? '',
    allowedEmails: () => [process.env.CLOUD_SCHEDULER_SA_EMAIL ?? ''],
  }),
  async (req, res) => {
    const dryRun = req.query.dryRun === 'true';
    const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId.length > 0
      ? req.query.tenantId
      : undefined;
    try {
      const { runReconciliation } = await import('./reconciler');
      const summary = await runReconciliation({ dryRun, tenantId });
      return res.json(summary);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  },
);

// Single-agent reconcile (plan §6.9). Called by tenant-runtime's chat-turn race
// fallback. Same pattern as src/internal-api/platform-tools-router.ts:39 — the
// runtime sends X-Service-Auth: PLATFORM_CALLBACK_TOKEN alongside the OIDC
// Authorization bearer that Cloud Run IAM validates.
internalAgentsServiceRouter.post(
  '/:internalAgentId/reconcile-now',
  verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' }),
  async (req, res) => {
    const tenantId = req.query.tenantId as string | undefined;
    const { internalAgentId } = req.params;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    try {
      const { reconcileOneAgentNow } = await import('./reconciler');
      const result = await reconcileOneAgentNow(tenantId, internalAgentId);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  },
);

// POST /api/internal-agents/_svc/:internalAgentId/force-republish?tenantId=…
//
// Operational lever: emit a fresh `tenant.internal_agent.updated` event with
// envelope entity_version=null so the runtime's version gate is bypassed and
// the current PB payload is applied unconditionally. Use this when an agent
// is stuck on a historical event that was processed by a since-fixed buggy
// handler version (canonical: CSR's v22 pre-ec5fcc5 trigger_config drop —
// event_versions advanced past it so neither the version-gated republish
// nor the reconciler's normal classify-and-repair pass will fire again).
//
// Service-auth gated (WORKFORCE_SERVICE_TOKEN). Same idempotency contract as
// redistill — caller may pass Idempotency-Key to dedupe in case of retry.
internalAgentsServiceRouter.post('/_svc/:internalAgentId/force-republish', svcAuth, async (req, res) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = (req.query.tenantId as string) || (req.body?.tenantId as string);
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
    const { forceRepublishAgent } = await import('./reconciler');
    const result = await forceRepublishAgent(tenantId, internalAgentId);
    return res.status(200).json(result);
  } catch (error) {
    log.error(
      { err: (error as Error).message, internalAgentId: req.params.internalAgentId, tenantId: req.query.tenantId },
      'force-republish failed',
    );
    res.status(500).json({ error: (error as Error).message });
  }
});


// The coordinator's handleInternalAgentCreated is idempotent — agents that already
// have an internal_agent_runtime_mapping row are skipped without side effects.
// Use this to fix agents created before the coordinator subscription was provisioned.
internalAgentsServiceRouter.post('/backfill-created-events', verifyServiceAuth(), async (req, res) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId required' });
  }
  try {
    // SELECT * because these rows go through mapInternalAgentRow, which reads
    // ~38 columns. A hand-written list here silently maps every column it omits
    // to the mapper's DEFAULT, and this endpoint republishes a `created` event
    // — the one the runtime rebuilds an agent from. The list this replaced was
    // missing twenty of them.
    //
    // The consequence verified against the runtime: `capabilityTier` defaults to
    // 'connector_only', and the runtime writes it into the new
    // compiled_instructions row unconditionally
    // (internal-agent-instruction-service.ts: `input.capabilityTier ?? <prompt
    // heuristic>`), so a republish DEMOTES an execution_enabled agent. Same for
    // instructionsMd / pinnedKnowledgeIds / workflowSteps / messagingNickname /
    // attachments, all of which arrive null or empty.
    //
    // Skills are NOT at risk, which is worth writing down because the opposite
    // is the intuitive guess: the runtime's supersede-then-insert is guarded by
    // `if (input.skills && input.skills.length > 0)`, so the empty array this
    // produced is a no-op rather than an erasure.
    //
    // Every other caller of the mapper — all twenty — selects *; this was the
    // only one that did not.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT * FROM internal_agents
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [tenantId],
    ));

    const published: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const row of result.rows) {
      try {
        const agent = mapInternalAgentRow(row);
        const eventPayload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created');
        // null entity_version bypasses the coordinator version gate — backfill events
        // must always process regardless of what updated events already stored.
        await publishInternalAgentEvent('tenant.internal_agent.created', row.id, tenantId, null, eventPayload);
        published.push(row.id);
      } catch (agentError) {
        errors.push({ id: row.id, error: (agentError as Error).message });
        log.error({ error: agentError, internalAgentId: row.id, tenantId }, 'Failed to republish created event in batch');
      }
    }

    log.info({ tenantId, published: published.length, errors: errors.length }, 'Batch backfill of created events completed');
    res.json({ success: errors.length === 0, published: published.length, errors, agentIds: published });
  } catch (error) {
    log.error({ error, tenantId }, 'Batch backfill failed');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /internal-agents/backfill-deleted-events (service auth)
// Re-publish tenant.internal_agent.deleted for every soft-deleted agent on the tenant.
// Drains runtime orphans created when a delete event was lost in transit, or when
// the agent was deleted before the delete-event publishing code path existed.
// The runtime's handleInternalAgentDeleted handler is idempotent — replays are safe.
// Supports ?dryRun=true to enumerate without publishing.
internalAgentsServiceRouter.post('/backfill-deleted-events', verifyServiceAuth(), async (req, res) => {
  const tenantId = req.query.tenantId as string;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId required' });
  }
  const dryRun = req.query.dryRun === 'true';

  try {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, deleted_at
       FROM internal_agents
       WHERE tenant_id = $1 AND deleted_at IS NOT NULL
       ORDER BY deleted_at ASC`,
      [tenantId],
    ));

    const published: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const row of result.rows) {
      if (dryRun) {
        published.push(row.id);
        continue;
      }
      try {
        // null entity_version bypasses the coordinator version gate — backfill
        // delete events must always process regardless of stored version state.
        // Payload is empty by convention (see /:internalAgentId delete handler).
        await publishInternalAgentEvent('tenant.internal_agent.deleted', row.id, tenantId, null, {});
        published.push(row.id);
      } catch (agentError) {
        errors.push({ id: row.id, error: (agentError as Error).message });
        log.error({ error: agentError, internalAgentId: row.id, tenantId }, 'Failed to republish deleted event in batch');
      }
    }

    log.info({ tenantId, published: published.length, errors: errors.length, dryRun }, 'Batch backfill of deleted events completed');
    res.json({ success: errors.length === 0, dryRun, published: published.length, errors, agentIds: published });
  } catch (error) {
    log.error({ error, tenantId }, 'Batch backfill of deleted events failed');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /internal-agents/:internalAgentId/republish-created (service auth)
// Re-publishes tenant.internal_agent.created for a single agent.
internalAgentsServiceRouter.post('/:internalAgentId/republish-created', verifyServiceAuth(), async (req, res) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId required' });
    }
    const internalAgent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!internalAgent) {
      return res.status(404).json({ error: 'agent not found' });
    }
    const eventPayload = await buildInternalAgentEventPayload(internalAgent, 'tenant.internal_agent.created');
    await publishInternalAgentEvent('tenant.internal_agent.created', internalAgent.id, tenantId, internalAgent.currentVersion, eventPayload);
    log.info({ internalAgentId, tenantId }, 'Re-published internal agent created event via service auth');
    res.json({ success: true, message: 'Created event re-published' });
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId }, 'Failed to republish created event via service auth');
    res.status(500).json({ error: (error as Error).message });
  }
});

const accountService = new AccountService();
const accountRepository = new AccountRepository();

// SE-001: Middleware for tenant authorization
// Tenant role-floor + ownership checks live in
// infrastructure/tenant-role-auth so multiple routers can share one
// implementation. Re-export the local names that downstream callers in
// this file already reference.
import { verifyTenantOwnership, requireMinRole } from '../infrastructure/tenant-role-auth';

// SE-005: Rate limit activation to prevent abuse. The ceiling lives with the
// shared status function, which enforces it for the assistants; this limiter
// is the same rule at the door for the dashboard path.
const activationLimiter = rateLimit({
  windowMs: ACTIVATION_LIMIT.windowMs,
  max: ACTIVATION_LIMIT.max,
  keyGenerator: (req) => (req.query.tenantId as string) || req.params.tenantId || req.body.tenantId,
  message: { error: 'Too many activation requests, please try again later' },
});

// Integration permission schema lives in ./permission-schemas so tests can
// import it without pulling in the full router → service graph.
export { integrationPermissionSchema, gmailBindingConfigSchema, outlookBindingConfigSchema } from './permission-schemas';
import { integrationPermissionSchema } from './permission-schemas';

import {
  adminModelConfigSchema,
  customerModelConfigSchema,
  memoryScopeSchema,
  execConfigSchema,
  workflowStepSchema,
  triggerConfigSchema,
  skillObjectSchema,
  resultRulesArraySchema,
  absorptionClassificationArraySchema,
  updateInternalAgentSchema,
  updateStatusSchema,
} from '../workspace-actions/schemas';
// Test-only handles and the loop schema keep their historical import path.
export {
  workflowStepLoopSchema,
  __workflowStepSchemaForTest,
  __workflowStepDelaySchemaForTest,
  __triggerConfigSchemaForTest,
} from '../workspace-actions/schemas';

// Delegate agent schema
// Input validation schemas (BE-003)
const createInternalAgentSchema = z.object({
  role: z.string().min(1).max(255),
  responsibilities: z.string().max(10000).optional(),
  integrations: z.array(integrationPermissionSchema).max(50).optional(),
  additionalContext: z.string().max(10000).optional(),
  // Which template this was hired from, so a later redistill can seed from it
  // again. Stored beside a hash of the authored text: the id is used only while
  // that text is still the template's. See migration 378.
  templateId: z.string().max(200).optional(),
  // The prose arrived already rewritten, so no provenance baseline is recorded
  // for it. Declared here or zod strips it and the hire is fingerprinted as
  // though it still said what the template said — see the field's own comment
  // in types.ts for why that is silent and costly.
  templateTextEdited: z.boolean().optional(),
  // The destinations the person named on the connectors step, keyed by object
  // id. Sent so the STORED prose can be resolved, not only the prompt.
  //
  // The distiller resolved `{{pick:...}}` on its way into the model and left
  // the stored text raw, which had two consequences. The edit screen showed a
  // person our own placeholder syntax. And picks live nowhere else, so a later
  // redistill had nothing to resolve them from and quietly substituted the
  // generic fallback — an agent told to post to "#deal-room" started saying
  // "your deal channel", with no error and a well-formed prompt.
  templatePicks: z.record(
    z.string().max(100),
    z.object({
      id: z.string().max(500),
      title: z.string().max(500),
      // Only a destination sends this, and only because it accepts either a
      // folder or a file: the prose that names it has to read correctly for
      // both, and the two imply different places for the work.
      kind: z.enum(['folder', 'file']).optional(),
    }),
  ).optional(),
  summary: z.string().max(10000).optional(),
  // systemPrompt / userInstructions / instructionsMd are no longer accepted.
  // They are generated, not authored, and taking them from a request body let a
  // caller pair any prompt with any templateId — nothing tied an agent labelled
  // with a template to that template's text. They now arrive only by redeeming
  // `distillId` against the artifact the distiller wrote.
  temperature: z.number().min(0).max(2).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
  // Runtime config fields
  agentType: z.enum(['agent', 'workflow']).optional(),
  modelConfig: adminModelConfigSchema,                     // customerModelConfigSchema gates non-admin requests before this fires
  pendingIntegrations: z.array(z.string()).optional(),
  memoryScope: memoryScopeSchema,
  execConfig: execConfigSchema,
  // Phase 3: max 50 steps (was 100). Security-adjacent cap for DoS
  // mitigation (maxToolCalls * maxIterations amplification) + preview sanity.
  workflowSteps: z.array(workflowStepSchema).max(50).optional(),
  triggerConfig: triggerConfigSchema,
  distillSessionId: z.string().uuid().optional(),  // Links distill LLM costs to this agent
  // Handle for the distillation this create is built from. When present it is
  // the authority for the generated fields above, and the client no longer
  // needs to echo them back. See the redemption in the POST / handler.
  distillId: z.string().uuid().optional(),
  skills: z.array(skillObjectSchema).max(50).optional(),
  capabilityTier: z.enum(['connector_only', 'execution_enabled']).optional(),
  resultRules: resultRulesArraySchema.optional(),
  attachments: teamAttachmentsArraySchema.optional(),
  absorption: absorptionClassificationArraySchema.optional(),
  libraryApprovals: z.array(z.string().max(512)).max(50).optional(),
}).superRefine((data, ctx) => {
  // Hybrid execution engine: workflowSteps presence — not agentType — drives
  // trigger requirement. agentType is preserved on incoming payloads for
  // back-compat but is no longer the source of truth.
  if (data.workflowSteps && data.workflowSteps.length > 0 && !data.triggerConfig) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'triggerConfig is required when workflowSteps is populated',
      path: ['triggerConfig'],
    });
  }

  // D-3.4 (SE-003): Aggregate byte-budget on workflowSteps.
  // toolInput is z.record(z.unknown()) which accepts arbitrary nesting —
  // per-field .max() caps don't prevent a 50MB deeply nested object.
  // This refine enforces an aggregate 256KB cap on the serialized array
  // and a 32KB cap per individual step's toolInput.
  if (data.workflowSteps && data.workflowSteps.length > 0) {
    const serialized = JSON.stringify(data.workflowSteps);
    if (serialized.length > 256 * 1024) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workflowSteps serialized size (${serialized.length} bytes) exceeds 256KB limit`,
        path: ['workflowSteps'],
      });
    }

    for (let i = 0; i < data.workflowSteps.length; i++) {
      const step = data.workflowSteps[i];
      if (step.toolInput) {
        const inputSize = JSON.stringify(step.toolInput).length;
        if (inputSize > 32 * 1024) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workflowSteps[${i}].toolInput (${inputSize} bytes) exceeds 32KB limit`,
            path: ['workflowSteps', i, 'toolInput'],
          });
        }
      }
    }
  }
});


// parseAndFilterPinnedKnowledge lives in ./pinned-knowledge so the workspace
// action that shares this route's body can call it without importing the
// router; re-exported here for its existing importers.
export { parseAndFilterPinnedKnowledge } from './pinned-knowledge';
import { parseAndFilterPinnedKnowledge, UUID_RE } from './pinned-knowledge';

// POST /internal-agents/distill-preview-lite — REMOVED (ADR-050).
//
// Served the hire-confirm screen during fused onboarding: a summary-only
// distill cheap enough to run before the customer had paid, plus a write of
// the hire input onto tenants.onboarding_hire_input so a Stripe webhook could
// pick the real distill up afterwards.
//
// The first hire now happens after onboarding, where the full distill runs
// directly, so there is nothing to preview on credit and nothing to persist
// across the payment boundary. Removed with its request schema rather than
// left mounted: its only caller was the onboarding wizard, and an endpoint
// whose sole job is to write a column being dropped is a liability.

// GET /internal-agents
// List internal agents with pagination (BE-001)
internalAgentsRouter.get('/', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const cursor = req.query.cursor as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const status = req.query.status as InternalAgentStatus | undefined;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    if (status && !['draft', 'active', 'paused'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await internalAgentService.listByTenant(tenantId, { cursor, limit, status });
    // Redacted here rather than in the service: listByTenant also backs the
    // service-auth _svc list, which the tenant runtime reads to actually run
    // these agents.
    res.json({ ...result, internalAgents: toClientAgents(result.internalAgents) });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /internal-agents/recently-viewed
// Fetch recently viewed internal agents for the authenticated user
internalAgentsRouter.get('/recently-viewed', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 10) : 6;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Extract account_id from JWT (never from params)
    const firebaseUid = req.ctx?.userId;
    if (!firebaseUid) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    // Get recently viewed internal agents from accounts table
    const recentViews = await accountRepository.getRecentlyViewedInternalAgents(account.id, tenantId);

    // For each entry, fetch internal agent (filter out deleted)
    const internalAgents: RecentlyViewedInternalAgentsResponse['internalAgents'] = [];
    for (const view of recentViews.slice(0, limit)) {
      const internalAgent = await internalAgentService.getById(view.internalAgentId, tenantId);
      if (internalAgent) {
        internalAgents.push({ internalAgent: toClientAgent(internalAgent), viewedAt: view.viewedAt });
      }
    }

    res.json({ internalAgents });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /internal-agents/department-slug
// Lightweight LLM call to extract a short department name from role + context
internalAgentsRouter.post('/department-slug', async (req: Request, res: Response) => {
  const { role, responsibilities, additionalContext } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'role is required' });
  }

  try {
    const { llmClient } = await import('../llm');
    const response = await llmClient.complete({
      messages: [{
        role: 'user',
        content: `Given this agent member's role and context, output ONLY a short department/function slug (1-2 words, lowercase, hyphenated, no quotes, no explanation).

Examples:
- "Sales Engineer" → sales
- "Engineering Program Manager" → engineering
- "Bitcoin Price Reporter" → bitcoin
- "Customer Support Bot" → customer-support
- "Human Resources Manager" → human-resources
- "Product Marketing Manager" → marketing
- "Data Analyst" → data
- "Revenue Operations Analyst" → revenue-ops

Role: ${role}
${responsibilities ? `Responsibilities: ${responsibilities.slice(0, 500)}` : ''}
${additionalContext ? `Context: ${additionalContext.slice(0, 200)}` : ''}

Department slug:`,
      }],
      maxTokens: 20,
    });

    const slug = (response.content || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/^-|-$/g, '')
      .slice(0, 20);

    return res.json({ slug: slug || role.toLowerCase().split(/\s+/)[0] });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to generate department slug');
    // Fallback: first word of role
    return res.json({ slug: role.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9-]/g, '') });
  }
});

// GET /internal-agents/check-nickname?tenantId=...&nickname=...&excludeId=...
// Check if a messaging nickname is available within the tenant
internalAgentsRouter.get('/check-nickname', verifyTenantOwnership, async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const nickname = req.query.nickname as string;
  const excludeId = req.query.excludeId as string | undefined;

  if (!tenantId || !nickname) {
    return res.status(400).json({ error: 'tenantId and nickname are required' });
  }

  try {
    const params: string[] = [tenantId, nickname];
    let excludeClause = '';
    if (excludeId) {
      excludeClause = ' AND id != $3';
      params.push(excludeId);
    }

    // Case-insensitive, matching updateInternalAgent's conflict check and the
    // case-insensitive name addressing in Slack. Reporting available for a
    // name the save path would reject is worse than rejecting it here.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, role FROM internal_agents
       WHERE tenant_id = $1 AND LOWER(messaging_nickname) = LOWER($2)
         AND deleted_at IS NULL${excludeClause}
       LIMIT 1`,
      params,
    ));

    if (result.rows.length > 0) {
      return res.json({ available: false, conflictWith: result.rows[0].role });
    }
    return res.json({ available: true });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});

// GET /internal-agents/:internalAgentId
// Get a single internal agent
internalAgentsRouter.get('/:internalAgentId', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const internalAgent = await internalAgentService.getById(internalAgentId, tenantId);

    if (!internalAgent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    res.json(toClientAgent(internalAgent));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /internal-agents/:internalAgentId/permissions
// Get permissions for tenant runtime enforcement
// Returns: { internalAgentId, tenantId, integrations: IntegrationPermission[] }
internalAgentsRouter.get('/:internalAgentId/permissions', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const internalAgent = await internalAgentService.getById(internalAgentId, tenantId);

    if (!internalAgent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    // Return permissions in a format optimized for runtime enforcement
    res.json({
      internalAgentId: internalAgent.id,
      tenantId: internalAgent.tenantId,
      status: internalAgent.status,
      integrations: internalAgent.integrations,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /internal-agents/:internalAgentId/views
// Record a view of an internal agent
internalAgentsRouter.post('/:internalAgentId/views', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Extract account_id from JWT (never from params)
    const firebaseUid = req.ctx?.userId;
    if (!firebaseUid) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    // Verify internal agent exists and user has access
    const internalAgent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!internalAgent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    // Get source from body (optional)
    const source = req.body?.source || 'direct_link';

    // Record the view
    await accountRepository.recordInternalAgentView(account.id, tenantId, internalAgentId, source);

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /internal-agents
// Create a new internal agent with idempotency (DE-001)
internalAgentsRouter.post('/', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Look up app account from Firebase UID
    const firebaseUid = req.ctx?.userId;
    let actorId: string | undefined;
    if (firebaseUid) {
      const account = await accountService.getByFirebaseUid(firebaseUid);
      actorId = account?.id;
    }

    // modelConfig is admin-only. Non-admin requests must omit it entirely —
    // customerModelConfigSchema rejects any caller-supplied value with a 400,
    // and only then does the full payload schema parse (which applies the
    // server-side tier='medium' default via adminModelConfigSchema).
    if (req.isPlatformAdmin !== true) {
      const customerCheck = customerModelConfigSchema.safeParse(
        (req.body as Record<string, unknown> | undefined)?.modelConfig,
      );
      if (!customerCheck.success) {
        return res.status(400).json({
          error: 'modelConfig is admin-only and must be omitted',
          details: customerCheck.error.errors,
        });
      }
    }

    // Validate input (BE-003)
    const parseResult = createInternalAgentSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    // Creating an agent ALREADY ACTIVE is a launch, and a launch needs a plan.
    //
    // Building is deliberately free (ADR-050): a tenant can browse, assemble a
    // team and save it as a draft with no subscription. Running it is what
    // costs money, and PATCH /:id/status already refuses to activate without
    // one. This route did not, so "Launch Now" — which creates with
    // status:'active' rather than creating a draft and then activating —
    // walked straight past the paywall and produced an agent that displays as
    // active while every invocation guard refuses it. Same guard, same 402, so
    // the two launch paths cannot disagree and the frontend modal is an
    // affordance over an enforced rule rather than the rule itself.
    if (parseResult.data.status === 'active') {
      const guardResult = await checkExecutionAllowed(tenantId);
      if (!guardResult.allowed) {
        // `message` mirrors `reason` so the frontend's ApiError plumbing
        // (which reads message || issue || error) carries the guard's own copy
        // — "outstanding balance of $X" and "needs an active plan" are
        // different things to tell a user. `error` and `reason` are unchanged
        // for any existing consumer.
        return res.status(402).json({
          error: 'payment_required',
          reason: guardResult.reason,
          message: guardResult.reason,
        });
      }
    }

    // WS-5.1 — UUID + connectorType validation on integrations JSONB. Rejects
    // literal-string ids like "slack" and references to unknown
    // connectorTypes BEFORE the row reaches the DB. The validator throws
    // IntegrationValidationError on first failure, which we surface as 400.
    if (parseResult.data.integrations && parseResult.data.integrations.length > 0) {
      try {
        await validateIntegrationsArray(parseResult.data.integrations, { tenantId });
      } catch (err) {
        if (err instanceof IntegrationValidationError) {
          return res.status(400).json({ error: err.message, context: err.context });
        }
        throw err;
      }
    }

    // Parse [[knowledge:...]] mentions, silently filter out orphans (item
    // missing OR connector not bound). React UI surfaces orphans as broken
    // chips so the operator is aware. No more systemPrompt injection — pins
    // act as a retrieval bias on corpus_search (see knowledge/repository.ts).
    const boundConnectorIds = new Set(
      (parseResult.data.integrations ?? []).map(i => i.id),
    );
    const pinnedKnowledgeIds = await parseAndFilterPinnedKnowledge(
      tenantId,
      boundConnectorIds,
      parseResult.data.responsibilities,
      parseResult.data.additionalContext,
    );
    // absorption/libraryApprovals drive the post-create apply step; they are
    // not agent columns, so they never reach the service payload. distillId is
    // a handle, not a column either — it is redeemed just below.
    const {
      absorption: createAbsorption,
      libraryApprovals: createLibraryApprovals,
      distillId: createDistillId,
      ...createFields
    } = parseResult.data;


    // Redeem the distill handle. The artifact is the authority over everything
    // the distiller generated: taking these from the request body instead let a
    // caller pair any systemPrompt with any templateId, and silently dropped
    // skills/capabilityTier/resultRules, which no client payload declared.
    //
    // Deliberately narrow. summary, agentType, triggerConfig and workflowSteps
    // are also in the artifact, but the person can change them after distilling
    // and before saving, so the request body stays authoritative for those.
    const createArtifact = createDistillId
      ? await getDistillArtifact(createDistillId, tenantId)
      : null;
    if (createDistillId && !createArtifact) {
      // Unknown, expired and cross-tenant are indistinguishable by design.
      // Never fall through to the client-supplied prompts: that would quietly
      // turn an expired handle into an agent built from whatever was posted.
      return res.status(400).json({
        error: 'Distillation not found or expired. Please run the optimization again.',
      });
    }
    // The schema accepts null for instructionsMd because the distiller emits it
    // that way; on a create the two are the same statement ("no project
    // guide"), since there is no prior value to clear. Normalising here keeps
    // that null out of the service contract, which takes `string | undefined`.
    const createData = {
      ...createFields,
      ...(createArtifact && {
        // Generated and not client-editable: the artifact is the only source.
        systemPrompt: createArtifact.systemPrompt,
        userInstructions: createArtifact.userInstructions,
        instructionsMd: createArtifact.instructionsMd,
        // Also generated, and dropped here until now. A redistill carried all
        // four and a hire carried none, so every agent shipped without them
        // and only got them if something later redistilled it — which for the
        // tri-state meant the gate had an empty map for every hire and could
        // gate nothing. Verified on a template hire that had distilled eight
        // minutes earlier: the artifact held the states, the agent did not.
        capabilityStates: createArtifact.capabilityStates,
        decisionRecord: createArtifact.decisionRecord,
        groundsOn: createArtifact.groundsOn,
        // No incumbent to merge against on a create, so the artifact's own
        // map is the whole answer; redistill merges because there is one.
        toolDescriptionOverrides: createArtifact.toolDescriptionOverrides,
        // Editable, so an explicit value in the request is the person's own
        // steering and outranks the distiller's. The artifact fills these in
        // only when the caller sent nothing, which is what stops them being
        // lost the way they were when no create payload declared them.
        skills: createFields.skills ?? createArtifact.skills,
        capabilityTier: createFields.capabilityTier ?? createArtifact.capabilityTier,
        resultRules: createFields.resultRules ?? createArtifact.resultRules,
        // The memory scope the template declared, which the distiller authored
        // the graph against: a `memory_save` on the role layer is written
        // because the template grants role. Left out of this redemption, every
        // wizard hire got the create default instead and the runtime refused
        // exactly those steps, on every fire. The person's own value still
        // wins, as with the fields above.
        memoryScope: createFields.memoryScope ?? createArtifact.memoryScope,
      }),
      // The distiller is allowed to emit a null instructionsMd (no project
      // guide) but the service contract takes `string | undefined`, so it is
      // normalised here. Nothing else can supply this field now.
      instructionsMd: createArtifact?.instructionsMd ?? undefined,
      pinnedKnowledgeIds,
    };

    // If idempotency key provided, use idempotency wrapper
    if (idempotencyKey) {
      const requestHash = crypto.createHash('sha256')
        .update(JSON.stringify(req.body))
        .digest('hex');

      const result = await withIdempotency(
        tenantId,
        idempotencyKey,
        'POST /api/internal-agents',
        requestHash,
        async () => {
          const internalAgent = await internalAgentService.create(
            tenantId,
            createData,
            idempotencyKey,
            actorId
          );

          logAudit('internal_agent.created', req.ctx, {
            internalAgentId: internalAgent.id,
            role: internalAgent.role,
            tenantId,
          });

          // Attribute distill LLM costs to the newly created agent
          if (createData.distillSessionId) {
            attributeSessionToAgent(createData.distillSessionId, internalAgent.id);
          }

          // Land imported skills / memories / approved library docs now
          // that the agent row exists. Fire-and-forget with its own error
          // handling: an absorption failure must never fail the create — the
          // team member exists, and what did not land is re-shareable in chat.
          fireAndForget(
            applyAbsorption({
              tenantId,
              agentId: internalAgent.id,
              classifications: createAbsorption ?? [],
              libraryApprovals: createLibraryApprovals,
              attachments: createData.attachments ?? [],
            }).then(() => undefined),
            'internal-agents absorption apply (create)',
          );

          // Event publish is owned by InternalAgentService.create — the
          // entity INSERT, version-history INSERT, and outbox enqueue commit
          // in one tx; the inline publish fires post-commit. Plan §5.4.

          return { status: 201, body: internalAgent };
        }
      );

      if (result.cached) {
        res.setHeader('X-Idempotency-Replay', 'true');
      }
      return res.status(result.status).json(result.response);
    }

    // No idempotency key - proceed normally
    const internalAgent = await internalAgentService.create(
      tenantId,
      createData,
      undefined,
      actorId
    );

    logAudit('internal_agent.created', req.ctx, {
      internalAgentId: internalAgent.id,
      role: internalAgent.role,
      tenantId,
    });

    // Attribute distill LLM costs to the newly created agent
    if (createData.distillSessionId) {
      attributeSessionToAgent(createData.distillSessionId, internalAgent.id);
    }

    fireAndForget(
      applyAbsorption({
        tenantId,
        agentId: internalAgent.id,
        classifications: createAbsorption ?? [],
        libraryApprovals: createLibraryApprovals,
        attachments: createData.attachments ?? [],
      }).then(() => undefined),
      'internal-agents absorption apply (create)',
    );

    // Event publish is owned by InternalAgentService.create (shape-3 canonical
    // pattern per plan §5.4).

    res.status(201).json(toClientAgent(internalAgent));
  } catch (error) {
    // A template named a connector the hire did not bind. The person can
    // fix that on the tools step, so it is theirs to see, not a 500.
    if (error instanceof RequiredConnectorMissingError) {
      return res.status(422).json({ error: error.message, context: error.context });
    }
    log.error({ error: (error as Error).message, stack: (error as Error).stack, tenantId: req.query.tenantId }, 'POST /api/internal-agents: unhandled error');
    res.status(500).json({ error: (error as Error).message });
  }
});

// PUT /internal-agents/:internalAgentId
// Update an internal agent
internalAgentsRouter.put('/:internalAgentId', verifyTenantOwnership, withIdempotencyMiddleware({ endpoint: 'PUT /api/internal-agents/:internalAgentId' }), async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Look up app account from Firebase UID
    const firebaseUid = req.ctx?.userId;
    const account = firebaseUid ? await accountService.getByFirebaseUid(firebaseUid) : null;
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }
    const actorId = account.id;
    const actorDisplayName = [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || account.email || '';

    // modelConfig is admin-only on update too. See POST handler for rationale.
    if (req.isPlatformAdmin !== true) {
      const customerCheck = customerModelConfigSchema.safeParse(
        (req.body as Record<string, unknown> | undefined)?.modelConfig,
      );
      if (!customerCheck.success) {
        return res.status(400).json({
          error: 'modelConfig is admin-only and must be omitted',
          details: customerCheck.error.errors,
        });
      }
    }

    // Validate input (BE-003)
    const parseResult = updateInternalAgentSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    // The route is an adapter: the body, the role rule (member and above)
    // and the attribution live in the shared workspace action every surface
    // calls. verifyTenantOwnership above proves membership; the role is read
    // again here so the write carries the role the person holds now.
    const actor = await resolveActor({ tenantId, accountId: actorId, surface: 'dashboard', displayName: actorDisplayName });
    if (!actor) {
      return res.status(403).json({ error: 'Access denied to tenant resources' });
    }

    const result = await applyTeamUpdate(
      actor,
      internalAgentId,
      parseResult.data,
      { distill: parseResult.data.distillId ? 'client' : 'none' },
    );
    if (isTeamUpdateRefusal(result)) {
      switch (result.refused) {
        case 'validation':
          return res.status(400).json({ error: result.message, ...(result.context !== undefined ? { context: result.context } : {}) });
        case 'not_found':
          return res.status(404).json({ error: result.message });
        case 'nickname_conflict':
          return res.status(409).json({ error: result.message, code: 'NICKNAME_CONFLICT' });
        case 'workflow_tampered':
          return res.status(409).json({ error: result.message, code: 'WORKFLOW_TAMPERED' });
        case 'distill_failed':
          return res.status(502).json({ error: result.message });
      }
    }

    res.json(toClientAgent(result.agent));
  } catch (error) {
    if (error instanceof PermissionDenied) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /internal-agents/:internalAgentId/status
// Update internal agent status (activate/pause)
// SE-005: Apply rate limiting to activation endpoint
internalAgentsRouter.patch('/:internalAgentId/status', activationLimiter, verifyTenantOwnership, withIdempotencyMiddleware({ endpoint: 'PATCH /api/internal-agents/:internalAgentId/status' }), async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Look up app account from Firebase UID
    const firebaseUid = req.ctx?.userId;
    const account = firebaseUid ? await accountService.getByFirebaseUid(firebaseUid) : null;
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }
    const actorId = account.id;
    const actorDisplayName = [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || account.email || '';

    // Validate input (BE-003)
    const parseResult = updateStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const actor = await resolveActor({ tenantId, accountId: actorId, surface: 'dashboard', displayName: actorDisplayName });
    if (!actor) {
      return res.status(403).json({ error: 'Access denied to tenant resources' });
    }

    const result = await setTeamStatus(actor, internalAgentId, parseResult.data.status);
    if ('refused' in result) {
      switch (result.refused) {
        case 'not_found':
          return res.status(404).json({ error: result.message });
        case 'payment_required':
          // `message` mirrors `reason` so the frontend's ApiError plumbing
          // (which reads message || issue || error) carries the guard's own copy
          // — "outstanding balance of $X" and "needs an active plan" are
          // different things to tell a user. `error` and `reason` are unchanged
          // for any existing consumer.
          return res.status(402).json({
            error: 'payment_required',
            reason: result.message,
            message: result.message,
          });
        case 'required_connector_missing':
          return res.status(422).json({ error: result.message, context: result.context });
        case 'workflow_tampered':
          return res.status(409).json({
            error: result.message,
            errorCode: 'workflow_tampered',
          });
        case 'rate_limited':
          return res.status(429).json({ error: result.message });
      }
    }

    res.json(toClientAgent(result.agent));
  } catch (error) {
    if (error instanceof PermissionDenied) {
      return res.status(403).json({ error: error.message });
    }
    log.error({ error, internalAgentId: req.params.internalAgentId, tenantId: req.query.tenantId }, 'Failed to update internal agent status');
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /internal-agents/:internalAgentId
// Soft delete an internal agent (DE-003)
internalAgentsRouter.delete('/:internalAgentId', verifyTenantOwnership, withIdempotencyMiddleware({ endpoint: 'DELETE /api/internal-agents/:internalAgentId' }), async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Look up app account from Firebase UID
    const firebaseUid = req.ctx?.userId;
    const account = firebaseUid ? await accountService.getByFirebaseUid(firebaseUid) : null;
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }
    const actorId = account.id;
    const actorDisplayName = [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || account.email || '';

    const actor = await resolveActor({ tenantId, accountId: actorId, surface: 'dashboard', displayName: actorDisplayName });
    if (!actor) {
      return res.status(403).json({ error: 'Access denied to tenant resources' });
    }

    const result = await archiveTeam(actor, internalAgentId);
    if ('refused' in result) {
      return res.status(404).json({ error: result.message });
    }

    res.status(204).send();
  } catch (error) {
    if (error instanceof PermissionDenied) {
      return res.status(403).json({ error: error.message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /internal-agents/:internalAgentId/versions
// List all versions for an internal agent
internalAgentsRouter.get('/:internalAgentId/versions', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const versions = await internalAgentService.getVersions(internalAgentId, tenantId);
    res.json({ versions });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /internal-agents/:internalAgentId/versions/:version
// Get a specific version
internalAgentsRouter.get('/:internalAgentId/versions/:version', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId, version: versionStr } = req.params;
    const tenantId = req.query.tenantId as string;
    const version = parseInt(versionStr, 10);

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    if (isNaN(version) || version < 1) {
      return res.status(400).json({ error: 'Invalid version number' });
    }

    const versionData = await internalAgentService.getVersion(internalAgentId, tenantId, version);

    if (!versionData) {
      return res.status(404).json({ error: 'Version not found' });
    }

    res.json(toClientVersion(versionData));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /internal-agents/:internalAgentId/rollback
// Rollback to a specific version
internalAgentsRouter.post('/:internalAgentId/rollback', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;
    const { version } = req.body;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    if (typeof version !== 'number' || version < 1) {
      return res.status(400).json({ error: 'version is required and must be a positive number' });
    }

    // Look up app account from Firebase UID
    const firebaseUid = req.ctx?.userId;
    let actorId: string | undefined;
    if (firebaseUid) {
      const account = await accountService.getByFirebaseUid(firebaseUid);
      actorId = account?.id;
    }

    const internalAgent = await internalAgentService.rollbackToVersion(internalAgentId, tenantId, version, actorId);

    if (!internalAgent) {
      return res.status(404).json({ error: 'agent or version not found' });
    }

    logAudit('internal_agent.rollback', req.ctx, {
      internalAgentId: internalAgent.id,
      tenantId,
      targetVersion: version,
      newVersion: internalAgent.currentVersion,
    });

    // Event publish is owned by InternalAgentService.update (called internally
    // by rollbackToVersion) via shape-3. The rollback marker is preserved in
    // the audit log + internal_agent_versions row; runtime sync only needs the
    // standard `updated` payload.

    res.json(toClientAgent(internalAgent));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agents/redistill-all?tenantId=…
// Re-run distillation for every non-deleted agent in the tenant. The agent's
// stored role / responsibilities / integrations / additionalContext stay
// untouched (those are the distillation inputs); the LLM-derived fields
// (systemPrompt, userInstructions, instructionsMd, triggerConfig, etc.) are
// regenerated and written back through internalAgentService.update so the
// existing version-bump + outbox-event + audit path fires unchanged.
//
// Bounded concurrency (4) keeps LLM spend predictable. Workspaces with more
// than 50 active agents are rejected so a single click can't fan out to an
// unbounded number of LLM calls — those operators should call the single-
// agent variant individually.
//
// MUST be declared BEFORE the `/:internalAgentId/redistill` route so Express
// matches it as a literal path rather than treating "redistill-all" as the
// :internalAgentId param.
// Redistillation is the most expensive LLM call in the product, and a redistill
// runs one per agent. `/redistill-all` multiplies that by the whole fleet.
//
// The distill-stream surface has been rate limited since D-5.10; these routes
// reach the SAME distillation, so leaving them unlimited meant the limiter
// governed the cheap door and not the expensive one. A fleet wave is exactly
// the traffic a limiter exists for.
//
// Deliberately TIGHTER than the interactive caps: nobody redistills a fleet
// forty times an hour on purpose, and a client retry loop against this endpoint
// is a large bill rather than a slow page.
const REDISTILL_RATE_LIMITS: ChatRateLimitCaps = {
  tenant: { maxPerMinute: 3, maxPerHour: 20, maxPerDay: 60 },
  user: { maxPerMinute: 2, maxPerHour: 10, maxPerDay: 30 },
};

/**
 * Rate-limit a redistill request. Returns a 429 body when the caller is over,
 * null when it may proceed.
 *
 * Resolves the Firebase uid to an account id before metering: the ledger keys
 * on `account_id UUID`, and passing the uid straight through is how this
 * surface's sibling spent months failing every insert and taking the limiter's
 * fail-open branch on every request.
 */
async function checkRedistillRateLimit(
  req: Request,
  tenantId: string,
): Promise<{ status: number; body: unknown } | null> {
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) return { status: 401, body: { error: 'Authentication required' } };

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) return { status: 401, body: { error: 'Account not found' } };

  if (!UUID_RE.test(tenantId)) {
    return { status: 400, body: { error: 'tenantId must be a valid UUID' } };
  }

  const rate = await checkAndIncrementChatRateLimit({
    tableName: 'distill_rate_limit_events',
    tenantId,
    accountId: account.id,
    limits: REDISTILL_RATE_LIMITS,
  });

  if (rate.allowed) return null;

  log.info(
    { metric: 'redistill.rate_limited', tenantId, retryAfter: rate.retryAfter },
    'Redistill rate limited',
  );
  return {
    status: 429,
    body: { error: 'Rate limit exceeded', errorCode: 'rate_limited', retryAfter: rate.retryAfter },
  };
}

// GET /api/internal-agents/stale-graphs — which agents are running a workflow
// that predates their instructions?
//
// For example, an agent's responsibilities are edited and saved, the redistill
// regenerates `instructions_md` and returns no `workflowSteps`, and because
// `service.update` reads an absent `workflowSteps` as "leave unchanged", the
// graph stays behind with its Slack step pointed at the old channel. Every
// column is individually valid; only the relationship between two of them is
// broken. Without the fingerprint, answering it takes a regex over Slack
// channel names, which is brittle and blind to every other way a graph goes
// stale.
//
// Reports `unverifiable` alongside `stale`. Rows written before the fingerprint
// column existed carry NULL, and calling those clean would be a confident
// all-clear over data nobody checked.
internalAgentsRouter.get('/stale-graphs', requireMinRole('admin'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const { sweepStaleGraphs } = await import('./distill-input-fingerprint');
    const { withTenantScope } = await import('../infrastructure/database');
    const findings = await withTenantScope(tenantId, (client) =>
      sweepStaleGraphs((sql, params) => client.query(sql, params), tenantId));
    return res.json({
      tenantId,
      stale: findings.filter((f) => f.freshness === 'stale').length,
      unverifiable: findings.filter((f) => f.freshness === 'unverifiable').length,
      findings,
    });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'stale-graph sweep failed');
    return res.status(500).json({ error: 'Failed to sweep for stale graphs' });
  }
});

internalAgentsRouter.post('/redistill-all', requireMinRole('admin'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const dryRun = req.query.dryRun === 'true';
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    // Before any LLM work. A dry run still distills — it only withholds the
    // write — so it costs the same and is metered the same.
    const limited = await checkRedistillRateLimit(req, tenantId);
    if (limited) return res.status(limited.status).json(limited.body);

    const firebaseUid = req.ctx?.userId;
    let actorId: string | undefined;
    if (firebaseUid) {
      const account = await accountService.getByFirebaseUid(firebaseUid);
      actorId = account?.id;
    }

    const { redistillAllAgents, RedistillTooManyAgentsError } = await import('./redistill-service');
    const run = async (): Promise<{ status: number; body: unknown }> => {
      try {
        const result = await redistillAllAgents(tenantId, actorId, { dryRun });
        logAudit('internal_agent.redistill_all', req.ctx, {
          tenantId,
          totalAgents: result.totalAgents,
          succeeded: result.succeeded,
          failed: result.failed,
          dryRun,
        });
        return { status: 200, body: result };
      } catch (err) {
        if (err instanceof RedistillTooManyAgentsError) {
          return {
            status: 413,
            body: { error: err.message, code: 'TOO_MANY_AGENTS', agentCount: err.agentCount },
          };
        }
        throw err;
      }
    };

    if (idempotencyKey) {
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ tenantId, dryRun })).digest('hex');
      const wrapped = await withIdempotency(
        tenantId,
        idempotencyKey,
        'POST /api/internal-agents/redistill-all',
        requestHash,
        run,
      );
      if (wrapped.cached) res.setHeader('X-Idempotency-Replay', 'true');
      return res.status(wrapped.status).json(wrapped.response);
    }

    const out = await run();
    res.status(out.status).json(out.body);
  } catch (error) {
    log.error({ err: (error as Error).message, tenantId: req.query.tenantId }, 'redistill-all failed');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/internal-agents/:internalAgentId/redistill?tenantId=…
// Re-run distillation for one existing agent. Same persist path as PUT —
// version bump, outbox event, audit log all fire through the existing
// internalAgentService.update method.
internalAgentsRouter.post('/:internalAgentId/redistill', requireMinRole('admin'), async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    // Before any LLM work — the same meter the fleet-wide route uses, so a
    // caller cannot sidestep it by looping over agents one at a time.
    const limited = await checkRedistillRateLimit(req, tenantId);
    if (limited) return res.status(limited.status).json(limited.body);

    const firebaseUid = req.ctx?.userId;
    let actorId: string | undefined;
    if (firebaseUid) {
      const account = await accountService.getByFirebaseUid(firebaseUid);
      actorId = account?.id;
    }

    const { redistillAgent, RedistillNotFoundError } = await import('./redistill-service');
    const run = async (): Promise<{ status: number; body: unknown }> => {
      try {
        const updated = await redistillAgent(internalAgentId, tenantId, actorId);
        logAudit('internal_agent.redistill', req.ctx, {
          internalAgentId: updated.id,
          tenantId,
          newVersion: updated.currentVersion,
        });
        // Admin-only, but still a browser response. The _svc twin at the top
        // of this file keeps the prompt: the tenant runtime executes from it.
        return { status: 200, body: toClientAgent(updated) };
      } catch (err) {
        if (err instanceof RedistillNotFoundError) {
          return { status: 404, body: { error: err.message } };
        }
        // The rebuild did not converge and was not applied: the agent keeps
        // its whole incumbent configuration. Named to the caller the way the
        // hire flow names it, so the two surfaces agree on what happened.
        if (err instanceof DistillationGraphNotConvergedError) {
          return {
            status: 422,
            body: { error: err.message, errorCode: 'graph_not_converged', rejections: err.reasons },
          };
        }
        throw err;
      }
    };

    if (idempotencyKey) {
      const requestHash = crypto.createHash('sha256')
        .update(JSON.stringify({ internalAgentId, tenantId }))
        .digest('hex');
      const wrapped = await withIdempotency(
        tenantId,
        idempotencyKey,
        'POST /api/internal-agents/:internalAgentId/redistill',
        requestHash,
        run,
      );
      if (wrapped.cached) res.setHeader('X-Idempotency-Replay', 'true');
      return res.status(wrapped.status).json(wrapped.response);
    }

    const out = await run();
    res.status(out.status).json(out.body);
  } catch (error) {
    log.error(
      { err: (error as Error).message, internalAgentId: req.params.internalAgentId, tenantId: req.query.tenantId },
      'redistill failed',
    );
    res.status(500).json({ error: (error as Error).message });
  }
});

// ── Run again (ADR-030) ──────────────────────────────────────────────────────
// POST /internal-agents/:internalAgentId/runs/:invocationId/rerun
// Re-run a failed autonomous run. Proxies to the Tenant Runtime, which validates
// re-runnability (failed, top-level, cron/event, replay_input present) and
// enqueues a fresh execution. Relays TR's status + body verbatim (202/404/422).
internalAgentsRouter.post('/:internalAgentId/runs/:invocationId/rerun', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const { internalAgentId, invocationId } = req.params;
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    // Look up app account from Firebase UID. A re-run is a NEW human action, so
    // the person who clicked is this run's trigger — without this the re-run
    // inherits the original's attribution and reads as another scheduled tick.
    // requireMinRole resolves the account to authorize the call but attaches
    // nothing to the request, so resolve it again here (the pattern this router
    // already uses for every actor-stamped route).
    const firebaseUid = req.ctx?.userId;
    let actorId: string | undefined;
    if (firebaseUid) {
      const account = await accountService.getByFirebaseUid(firebaseUid);
      actorId = account?.id;
    }

    const { status, body } = await tenantRuntimeClient.rerunFailedRun(tenantId, internalAgentId, invocationId, actorId);
    return res.status(status).json(body ?? {});
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId, invocationId: req.params.invocationId }, 'Failed to re-run agent run');
    return res.status(502).json({ error: 'Could not start the re-run. Please try again.' });
  }
});

// ── Memory CRUD API ──────────────────────────────────────────────────────────
// These three routes proxy to the Tenant Runtime's memory store.
// Auth: Firebase token + tenant membership (same as all internal-agents routes).

// GET /internal-agents/:internalAgentId/memories
// List runtime memories. Optional query params: limit, cursor, search.
internalAgentsRouter.get('/:internalAgentId/memories', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;
    const { limit, cursor, search } = req.query as Record<string, string | undefined>;

    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    const result = await tenantRuntimeClient.listAgentMemories(tenantId, internalAgentId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
      search,
    });

    res.json(result);
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId }, 'Failed to list agent memories');
    res.status(502).json({ error: 'Could not load memories. Please try again.' });
  }
});

// DELETE /internal-agents/:internalAgentId/memories/:memoryId
// Delete a single runtime memory.
internalAgentsRouter.delete('/:internalAgentId/memories/:memoryId', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const { internalAgentId, memoryId } = req.params;
    const tenantId = req.query.tenantId as string;

    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    await tenantRuntimeClient.deleteAgentMemory(tenantId, internalAgentId, memoryId);
    res.status(204).send();
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (msg.includes('HTTP 404')) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    log.error({ error, internalAgentId: req.params.internalAgentId, memoryId: req.params.memoryId }, 'Failed to delete agent memory');
    res.status(502).json({ error: 'Could not delete that memory. Please try again.' });
  }
});

// PATCH /internal-agents/:internalAgentId/memories/:memoryId
// Edit the content of a single runtime memory.
const memoryUpdateSchema = z.object({
  content: z.string().min(1).max(10000),
});

internalAgentsRouter.patch('/:internalAgentId/memories/:memoryId', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const { internalAgentId, memoryId } = req.params;
    const tenantId = req.query.tenantId as string;

    const parsed = memoryUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'content is required and must be a non-empty string (max 10000 chars)' });
    }

    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    const updated = await tenantRuntimeClient.updateAgentMemory(tenantId, internalAgentId, memoryId, parsed.data.content);
    res.json(updated);
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (msg.includes('HTTP 404')) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    log.error({ error, internalAgentId: req.params.internalAgentId, memoryId: req.params.memoryId }, 'Failed to update agent memory');
    res.status(502).json({ error: 'Could not update that memory. Please try again.' });
  }
});

// GET /internal-agents/:internalAgentId/skills
// Returns active skills for an agent — proxied from tenant runtime.
// The routines a person can pick for this team member, without anyone
// typing a cron expression. Filtered by what is actually connected, because a
// blueprint whose integration is missing produces a routine that cannot run and
// fails silently on a schedule.
internalAgentsRouter.get('/:internalAgentId/routine-blueprints', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const agent = await internalAgentService.getById(req.params.internalAgentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const { blueprintsFor } = await import('./routine-blueprints');
    const connectorTypes = (agent.integrations ?? [])
      .map((i) => i.type)
      .filter((t): t is string => Boolean(t));
    return res.json({ blueprints: blueprintsFor(connectorTypes) });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'routine-blueprints: list failed');
    return res.status(500).json({ error: 'Failed to list routine blueprints' });
  }
});

// Apply one. This does NOT write a schedule: it appends the blueprint's prose to
// the team member's standing guidance and redistills, which is the only way
// routines are ever authored here — so the result carries a version, a
// rollback, and the analyzer's guards, exactly like a routine somebody typed.
internalAgentsRouter.post('/:internalAgentId/routine-blueprints/:blueprintId', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const { internalAgentId, blueprintId } = req.params;

    const { findBlueprint, renderBlueprintProse } = await import('./routine-blueprints');
    const blueprint = findBlueprint(blueprintId);
    if (!blueprint) return res.status(404).json({ error: 'Blueprint not found' });

    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const values = (req.body?.values ?? {}) as Record<string, string | undefined>;
    const line = renderBlueprintProse(blueprint, values);

    const existing = (agent.additionalContext ?? '').trim();
    const nextGuidance = existing.length > 0 ? `${existing}\n\n${line}` : line;

    // Same Firebase-uid → account-id resolution the other write routes use, so
    // the version this produces is attributed to the person who applied it.
    const firebaseUid = req.ctx?.userId;
    const actorId = firebaseUid
      ? (await accountService.getByFirebaseUid(firebaseUid))?.id
      : undefined;

    await internalAgentService.update(
      internalAgentId, tenantId, { additionalContext: nextGuidance }, actorId, 'manual',
    );
    const { redistillAgent } = await import('./redistill-service');
    const updated = await redistillAgent(internalAgentId, tenantId, actorId);

    return res.json({ applied: blueprint.id, prose: line, agent: updated });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'routine-blueprints: apply failed');
    return res.status(500).json({ error: 'Failed to apply routine blueprint' });
  }
});

internalAgentsRouter.get('/:internalAgentId/skills', requireMinRole('member'), async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const agent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    // The platform column is authoritative, and it is the only store
    // that holds provenance, protection, and archived skills — the runtime is a
    // projection of the ACTIVE set, so an archived skill is deliberately absent
    // there and could never be restored from it.
    //
    // The runtime is still consulted, for one thing the column cannot give: the
    // runtime-assigned id of any skill the column has not caught up on yet.
    // Merged by name, so a skill is never listed twice.
    const stored = agent.skills ?? [];
    let runtimeSkills: Array<{ id: string; name: string; description: string; instruction: string; tags: string[] }> = [];
    try {
      const runtimeResult = await tenantRuntimeClient.getAgentSkills(tenantId, internalAgentId);
      runtimeSkills = runtimeResult.skills ?? [];
    } catch (err) {
      // The stored set is enough to render and steer; the runtime is only
      // consulted for ids. Degrade rather than fail the page.
      log.warn(
        { internalAgentId, tenantId, error: (err as Error).message },
        'skills: runtime lookup failed, returning the stored set',
      );
    }
    const runtimeIdByName = new Map(
      runtimeSkills.map((s) => [s.name.trim().toLowerCase(), s.id]),
    );
    const storedNames = new Set(stored.map((s) => s.name.trim().toLowerCase()));

    const skills = [
      ...stored.map((s) => ({
        ...s,
        id: s.id ?? runtimeIdByName.get(s.name.trim().toLowerCase()),
        tags: s.tags ?? [],
        provenance: s.provenance ?? 'distilled',
        protected: s.protected ?? false,
        archived: s.archived ?? false,
      })),
      // Anything the runtime is running that the column has not recorded yet
      // (a flywheel append between syncs). Shown so the list matches reality.
      ...runtimeSkills
        .filter((s) => !storedNames.has(s.name.trim().toLowerCase()))
        .map((s) => ({ ...s, provenance: 'learned' as const, protected: false, archived: false })),
    ];

    res.json({ skills });
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId }, 'Failed to fetch agent skills');
    res.status(502).json({ error: 'Could not load skills. Please try again.' });
  }
});

// ── Admin / backfill ─────────────────────────────────────────────────────────

// POST /internal-agents/:internalAgentId/republish-created
// Re-publish the created event for an existing internal agent
// Used to backfill agent records for internal agents created before event handlers
internalAgentsRouter.post('/:internalAgentId/republish-created', verifyTenantOwnership, async (req: Request, res: Response) => {
  try {
    const { internalAgentId } = req.params;
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const internalAgent = await internalAgentService.getById(internalAgentId, tenantId);
    if (!internalAgent) {
      return res.status(404).json({ error: 'agent not found' });
    }

    // Publish created event with the canonical shared payload (plan §6.5).
    const eventPayload = await buildInternalAgentEventPayload(internalAgent, 'tenant.internal_agent.created');
    await publishInternalAgentEvent('tenant.internal_agent.created', internalAgent.id, tenantId, internalAgent.currentVersion, eventPayload);

    log.info({ internalAgentId, tenantId }, 'Re-published internal agent created event for backfill');

    res.json({ success: true, message: 'Created event re-published' });
  } catch (error) {
    log.error({ error, internalAgentId: req.params.internalAgentId }, 'Failed to republish created event');
    res.status(500).json({ error: (error as Error).message });
  }
});
