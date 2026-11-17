// The request-boundary schemas for an agent, shared by the dashboard route
// (PUT /api/internal-agents/:id, PATCH /:id/status) and the workspace action
// applyTeamUpdate / setTeamStatus that every other surface calls. One
// definition, so a field the page can send is a field the assistants can
// send, and a field zod strips here is stripped for everyone.
//
// Moved verbatim out of internal-agents/router.ts; the router imports them
// back and re-exports the test-only handles it used to own.

import { z } from 'zod';
import { LLM_MODEL_TIERS, normalizeTier } from '../llm/types';
import { WORKSPACE_AI_SELECTIONS } from '../model-registry/workspace-ai-vendors';
import { integrationPermissionSchema } from '../internal-agents/permission-schemas';
import { WORKFLOW_STEP_DESCRIPTION_MAX } from '../internal-agents/workflow-step-limits';
import { teamAttachmentsArraySchema } from '../internal-agents/attachment-schema';

// Model config schemas — admin-only authoring. Two variants are exported so
// the request handler can pick by req.isPlatformAdmin:
//   - customerModelConfigSchema:  rejects any caller-supplied modelConfig
//     outright. Customer requests that include the field fail validation,
//     not silently drop it.
//   - adminModelConfigSchema:     accepts modelConfig and defaults tier to
//     'medium' both inside the object and at the top level (so admins who
//     omit it altogether still get an explicit tier on the row).
export const adminModelConfigSchema = z.object({
  modelId: z.string().max(100).optional(),
  tier: z.preprocess(normalizeTier, z.enum(LLM_MODEL_TIERS).default('medium')),
  maxTokens: z.number().int().min(1).max(200000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  provider: z.string().max(50).optional(), // D4 — serving-side createAdapter provider for tuned models
}).default({ tier: 'medium' });

export const customerModelConfigSchema = z.undefined().optional();

// Per-agent AI vendor override — the CUSTOMER-safe surface in front of the
// admin-only modelConfig above. modelConfig stays admin-only; this field is
// what a workspace owner is allowed to turn.
//
// Built straight off WORKSPACE_AI_SELECTIONS so the wire vocabulary has exactly
// one definition and cannot drift from the React WorkspaceAiVendor union.
//
// `.nullable()` is load-bearing: null is how the client CLEARS the override and
// returns the team to the workspace choice. `.optional()` alone accepts
// undefined but rejects null, which would make revert-to-inherit a silent
// validation failure.
//
// 'default' is deliberately IN the list. It means "pin this team to Liftoff
// Managed" — a distinct state from inherit. On a workspace pinned to Anthropic,
// someone choosing Liftoff Managed for one team sends exactly this value.
// Omitting it would 400 a legitimate selection, and because the field rides the
// same PUT as role/responsibilities/skills/attachments, the entire save with it.
export const aiVendorOverrideSchema = z.enum([...WORKSPACE_AI_SELECTIONS]).nullable().optional();

// Memory scope schema
export const memoryScopeSchema = z.object({
  readableLayers: z.array(z.enum(['global', 'role', 'individual'])).optional(),
  writableLayers: z.array(z.enum(['global', 'role', 'individual'])).optional(),
  scopeKeys: z.array(z.string().max(255)).max(20).optional(),
}).optional();

// Execution config schema
export const execConfigSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
}).optional();

// Workflow step schema (for Type C agents)
// Phase 3: extended WorkflowStep schema with new fields + byte budget (SE-003).
// The loop / retry sub-objects are produced by the distillation LLM, which
// occasionally uses a synonym for a field (observed: `as` for the loop variable
// this schema and the runtime call `itemVar`). Normalize the known synonym and
// let any other stray key be stripped (zod's default) instead of hard-failing
// the entire launch with `.strict()` on a single unrecognized key. This does not
// lose meaningful setup: the runtime exposes the current element to the step's
// template as `{{item}}` regardless of the variable's declared name, so
// `itemVar` is descriptive only — the loop still iterates and runs correctly.
export const workflowStepLoopSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = { ...(raw as Record<string, unknown>) };
      if (o.itemVar === undefined && typeof o.as === 'string') o.itemVar = o.as;
      delete o.as;
      return o;
    }
    return raw;
  },
  z.object({
    over: z.string().min(1).max(500),
    itemVar: z.string().max(100).optional(),
    maxIterations: z.number().int().min(1).max(1000).optional(),
    collect: z.boolean().optional(),
  }),
);

const workflowStepRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  backoffMs: z.number().int().min(0).max(30000).optional(),
});

