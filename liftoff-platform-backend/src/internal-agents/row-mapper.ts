// Shared row → InternalAgent mapper.
//
// Used by both InternalAgentService (private wrapper retained for back-compat)
// and the reconciler (which queries directly because it needs cross-tenant
// access via withAdminScope). Extracted from service.ts:878 to ensure the live
// publish path and the reconciler use the SAME mapping logic — preventing
// silent drift between the two.

import type {
  AgentType,
  CapabilityTier,
  DecisionRecord,
  ExecConfig,
  IntegrationPermission,
  InternalAgent,
  InternalAgentStatus,
  MemoryScope,
  ModelConfig,
  ResultRule,
  Skill,
  TeamAttachment,
  TriggerConfig,
  WorkflowStep,
  WorkflowVisualizationStep,
} from './types';
import { normalizeMemoryScope } from './memory-scope';
import { withNormalizedTier } from '../llm/types';
import type { AutonomyLevel } from '../internal-agent-oversight/types';
import type { WorkspaceAiSelection } from '../model-registry/workspace-ai-vendors';

function parseJsonb<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

/**
 * Read the `skills` column into the canonical `Skill[]`, dropping archived
 * entries.
 *
 * Exported because `internal_agents.skills` is the authoritative record of what
 * a team member can actually do (ADR-043), and two surfaces outside the mapper
 * need exactly that view: the A2A agent card and the capability embedding. Both
 * previously read a `capabilities` column that has never existed on this table,
 * so both were reading nothing at all. Sharing one reader means the next
 * consumer gets the archived filter for free rather than rediscovering it.
 */
export function readActiveSkills(raw: unknown): Skill[] {
  return parseJsonb<Skill[]>(raw, []).filter((s) => s && !s.archived);
}

function parseIntegrations(raw: unknown): IntegrationPermission[] {
  if (!Array.isArray(raw)) return [];
  return raw as IntegrationPermission[];
}

