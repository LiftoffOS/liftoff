// Re-run distillation for existing agents without touching role/responsibilities.
//
// Distillation has always been the "convert role + responsibilities + integrations
// into systemPrompt / userInstructions / instructionsMd / triggerConfig" step.
// Until now it only fired on first creation (and on PUT-edit, which the frontend
// triggers when the user changes any of the source fields). When the distill
// prompt itself evolves — new trigger primitives, new prompt sections, new
// connector-catalog data — existing agents stay frozen on whatever the prompt
// said the day they were created.
//
// `redistillAgent` reads the agent's current source fields, calls the same
// distillInternalAgent the create/edit path uses, and writes the result back
// through internalAgentService.update so the existing version-bump + outbox-
// event + audit trail path fires unchanged.
//
// Two callers:
//   - POST /api/internal-agents/:id/redistill           (single agent, sync)
//   - POST /api/internal-agents/redistill-all           (every non-deleted
//                                                        agent in the tenant,
//                                                        bounded concurrency)

import { templatePicksFromBindings } from './picks-from-bindings';
import type { InternalAgent, UpdateInternalAgentInput } from './types';
import type { DistillInput, DistillOutput, IntegrationInfo } from './distill-service';
import { distillInternalAgent, MAX_RETRIES } from './distill-service';
import { internalAgentService } from './service';
import { getCatalog as getConnectorCatalog } from '../connectors/connector-service-client';
import { log } from '../infrastructure/logging';
import { DistillationGraphNotConvergedError } from './distill-errors';
import { mergeDistillIntegrationConfigs } from './integration-config-merge';
import { mergeSkillsByProvenance } from './skill-provenance';
import { mergeToolDescriptionOverrides, distilledOverrideTools } from './tool-override-provenance';
import { carryFlowIncumbency } from './flow-incumbency';
import { templateIdForRedistill, templateIdForObligations } from './template-provenance';
import { collectRecurringPreferences } from './preference-aggregation';

const MAX_AGENTS_PER_BATCH = 50;
const BATCH_CONCURRENCY = 4;

export class RedistillNotFoundError extends Error {
  constructor(internalAgentId: string) {
    super(`Agent ${internalAgentId} not found`);
    this.name = 'RedistillNotFoundError';
  }
}

export class RedistillTooManyAgentsError extends Error {
  constructor(public readonly agentCount: number) {
    super(
      `Workspace has ${agentCount} agents; redistill-all caps at ${MAX_AGENTS_PER_BATCH} ` +
      `per call. Redistill agents individually via POST /api/internal-agents/:id/redistill.`,
    );
    this.name = 'RedistillTooManyAgentsError';
  }
}

/** Translate a stored IntegrationPermission[] into the IntegrationInfo[] shape
 *  distillInternalAgent expects.
 *
 *  CRITICAL: IntegrationPermission stores the connector type under EITHER
 *  `type` OR `integrationId` — historical drift (the FE writes
 *  `integrationId`; the router schema accepts both). Distill keys catalog
 *  lookups on `IntegrationInfo.type`. Missing the integrationId fallback
 *  meant every redistill saw `type = ''`, the catalog lookup failed, the
 *  EVENT TOPICS section in the distill prompt came up empty, and the LLM
 *  was forced into rule 2 (cron) even for connectors with declared event
 *  topics — silently regressing event-based agents back to cron polling
 *  on every redistill. */
function buildIntegrationInfos(
  permissions: InternalAgent['integrations'],
  catalogByType: Map<string, { displayName: string; type: string }>,
): IntegrationInfo[] {
  return permissions.map((perm) => {
    const type = perm.type ?? perm.integrationId ?? '';
    const def = catalogByType.get(type);
    return {
      id: perm.id,
      type,
      name: def?.displayName ?? type ?? perm.id,
      selectedObjects: perm.selectedObjects ?? [],
    };
  });
}

/** The distillation input an existing agent implies: its own prose, its
 *  bindings with their display names, the template it still says what it said,
 *  the obligations that bind regardless, the picks recovered from the bindings,
 *  its memory scope, its attachments and what the last distillation decided.
 *
 *  Shared by the redistill (which spreads its own cadence/scope options on
 *  top) and by the workspace action's server-side distil, which projects a
 *  patch onto the agent first so the SAME assembly runs over the merged
 *  inputs. */