/** Mirrors WorkflowDelayStep in @liftoffos/shared-types. */
const workflowStepDelaySchema = z.object({
  durationSeconds: z.number().int().min(60).max(2592000).optional(),
  untilIso: z.string().max(64).optional(),
  contextRef: z.string().max(255).optional(),
}).strict();

export const workflowStepSchema = z.object({
  stepId: z.string().min(1).max(100),
  // Shared with the generator and honoured verbatim by the runtime — see
  // workflow-step-limits.ts. This is the step's instruction, not a display
  // label; labels come from workflowVisualizationSteps.
  description: z.string().max(WORKFLOW_STEP_DESCRIPTION_MAX),
  toolName: z.string().max(255).optional(),
  toolInput: z.record(z.unknown()).optional(),
  toolInputTemplate: z.string().max(16384).optional(),  // 16KB cap per plan
  outputField: z.string().max(500).optional(),
  // What the step produces for the person, declared by the distiller. Must be
  // accepted here or zod strips it before persistence and the graph is written
  // without the contract it was validated against — the exact drift the schema
  // parity contract exists to catch.
  expectedOutput: z.string().max(1000).optional(),
  condition: z.string().max(500).optional(),
  onSuccess: z.string().max(100).optional(),
  onFailure: z.string().max(100).optional(),
  loop: workflowStepLoopSchema.optional(),
  retry: workflowStepRetrySchema.optional(),
  timeoutMs: z.number().int().min(1).max(600000).optional(),  // max 10 min
  requiresApproval: z.boolean().optional(),
  idempotencyKey: z.string().max(255).optional(),
  // The four fields this schema did not declare, and what their absence cost.
  //
  // zod strips undeclared keys by default. The distiller REQUIRES `type` on
  // every step variant and its own validator checks it, so steps arrive here
  // correct — and, undeclared, would leave stripped: the `created` audit row
  // would show no step with a `type` key, because the strip happens before
  // persistence ever sees them.
  //
  // Downstream, a step with no type and no toolName is a silent NO-OP: the
  // runtime walks the graph, executes nothing, and reports success. `question`
  // and `delay` are the required fields of `ask_user` and `delay` steps, so
  // their absence turned those into no-ops too.
  //
  // `.strict()` below is the part that matters more than these four names.
  type: z.enum(['tool_call', 'llm_reason', 'delay', 'ask_user', 'capability']).optional(),
  question: z.string().max(2000).optional(),
  delay: workflowStepDelaySchema.optional(),
  semanticValidation: z.boolean().optional(),
  // The vendor-agnostic capability need for a `capability` step. Declared here,
  // not only in the distiller's produce_agent schema, or zod strips it before
  // persistence and the step reaches the runtime with no need to resolve — the
  // exact silent-drop the schema-parity contract exists to catch.
  capabilityNeed: z.object({
    operation: z.string().max(200),
    entity: z.string().max(200),
    mode: z.enum(['public_data', 'own_account']),
    targetSystem: z.string().max(64).optional(),
    availableInputs: z.array(z.string().max(120)).max(20).optional(),
    requiredOutputFields: z.array(z.string().max(120)).max(20).optional(),
  }).optional(),
})
  // A field this schema does not know about is now an ERROR, not a silent
  // deletion. That is the actual defect: not the four missing names, but that
  // losing them looked exactly like success. Three separate places dropped a
  // field this way in one day — an event payload, a field-by-field mirror, and
  // this schema — and every one of them failed silently.
  .strict();

/** Exported for the schema-parity contract test only.
 *
 *  The test compares this schema's declared keys against the canonical
 *  WorkflowStep in @liftoffos/shared-types. It exists because this schema was
 *  written as a hand-maintained subset of that interface and drifted: four
 *  fields went undeclared, zod stripped them, and a production agent ended up
 *  with steps the runtime executes as no-ops. */
export const __workflowStepSchemaForTest = workflowStepSchema;
export const __workflowStepDelaySchemaForTest = workflowStepDelaySchema;

