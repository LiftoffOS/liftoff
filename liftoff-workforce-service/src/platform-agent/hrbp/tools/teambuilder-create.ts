// Tool: teambuilder__create
//
// Creates the internal_agents row on platform-backend. NEVER passes
// modelConfig — the server applies tier='medium' by default (PR 1.2 policy).

import { loadConfig } from '../../../infrastructure/config.js';
import { getServiceAuthHeaders } from '../../../infrastructure/service-auth.js';
import type { LLMToolDefinition } from '../../../llm/types.js';
import type { HrbpToolContext } from '../types.js';
import { resolveSpecIntegrations } from '../spec-integrations.js';
import { log } from '../../../infrastructure/logging.js';

export const TEAMBUILDER_CREATE_TOOL: LLMToolDefinition = {
  name: 'teambuilder__create',
  description:
    'Create an internal_agents row from a distilled spec. status defaults to "draft" so the team ' +
    'appears on the Teams page for the user to start (the button there reads "Start Team"; the ' +
    'product has no "activate" or "launch" control). modelConfig MUST NOT be passed — the ' +
    'platform applies tier=medium by default.',
  input_schema: {
    type: 'object',
    properties: {
      role:             { type: 'string' },
      responsibilities: { type: 'string' },
      agentType: {
        type: 'string',
        enum: ['agent', 'workflow'],
      },
      summary:           { type: 'string' },
      systemPrompt:      { type: 'string' },
      userInstructions:  { type: 'string' },
      // No integrations / pendingIntegrations / triggerConfig / workflowSteps /
      // skills here on purpose.
      //
      // Bindings are resolved from the approved spec in code, and everything the
      // distiller produced is merged from the distill result in code. Asking the
      // model for either means asking it to carry data it cannot see or cannot
      // fully name.
      distillSessionId: { type: 'string' },
    },
    required: ['role', 'systemPrompt'],
  },
};

export async function handleTeambuilderCreate(
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
): Promise<{ ok: boolean; data: unknown }> {
  const pbUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const authHeaders = await getServiceAuthHeaders(pbUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);

  // Bindings are resolved from the approved spec, in code. The model has no
  // visibility into which connectors a workspace has connected, so asking it to
  // decide produces guesses: an active connector filed as pending leaves the
  // agent with no binding to the system it exists to work in.
  const resolved = await resolveSpecIntegrations(ctx.tenantId, ctx.spec);

  // Distilled output comes from the distill call, not from the model retyping
  // it. A model copying structured output by hand can only carry the fields it
  // was asked for, so anything the create schema does not name — workflowSteps,
  // skills, instructionsMd, capabilityTier — silently does not arrive.
  const distilled = ctx.distillResult ?? {};
  if (!ctx.distillResult) {
    log.warn(
      { specId: ctx.specId, planId: ctx.planId },
      'HRBP create: no distill result on the context — creating from the model arguments alone',
    );
  }

  const body: Record<string, unknown> = {
    ...input,
    ...distilled,
    // The approved prose, verbatim.
    //
    // A model asked to retype prose summarises it. That is survivable in the
    // distilled artifact, which is generated from the full text, but not in the
    // stored row: platform-backend's redistill feeds the STORED
    // responsibilities back into the distiller, so a paraphrase here becomes
    // the whole input to every future rebuild of this agent. The plan the user
    // approved is the source of truth for what they asked for.
    role: ctx.spec.name,
    responsibilities: ctx.spec.responsibilities ?? ctx.spec.roleSummary,
    ...(ctx.spec.additionalContext ? { additionalContext: ctx.spec.additionalContext } : {}),
    integrations: resolved.integrations,
    pendingIntegrations: resolved.pendingConnectorTypes,
    // Ties the agent back to the plan that asked for it.
    workforcePlanId: ctx.planId,
    tenantId: ctx.tenantId,
    status: 'draft',
  };
  // agentType is the spec's decision, not the distiller's — platform-backend
  // always returns 'agent' from distill (ADR-022 collapsed the two types), so
  // letting it through would overwrite a workflow spec.
  if (ctx.spec.agentType) body.agentType = ctx.spec.agentType;
  // Strip modelConfig defensively even if the LLM passed it — the server
  // also strips for non-admin callers, but explicit > implicit.
  delete body.modelConfig;
  // Distill-only fields platform-backend's create does not accept.
  delete body.absorption;
  delete body.integrationConfigs;

  // Scoped to the run, not the plan.
  //
  // platform-backend's withIdempotency replays the cached response body for a
  // repeated key, and provisioning__compensate deletes the agent the cached
  // response names. A key that outlives the agent therefore answers a later
  // attempt with a 201 for something that no longer exists, and no agent is
  // ever created.
  //
  // Run-scoping keeps the guarantee that matters — Cloud Tasks retrying the
  // same task shares a run, so it shares the key and cannot create twice —
  // while letting a genuinely new attempt create. Safe because the resumer only
  // re-enqueues specs that are not `completed`, so a new run implies no agent
  // was kept.
  const idempotencyKey = `hrbp-${ctx.runId}-${ctx.specId}`;
  // _svc base route — service-auth, before authMiddleware on PB.
  const response = await fetch(`${pbUrl}/api/internal-agents/_svc?tenantId=${encodeURIComponent(ctx.tenantId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...authHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    return {
      ok: false,
      data: { error: `create failed: HTTP ${response.status}`, body: bodyText.slice(0, 400) },
    };
  }
  const data = (await response.json()) as { agent?: { id: string } };
  if (data.agent?.id) {
    ctx.createdInternalAgentId = data.agent.id;
  }
  return { ok: true, data };
}
