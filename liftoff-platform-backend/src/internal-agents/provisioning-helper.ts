// Canonical server-side provisioning: distill → create → absorption.
//
// This is the builder flow, extracted so a second caller cannot become a second
// agent-provisioning path. The interactive builder does this in
// internal-agents/router.ts; Liftoff Switch does it for imported identities.
// Both MUST go through here, because the sequence carries obligations that are
// easy to lose when reimplemented:
//
//   * distill once, and reuse ITS classifications — classifying the same
//     attachments a second time would produce a different split of skills and
//     memories from the one the distiller was told about.
//   * persist the distill output BEFORE creating the agent, so a crash between
//     the two costs a create, not an LLM run.
//   * create through InternalAgentService.create(..., 'distill'), which owns
//     the version-history row, the create event, workflow validation and the
//     runtime publish, all in one transaction.
//   * attribute the distill session's LLM cost to the agent that resulted.
//   * apply absorption AFTER the row exists, and never let an absorption
//     failure fail the create — the team member exists, and what did not land
//     is re-shareable in chat.
//
// There is no direct bundle-to-agent write anywhere in this file: a caller
// hands over inputs, and the canonical services do the writing.

import { distillInternalAgentWithProgress, type DistillInput, type DistillOutput } from './distill-service';
import { mergeDistillIntegrationConfigs } from './integration-config-merge';
import { applyAbsorption } from './absorption-apply';
import { InternalAgentService } from './service';
import { attributeSessionToAgent } from '../llm/usage-tracker';
import { log } from '../infrastructure/logging';
import type {
  IntegrationPermission,
  InternalAgent,
  InternalAgentStatus,
  TeamAttachment,
} from './types';

export interface ProvisionFromDistillParams {
  tenantId: string;
  /** The canonical distill input. Instruction files and other imported
   *  artifacts belong in `attachments`, never copied onto agent fields. */
  distillInput: DistillInput;
  /** Bindings to CONCRETE connector UUIDs. An imported agent binds to the
   *  exact placeholder UUID so reconnection heals the binding in place;
   *  pendingIntegrations is only for a type with no placeholder. */
  integrations: IntegrationPermission[];
  pendingIntegrations?: string[];
  /** Deterministic key so a crash between create and mapping recovery does not
   *  produce a duplicate team member. */
  idempotencyKey: string;
  actorId?: string;
  /** Imported team members are created as drafts and stay inactive until the
   *  user confirms cutover. */
  status?: InternalAgentStatus;
  /** Reuse an already-completed distill instead of running a new one. This is
   *  what makes a retry after a failed create cost nothing: the stored output
   *  is replayed, never re-distilled. */
  existingDistillOutput?: DistillOutput;
  /** Called with a successful distill BEFORE agent creation is attempted. */
  onDistillComplete?: (output: DistillOutput) => Promise<void>;
  /** Artifact names the user approved for the shared knowledge library.
   *  Workspace-scoped context requires explicit consent; absent approval,
   *  nothing reaches the library. */
  libraryApprovals?: string[];
  /** Replaces the distiller's inferred trigger.
   *
   *  An import already KNOWS when the work runs, because the source said so.
   *  Letting the LLM re-derive a schedule from prose is how a Monday brief
   *  quietly becomes a daily one. */
  triggerOverride?: { type: 'cron' | 'event' | 'manual'; cronExpr?: string; eventTopic?: string };
}

export interface ProvisionResult {
  agent: InternalAgent;
  distillOutput: DistillOutput;
  /** True when the distill was replayed from a stored output rather than run. */
  reusedDistill: boolean;
}

const internalAgentService = new InternalAgentService();

export async function provisionAgentFromDistill(
  params: ProvisionFromDistillParams,
): Promise<ProvisionResult> {
  const {
    tenantId,
    distillInput,
    integrations,
    idempotencyKey,
    actorId,
    status = 'draft',
  } = params;

  // 1. Distill once. classifyArtifacts runs INSIDE this call and decides which
  //    attachments inform distillation and which become absorbed skills,
  //    memories or proposed library items.
  let distillOutput: DistillOutput;
  let reusedDistill = false;

  if (params.existingDistillOutput) {
    distillOutput = params.existingDistillOutput;
    reusedDistill = true;
  } else {
    distillOutput = await distillInternalAgentWithProgress(distillInput);
    // 2. Persist BEFORE creating. The whole point of the ordering.
    if (params.onDistillComplete) {
      await params.onDistillComplete(distillOutput);
    }
  }

  // 3. Merge connector-specific settings the distiller emitted onto the
  //    concrete bindings.
  const mergedIntegrations = mergeDistillIntegrationConfigs(
    integrations,
    distillOutput.integrationConfigs,
  );

  // 4. Create through the canonical path. This owns the version row, the
  //    create event, workflow-integrity validation and the runtime publish.
  const agent = await internalAgentService.create(
    tenantId,
    {
      role: distillInput.role,
      responsibilities: distillInput.responsibilities,
      additionalContext: distillInput.additionalContext ?? undefined,
      integrations: mergedIntegrations,
      pendingIntegrations: params.pendingIntegrations,
      summary: distillOutput.summary,
      systemPrompt: distillOutput.systemPrompt,
      userInstructions: distillOutput.userInstructions,
      instructionsMd: distillOutput.instructionsMd ?? undefined,
      agentType: distillOutput.agentType,
      triggerConfig:
        params.triggerOverride ??
        (distillOutput.triggerConfig
          ? {
              type: distillOutput.triggerConfig.type,
              cronExpr: distillOutput.triggerConfig.cronExpr,
              eventTopic: distillOutput.triggerConfig.eventTopic,
            }
          : undefined),
      skills: distillOutput.skills,
      workflowSteps: distillOutput.workflowSteps,
      capabilityTier: distillOutput.capabilityTier,
      // The template's declared scope, which this path used to drop.
      //
      // Templates grant `role` to the hires whose work spans runs, and only
      // team-provisioning ever passed it on. Passing nothing here meant the
      // create default applied instead, so the agent was denied the layer its
      // own template granted — while the distiller, reading that same template,
      // authored `memory_save` steps against it. Every one of those was refused
      // at dispatch, on every fire.
      memoryScope: distillOutput.memoryScope,
      resultRules: distillOutput.resultRules,
      attachments: distillInput.attachments ?? undefined,
      status,
    },
    idempotencyKey,
    actorId,
    'distill',
  );

  // 5. Attribute the distill session's LLM cost to the agent that resulted.
  if (distillInput.sessionId) {
    void attributeSessionToAgent(distillInput.sessionId, agent.id);
  }

  // 6. Absorption, with the classifications from THAT distill. Never
  //    re-classify: a second classification would disagree with the first and
  //    silently move a user's material to a different destination.
  //
  //    Awaited rather than fire-and-forget, unlike the interactive builder: a
  //    migration must be able to report what landed. A failure is still not
  //    allowed to fail the create.
  try {
    await applyAbsorption({
      tenantId,
      agentId: agent.id,
      classifications: distillOutput.absorption ?? [],
      libraryApprovals: params.libraryApprovals,
      attachments: (distillInput.attachments ?? []) as TeamAttachment[],
    });
  } catch (err) {
    log.error(
      { error: (err as Error).message, tenantId, agentId: agent.id },
      'provisionAgentFromDistill: absorption failed; the team member was still created',
    );
  }

  return { agent, distillOutput, reusedDistill };
}