// Trigger config schema — the COMPLETE trigger contract, at the request
// boundary.
//
// A trigger is more than its primary schedule: the distiller emits companion
// crons, reactive subscriptions, a timezone and its reasoning on the same
// object (TRIGGER_CONFIG_SCHEMA in distill-service.ts), the runtime schedules
// off every one of those fields (agent-lifecycle/trigger-config-helpers.ts),
// and neither create surface lets a person edit the trigger, so the object the
// browser posts IS the distiller's. zod strips what a schema does not declare.
// While this declared only the primary, every companion the distiller designed
// for a wizard hire was dropped between the artifact and the row, silently: a
// weekly sweep shipped without its mid-week material-move check and nothing
// said so anywhere. The trigger-schema parity test holds this schema to the
// distiller's key set so it cannot fall behind again.
const companionCronSchema = z.object({
  label: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  cronExpr: z.string().max(100),
  timezone: z.string().max(64).optional(),
  contextFromLabel: z.string().max(32).optional(),
  objective: z.string().max(4000).optional(),
  script: z.array(z.string().max(500)).max(32).optional(),
  noAgent: z.boolean().optional(),
  workSource: z.object({
    toolName: z.string().max(255),
    toolArgs: z.record(z.unknown()).optional(),
    itemsPath: z.string().max(255),
    source: z.string().max(64),
    maxItems: z.number().int().min(1).max(1000).optional(),
  }).optional(),
});

const reactiveSubscriptionSchema = z.object({
  label: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  source: z.object({
    kind: z.enum(['connector_event', 'system_event', 'computed_metric']),
    connectorRef: z.string().max(255).optional(),
    entityType: z.string().max(255).optional(),
    topic: z.string().max(255).optional(),
    fn: z.string().max(255).optional(),
    args: z.record(z.unknown()).optional(),
    pollIntervalSeconds: z.number().int().min(60).max(86400).optional(),
    extractPath: z.string().max(255).optional(),
  }),
  filter: z.record(z.unknown()).optional(),
  window: z.record(z.unknown()).optional(),
  cooldownSeconds: z.number().int().min(0).optional(),
  objective: z.string().max(4000),
});

const triggerConfigObjectSchema = z.object({
  type: z.enum(['cron', 'event', 'manual']),
  cronExpr: z.string().max(100).optional(),
  eventTopic: z.string().max(255).optional(),
  eventTopics: z.array(z.string().max(255)).max(8).optional(),
  timezone: z.string().max(64).optional(),
  companionCrons: z.array(companionCronSchema).max(5).optional(),
  /** @deprecated singular form; the runtime normalises it to companionCrons. */
  companionCron: z.object({ cronExpr: z.string().max(100), timezone: z.string().max(64).optional() }).optional(),
  reactiveSubscriptions: z.array(reactiveSubscriptionSchema).max(10).optional(),
  reasoning: z.string().max(4000).optional(),
});

/** Exported for the trigger-schema parity contract test only. */
export const __triggerConfigSchemaForTest = triggerConfigObjectSchema;

export const triggerConfigSchema = triggerConfigObjectSchema.superRefine((data, ctx) => {
  if (data.type === 'cron' && !data.cronExpr) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cronExpr is required when trigger type is cron',
      path: ['cronExpr'],
    });
  }
  if (data.type === 'event' && !data.eventTopic) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'eventTopic is required when trigger type is event',
      path: ['eventTopic'],
    });
  }
}).optional();

// Skill schema, shared by the create and update payloads.
//
// `provenance` is accepted so the client can round-trip what it read (a
// distilled skill stays distilled across an unrelated edit) and so the skill
// steering verbs can hand ownership to the operator. It is deliberately NOT
// free-form: only 'operator' may be asserted by a client — claiming 'learned'
// would let a caller forge flywheel authorship, and 'distilled' arrives from
// the distiller's own output, which is server-side. `id` round-trips the
// runtime identity so metrics and usefulness scoring survive an edit.
export const skillObjectSchema = z.object({
  id: z.string().max(200).optional(),
  name: z.string().min(1).max(255),
  description: z.string().min(1).max(1000),
  instruction: z.string().min(1).max(10000),
  tags: z.array(z.string().max(100)).max(20).optional(),
  provenance: z.enum(['distilled', 'learned', 'operator']).optional(),
  protected: z.boolean().optional(),
  archived: z.boolean().optional(),
});

// Per-tool result-handling policy from distillation. `toolName` is an aliased
// catalog name, bounded like every other free-form identifier on this route;
// distillation already drops entries naming tools the catalog does not expose,
// and the runtime ignores a name it cannot resolve, so an unknown name here is
// inert rather than dangerous. Capped at 50 to match the skills array — a
// policy longer than the tool list it describes is malformed by construction.
export const resultRulesArraySchema = z.array(z.object({
  toolName: z.string().min(1).max(255),
  requiresComplete: z.boolean(),
})).max(50);