export function buildDistillInputFromAgent(
  agent: InternalAgent,
  catalogByType: Map<string, { displayName: string; type: string }>,
  opts: { recurringPreferences?: DistillInput['recurringPreferences'] } = {},
): DistillInput {
  const integrations = buildIntegrationInfos(agent.integrations, catalogByType);

  // Seed from the template only while the agent still says what the template
  // said. Editing responsibilities or additionalContext makes the agent its
  // owner's, and re-seeding theirs from ours would pull their wording back
  // toward the catalog during what they asked for as an optimisation.
  const templateId = templateIdForRedistill(agent) ?? undefined;
  // The obligations bind whether or not the owner edited the words. Without
  // this an edited hire silently loses its delivery step, its idempotency check
  // and its column contract on the next redistill.
  const obligationTemplateId = templateIdForObligations(agent) ?? undefined;

  return {
    tenantId: agent.tenantId,
    agentId: agent.id,
    ...(templateId ? { templateId } : {}),
    ...(obligationTemplateId ? { obligationTemplateId } : {}),
    role: agent.role,
    responsibilities: agent.responsibilities ?? '',
    // What this agent is ACTUALLY granted, so the graph is checked against the
    // scope dispatch will enforce rather than the one its template declares.
    currentMemoryScope: agent.memoryScope,
    integrations,
    // Recovered from the bindings, because templatePicks is an input to
    // distillation and not a stored field. Without them a redistill resolves
    // the template's raw {{pick:...}} to the generic fallback, and an agent
    // told to post to "#deal-room" starts saying "your deal channel".
    templatePicks: templatePicksFromBindings(integrations),
    additionalContext: agent.additionalContext,
    ...(opts.recurringPreferences ? { recurringPreferences: opts.recurringPreferences } : {}),
    // Stored build-time attachments keep shaping the prompts on redistill,
    // same as additionalContext does.
    attachments: agent.attachments,
    // What the LAST distillation decided. Rendered into the user message as a
    // section the model must honour, and diffed against what this run produces
    // so a reversal is reported instead of silent. This is the whole reason a
    // redistill is a merge rather than a rewrite.
    priorDecisionRecord: agent.decisionRecord,
  };
}

/** Build the UpdateInternalAgentInput payload that mirrors the distill result.
 *  Only the LLM-derived fields are written — role, responsibilities,
 *  integrations, additionalContext stay untouched (they're the inputs).
 *  Exported for the workspace action's server-side distil (team-update.ts),
 *  which projects a patch onto the agent and writes the result the same way. */
