// Tool: teambuilder__distill
//
// Calls platform-backend's distill service to convert a raw spec into a
// distilled agent config (summary, systemPrompt, userInstructions,
// triggerConfig). Distill uses the flagship tier for quality.

import { loadConfig } from '../../../infrastructure/config.js';
import { getServiceAuthHeaders } from '../../../infrastructure/service-auth.js';
import type { LLMToolDefinition } from '../../../llm/types.js';
import type { HrbpToolContext } from '../types.js';
import { resolveSpecIntegrations } from '../spec-integrations.js';
import { log } from '../../../infrastructure/logging.js';

export const TEAMBUILDER_DISTILL_TOOL: LLMToolDefinition = {
  name: 'teambuilder__distill',
  description:
    'Generate a distilled agent configuration (summary, systemPrompt, userInstructions, triggerConfig) ' +
    'from a workforce-plan agent spec via the platform distill service.',
  input_schema: {
    type: 'object',
    properties: {
      role:             { type: 'string', description: 'Agent role/name from the spec.' },
      responsibilities: { type: 'string', description: 'Agent responsibilities from the spec.' },
      // No `integrations` parameter on purpose. Bindings are resolved from the
      // approved spec's `connectors` in code (see spec-integrations.ts). The
      // model cannot know connection ids, and when it was asked for them it
      // supplied objects with no usable `type`, which is what sent distill down
      // the "use every manifest in the tenant" path.
      additionalContext: { type: 'string', description: 'Optional template/context hint.' },
      sessionId:         { type: 'string', description: 'Distill session id for cost attribution.' },
    },
    required: ['role', 'responsibilities'],
  },
};

export interface DistillOutput {
  summary: string;
  systemPrompt: string;
  userInstructions?: string;
  triggerConfig?: {
    type: 'cron' | 'event' | 'manual';
    cronExpr?: string;
    eventTopic?: string;
    reasoning: string;
  };
}

export async function handleTeambuilderDistill(
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
): Promise<{ ok: boolean; data: unknown }> {
  const pbUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const authHeaders = await getServiceAuthHeaders(pbUrl, loadConfig().WORKFORCE_SERVICE_TOKEN);

  // Integrations come from the approved spec, resolved here — not from the
  // model's tool arguments. A model cannot know connection ids, so what it
  // supplies carries no usable `type`, and platform-backend reads an empty type
  // set as "no filter" rather than "no integrations".
  const resolved = await resolveSpecIntegrations(ctx.tenantId, ctx.spec);
  if (resolved.pendingConnectorTypes.length > 0) {
    log.info(
      {
        specId: ctx.specId,
        bound: resolved.integrations.map(i => i.type),
        pending: resolved.pendingConnectorTypes,
        lookupSucceeded: resolved.lookupSucceeded,
      },
      'HRBP distill: some requested connectors are not connected — binding the rest',
    );
  }
  // _svc/* paths are mounted on platform-backend's internalAgentsServiceRouter
  // BEFORE authMiddleware. The Firebase-gated /api/internal-agents/distill
  // path won't accept our X-Service-Auth header.
  const response = await fetch(`${pbUrl}/api/internal-agents/_svc/distill?tenantId=${encodeURIComponent(ctx.tenantId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    // role and responsibilities come from the approved spec for the same reason
    // the integrations do: a model asked to retype prose summarises it, and it
    // does so inconsistently between calls.
    body: JSON.stringify({
      ...input,
      role: ctx.spec.name,
      responsibilities: ctx.spec.responsibilities ?? ctx.spec.roleSummary,
      ...(ctx.spec.additionalContext ? { additionalContext: ctx.spec.additionalContext } : {}),
      integrations: resolved.integrations,
      tenantId: ctx.tenantId,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      data: { error: `distill failed: HTTP ${response.status}`, body: body.slice(0, 400) },
    };
  }
  const data = (await response.json()) as DistillOutput;

  // Stash the whole response for teambuilder__create.
  //
  // Otherwise the model is the only path between the two tools, retyping the
  // result into create's arguments — which can carry only the fields create's
  // schema names, and silently drops the rest.
  ctx.distillResult = data as unknown as Record<string, unknown>;

  return { ok: true, data };
}