// Absorption classification — the distill response's routing decision,
// handed back on create/update so the apply step lands each artifact in its
// home without re-classifying. `libraryApprovals` carries the artifact names
// the user consented to add to the shared knowledge library; anything not
// named there is never written to it.
export const absorptionClassificationArraySchema = z.array(z.object({
  name: z.string().max(512),
  category: z.enum(['instructions', 'routine', 'skill', 'memory', 'reference']),
  skills: z.array(z.object({
    name: z.string().min(1).max(255),
    description: z.string().min(1).max(1000),
    instruction: z.string().min(1).max(10000),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })).max(50).optional(),
  memories: z.array(z.object({
    content: z.string().min(1).max(4000),
    scope: z.enum(['individual', 'workspace']),
  })).max(100).optional(),
  referenceTitle: z.string().max(512).optional(),
})).max(50);

export const updateInternalAgentSchema = z.object({
  role: z.string().min(1).max(255).optional(),
  responsibilities: z.string().max(10000).optional(),
  integrations: z.array(integrationPermissionSchema).max(50).optional(),
  additionalContext: z.string().max(10000).optional(),
  summary: z.string().max(10000).optional(),
  // Not accepted here either; see the create schema above.
  temperature: z.number().min(0).max(2).optional(),
  messagingNickname: z.string().max(35).optional(),
  // Runtime config fields
  agentType: z.enum(['agent', 'workflow']).optional(),
  modelConfig: adminModelConfigSchema,                     // customerModelConfigSchema gates non-admin requests before this fires
  pendingIntegrations: z.array(z.string()).optional(),
  memoryScope: memoryScopeSchema,
  execConfig: execConfigSchema,
  workflowSteps: z.array(workflowStepSchema).max(50).nullable().optional(),
  triggerConfig: triggerConfigSchema.nullable().optional(),
  skills: z.array(skillObjectSchema).max(50).optional(),
  capabilityTier: z.enum(['connector_only', 'execution_enabled']).optional(),
  resultRules: resultRulesArraySchema.optional(),
  autonomyOverride: z.enum(['autonomous', 'balanced', 'controlled']).nullable().optional(),
  aiVendorOverride: aiVendorOverrideSchema,
  attachments: teamAttachmentsArraySchema.optional(),
  absorption: absorptionClassificationArraySchema.optional(),
  libraryApprovals: z.array(z.string().max(512)).max(50).optional(),
  // Set when the caller distilled immediately before saving, so the version is
  // recorded as a distill rather than a hand edit. `update` defaults to
  // 'manual', which meant every save through this route claimed to be one and
  // the history could not answer whether the compiled prompt and skills had
  // been regenerated from the prose. Not persisted as a field.
  distilled: z.boolean().optional(),
  // Handle for the distillation this save carries, redeemed server-side. Unlike
  // `distilled` above, which is an unverifiable client assertion, presenting a
  // handle proves a distillation actually happened and produced these fields.
  distillId: z.string().uuid().optional(),
});

export const updateStatusSchema = z.object({
  status: z.enum(['draft', 'active', 'paused']),
});

// ── The workspace-action patch ─────────────────────────────────────────
//
// What an assistant may send to applyTeamUpdate: every field the dashboard's
// PUT accepts, plus three shapes only a conversation produces. `bindings`
// names connector types, collaborators and peer teams and REPLACES
// `integrations` for assistant callers (the PUT route still sends
// `integrations`; bindings.ts resolves these into it). `skillEdits` are the
// skill steering verbs, translated onto the stored skills so provenance moves
// to the operator where a person changed the text. `memoryDeletions` are
// runtime memory ids, deleted only after a successful save.

export const bindingRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('connector'),
    type: z.string().min(1).max(100),
    /** A specific connection of that type. Named when the team already holds
     *  one (so a re-binding keeps it) or when the person picked one of
     *  several; absent means the workspace's first active connection of the
     *  type. */
    connectorId: z.string().min(1).max(200).optional(),
    selectedObjects: z.array(z.string().max(500)).max(200).optional(),
  }),
  z.object({ kind: z.literal('collaborator'), id: z.string().uuid() }),
  z.object({ kind: z.literal('team'), id: z.string().uuid() }),
]);

export const skillEditSchema = z.object({
  id: z.string().min(1).max(200),
  instruction: z.string().min(1).max(10000).optional(),
  preserve: z.boolean().optional(),
  archive: z.boolean().optional(),
  restore: z.boolean().optional(),
});

export const teamUpdatePatchSchema = updateInternalAgentSchema.extend({
  bindings: z.array(bindingRequestSchema).max(50).optional(),
  skillEdits: z.array(skillEditSchema).max(50).optional(),
  memoryDeletions: z.array(z.string().min(1).max(200)).max(100).optional(),
});
