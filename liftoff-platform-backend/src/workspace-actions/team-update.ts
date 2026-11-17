// Change an agent: the one function behind the dashboard's Save, the
// Chief AI Officer's service-auth update, and the assistants' team_update.
//
// The body is the dashboard route's, lifted out verbatim, with three things
// every caller now gets for free: the role rule (member and above; the
// dashboard route tightens with everyone else), attribution (the audit row
// carries the person and the surface), and a server-side distil for callers
// that cannot run the client's distill-then-save round trip. That distil runs
// FIRST, over the merged inputs, like Save does; a failed distil writes
// nothing (D4).
//
// Three distil modes:
//   client — the page distilled and holds an artifact handle; redeem it. The
//            artifact, not the request body, is the authority for what the
//            distiller generated.
//   server — project the patch onto the stored agent, distil the projection
//            through the SAME input assembly a redistill uses, and write the
//            distiller's output beside the patched inputs, source 'distill'.
//   none   — a plain edit of what the patch names, source 'manual' unless the
//            caller asserts `distilled`.

import type { z } from 'zod';
import { distillInternalAgent } from '../internal-agents/distill-service';
import { getDistillArtifact } from '../internal-agents/distill-artifact-store';
import { internalAgentService } from '../internal-agents/service';
import { validateIntegrationsArray, IntegrationValidationError } from '../internal-agents/integration-validator';
import { parseAndFilterPinnedKnowledge } from '../internal-agents/pinned-knowledge';
import { applyAbsorption } from '../internal-agents/absorption-apply';
import { buildDistillInputFromAgent, buildUpdatePayload } from '../internal-agents/redistill-service';
import { collectRecurringPreferences } from '../internal-agents/preference-aggregation';
import { getCatalog as getConnectorCatalog } from '../connectors/connector-service-client';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { fireAndForget } from '../shared/fire-and-forget';
import { log } from '../infrastructure/logging';
import type { InternalAgent, IntegrationPermission, Skill, UpdateInternalAgentInput, VersionSource } from '../internal-agents/types';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';
import { resolveBindings } from './bindings';
import type { teamUpdatePatchSchema } from './schemas';

// The INPUT type: callers that build a patch in code (the collaboration
// reconciler, the tools) send only what they mean to change; the route hands
// in the parsed body, which is assignable to it.
export type TeamUpdatePatch = z.input<typeof teamUpdatePatchSchema>;

export type TeamUpdateOptions = { distill: 'client' } | { distill: 'server' } | { distill: 'none' };

export type TeamUpdateRefusal = {
  refused: 'validation' | 'nickname_conflict' | 'workflow_tampered' | 'distill_failed' | 'not_found';
  message: string;
  context?: unknown;
};

export type TeamUpdateResult =
  | {
      agent: InternalAgent;
      /** Runtime memory ids the caller asked to delete that could not be
       *  deleted after the save. A re-run of the same request converges:
       *  deleting an absent memory is a no-op. */
      memoryDeletionsFailed?: string[];
    }
  | TeamUpdateRefusal;

export function isTeamUpdateRefusal(r: TeamUpdateResult): r is TeamUpdateRefusal {
  return 'refused' in r;
}

// The fields a server-side distil takes from the PATCH rather than from the
// distiller's output: everything else it writes is a distillation output.
const NON_PRIMARY_PATCH_KEYS = ['temperature', 'messagingNickname', 'autonomyOverride', 'aiVendorOverride'] as const;

/** Translate the skill steering verbs onto the stored skills. An instruction
 *  change hands the skill to the operator; `preserve` does the same without
 *  changing the text; `archive` / `restore` toggle the flag. The provenance
 *  merge in service.update keeps every other skill exactly as it was. */
function applySkillEdits(
  current: Skill[],
  edits: NonNullable<TeamUpdatePatch['skillEdits']>,
): { skills: Skill[] } | { unknown: string[] } {
  const byId = new Map(current.filter((s) => s.id).map((s) => [s.id as string, { ...s }]));
  const unknown: string[] = [];
  for (const edit of edits) {
    const skill = byId.get(edit.id);
    if (!skill) {
      unknown.push(edit.id);
      continue;
    }
    if (edit.instruction !== undefined) {
      skill.instruction = edit.instruction;
      skill.provenance = 'operator';
    }
    if (edit.preserve) skill.provenance = 'operator';
    if (edit.archive) skill.archived = true;
    if (edit.restore) skill.archived = false;
  }
  if (unknown.length > 0) return { unknown };
  return { skills: current.map((s) => (s.id && byId.has(s.id) ? byId.get(s.id)! : s)) };
}

