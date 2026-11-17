// Shared event-payload builder for tenant.internal_agent.* events.
//
// Extracted from the duplicated payload-construction code in router.ts so the
// live publish path (~12 sites) and the reconciler (Phase 6) share a single
// source of truth. If a new payload field is needed, add it here exactly once.
//
// Schema modelled on the richest live emitter: router.ts:995 (idempotent-create
// branch). buildInternalAgentEventPayloadSchemaTest should snapshot this.

import type { InternalAgent } from './types';
import { buildEffectiveInstructionsMd } from './effective-instructions-md';
import { enrichIntegrationsWithType } from './integration-enrichment';
import { skillsForRuntime } from './skill-provenance';
import { effectiveModelConfig } from '../model-registry/workspace-ai-vendors';

export type InternalAgentEventTypeForPayload =
  | 'tenant.internal_agent.created'
  | 'tenant.internal_agent.updated'
  | 'tenant.internal_agent.deleted';

interface BuildOpts {
  actorId?: string | null;
}

// v5: the substring heuristic that recomputed capability_tier from system
// prompt content has been dropped. agent.capabilityTier is now the source of
// truth, persisted by service.create / service.update, seeded for legacy rows
// by migration 252.

function sanitize(payload: Record<string, unknown>): Record<string, unknown> {
  const sensitiveFields = ['apiKeys', 'secrets', 'credentials', 'tokens'];
  const sanitized = { ...payload };
  for (const field of sensitiveFields) {
    delete sanitized[field];
  }
  if (sanitized.modelConfig && typeof sanitized.modelConfig === 'object') {
    const config = { ...(sanitized.modelConfig as Record<string, unknown>) };
    delete config.apiKey;
    sanitized.modelConfig = config;
  }
  return sanitized;
}

export async function buildInternalAgentEventPayload(
  agent: InternalAgent,
  eventType: InternalAgentEventTypeForPayload,
  opts: BuildOpts = {},
): Promise<Record<string, unknown>> {
  if (eventType === 'tenant.internal_agent.deleted') {
    // Runtime handleInternalAgentDeleted only needs id + tenant_id (envelope).
    return { id: agent.id, name: agent.role };
  }

  const enrichedIntegrations = await enrichIntegrationsWithType(agent.tenantId, agent.integrations);
  const effectiveInstructionsMd = await buildEffectiveInstructionsMd(agent.tenantId, agent);

  return sanitize({
    id: agent.id,
    tenantId: agent.tenantId,
    name: agent.role,
    description: agent.responsibilities,
    role: agent.role,
    status: agent.status,
    agentType: agent.agentType,
    // Publish site 1 of 2. Site 2 is the inline runtime_config_updated payload
    // in service.update — both must use this helper or the two events race on
    // TR's agents.model_config with different values.
    modelConfig: effectiveModelConfig(agent),
    execConfig: agent.execConfig,
    memoryScope: agent.memoryScope,
    systemPrompt: agent.systemPrompt,
    userInstructions: agent.userInstructions,
    capabilityTier: agent.capabilityTier,
    // Sent on every publish, `[]` included. The runtime compiles a fresh
    // instruction row from this payload, so there is no prior value to preserve
    // — an omitted field and an empty list mean the same thing over there, and
    // sending the column verbatim keeps the two sides from disagreeing about
    // which one that is.
    resultRules: agent.resultRules ?? [],
    // Same treatment and the same reasoning: sent on every publish, `{}`
    // included. The runtime compiles a fresh instruction row from this payload,
    // so an omitted field and an empty map would mean the same thing over there
    // — sending the column verbatim keeps the two sides from having to agree
    // about which one it was.
    toolDescriptionOverrides: agent.toolDescriptionOverrides ?? {},
    groundsOn: agent.groundsOn ?? [],
    capabilityStates: agent.capabilityStates ?? {},
    instructionsMd: effectiveInstructionsMd,
    triggerConfig: agent.triggerConfig,
    integrations: enrichedIntegrations,
    // The steps THEMSELVES, not only the hash of them.
    //
    // If the hash travels alone, the runtime stores it in
    // `agents.workflow_steps_hash` and reads the steps from
    // `agents.workflow_steps` — a column nothing else fills. So
    // `loadRuntimeConfig` returns undefined steps, the hybrid loop's
    // `workflowSteps?.length` branch cannot fire, and every agent the distiller
    // designed with a deterministic backbone runs the conversational path
    // instead. `verifyWorkflowStepsHash` returns ok on the first line for the
    // same reason: it short-circuits when there are no steps, so the tamper
    // check it exists to perform is skipped.
    //
    // Real steps exist upstream — the distiller is told to emit them whenever
    // the responsibilities carry a numbered workflow section, with no
    // exceptions. Without this field they never cross the boundary.
    // `null`, not `undefined`: the runtime treats an absent field as "an older
    // publisher sent this, keep what you have" and an explicit null as "the
    // control plane has no steps for this agent". Sending undefined for an
    // agent whose workflow was removed would leave it executing here forever.
    workflowSteps: agent.workflowSteps ?? null,
    workflowStepsHash: (agent as { workflowStepsHash?: string }).workflowStepsHash,
    createdAt: agent.createdAt,
    createdBy: opts.actorId ?? null,
    // Archived skills stay in the authoritative platform column but never
    // reach the runtime: the runtime's supersede-then-insert rebuilds its
    // active set from this payload, so filtering here is what retires them
    // (and un-archiving re-inserts them on the next write). P1.4.
    skills: skillsForRuntime(agent.skills ?? []),
    autonomyOverride: agent.autonomyOverride ?? null,
    pinnedKnowledgeIds: agent.pinnedKnowledgeIds ?? [],
  });
}