export function buildUpdatePayload(
  current: InternalAgent,
  distillResult: Awaited<ReturnType<typeof distillInternalAgent>>,
): UpdateInternalAgentInput {
  // A rebuild that lost its graph is not applied at all. The distiller only
  // hands back such an artifact for a hire that owes nothing structural, but
  // on a redistill the agent already has a configuration, and writing this
  // one's instructions, trigger and integrations while its steps are gone
  // would leave yesterday's graph (or none) under today's prompts. The
  // rebuild fails whole; the incumbent configuration stays whole.
  if (distillResult.graphDropped) {
    log.warn({
      metric: 'redistill.rebuild_not_applied',
      agentId: current.id,
      tenantId: current.tenantId,
      reasons: distillResult.graphDropped.reasons,
      incumbentStepCount: current.workflowSteps?.length ?? 0,
    }, 'redistill produced no graph; the incumbent configuration is kept whole');
    throw new DistillationGraphNotConvergedError(
      distillResult.graphDropped.reasons,
      distillResult.graphDropped.stepCount,
      MAX_RETRIES,
    );
  }
  // §2 Group B: merge distill's integrationConfigs into the agent's existing
  // IntegrationPermission.config fields. Mirrors the frontend merge so
  // redistilled agents land on the same persisted shape as freshly-created
  // ones.
  const mergedIntegrations = mergeDistillIntegrationConfigs(
    current.integrations,
    distillResult.integrationConfigs,
  );

  // Incumbency FIRST, before the provenance merge.
  //
  // mergeSkillsByProvenance keys on `id` when there is one and falls back to an
  // exact lowercased NAME match otherwise, so a paraphrase — "Avoiding
  // duplicate reviews" against "Preventing duplicate reviews" — misses and
  // mints a fresh id, stranding every metric row behind the old one. Assigning
  // the incumbent id here means the provenance merge sees one skill, which is
  // what it would have concluded had the wording held still.
  const incumbency = carryFlowIncumbency({
    incumbents: current.skills ?? [],
    incoming: distillResult.skills ?? [],
    mintedSubjects: current.decisionRecord?.flowSubjects,
    responsibilities: current.responsibilities ?? '',
  });
  if (incumbency.carried.length > 0 || incumbency.reminted.length > 0) {
    log.info({
      event: 'redistill.flow_incumbency',
      metric: 'distill.flow_identity_carried',
      agentId: current.id,
      carried: incumbency.carried.length,
      reminted: incumbency.reminted,
    }, 'carried invented flow identities across the redistill');
  }

  const overrideMerge = mergeToolDescriptionOverrides(
    current.toolDescriptionOverrides,
    distillResult.toolDescriptionOverrides,
    distilledOverrideTools(current.decisionRecord),
  );
  if (overrideMerge.preserved.length > 0 || overrideMerge.retired.length > 0) {
    log.info({
      event: 'redistill.tool_override_merge',
      agentId: current.id,
      preserved: overrideMerge.preserved,
      retired: overrideMerge.retired,
    }, 'merged tool description overrides by provenance');
  }

  const base: UpdateInternalAgentInput = {
    // §1
    agentType: distillResult.agentType,
    // Existing fields
    summary: distillResult.summary,
    systemPrompt: distillResult.systemPrompt,
    userInstructions: distillResult.userInstructions,
    instructionsMd: distillResult.instructionsMd,
    triggerConfig: distillResult.triggerConfig,
    // §2 Group A — new column-backed fields
    // The incumbency pass has already stamped surviving identities onto these.
    skills: incumbency.skills,
    capabilityTier: distillResult.capabilityTier ?? 'connector_only',
    // `[]` rather than absent when this run named no tool: the rules describe
    // the workflow this same distillation produced, so leaving the previous
    // run's policy in place would apply it to steps that no longer exist.
    resultRules: distillResult.resultRules ?? [],
    // Provenance-merged rather than replaced: this run's overrides win where it
    // named a tool, the previous run's are retired where it did not, and any an
    // operator authored survive both. See tool-override-provenance.ts for why
    // the marker lives in the decision record.
    toolDescriptionOverrides: overrideMerge.merged,
    // Re-derived from what is bound NOW rather than merged: a grounding rule
    // names a tool, and the point of re-deriving is that a rebinding changes
    // which tool that is. Merging would preserve a rule pointing at a tool this
    // hire no longer has.
    groundsOn: distillResult.groundsOn ?? [],
    capabilityStates: distillResult.capabilityStates ?? {},
    // The record this run produced, with the override marker replaced by what
    // the MERGE actually kept — the distiller only knows what it authored, and
    // the marker has to describe the stored map or the next merge retires the
    // wrong keys.
    ...(distillResult.decisionRecord
      ? {
        decisionRecord: {
          ...distillResult.decisionRecord,
          distilledOverrideTools: overrideMerge.distilledTools,
          // Recorded at mint time so the NEXT redistill can ask whether the
          // responsibilities have moved away from a flow, rather than whether
          // the flow happens to suit the responsibilities as they now read.
          flowSubjects: incumbency.subjects,
        },
      }
      : {}),
    // §2 Group B — merged integrations carry the per-binding config
    integrations: mergedIntegrations,
  };

  // Hybrid execution engine: distillation only emits agentType='agent'.
  // workflowSteps is optional on the output — persist it when present, NULL
  // it out otherwise so the service.update path's version-diff check stays
  // clean for agents that previously carried a workflow.
  base.workflowSteps = distillResult.workflowSteps ?? null;

  return base;
}

/** Per-binding integration-config diff entry. Surfaces every binding whose
 *  `config` field changed, with the before/after JSON so an operator can spot
 *  unexpected scope changes (e.g. an over-broad `gmailQuery` rewrite) without
 *  re-running distill themselves. */
