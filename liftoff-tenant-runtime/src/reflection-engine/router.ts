// Agent Evaluations REST router.
//
// Mount at `/api/v1` in src/index.ts. An "evaluation" is a model-run
// post-mortem of an agent's recent workflows that produces instruction-
// improvement suggestions. The former `/api/reflection/*` paths are gone —
// "evaluations" is the industry term (Anthropic Evals, OpenAI Evals, etc.);
// "reflection" was a CS-adjacent term that didn't describe the API surface.
//
// The internal directory name (`src/reflection-engine/`) is left alone: it
// refers to the algorithm (self-reflection as an agent-design technique) and
// is implementation detail. The HTTP resource noun is what callers see.
//
// Resource map:
//
//   POST   /evaluations                                     — create an evaluation
//                                                             body: { agentId, tenantId, triggerType, metadata? }
//   GET    /evaluations/eligibility                         — should-trigger check
//                                                             query: agentId, tenantId, triggerType
//   GET    /evaluations/quotas/{tenantId}                   — tenant quota status
//   GET    /evaluations/suggestions                         — list suggestions
//                                                             query: agentId
//   PATCH  /evaluations/suggestions/{id}                    — update (accept/reject)
//                                                             body: { accepted, tenantId, agentId }
//
// Auth: Google OIDC (aud == REFLECTION_SERVICE_URL) or the shared
// X-Service-Auth bearer. Cloud Tasks delivers the async evaluation trigger
// with OIDC; direct callers via ReflectionServiceClient send both.

import { Router } from 'express';
import { ReflectionEngineService } from './service';
import { reflectionTriggerService } from './trigger-service';
import type { ReflectionTriggerType } from './types';
import { logger } from '../infrastructure/logging';
import { requireServiceAuth } from '../security/service-auth';
import { getPoolForService } from '../infrastructure/database';

export const evaluationsRouter = Router();
const service = new ReflectionEngineService();

function resolveTenantRuntimeSaEmail(): string[] {
  const tenantId = process.env.TENANT_ID;
  const env = process.env.ENVIRONMENT;
  if (!tenantId || !env) return [];
  return [`tenant-${tenantId}-runtime@tenant-${tenantId}-${env}.iam.gserviceaccount.com`];
}

function resolveOidcAudience(): string | undefined {
  const url = process.env.REFLECTION_SERVICE_URL?.trim();
  return url && url.length > 0 ? url : undefined;
}

evaluationsRouter.use(
  requireServiceAuth({
    acceptOidc: true,
    oidcAudience: () => resolveOidcAudience() ?? '',
    allowedOidcEmails: resolveTenantRuntimeSaEmail,
  }),
);

// -----------------------------------------------------------------------------
// POST /evaluations — create an evaluation run
// -----------------------------------------------------------------------------
// Replaces the old `/trigger/:agentId` and `/scheduled/:agentId` endpoints.
// `triggerType` in the body selects the intent (workflow_completed,
// workflow_failed, scheduled, late_feedback, etc.). The handler decrements
// the concurrent-jobs quota on both success AND failure — the quota is
// `reflection-engine`'s admission-control primitive and must reflect every
// run, not just happy paths.

evaluationsRouter.post('/evaluations', async (req, res) => {
  const agentId: string | undefined = req.body?.agentId;
  const tenantId: string | undefined = req.body?.tenantId ?? (req.headers['x-tenant-id'] as string | undefined);
  const triggerType: string | undefined = req.body?.triggerType;
  if (!agentId || !tenantId || !triggerType) {
    return res.status(400).json({
      error: 'Missing required fields: agentId, tenantId, triggerType',
    });
  }

  const triggerBody = {
    tenantId,
    triggerType: triggerType as ReflectionTriggerType,
    metadata: req.body?.metadata,
  };

  try {
    const result = await service.triggerReflection(agentId, triggerBody);
    await reflectionTriggerService.onReflectionJobCompleted(tenantId);
    res.status(201).json(result);
  } catch (error) {
    await reflectionTriggerService.onReflectionJobCompleted(tenantId).catch((err) => {
      logger.error('Failed to decrement quota after evaluation failure', {
        error: (err as Error).message,
      });
    });
    throw error;
  }
});

// -----------------------------------------------------------------------------
// GET /evaluations/eligibility — should-trigger check
// -----------------------------------------------------------------------------
// Query params: agentId, tenantId, triggerType. The older `/should-trigger/:id`
// endpoint mixed a path param with required query params; both are now query
// so the URL is symmetric and every input goes through a single parse.

evaluationsRouter.get('/evaluations/eligibility', async (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  const tenantId = req.query.tenantId as string | undefined;
  const triggerType = req.query.triggerType as string | undefined;
  if (!agentId || !tenantId || !triggerType) {
    return res.status(400).json({
      error: 'Missing query params: agentId, tenantId, triggerType',
    });
  }
  const result = await service.shouldTriggerReflection(
    agentId,
    tenantId,
    triggerType as Parameters<typeof service.shouldTriggerReflection>[2],
  );
  res.json(result);
});

// -----------------------------------------------------------------------------
// GET /evaluations/quotas/{tenantId} — quota status
// -----------------------------------------------------------------------------

evaluationsRouter.get('/evaluations/quotas/:tenantId', async (req, res) => {
  const quota = await service.getQuotaStatus(req.params.tenantId);
  res.json(quota);
});

// -----------------------------------------------------------------------------
// GET /evaluations/suggestions — list suggestions for an agent
// -----------------------------------------------------------------------------
// Required query: agentId. Callers are always scoped to an agent; a global
// suggestions list would fan out across tenants and isn't meaningful.