function parsePendingIntegrations(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function mapInternalAgentRow(row: Record<string, unknown>): InternalAgent {
  const modelConfig = withNormalizedTier(parseJsonb<ModelConfig>(row.model_config, {} as ModelConfig));
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    role: row.role as string,
    responsibilities: (row.responsibilities as string | null) ?? null,
    integrations: parseIntegrations(row.integrations),
    pendingIntegrations: parsePendingIntegrations(row.pending_integrations),
    additionalContext: (row.additional_context as string | null) ?? null,
    templateId: (row.template_id as string | null) ?? null,
    templateSourceHash: (row.template_source_hash as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    systemPrompt: (row.system_prompt as string | null) ?? null,
    userInstructions: (row.user_instructions as string | null) ?? null,
    instructionsMd: (row.instructions_md as string | null) ?? null,
    temperature: parseFloat(row.temperature as string) || 0.3,
    status: row.status as InternalAgentStatus,
    currentVersion: (row.current_version as number) || 1,
    tasksCompleted: (row.tasks_completed as number) ?? 0,
    tasks30d: 0,
    monthlyCost: 0,
    lastActive: row.last_active ? new Date(row.last_active as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    agentType: (row.agent_type as AgentType) || 'agent',
    modelConfig,
    // Normalised, not just parsed. The column can hold two spellings — the
    // create path wrote snake_case while this type, the API schema and both
    // runtimes are camelCase — and `parseJsonb` hands valid JSON straight back,
    // so the fallback it is given cannot fire and the wrong shape would travel
    // on as `MemoryScope`. See memory-scope.ts.
    memoryScope: normalizeMemoryScope(row.memory_scope),
    execConfig: parseJsonb<ExecConfig>(row.exec_config, {} as ExecConfig),
    workflowSteps: row.workflow_steps ? parseJsonb<WorkflowStep[]>(row.workflow_steps, []) : null,
    triggerConfig: row.trigger_config ? parseJsonb<TriggerConfig | null>(row.trigger_config, null) : null,
    workforcePlanId: (row.workforce_plan_id as string | null) ?? null,
    pinnedKnowledgeIds: Array.isArray(row.pinned_knowledge_ids)
      ? (row.pinned_knowledge_ids as string[])
      : [],
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at as string) : null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    workflowStepsHash: (row.workflow_steps_hash as string | null) ?? null,
    messagingNickname: (row.messaging_nickname as string | null) ?? null,
    lastActivity: null,
    lastActivityAction: null,
    workflowVisualizationSteps: row.workflow_visualization_steps
      ? parseJsonb<WorkflowVisualizationStep[]>(row.workflow_visualization_steps, [])
      : null,
    autonomyOverride: (row.autonomy_override as AutonomyLevel | null) ?? null,
    aiVendorOverride: (row.ai_vendor_override as WorkspaceAiSelection | null) ?? null,
    skills: parseJsonb<Skill[]>(row.skills, []),
    capabilityTier: ((row.capability_tier as CapabilityTier | null) ?? 'connector_only'),
    resultRules: parseJsonb<ResultRule[]>(row.result_rules, []),
    // Both default to empty rather than null: a reader forced to distinguish
    // "no overrides" from "never distilled" gets it wrong once and then treats
    // every legacy row as an instruction to erase.
    toolDescriptionOverrides: parseJsonb<Record<string, string>>(row.tool_description_overrides, {}),
    decisionRecord: parseJsonb<DecisionRecord>(row.decision_record, {}),
    groundsOn: parseJsonb<InternalAgent['groundsOn']>(row.grounds_on, []),
    capabilityStates: parseJsonb<InternalAgent['capabilityStates']>(row.capability_states, {}),
    attachments: parseJsonb<TeamAttachment[]>(row.attachments, []),
  };
}

// Carries the soft-delete column alongside the camelCase InternalAgent shape.
// The reconciler needs deleted_at to detect missed_delete drift, but
// InternalAgent (the public shape) does not expose it.
export interface InternalAgentRow extends InternalAgent {
  deletedAt: Date | null;
}

export function mapInternalAgentRowWithDeletedAt(row: Record<string, unknown>): InternalAgentRow {
  return {
    ...mapInternalAgentRow(row),
    deletedAt: row.deleted_at ? new Date(row.deleted_at as string) : null,
  };
}

/** The three fields that together are the compiled agent. Named once so the
 *  redactions below and any future caller cannot drift apart. */
const GENERATED_PROMPT_FIELDS = ['systemPrompt', 'userInstructions', 'instructionsMd'] as const;

/**
 * Strip the compiled prompt from an agent bound for a browser.
 *
 * `mapInternalAgentRow` keeps these because plenty of server-side callers need
 * them: version snapshots, the reconciler, the Pub/Sub payload the tenant
 * runtime executes from, and the service-auth `_svc` routes. What no client
 * needs them for is rendering — nothing in the app has ever displayed one — so
 * they are removed here, at the response boundary, rather than at the mapper.
 *
 * Returning them meant `GET /api/internal-agents` handed over every agent's
 * compiled prompt in a single call, and made `systemPrompt` something a client
 * could send back on a save. Distillations now travel by handle instead
 * (`distill_artifacts`), so nothing is lost by withholding them.
 *
 * Deliberately a redaction rather than an allowlist, unlike the agent-template
 * card projection: an agent carries dozens of fields the UI does need, and an
 * allowlist here would silently drop each new one.
 */
export function toClientAgent<T extends object>(agent: T): Omit<T, typeof GENERATED_PROMPT_FIELDS[number]> {
  const copy = { ...agent } as Record<string, unknown>;
  for (const field of GENERATED_PROMPT_FIELDS) delete copy[field];
  return copy as Omit<T, typeof GENERATED_PROMPT_FIELDS[number]>;
}

/** Same redaction for a list. */
export function toClientAgents<T extends object>(agents: T[]): Omit<T, typeof GENERATED_PROMPT_FIELDS[number]>[] {
  return agents.map(toClientAgent);
}

/**
 * Same three fields, same reasoning, for a version snapshot.
 *
 * This one mattered more than the single-agent read: `GET /:id/versions`
 * returns every version at once, so it handed a browser the agent's entire
 * prompt-evolution history in one response, while the only version UI
 * (RollbackModal) reads nothing but `version` and `createdAt`.
 *
 * A response-boundary redaction rather than a change to `mapVersion`, because
 * `rollbackToVersion` reads a snapshot through the same mapper and has to
 * restore the prompts it finds there.
 */
export const toClientVersion = toClientAgent;