export interface IntegrationConfigDiffEntry {
  integrationId: string;
  type?: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/** Per-agent diff surfaced by `redistillAgentDryRun()` and the batch
 *  `?dryRun=true` query param. Mirrors the fields §4.10 enumerates so an
 *  operator can review changes before triggering the destructive sweep. */
export interface RedistillDryRunDiff {
  agentId: string;
  role: string;
  currentAgentType: 'agent' | 'workflow';
  newAgentType: 'agent' | 'workflow';
  currentTriggerSummary: string;
  newTriggerSummary: string;
  currentSkillCount: number;
  newSkillCount: number;
  /** Post-merge skill accounting (P1.0). `newSkillCount` is the raw distiller
   *  output; these describe what actually lands after the provenance merge —
   *  which distilled skills get replaced, which learned/operator skills are
   *  preserved, and how many fresh distilled skills were dropped as duplicates
   *  of a preserved one. */
  skillMerge: {
    replaced: number;
    preservedLearned: number;
    preservedOperator: number;
    deduped: number;
    resultingTotal: number;
  };
  /** Number of bindings whose IntegrationPermission.config changed. */
  integrationConfigDelta: number;
  /** Per-binding before/after for every changed binding. Empty array when no
   *  binding's config changed. */
  integrationConfigChanges: IntegrationConfigDiffEntry[];
}

function summarizeTrigger(trigger: { type?: string; cronExpr?: string; eventTopic?: string } | null | undefined): string {
  if (!trigger) return 'none';
  if (trigger.type === 'cron' && trigger.cronExpr) return `cron:${trigger.cronExpr}`;
  if (trigger.type === 'event' && trigger.eventTopic) return `event:${trigger.eventTopic}`;
  return trigger.type ?? 'unknown';
}

function diffIntegrationConfigs(
  before: InternalAgent['integrations'],
  after: InternalAgent['integrations'],
): IntegrationConfigDiffEntry[] {
  const beforeById = new Map(before.map((p) => [p.id, p]));
  const changes: IntegrationConfigDiffEntry[] = [];
  for (const a of after) {
    const b = beforeById.get(a.id);
    const beforeCfg = (b?.config ?? {}) as Record<string, unknown>;
    const afterCfg = (a.config ?? {}) as Record<string, unknown>;
    if (JSON.stringify(beforeCfg) !== JSON.stringify(afterCfg)) {
      changes.push({ integrationId: a.id, type: a.type, before: beforeCfg, after: afterCfg });
    }
  }
  return changes;
}

/** Re-run distillation for a single existing agent and persist the result. */
export interface RedistillOptions {
  /** Cadences the person stated exactly, parsed deterministically by the
   *  caller (cadence-parse.ts). Threaded into DistillInput so the analyzer
   *  requires the derived trigger set to contain each one. */
  expectedCadences?: Array<{ prose: string; cronExpr: string }>;
  /** Routines the person stopped, whose guidance lines were removed. Threaded
   *  into DistillInput so the stop is stated to the model (the removed line
   *  leaves nothing in the guidance to obey) and, when the prose parses to a
   *  cron, enforced by the analyzer. */
  stoppedCadences?: Array<{ prose: string; cronExpr?: string }>;
  /** 'triggers' regenerates only the trigger decision: the distiller is
   *  handed the previous output, every validator runs on the spliced full
   *  artifact, and the UPDATE writes only triggerConfig — the safest possible
   *  write for an edit that changed nothing but a cadence line. Callers must
   *  fall back to a full redistill on any failure. */
  scope?: 'triggers';
}

/** The stored agent, reshaped as the DistillOutput it once was, for the
 *  scoped rebuild's carry-over. Skills are trimmed to the distilled slice the
 *  provenance rules let a distill re-author; learned and operator skills are
 *  not this pipeline's to restate (they are also not written back, since the
 *  scoped update touches only the trigger). */
function previousOutputFromAgent(current: InternalAgent): DistillOutput {
  const skills = (current.skills ?? []).filter(
    (skill) => (skill as { provenance?: string }).provenance === 'distilled'
      || (skill as { provenance?: string }).provenance === undefined,
  );
  return {
    agentType: 'agent',
    summary: current.summary ?? '',
    systemPrompt: current.systemPrompt ?? '',
    userInstructions: current.userInstructions ?? '',
    instructionsMd: current.instructionsMd ?? null,
    triggerConfig: (current.triggerConfig ?? { type: 'manual' }) as DistillOutput['triggerConfig'],
    skills,
    ...(current.workflowSteps && current.workflowSteps.length > 0
      ? { workflowSteps: current.workflowSteps }
      : {}),
    ...(current.capabilityTier ? { capabilityTier: current.capabilityTier } : {}),
    ...(current.memoryScope ? { memoryScope: current.memoryScope } : {}),
    ...(current.resultRules ? { resultRules: current.resultRules } : {}),
    ...(current.toolDescriptionOverrides
      ? { toolDescriptionOverrides: current.toolDescriptionOverrides }
      : {}),
    ...(current.decisionRecord ? { decisionRecord: current.decisionRecord } : {}),
    ...(current.groundsOn ? { groundsOn: current.groundsOn } : {}),
    ...(current.capabilityStates ? { capabilityStates: current.capabilityStates } : {}),
  };
}

export async function redistillAgent(
  internalAgentId: string,
  tenantId: string,
  actorId: string | undefined,
  options?: RedistillOptions,
): Promise<InternalAgent> {
  const outcome = await redistillAgentImpl(internalAgentId, tenantId, actorId, false, options);
  return outcome as InternalAgent;
}

/** Dry-run variant: run distillation but return a diff instead of persisting.
 *  Powers the `?dryRun=true` query param on the batch endpoints. Distill-service
 *  caches structurally-clean results for ~5 min, so a real sweep that follows
 *  within the cache window does not re-pay the LLM bill. */
export async function redistillAgentDryRun(
  internalAgentId: string,
  tenantId: string,
): Promise<RedistillDryRunDiff> {
  const outcome = await redistillAgentImpl(internalAgentId, tenantId, undefined, true);
  return outcome as RedistillDryRunDiff;
}

async function redistillAgentImpl(
  internalAgentId: string,
  tenantId: string,
  actorId: string | undefined,
  dryRun: boolean,
  options?: RedistillOptions,
): Promise<InternalAgent | RedistillDryRunDiff> {
  const current = await internalAgentService.getById(internalAgentId, tenantId);
  if (!current) {
    throw new RedistillNotFoundError(internalAgentId);
  }

  // Catalog lookup gives each IntegrationPermission its display name.
  const catalog = await getConnectorCatalog();
  const catalogByType = new Map(catalog.connectors.map((c) => [c.type, c]));

  // P1.2: preferences the person has repeated often enough to be standing
  // expectations get baked into the permanent instructions here. Returns an
  // empty array when nothing recurs, which leaves the prompt exactly as it was.
  const recurringPreferences = await collectRecurringPreferences(tenantId, internalAgentId);

  const distilled = await distillInternalAgent({
    ...buildDistillInputFromAgent(current, catalogByType, { recurringPreferences }),
    ...(options?.expectedCadences?.length ? { expectedCadences: options.expectedCadences } : {}),
    ...(options?.stoppedCadences?.length ? { stoppedCadences: options.stoppedCadences } : {}),
    ...(options?.scope === 'triggers'
      ? { scope: { previousOutput: previousOutputFromAgent(current), regenerate: 'triggers' as const } }
      : {}),
  });

  // A scoped rebuild writes the trigger AND the decision record. The rest of
  // the row already IS the previous output, and pushing identical values back
  // through the merge machinery would spend its provenance rules on a no-op
  // with edge cases — but the decision record is not "the rest": it DESCRIBES
  // the trigger this run just changed. Persisting only the trigger left the
  // stored record describing the pre-change trigger, so a later FULL redistill
  // rendered that stale record into the prompt as authoritative context and
  // regenerated routines a scoped stop had removed. The freshly-derived record
  // (applyScopedCarryOver keeps it rather than carrying the previous one)
  // matches the new trigger; its tool/flow metadata is carried from the
  // current record because a trigger-only rebuild does not recompute those.
  const updateInput: UpdateInternalAgentInput =
    options?.scope === 'triggers'
      ? {
        triggerConfig: distilled.triggerConfig as UpdateInternalAgentInput['triggerConfig'],
        ...(distilled.decisionRecord
          ? {
            decisionRecord: {
              ...distilled.decisionRecord,
              ...(current.decisionRecord?.distilledOverrideTools
                ? { distilledOverrideTools: current.decisionRecord.distilledOverrideTools }
                : {}),
              ...(current.decisionRecord?.flowSubjects
                ? { flowSubjects: current.decisionRecord.flowSubjects }
                : {}),
            },
          }
          : {}),
      }
      : buildUpdatePayload(current, distilled);

  if (dryRun) {
    // §4.10: dry-run skips the destructive update; the diff lets the operator
    // sanity-check before the real sweep. distill-service caches a successful
    // result for ~5min so a quick subsequent real sweep avoids re-paying the
    // LLM bill.
    const integrationConfigChanges = diffIntegrationConfigs(
      current.integrations,
      updateInput.integrations ?? current.integrations,
    );
    // Run the same provenance merge the real sweep will run, so the operator
    // reviews what actually lands rather than the raw distiller output.
    const mergePreview = await mergeSkillsByProvenance(
      current.skills ?? [],
      distilled.skills ?? [],
      { incomingProvenance: 'distilled', tenantId: current.tenantId, agentId: current.id },
    );
    return {
      agentId: current.id,
      role: current.role,
      currentAgentType: current.agentType,
      newAgentType: distilled.agentType,
      currentTriggerSummary: summarizeTrigger(current.triggerConfig),
      newTriggerSummary: summarizeTrigger(distilled.triggerConfig),
      currentSkillCount: (current.skills ?? []).length,
      newSkillCount: (distilled.skills ?? []).length,
      skillMerge: {
        replaced: mergePreview.stats.replaced,
        preservedLearned: mergePreview.stats.preservedLearned,
        preservedOperator: mergePreview.stats.preservedOperator,
        deduped: mergePreview.stats.deduped,
        resultingTotal: mergePreview.skills.length,
      },
      integrationConfigDelta: integrationConfigChanges.length,
      integrationConfigChanges,
    };
  }

  // WS-5.1 — validate the merged integrations before persisting. Redistill
  // bypasses the router-layer validator at PUT /api/internal/agents/:id, so
  // we validate here so distill-output drift can never reintroduce a
  // literal-string-`"slack"` id.
  if (updateInput.integrations && updateInput.integrations.length > 0) {
    const { validateIntegrationsArray, IntegrationValidationError } = await import('./integration-validator');
    try {
      await validateIntegrationsArray(updateInput.integrations, { tenantId, agentId: internalAgentId });
    } catch (err) {
      if (err instanceof IntegrationValidationError) {
        throw new Error(`redistillAgent: ${err.message}`);
      }
      throw err;
    }
  }

  const updated = await internalAgentService.update(
    internalAgentId,
    tenantId,
    updateInput,
    actorId,
    'distill',
  );

  if (!updated) {
    // getById succeeded above; a null from update means the row was
    // soft-deleted between the read and the write. Surface as not-found.
    throw new RedistillNotFoundError(internalAgentId);
  }
  return updated;
}

export interface RedistillAllResult {
  totalAgents: number;
  succeeded: number;
  failed: number;
  dryRun: boolean;
  results: Array<{
    agentId: string;
    role: string;
    success: boolean;
    error?: string;
    diff?: RedistillDryRunDiff;
  }>;
}

export interface RedistillAllOptions {
  dryRun?: boolean;
}

/** Re-run distillation for every non-deleted agent in the tenant. Bounded
 *  concurrency keeps LLM spend predictable. */
export async function redistillAllAgents(
  tenantId: string,
  actorId: string | undefined,
  options: RedistillAllOptions = {},
): Promise<RedistillAllResult> {
  const agents = await internalAgentService.listAllByTenant(tenantId);
  if (agents.length > MAX_AGENTS_PER_BATCH) {
    throw new RedistillTooManyAgentsError(agents.length);
  }

  const result: RedistillAllResult = {
    totalAgents: agents.length,
    succeeded: 0,
    failed: 0,
    dryRun: !!options.dryRun,
    results: [],
  };

  // Concurrency-bounded fan-out. Promise.all + a worker pool pattern.
  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(BATCH_CONCURRENCY, agents.length); w++) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= agents.length) return;
        const agent = agents[idx];
        try {
          if (options.dryRun) {
            const diff = await redistillAgentDryRun(agent.id, tenantId);
            result.succeeded++;
            result.results.push({
              agentId: agent.id,
              role: agent.role,
              success: true,
              diff,
            });
          } else {
            await redistillAgent(agent.id, tenantId, actorId);
            result.succeeded++;
            result.results.push({ agentId: agent.id, role: agent.role, success: true });
          }
        } catch (err) {
          result.failed++;
          const error = (err as Error).message;
          result.results.push({ agentId: agent.id, role: agent.role, success: false, error });
          log.warn(
            { tenantId, agentId: agent.id, err: error },
            'redistillAllAgents: agent failed; continuing with batch',
          );
        }
      }
    })());
  }
  await Promise.all(workers);

  log.info(
    { tenantId, totalAgents: result.totalAgents, succeeded: result.succeeded, failed: result.failed, dryRun: !!options.dryRun },
    'redistillAllAgents: batch complete',
  );
  return result;
}