evaluationsRouter.get('/evaluations/suggestions', async (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  if (!agentId) {
    return res.status(400).json({ error: 'Missing agentId query param' });
  }
  const suggestions = await service.getSuggestions(agentId);
  res.json({ items: suggestions });
});

// -----------------------------------------------------------------------------
// PATCH /evaluations/suggestions/{id} — update a suggestion
// -----------------------------------------------------------------------------
// Accepts { accepted: true, tenantId, agentId } today. The PATCH idiom lets
// us add more fields (e.g., { rejected: true, reason }) without minting a
// new endpoint. The suggestion-applier module runs the side effect of
// materialising the accepted suggestion into the agent's instruction.

evaluationsRouter.patch('/evaluations/suggestions/:id', async (req, res) => {
  const suggestionId = req.params.id;
  const { accepted, tenantId, agentId, reason } = req.body ?? {};
  if (!tenantId || !agentId) {
    return res.status(400).json({ error: 'tenantId and agentId are required in body' });
  }
  try {
    const { ReflectionRepository } = await import('./repository');
    const repo = new ReflectionRepository();
    // A7: scoped load (id-only would allow cross-agent application).
    const s = await repo.getSuggestionForAgent(suggestionId, agentId);
    if (!s) return res.status(404).json({ error: 'Suggestion not found' });

    if (accepted === false) {
      await repo.updateSuggestionStatus(suggestionId, agentId, 'rejected', typeof reason === 'string' ? reason : undefined);
      return res.json({ status: 'rejected' });
    }
    if (accepted !== true) {
      return res.status(400).json({ error: 'Only { accepted: true|false } updates are supported' });
    }

    const { applySuggestion } = require('../learning/suggestion-applier');
    const result = await applySuggestion(tenantId, agentId, suggestionId);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const name = error instanceof Error ? error.name : '';
    // A refusal is not a fault. `StaleSuggestionError` means the agent changed
    // while this suggestion was being planned or reviewed, and
    // `AutoApplyForbiddenError` means this row requires a human — both are the
    // system working. Returning 500 for either tells the operator we broke and
    // invites a retry that will refuse identically, while burying the one
    // sentence that says what to do instead.
    if (name === 'StaleSuggestionError') {
      return res.status(409).json({ error: message, status: 'stale' });
    }
    if (name === 'AutoApplyForbiddenError') {
      return res.status(403).json({ error: message, status: 'requires_human_review' });
    }
    res.status(500).json({ error: message });
  }
});

// -----------------------------------------------------------------------------
// POST /evaluations/suggestions/{id}/revert — undo an applied suggestion
// -----------------------------------------------------------------------------
//
// Undo an applied suggestion. There was no way to do this: a refinement that
// made an agent worse could only be corrected by writing another one on top and
// hoping, because the state it replaced was gone.
//
// Two properties make it safe rather than merely possible:
//   · it REFUSES when the agent has changed since the suggestion was applied —
//     the recorded after_state is what the revert assumes it is undoing, and a
//     blind revert would discard whatever changed in between;
//   · it writes through the same update path a normal write uses, so the revert
//     cannot itself violate the provenance rules that path enforces.
evaluationsRouter.post('/evaluations/suggestions/:id/revert', async (req, res) => {
  const suggestionId = req.params.id;
  const { tenantId, agentId } = req.body ?? {};
  if (!tenantId || !agentId) {
    return res.status(400).json({ error: 'tenantId and agentId are required in body' });
  }
  try {
    const pool = getPoolForService('reflection-engine');
    const agentResult = await pool.query(
      `SELECT system_prompt, user_instructions, entity_version FROM agents WHERE id = $1 AND tenant_id = $2`,
      [agentId, tenantId],
    );
    if (agentResult.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
    const current = {
      systemPrompt: agentResult.rows[0].system_prompt as string | null,
      userInstructions: agentResult.rows[0].user_instructions as string | null,
      entityVersion: agentResult.rows[0].entity_version as number | null,
    };

    const plan = await new ReflectionEngineService().getRevertPlan(suggestionId, current);
    if (plan.ok !== true) return res.status(409).json({ error: plan.reason });
    if (plan.agentId !== agentId) {
      return res.status(404).json({ error: 'Suggestion not found for this agent' });
    }

    const before = plan.beforeState as {
      systemPrompt: string | null;
      userInstructions: string | null;
      entityVersion: number | null;
    };
    // A revert is a new version, not a rewind to an old number: the history of
    // what happened to this agent stays intact, and only the CONTENT goes back.
    const newVersion = (current.entityVersion ?? 1) + 1;
    // Same writer as apply. A revert that restored only `agents` would leave the
    // refined text in `compiled_instructions`, which is the row every prompt
    // actually loads — so the revert would report success while the agent kept
    // behaving as though nothing had been reverted.
    const { writeAgentInstructions } = await import('../learning/suggestion-applier');
    const { compiledUpdated } = await writeAgentInstructions(pool, {
      agentId, tenantId, userInstructions: before.userInstructions, entityVersion: newVersion,
    });
    if (!compiledUpdated) {
      logger.warn(
        { agentId, tenantId, suggestionId },
        'Reverted, but no ACTIVE compiled_instructions row exists — nothing a prompt reads was changed back',
      );
    }
    await pool.query(
      `UPDATE reflection_suggestions SET status = 'reverted', updated_at = NOW() WHERE id = $1`,
      [suggestionId],
    );
    logger.info(
      { event: 'reflection_suggestion_reverted', tenantId, agentId, suggestionId, newVersion },
      'an applied reflection suggestion was reverted by an operator',
    );
    res.json({ status: 'reverted', newVersion });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});