export async function applyTeamUpdate(
  actor: Actor,
  agentId: string,
  patch: TeamUpdatePatch,
  opts: TeamUpdateOptions,
): Promise<TeamUpdateResult> {
  requirePermission(actor, 'teams:update');
  const { tenantId } = actor;

  // WS-5.1 — UUID + connectorType validation on integrations JSONB. The
  // validator's parse is also what fills the schema defaults in (an absent
  // selectedObjects becomes []), so its output is what the row stores.
  let integrations: IntegrationPermission[] | undefined;
  if (patch.integrations && patch.integrations.length > 0) {
    try {
      integrations = await validateIntegrationsArray(patch.integrations, { tenantId, agentId }) as IntegrationPermission[];
    } catch (err) {
      if (err instanceof IntegrationValidationError) {
        return { refused: 'validation', message: err.message, context: err.context };
      }
      throw err;
    }
  } else if (patch.integrations) {
    integrations = [];
  }

  // Snapshot pre-update state — used both for pin re-validation against
  // post-patch integrations AND for the autonomy_override diff below.
  const current = await internalAgentService.getById(agentId, tenantId);
  if (!current) {
    return { refused: 'not_found', message: 'agent not found' };
  }

  // Bindings name connector types, collaborators and peer teams; they resolve
  // into the integrations the row stores and the types still waiting on a
  // connection.
  let pendingIntegrations = patch.pendingIntegrations;
  if (patch.bindings) {
    try {
      const resolved = await resolveBindings(tenantId, agentId, patch.bindings, actor.accountId);
      if (resolved.unresolved.length > 0) {
        return {
          refused: 'validation',
          message: `These bindings name nothing in this workspace: ${resolved.unresolved.join(', ')}`,
          context: { unresolved: resolved.unresolved },
        };
      }
      integrations = resolved.integrations;
      pendingIntegrations = resolved.pendingIntegrations;
    } catch (err) {
      if (err instanceof IntegrationValidationError) {
        return { refused: 'validation', message: err.message, context: err.context };
      }
      throw err;
    }
  }

  // Skill verbs are translated onto the stored skills before the write so the
  // provenance merge sees one list.
  let skills = patch.skills;
  if (patch.skillEdits && patch.skillEdits.length > 0) {
    const edited = applySkillEdits(current.skills ?? [], patch.skillEdits);
    if ('unknown' in edited) {
      return {
        refused: 'validation',
        message: `These skills do not exist on this team: ${edited.unknown.join(', ')}`,
        context: { unknown: edited.unknown },
      };
    }
    skills = edited.skills;
  }

  // Re-validate pins on every save: even an integrations-only patch can
  // orphan an existing pin if the operator removes its source connector.
  const effectiveIntegrations = integrations ?? current.integrations;
  const boundConnectorIds = new Set(effectiveIntegrations.map((i) => i.id));
  const effectiveResponsibilities = patch.responsibilities ?? current.responsibilities;
  const effectiveAdditionalContext = patch.additionalContext ?? current.additionalContext;

  const pinnedKnowledgeIds = await parseAndFilterPinnedKnowledge(
    tenantId,
    boundConnectorIds,
    effectiveResponsibilities,
    effectiveAdditionalContext,
  );
  const {
    absorption: updateAbsorption,
    libraryApprovals: updateLibraryApprovals,
    distilled: updateWasDistilled,
    distillId: updateDistillId,
    bindings: _bindings,
    skillEdits: _skillEdits,
    memoryDeletions,
    integrations: _integrations,
    pendingIntegrations: _pendingIntegrations,
    skills: _skills,
    ...updateFields
  } = patch;

  let updateData: UpdateInternalAgentInput;
  let source: VersionSource;

  if (opts.distill === 'server') {
    // Distil FIRST, over the merged inputs: the stored agent with the five
    // primary fields the patch changes projected onto it, through the same
    // input assembly a redistill uses. A throw here writes nothing.
    const projected: InternalAgent = {
      ...current,
      role: patch.role ?? current.role,
      responsibilities: patch.responsibilities ?? current.responsibilities,
      additionalContext: patch.additionalContext ?? current.additionalContext,
      attachments: patch.attachments ?? current.attachments,
      integrations: effectiveIntegrations,
      pendingIntegrations: pendingIntegrations ?? current.pendingIntegrations,
    };
    let distillPayload: UpdateInternalAgentInput;
    try {
      const catalog = await getConnectorCatalog();
      const catalogByType = new Map(catalog.connectors.map((c) => [c.type, c]));
      const recurringPreferences = await collectRecurringPreferences(tenantId, agentId);
      const distilled = await distillInternalAgent(
        buildDistillInputFromAgent(projected, catalogByType, { recurringPreferences }),
      );
      distillPayload = buildUpdatePayload(projected, distilled);
    } catch (err) {
      log.error({ error: (err as Error).message, tenantId, agentId }, 'workspace-actions: server-side distil failed; nothing written');
      return { refused: 'distill_failed', message: (err as Error).message };
    }
    updateData = {
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.responsibilities !== undefined ? { responsibilities: patch.responsibilities } : {}),
      ...(patch.additionalContext !== undefined ? { additionalContext: patch.additionalContext } : {}),
      ...(patch.attachments !== undefined ? { attachments: patch.attachments } : {}),
      ...(integrations !== undefined ? { integrations } : {}),
      ...(pendingIntegrations !== undefined ? { pendingIntegrations } : {}),
      ...distillPayload,
      ...Object.fromEntries(
        NON_PRIMARY_PATCH_KEYS
          .filter((k) => updateFields[k] !== undefined)
          .map((k) => [k, updateFields[k]]),
      ),
      ...(skills !== undefined ? { skills } : {}),
      pinnedKnowledgeIds,
    } as UpdateInternalAgentInput;
    source = 'distill';
  } else {
    // Same redemption as create: the artifact, not the request body, is the
    // authority for what the distiller generated.
    const updateArtifact = opts.distill === 'client' && updateDistillId
      ? await getDistillArtifact(updateDistillId, tenantId)
      : null;
    if (opts.distill === 'client' && updateDistillId && !updateArtifact) {
      return {
        refused: 'validation',
        message: 'Distillation not found or expired. Please run the optimization again.',
      };
    }

    updateData = {
      ...updateFields,
      ...(integrations !== undefined ? { integrations } : {}),
      ...(pendingIntegrations !== undefined ? { pendingIntegrations } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(updateArtifact && {
        systemPrompt: updateArtifact.systemPrompt,
        userInstructions: updateArtifact.userInstructions,
        instructionsMd: updateArtifact.instructionsMd,
        // Same precedence as create, and it carries real weight here: the
        // update page lets someone rewrite a skill's instruction by hand and
        // save it in the same request as a redistill. Taking the artifact's
        // list unconditionally would throw that edit away.
        skills: skills ?? updateArtifact.skills,
        capabilityTier: updateFields.capabilityTier ?? updateArtifact.capabilityTier,
        resultRules: updateFields.resultRules ?? updateArtifact.resultRules,
      }),
      pinnedKnowledgeIds,
    } as UpdateInternalAgentInput;
    // A redeemed handle is proof a distillation produced these fields, so it
    // settles the version source on its own. `distilled` remains as the
    // fallback for callers that have not moved to handles.
    source = updateWasDistilled || updateArtifact ? 'distill' : 'manual';
  }

  let internalAgent: InternalAgent | null;
  try {
    internalAgent = await internalAgentService.update(agentId, tenantId, updateData, actor.accountId, source);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'NICKNAME_CONFLICT') {
      return { refused: 'nickname_conflict', message: (err as Error).message };
    }
    if (code === 'WORKFLOW_TAMPERED') {
      return { refused: 'workflow_tampered', message: (err as Error).message };
    }
    throw err;
  }

  if (!internalAgent) {
    return { refused: 'not_found', message: 'agent not found' };
  }

  if (
    patch.autonomyOverride !== undefined &&
    (current as { autonomyOverride?: unknown } | null)?.autonomyOverride !==
      (internalAgent as { autonomyOverride?: unknown }).autonomyOverride
  ) {
    writeAudit(actor, 'internal_agent.autonomy_override_updated', {
      resourceType: 'internal_agent',
      resourceId: internalAgent.id,
      previousState: {
        autonomyOverride: (current as { autonomyOverride?: unknown } | null)?.autonomyOverride ?? null,
      },
      newState: {
        autonomyOverride: (internalAgent as { autonomyOverride?: unknown }).autonomyOverride ?? null,
      },
    });
  }

  writeAudit(actor, 'internal_agent.updated', {
    internalAgentId: internalAgent.id,
    tenantId,
    versionSource: source,
  });

  // Event publish is owned by InternalAgentService.update (shape-3 canonical
  // pattern per plan §5.4) — entity UPDATE + outbox commit in one tx.

  // The guidance-attachment lane on the team settings page imports the
  // same way the build wizard does.
  if (updateAbsorption?.length) {
    fireAndForget(
      applyAbsorption({
        tenantId,
        agentId,
        classifications: updateAbsorption,
        libraryApprovals: updateLibraryApprovals,
        attachments: updateData.attachments ?? [],
      }).then(() => undefined),
      'internal-agents absorption apply (update)',
    );
  }

  // Memory deletions AFTER the distil and the update have succeeded, so a
  // failed distil deletes nothing. Each 404 counts as done; the rest are
  // reported so the caller can say so, and a re-run converges.
  let memoryDeletionsFailed: string[] = [];
  if (memoryDeletions && memoryDeletions.length > 0) {
    const outcomes = await Promise.allSettled(
      memoryDeletions.map((memoryId) => tenantRuntimeClient.deleteAgentMemory(tenantId, agentId, memoryId)),
    );
    memoryDeletionsFailed = memoryDeletions.filter((_, i) => {
      const o = outcomes[i];
      if (o.status === 'fulfilled') return false;
      return !/HTTP 404/.test(String((o.reason as Error)?.message ?? ''));
    });
    if (memoryDeletionsFailed.length > 0) {
      log.warn({ tenantId, agentId, failed: memoryDeletionsFailed }, 'workspace-actions: some memory deletions failed after the save');
    }
  }

  return {
    agent: internalAgent,
    ...(memoryDeletionsFailed.length > 0 ? { memoryDeletionsFailed } : {}),
  };
}
