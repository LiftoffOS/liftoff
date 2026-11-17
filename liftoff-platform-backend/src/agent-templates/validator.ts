// Agent Templates — Zod validation schemas
// Validates YAML catalog entries and API request bodies.

import { z } from 'zod';
import { RESPONSIBILITIES_SECTIONS, ADDITIONAL_CONTEXT_SECTIONS, SECTION_DESTINATION } from '@liftoffos/workforce-types';
import type { AgentTemplate } from './schema';
import { CONNECTOR_CAPABILITIES } from './connector-capabilities';

// ── Sub-schemas ────────────────────────────────────────────────────────────

/** A thing in the customer's workspace the requirement needs named — which
 *  channel, which folder. `label` is read by a person mid-hire, so it is held
 *  to the same length discipline as the other customer-facing strings here. */
/** An input's id is substituted into template prose as `{{id}}`, so it is
 *  restricted to what can appear in a placeholder without ambiguity. */
const templateInputZodSchema = z.object({
  id: z.string().min(1).max(60).regex(
    /^[a-z][a-z0-9_]*$/,
    'input id must be lower snake case, since it appears in prose as {{id}}',
  ),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'url']),
  required: z.boolean(),
  placeholder: z.string().max(120).optional(),
  hint: z.string().max(300).optional(),
  // See TemplateInput.fallback.
  fallback: z.string().min(1).max(120).optional(),
});

const requirementObjectZodSchema = z.object({
  // Lower kebab, because it is written into template prose as
  // `{{pick:<id>}}` and read back out by that pattern. A space or a brace in
  // an id would produce a placeholder nothing substitutes, which then reaches
  // both the system prompt and the person reading the template.
  id: z.string().min(1).max(100).regex(
    /^[a-z][a-z0-9-]*$/,
    'object id must be lower kebab case, since it appears in prose as {{pick:id}}',
  ),
  /** `destination` is where a team's work goes, and it accepts EITHER a file or
   *  a folder, because those are the two ways a person answers one question.
   *
   *  It replaces the folder/file pair a documents requirement used to declare.
   *  A tree routes a row by what it IS, so a pair meant the ANSWER chose the
   *  question: someone naming a document as their save location was recorded
   *  against the read pick instead, hired a team with nowhere to work, and its
   *  next run scattered its output. One question cannot be answered wrongly. */
  kind: z.enum(['destination', 'folder', 'file', 'channel', 'table']),
  direction: z.enum(['read', 'write']),
  label: z.string().min(1).max(200),
  required: z.boolean(),
  /** See RequirementObject.fallback: what the sentence reads as before anyone
   *  has picked, and when an optional pick goes unanswered. */
  fallback: z.string().min(1).max(120).optional(),
  /** This destination has a platform floor, so naming it bare is safe even
   *  when its connector is not bound. See platform-destinations.ts. */
  whenUnbound: z.literal('platform_chat').optional(),
});

const connectorRequirementZodSchema = z.object({
  id: z.string().min(1).max(100),
  connectorType: z.string().min(1).max(100).optional(),
  capability: z.string().min(1).max(100).optional(),
  capabilities: z.array(z.string().min(1).max(100)).optional(),
  role: z.enum(['data_source', 'tool']),
  requiredScopes: z.array(z.string().min(1).max(200)).default([]),
  description: z.string().min(1).max(1000),
  objects: z.array(requirementObjectZodSchema).optional(),
  // The two ways a clause reads, chosen at hire by whether this connector was
  // bound. Clauses, not sentences, so they sit inside a numbered step.
  prose: z.object({
    whenBound: z.string().min(1).max(600),
    whenUnbound: z.string().min(1).max(600),
  }).optional(),
}).superRefine((data, ctx) => {
  // A data_source may name what to READ, and only that.
  //
  // This rule used to forbid objects on a data_source outright, on the
  // assumption that a pick always named an output destination. That assumption
  // was wrong and it was load-bearing: it is why every object in the catalog
  // was a write folder, and why templates that need a specific input — a clause
  // library, a policy handbook, a positioning document — carried paragraphs
  // teaching the team to go find it instead of being handed it.
  //
  // A write pick on a data_source is still an authoring mistake: nothing is
  // written back through a read-only binding, so the picker would collect an
  // answer that gets silently dropped.
  for (const obj of data.objects ?? []) {
    if (data.role === 'data_source' && obj.direction === 'write') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ConnectorRequirement "${data.id}": object "${obj.id}" is a write destination on a data_source requirement, which is read-only`,
      });
    }
  }
  const ids = (data.objects ?? []).map((o) => o.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ConnectorRequirement "${data.id}": object ids must be unique within a requirement`,
    });
  }
  // What one modal can answer, because a requirement gets exactly one.
  //
  // The picker resolves its kind from the FIRST object: a tree browses folders
  // and files together and routes each row to the pick its own kind answers, so
  // it can answer one of each; a flat list answers the single pick it was
  // opened for. Anything else declared on the same requirement is never
  // rendered, and nothing anywhere reports that — the template reads as though
  // the person was asked, and they never were.
  const kinds = (data.objects ?? []).map((o) => o.kind);
  const tree = kinds.filter((k) => k === 'folder' || k === 'file' || k === 'destination');
  const flat = kinds.filter((k) => k === 'channel' || k === 'table');
  const twice = (['folder', 'file'] as const).filter(
    (k) => kinds.filter((x) => x === k).length > 1,
  );
  if (tree.length && flat.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ConnectorRequirement "${data.id}": mixes ${flat[0]} with ${tree[0]}. One requirement opens one picker, and it cannot be both a tree and a list — split them across requirements`,
    });
  }
  if (flat.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ConnectorRequirement "${data.id}": declares ${flat.length} ${flat[0]} picks. A flat picker answers one; the second would never be shown`,
    });
  }
  // A destination is THE place this team's work goes. Two of them is two
  // answers to one question, and a destination beside the folder/file pair it
  // replaces means a row could still land on either.
  const destinations = (data.objects ?? []).filter((o) => o.kind === 'destination');
  if (destinations.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ConnectorRequirement "${data.id}": declares ${destinations.length} destinations. A team's work goes in one place`,
    });
  }
  if (destinations.length && kinds.some((k) => k === 'folder' || k === 'file')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ConnectorRequirement "${data.id}": mixes a destination with a folder/file pick. The destination replaces that pair — a row would have two picks it could answer`,
    });
  }
  // Optional was how a hire completed with nowhere to save. Nothing asked
  // again, nothing warned, and the team wrote wherever it liked.
  for (const d of destinations) {
    if (!d.required) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ConnectorRequirement "${data.id}": destination "${d.id}" is optional. A team that writes has to be told where, or it writes anywhere`,
      });
    }
  }

  for (const k of twice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `ConnectorRequirement "${data.id}": declares two ${k} picks. The tree routes a row by its kind, so the second has nothing that can answer it`,
    });
  }
  // How the requirement names what satisfies it: one vendor, one capability
  // group, or several groups any one of which will do. Exactly one of the
  // three, because each is read by a different branch of the picker and two of
  // them set at once means one is silently ignored.
  const named = [
    Boolean(data.connectorType),
    Boolean(data.capability),
    Boolean(data.capabilities?.length),
  ].filter(Boolean).length;
  if (named !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ConnectorRequirement must specify exactly one of: connectorType, capability or capabilities (not more than one, not none)',
    });
    return;
  }
  if (data.capability && !CONNECTOR_CAPABILITIES[data.capability]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown capability "${data.capability}". Valid: ${Object.keys(CONNECTOR_CAPABILITIES).join(', ')}`,
      path: ['capability'],
    });
  }
  if (data.capabilities?.length) {
    // A one-entry list is `capability` written the long way, and the two spell
    // the same requirement differently for every reader downstream.
    if (data.capabilities.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ConnectorRequirement "${data.id}": a single-capability list is a "capability", not a "capabilities"`,
        path: ['capabilities'],
      });
    }
    if (new Set(data.capabilities).size !== data.capabilities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ConnectorRequirement "${data.id}": capabilities must be unique`,
        path: ['capabilities'],
      });
    }
    for (const cap of data.capabilities) {
      if (!CONNECTOR_CAPABILITIES[cap]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown capability "${cap}". Valid: ${Object.keys(CONNECTOR_CAPABILITIES).join(', ')}`,
          path: ['capabilities'],
        });
      }
    }
  }
});

const companionCronZodSchema = z.object({
  label: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'lowercase alphanumeric + hyphens, 1-32 chars'),
  cronExpr: z.string().max(100),
  timezone: z.string().max(64).optional(),
  objective: z.string().max(2000).optional(),
});

// Phase C — reactive subscription validation
const MAX_PREDICATE_DEPTH = 10;
const MAX_PREDICATE_OPERANDS = 50;

function predicateDepth(expr: any): number {
  if (!expr || typeof expr !== 'object') return 0;
  if (expr.operands) return 1 + Math.max(0, ...expr.operands.map(predicateDepth));
  if (expr.operand) return 1 + predicateDepth(expr.operand);
  return 1;
}
function predicateOpCount(expr: any): number {
  if (!expr || typeof expr !== 'object') return 0;
  if (expr.operands) return 1 + expr.operands.reduce((s: number, o: any) => s + predicateOpCount(o), 0);
  if (expr.operand) return 1 + predicateOpCount(expr.operand);
  return 1;
}

const predicateExprZodSchema: z.ZodType<any> = z.lazy(() => z.union([
  z.object({ op: z.enum(['and', 'or']), operands: z.array(predicateExprZodSchema).min(1).max(10) }),
  z.object({ op: z.literal('not'), operand: predicateExprZodSchema }),
  z.object({ op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']), path: z.string().max(200), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ op: z.enum(['in', 'nin']), path: z.string().max(200), values: z.array(z.union([z.string(), z.number()])).max(50) }),
  z.object({ op: z.enum(['exists', 'not_exists']), path: z.string().max(200) }),
  z.object({ op: z.literal('changed_to'), path: z.string().max(200), value: z.union([z.string(), z.number()]) }),
  z.object({ op: z.literal('matches'), path: z.string().max(200), pattern: z.string().max(512) }),
])).superRefine((data, ctx) => {
  if (predicateDepth(data) > MAX_PREDICATE_DEPTH) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `predicate depth > ${MAX_PREDICATE_DEPTH}`, path: [] });
  }
  if (predicateOpCount(data) > MAX_PREDICATE_OPERANDS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `predicate has > ${MAX_PREDICATE_OPERANDS} operands`, path: [] });
  }
});

const windowSpecZodSchema = z.object({
  aggregate: z.enum(['count', 'sum', 'avg', 'rate', 'min', 'max']),
  field: z.string().max(200).optional(),
  durationSeconds: z.number().int().min(60).max(86400),
  threshold: z.object({ comparator: z.enum(['gt', 'gte', 'lt', 'lte']), value: z.number() }),
}).superRefine((data, ctx) => {
  if (data.aggregate !== 'count' && !data.field) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field is required for aggregate=${data.aggregate}`, path: ['field'] });
  }
});

const reactiveSubscriptionZodSchema = z.object({
  label: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('connector_event'), connectorRef: z.string(), entityType: z.string().optional() }),
    z.object({ kind: z.literal('system_event'), topic: z.string() }),
    z.object({
      kind: z.literal('computed_metric'),
      connectorRef: z.string(),
      fn: z.string(),
      args: z.record(z.unknown()).optional(),
      pollIntervalSeconds: z.number().int().min(60).max(86400),
      extractPath: z.string().optional(),
    }),
  ]),
  filter: predicateExprZodSchema.optional(),
  window: windowSpecZodSchema.optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  objective: z.string().min(1).max(4000),
});

const triggerConfigZodSchema = z.object({
  type: z.enum(['cron', 'event', 'manual']),
  cronExpr: z.string().max(100).optional(),
  eventTopic: z.string().max(255).optional(),
  /** Every topic the role handles. The per-binding filter is built from this,
   *  so a topic left out is an event the agent never sees — and a template that
   *  reads from either cloud storage or a documents tool handles two. */
  eventTopics: z.array(z.string().max(255)).max(10).optional(),
  timezone: z.string().max(100).optional(),
  // Deprecated singular (back-compat with predecessor plan output). Loader normalizes to companionCrons.
  companionCron: z.object({ cronExpr: z.string().max(100), timezone: z.string().optional() }).optional(),
  companionCrons: z.array(companionCronZodSchema).max(5).optional(),
  reactiveSubscriptions: z.array(reactiveSubscriptionZodSchema).max(10).optional(),
}).superRefine((data, ctx) => {
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
  // The primary must be one of the declared set, or the filter is built from a
  // list that does not include the topic the trigger names.
  if (data.eventTopic && data.eventTopics && !data.eventTopics.includes(data.eventTopic)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `eventTopic "${data.eventTopic}" is not in eventTopics, so the per-binding filter would exclude the trigger's own topic`,
      path: ['eventTopics'],
    });
  }
  if (data.companionCron && data.companionCrons?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Set companionCrons (array) — singular companionCron is deprecated',
      path: ['companionCron'],
    });
  }
  if (data.companionCrons) {
    const labels = data.companionCrons.map(c => c.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'companion labels must be unique within an agent',
        path: ['companionCrons'],
      });
    }
  }
  if (data.reactiveSubscriptions) {
    const labels = data.reactiveSubscriptions.map(s => s.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reactive subscription labels must be unique within an agent',
        path: ['reactiveSubscriptions'],
      });
    }
  }
});

const memoryScopeZodSchema = z.object({
  readableLayers: z.array(z.string()).optional(),
  writableLayers: z.array(z.string()).optional(),
});

const extractionColumnFormatZodSchema = z.enum([
  'text', 'bulleted_list', 'date', 'yes_no', 'monetary_amount',
  'percentage', 'currency', 'tag', 'number',
]);

/** Revision identifiers that YAML turned into numbers.
 *
 *  A sha is hexadecimal, so roughly one in three has the shape `<digits>e<digits>`
 *  and nothing else — which YAML reads as scientific notation. `head: 2358e17`
 *  loads as 235800000000000000000 and the original characters are unrecoverable,
 *  while `head: 03d4fc5` survives untouched because it contains letters. So the
 *  fault appears in some fixtures and not others, looks like a bug anywhere but
 *  here, and is silent: the ledger then records WHICH pull request was acted on
 *  and not at which commit, so an idempotency check can only answer "you did
 *  something here, I cannot tell at which revision".
 *
 *  Caught at load rather than left to a reviewer's eye, because reading a sha
 *  and noticing it happens to be legal scientific notation is not a thing a
 *  person reliably does. */
const REVISION_KEYS = /^(head|sha|commit|head_sha|headSha|commit_id|commitId)$/i;

function numericShaPaths(value: unknown, path = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${k}` : k;
    if (REVISION_KEYS.test(k) && typeof v === 'number') out.push(here);
    else out.push(...numericShaPaths(v, here));
  }
  return out;
}

const extractionColumnZodSchema = z.object({
  index: z.number().int().min(0),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(5000),
  format: extractionColumnFormatZodSchema.optional(),
  tags: z.array(z.string().min(1).max(100)).optional(),
});

// ── Responsibilities section validation helpers ────────────────────────────
//
// The section sets live in @liftoffos/workforce-types so the validator, the
// catalog and the surfaces that compose these fields all read one definition.
// Re-exported below for existing importers.

// ── Main template schema (used for YAML catalog validation) ────────────────

export const agentTemplateZodSchema = z.object({
  id: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  version: z.string()
    .regex(/^\d+\.\d+\.\d+$/, 'version must be semver format e.g. "1.0.0"')
    .optional()
    .default('1.0.0'),
  displayName: z.string().min(1).max(200),
  departmentCategory: z.enum([
    'customer_support', 'sales', 'marketing', 'finance',
    'hr', 'legal', 'operations', 'engineering', 'other',
  ]),
  description: z.string().min(1).max(2000),
  roleSummary: z.string().min(1).max(500),
  // role: short job title, not a sentence
  role: z.string().min(1).max(500),
  // responsibilities: multi-section markdown block
  responsibilities: z.string().min(1).max(50000),
  // additionalContext: multi-section markdown block
  additionalContext: z.string().min(1).max(50000),
  requiredConnectors: z.array(connectorRequirementZodSchema),
  optionalConnectors: z.array(connectorRequirementZodSchema).default([]),
  // Facts the template needs and the platform must not guess. See
  // AgentTemplate.inputs.
  inputs: z.array(templateInputZodSchema).optional(),
  defaultAgentType: z.enum(['agent', 'workflow']),
  defaultMemoryScope: memoryScopeZodSchema,
  defaultTriggerConfig: triggerConfigZodSchema,
  schemaVersion: z.number().int().min(1),
  practiceName: z.string().min(1).max(200).optional(),
  extractionSchema: z.array(extractionColumnZodSchema).optional(),
  // Singular, because it names ONE row: "condition precedent", not
  // "conditions precedent". It is read straight into "Find every <this> in the
  // document", so a plural here produces a prompt that reads wrong.
  extractionRowDefinition: z.string().min(1).max(200).optional(),
  // See AgentTemplate.requiresIdempotencyCheck.
  requiresIdempotencyCheck: z.boolean().optional(),
  // See AgentTemplate.comparesWithLastRun.
  comparesWithLastRun: z.boolean().optional(),
  // See AgentTemplate.producesDocument.
  producesDocument: z.boolean().optional(),

  // ── The distillation input contract ──────────────────────────────────
  // Every field optional: a thin two-field template stays valid, and the
  // ratchets below bind added and edited templates only.
  sections: z.record(z.string(), z.string()).optional(),
  flows: z.array(z.object({
    id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, 'flow id must be kebab-case'),
    name: z.string().min(1).max(200),
    useWhen: z.string().min(1).max(2000),
    notNeededFor: z.string().min(1).max(2000),
    body: z.string().min(1).max(20000),
    companionCron: z.string().min(1).max(200).optional(),
  })).optional(),
  toolNotes: z.record(z.string(), z.string().min(1).max(10000)).optional(),
  capabilities: z.record(z.string(), z.enum(['live', 'unwired', 'absent'])).optional(),
  domainAliases: z.record(z.string(), z.string().min(1).max(1000)).optional(),
  evals: z.array(z.object({
    id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, 'eval id must be kebab-case'),
    state: z.record(z.string(), z.unknown()).optional(),
    /** Run this case as an EVENT rather than a chat turn.
     *
     *  A role that wakes on a trigger behaves differently when asked in chat:
     *  a code reviewer asked reads the pull request and reports back, while
     *  the same agent woken by pr.opened reads it and publishes a review. A
     *  case about the second cannot be run as the first. */
    trigger: z.object({
      source: z.string().min(1).max(100),
      entityType: z.string().min(1).max(100),
      /** The event body, as the connector would have delivered it. A
       *  trigger-bound step addresses this by name, so a trigger without one
       *  produces a run that executes, calls nothing, and reports success. */
      payload: z.record(z.string(), z.unknown()).optional(),
    })
      .refine(
        (t) => numericShaPaths(t.payload).length === 0,
        (t) => ({
          message:
            'a revision identifier loaded as a NUMBER, which means an unquoted sha in the YAML: '
            + `${numericShaPaths(t.payload).join(', ')}. `
            + '`head: 2358e17` is valid scientific notation and becomes 235800000000000000000 — '
            + 'the sha is not mistyped, it is gone, and nothing downstream can recover it. Quote it.',
        }),
      )
      .optional(),
    turns: z.array(z.string().min(1)).min(1),
    expected: z.object({
      calls_tool: z.array(z.string().min(1)).optional(),
      /** Satisfied by any ONE of these, for a behaviour with several honest routes. */
      calls_any_of: z.array(z.string().min(1)).min(2).optional(),
      never_calls: z.array(z.string().min(1)).optional(),
      /** Not called on the FINAL delivery. For a case that delivers an event
       *  more than once and expects the agent to act only the first time:
       *  `never_calls` forbids the action outright, including the one the case
       *  is asking for. Trigger cases only — a chat case has one delivery, and
       *  there this says exactly what `never_calls` already says. */
      last_delivery_never_calls: z.array(z.string().min(1)).optional(),
      first_tool: z.string().min(1).optional(),
      reply_includes: z.array(z.string().min(1)).optional(),
      reply_omits: z.array(z.string().min(1)).optional(),
      /** Read the ARGUMENTS the agent passed to its tools — what it wrote,
       *  rather than what it said about it afterwards. */
      writes_include: z.array(z.string().min(1)).optional(),
      /** Satisfied by any ONE of these phrasings, for a message the role is
       *  told to convey rather than a string it is told to write. */
      writes_include_any: z.array(z.string().min(1)).min(2).optional(),
      writes_omit: z.array(z.string().min(1)).optional(),
      no_skill_load: z.boolean().optional(),
      rubric: z.string().min(1).max(4000).optional(),
    }).refine(
      (e) => Object.values(e).some((v) => v !== undefined),
      { message: 'expected must assert at least one thing, or the case passes for any behaviour' },
    ),
    counterpartOf: z.string().min(1).max(120).optional(),
  })).optional(),
  // See AgentTemplate.writesRequireProvenance.
  writesRequireProvenance: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // ── One destination per TEMPLATE, not per requirement ───────────────────
  //
  // The per-requirement rule above already refuses two destinations on one
  // picker. This is the same property one level up, and it is the level that
  // matters to everything downstream: `namedDestination` (destination-rule.ts)
  // reads the picks as ONE set, keyed by object id, so two destinations on two
  // requirements are two answers to "where does this team's work go" and whoever
  // sorts first wins. The rule that reads them then tells the stored prose, the
  // distillation prompt and the graph fence about one of the two, arbitrarily.
  //
  // Declared here rather than left to the reader to be careful about, because the
  // reader cannot be: a template author adding a second documents connector has
  // no reason to suspect the first one's destination is what the team is told
  // about.
  {
    const destinations = [...(data.requiredConnectors ?? []), ...(data.optionalConnectors ?? [])]
      .flatMap((req) => (req.objects ?? [])
        .filter((o) => o.kind === 'destination')
        .map((o) => `${req.id}/${o.id}`));
    if (destinations.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Declares ${destinations.length} destinations across its requirements (${destinations.join(', ')}). A team's work goes in ONE place, and everything that reads the pick reads one: a second destination is answered and then silently ignored`,
      });
    }
  }

  // ── Connector prose variants ────────────────────────────────────────────
  //
  // `{{connector:<id>}}` resolves at hire to whichever clause matches what was
  // actually bound, so a hired team reads one instruction rather than an
  // instruction plus an explanation of the tool it does not have.
  const proseAll = `${data.responsibilities}\n${data.additionalContext}`;
  const referenced = new Set(
    [...proseAll.matchAll(/\{\{\s*connector:([a-z][a-z0-9-]*)\s*\}\}/g)].map((m) => m[1]),
  );
  const optionalById = new Map((data.optionalConnectors ?? []).map((r) => [r.id, r] as const));

  for (const reqId of referenced) {
    const req = optionalById.get(reqId);
    if (!req) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Prose references {{connector:${reqId}}}, which is not a declared OPTIONAL connector. A required connector is always bound, so it has no second version to choose between`,
      });
      continue;
    }
    if (!req.prose) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Prose references {{connector:${reqId}}} but "${reqId}" declares no prose variants. Unresolved, the reference disappears and the sentence loses its verb`,
      });
    }
  }

  for (const req of data.optionalConnectors ?? []) {
    // A destination on an OPTIONAL connector must go through variants, always.
    //
    // Left as a bare {{pick:...}} it resolves to the object's fallback phrase
    // whether or not the connector was bound, so a team with no team chat is
    // told to post to "your deal channel". That is the defect this mechanism
    // exists to remove, and it stayed legal for as long as the catalog was
    // mid-conversion. It is not mid-conversion any more.
    const namedBare = (req.objects ?? []).filter(
      (o) => proseAll.includes(`{{pick:${o.id}}}`) && o.whenUnbound === undefined,
    );
    // A destination with a platform floor may be named bare: unbound, it
    // resolves to a surface that exists rather than to a phrase naming
    // nothing, so the sentence stays true and needs no second version.
    if (!req.prose && namedBare.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Optional connector "${req.id}" owns a destination named directly in the prose. Declare prose.whenBound / prose.whenUnbound and reference it as {{connector:${req.id}}}, declare whenUnbound on the object if the platform can supply it, or the destination reaches a team that has no ${req.id}`,
      });
    }
    if (!req.prose) continue;
    if (!referenced.has(req.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Optional connector "${req.id}" declares prose variants that nothing references. Write {{connector:${req.id}}} where the clause belongs, or drop the variants`,
      });
    }
    // The unbound clause must not name a destination on the connector it is
    // standing in for: that pick would resolve to a phrase describing a channel
    // the team was never given.
    for (const m of req.prose.whenUnbound.matchAll(/\{\{\s*pick:([a-z][a-z0-9-]*)\s*\}\}/g)) {
      if ((req.objects ?? []).some((o) => o.id === m[1])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${req.id}".prose.whenUnbound names {{pick:${m[1]}}}, a destination on the connector that is NOT bound. The unbound clause must read as though that tool was never part of the job`,
        });
      }
    }
    // And a destination on such a connector may appear ONLY inside its own
    // whenBound clause. Left in the body prose it survives into a hired team
    // that has no such connector, which is the hole this mechanism closes.
    for (const obj of req.objects ?? []) {
      if (proseAll.includes(`{{pick:${obj.id}}}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `{{pick:${obj.id}}} appears in the template prose, but "${obj.id}" belongs to optional connector "${req.id}", which uses prose variants. Move it inside that connector's whenBound clause`,
        });
      }
    }
  }

  // A template whose deliverable is a file must declare it, or nothing holds the
  // graph to producing one.
  if (/produce (a|the) (document|memo|checklist|grid|report|deck)|create the document|as a (document|Word document)|deliver it as|save the draft to/i
      .test(`${data.responsibilities}\n${data.additionalContext}`)
      && !data.producesDocument) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The responsibilities promise a produced document, but producesDocument is not set. Declare it, or a graph that analyses and reports without ever making the artifact passes unnoticed',
    });
  }

  // A produced document needs a REQUIRED place to go.
  //
  // The distiller reads `producesDocument` as "the graph MUST write the file
  // to the bound documents or cloud-storage connector", and its fence stands
  // down when no such connector is bound. So an optional destination makes the
  // obligation hold for exactly the hires that connected one and lapse for the
  // rest: the same template promises a document to everyone and produces one
  // for some. It also empties the gallery card, which shows the required
  // connectors and nothing else, so a document-writing team reads as needing
  // no tools. Five marketing templates shipped that way. Every other
  // document-producing template in the catalog requires its documents
  // connector, and this holds the rest to it.
  if (data.producesDocument) {
    const DOCUMENT_STORES = new Set(['documents', 'cloud_storage']);
    const hasStore = data.requiredConnectors.some((req) =>
      (req.capability !== undefined && DOCUMENT_STORES.has(req.capability))
      || (req.capabilities ?? []).some((c) => DOCUMENT_STORES.has(c)));
    if (!hasStore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredConnectors'],
        message: 'producesDocument is set but no required connector offers documents or cloud_storage. The deliverable is a file, so the place it is written must be bound on every hire: move the documents connector to requiredConnectors, or drop producesDocument if the file is not the deliverable',
      });
    }
  }

  // A template that reports a change against a previous run must declare it, or
  // the write half of the comparison is prose the graph can skip. Matched on the
  // phrases case (b3) itself names.
  // "the TIME since the last run" is elapsed duration, not a comparison against
  // a recorded figure. social-intent-lead-finder reports it and keeps no series,
  // and a fence that failed it would be failing correct work.
  // Hyphenated and spaced forms both, because the catalog writes both and this
  // rule once read only the spaced one: competitive-intelligence-analyst says
  // "week-over-week" and went undeclared for as long as the fence existed.
  // A phrase list is a net with holes by construction, which is why the
  // idempotency half no longer relies on one (see
  // __tests__/idempotency-declaration-ratchet.test.ts). This stays a net.
  if (/(week|day|month|quarter)[\s-]over[\s-]\1|(?<!the time )since (the |your )?last (run|sweep)|prior[\s-](week|run|period|quarter|day)|read (last|yesterday|the previous|the prior)[\s']|against (last|the previous|the prior) (week|run|month|quarter|day)|previous (run|week|report|period)/i
      .test(`${data.responsibilities}\n${data.additionalContext}`)
      && !data.comparesWithLastRun) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The responsibilities compare this run against a previous one, but comparesWithLastRun is not set. Declare it, or nothing holds the graph to writing the record the next run reads',
    });
  }

  // A template that TELLS the agent to check whether it already acted must also
  // DECLARE it, or the check is prose the graph is free to skip.
  //
  // Matched on the imperative form only — "confirm you have not already", "do
  // not produce a second" — never on the scope rule the legal analysts carry
  // ("do not go looking for other documents"), which is a different promise. A
  // template that phrases the check some other way simply is not caught, which
  // fails open exactly as today does rather than failing a correct template.
  if (/(confirm|check) (that )?you have not already|do not (produce|create|send|post) a second/i
      .test(`${data.responsibilities}\n${data.additionalContext}`)
      && !data.requiresIdempotencyCheck) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'The responsibilities tell this role to confirm it has not already acted, but requiresIdempotencyCheck is not set. Declare it, or the obligation stays prose and the graph is free to omit the step that performs it',
    });
  }

  // A row definition without columns says how to count rows in a table that
  // has none. It would compile to nothing and read as though the shape were
  // enforced, which is the failure this whole family exists to prevent.
  if (data.extractionRowDefinition && !data.extractionSchema?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'extractionRowDefinition needs an extractionSchema: it says what one ROW is, and without columns there is no table',
    });
  }

  // A pick is written into the prose as `{{pick:<object-id>}}` and replaced at
  // hire time with what the person named. Three ways that goes wrong silently,
  // all checked here because every one of them ends with a placeholder or a
  // hole reaching a system prompt and a customer's screen.
  const objects = [...data.requiredConnectors, ...(data.optionalConnectors ?? [])]
    .flatMap((r) => r.objects ?? []);

  // An optional connector never holds the hire, and its picks do not either.
  //
  // The connectors step reads `required` and disables Continue until every one
  // is answered. A tenant that connected Slack once, for something else, then
  // met a template mentioning a channel, could not proceed until it named one:
  // an optional tool turned mandatory by the mere existence of a connection.
  // The pick is still asked for; unanswered, the prose falls back to the
  // object's own phrase.
  for (const req of data.optionalConnectors ?? []) {
    for (const obj of req.objects ?? []) {
      if (obj.required) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Object "${obj.id}" is required on optional connector "${req.id}". An optional connector cannot make anything required — set required: false`,
        });
      }
    }
  }

  // 1. Ids are unique per requirement above; the placeholder namespace is the
  //    whole template, so two requirements each declaring `alert-channel`
  //    would resolve one placeholder to whichever came first.
  const seen = new Set<string>();
  for (const o of objects) {
    if (seen.has(o.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Object id "${o.id}" is declared on more than one requirement. Prose refers to a pick by id alone, so ids must be unique across the template`,
      });
    }
    seen.add(o.id);
  }

  // 0. Only two fields are ever substituted. A placeholder anywhere else is
  //    shown to a person exactly as written, and description + roleSummary are
  //    the gallery card. Neither passes through applyTemplatePicks.
  //
  //    `escalationPatterns` used to be scanned here too, on the stated grounds
  //    that "an escalation description is read in the oversight queue". It is
  //    not, and never was: nothing in any repo read the field, the oversight
  //    queue is driven by workspace settings, and no customer-facing page
  //    rendered it. The field is gone; this comment records why the scan lost
  //    an entry rather than leaving it looking like an oversight.
  const unsubstituted: Array<[string, string]> = [
    ['description', data.description],
    ['roleSummary', data.roleSummary],
  ];
  for (const [field, text] of unsubstituted) {
    if (/\{\{\s*pick:/.test(text ?? '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} contains a {{pick:...}} placeholder, and this field is never substituted. It would be read with the braces still in it`,
      });
    }
  }

  const byId = new Map(objects.map((o) => [o.id, o]));
  const prose = [data.role, data.responsibilities, data.additionalContext].join('\n');
  for (const m of prose.matchAll(/\{\{\s*pick:([a-z][a-z0-9-]*)\s*\}\}/g)) {
    const id = m[1];
    const object = byId.get(id);
    // 2. A placeholder naming nothing substitutes to nothing, and the raw
    //    braces are what the customer reads.
    if (!object) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Prose refers to {{pick:${id}}}, which no connector requirement declares`,
      });
      continue;
    }
    // 3. Before anyone picks, and whenever an optional pick goes unanswered,
    //    the phrase is the sentence. Without one it reads "Post the summary
    //    to ."
    if (!object.fallback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Object "${id}" appears in prose as {{pick:${id}}} but declares no fallback phrase to read as before it is picked`,
      });
    }
  }

  // An input is written into the prose as `{{<input-id>}}` and replaced at
  // hire time with what the person typed. An OPTIONAL one can be left blank,
  // and blank substitutes to an empty string: the sentence loses its object
  // and the team reads "argue from what  says". The fallback phrase is what
  // the placeholder reads as instead, the same rule an object's pick carries.
  const inputsById = new Map((data.inputs ?? []).map((i) => [i.id, i]));
  for (const m of prose.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    const id = m[1];
    const input = inputsById.get(id);
    if (!input) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Prose refers to {{${id}}}, which no input declares. It substitutes to nothing, and the raw braces are what the team reads`,
      });
      continue;
    }
    if (!input.required && !input.fallback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Input "${id}" is optional and appears in prose as {{${id}}} but declares no fallback phrase to read as when it is left blank`,
      });
    }
  }

  validateInputContract(data, ctx);
});

/**
 * The distillation input contract's rules.
 *
 * Split out of the superRefine above only for length; it is the same pass, and
 * the messages follow the same reason-first style — say what breaks, then what
 * to do about it, because a validator message is read by someone who has just
 * been stopped and wants to know whether the rule is right.
 *
 * These rules bind whatever is PRESENT. A template with no flows is not failed
 * for having none: optionality is a product constraint, not leniency. What is
 * failed is a half-authored flow, because a flow with no exclusion competes
 * with its siblings inside one agent's top-K and retrieval starts choosing by
 * tie-break.
 */
/** The ids that appear more than once, each reported once. */
function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dups.add(id);
    seen.add(id);
  }
  return [...dups];
}

function validateInputContract(
  data: {
    flows?: Array<{ id: string; name: string; useWhen: string; notNeededFor: string; body: string; companionCron?: string }>;
    evals?: Array<{ id: string; counterpartOf?: string; expected: Record<string, unknown> }>;
    defaultTriggerConfig: { companionCrons?: Array<{ label: string }> };
    toolNotes?: Record<string, string>;
    capabilities?: Record<string, 'live' | 'unwired' | 'absent'>;
    sections?: Record<string, string | undefined>;
    requiredConnectors: Array<{ capability?: string; capabilities?: string[] }>;
    optionalConnectors?: Array<{ capability?: string; capabilities?: string[] }>;
    responsibilities: string;
    additionalContext: string;
    writesRequireProvenance?: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  const flows = data.flows ?? [];

  // An id is the flow's IDENTITY: it becomes the skill id verbatim and is what
  // survives a redistill, so two flows sharing one collapse into one skill and
  // the second's metrics land on the first. Heading-derived slugs collide
  // easily ("Weekly report" twice, in two families), and a Set built from them
  // hid the collision by construction.
  for (const dup of duplicateIds(flows.map((f) => f.id))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Flow id "${dup}" is declared more than once. A flow's id is its stable identity — the skill id it becomes and the key its metrics accrue under — so two flows with one id are one skill with two bodies. Rename one`,
    });
  }

  for (const flow of flows) {
    // A boundary has to name something. "Not needed for other requests" is a
    // sentence that excludes nothing, and a key that excludes nothing competes
    // with every sibling for the same top-K slot.
    const namesSibling = flows.some((o) => o.id !== flow.id
      && (flow.notNeededFor.toLowerCase().includes(o.name.toLowerCase())
        || flow.notNeededFor.includes(o.id)));
    const namesExclusion = /\b(unless|except|not when|already|instead)\b/i.test(flow.notNeededFor);
    if (!namesSibling && !namesExclusion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Flow "${flow.id}" has a boundary that excludes nothing: notNeededFor names no sibling flow and states no exclusion. Two flows that both match every request mean retrieval is choosing between them by tie-break. Name the flow that covers the excluded case, or say the condition under which this one does not apply`,
      });
    }

    // A quoted utterance is a key that matches one phrasing and nothing else a
    // person might actually say.
    if (/["\u201c\u2018].{8,}["\u201d\u2019]/.test(flow.useWhen)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Flow "${flow.id}" quotes a sample utterance in useWhen. A retrieval key written as one phrasing of a request matches that phrasing and misses every other way of asking. Describe the SHAPE of the request instead`,
      });
    }
  }

  // A flow's clock names a declared companion, or it is a clock nothing fires.
  //
  // `companionCron` is a LABEL into `defaultTriggerConfig.companionCrons`. The
  // promoter writes the raw phrase there when it cannot decide the cron for it
  // ("quarterly", "weekly" with no day), so that a person decides — and this is
  // the refusal that makes them. A clock left as prose would hire an agent whose
  // flow says "every quarter" and whose triggers say nothing of the kind.
  const companionLabels = new Set((data.defaultTriggerConfig.companionCrons ?? []).map((c) => c.label));
  for (const flow of flows) {
    if (flow.companionCron && !companionLabels.has(flow.companionCron)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Flow "${flow.id}" carries companionCron "${flow.companionCron}", which names no label in defaultTriggerConfig.companionCrons. A clock a flow carries has to be a trigger the hire actually has: declare the companion (label, cronExpr) and name its label here, or drop the clock`,
      });
    }
  }

  // Boundaries are mutual. A names B as not-its-business while B says nothing
  // about A leaves B matching A's requests, so the exclusion holds in one
  // direction and the competition it was meant to settle is still there.
  for (const flow of flows) {
    for (const other of flows) {
      if (other.id === flow.id) continue;
      const excludesOther = flow.notNeededFor.includes(other.id)
        || flow.notNeededFor.toLowerCase().includes(other.name.toLowerCase());
      if (!excludesOther) continue;
      const reciprocated = other.notNeededFor.includes(flow.id)
        || other.notNeededFor.toLowerCase().includes(flow.name.toLowerCase());
      if (!reciprocated) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Flow "${flow.id}" excludes "${other.id}" but "${other.id}" does not exclude it back. A one-sided boundary still leaves "${other.id}" matching requests that belong to "${flow.id}"`,
        });
      }
    }
  }

  // ── Evals ──────────────────────────────────────────────────────────────
  const evals = data.evals ?? [];
  const evalIds = new Set(evals.map((e) => e.id));
  // Same rule, same reason: a case is addressed by id — by `counterpartOf`, by
  // the harness's recordings, by the per-family evidence — and two cases with
  // one id are one case whose result depends on which was read.
  for (const dup of duplicateIds(evals.map((e) => e.id))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Eval id "${dup}" is declared more than once. A case is addressed by id — its counterpart names it, the harness records under it — so two cases with one id are one case with two answers. Rename one`,
    });
  }
  for (const ev of evals) {
    if (ev.counterpartOf && !evalIds.has(ev.counterpartOf)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Eval "${ev.id}" names counterpart "${ev.counterpartOf}", which no case in this template declares`,
      });
    }
  }

  // Every refusal case needs a served counterpart. A case asserting the agent
  // refuses passes trivially for an agent that refuses everything, and the
  // served case is the only thing that distinguishes judgement from a blanket
  // no.
  //
  // The rule is one-directional on purpose, and stays so: a served case does
  // NOT need a refusal counterpart. A rubric case about the shape of a
  // produced grid or memo has no refusal to pair with — there is no "does not
  // produce the grid" a well-behaved role should exhibit — and most of the
  // catalog's cases are of that kind. "Every positive has a negative" is the
  // AUTHORING rule for behaviours that can go either way, and it is checked in
  // family review, where a person can tell which cases those are; a validator
  // cannot, and one that demanded a negative for every rubric would fail the
  // catalog for cases that are complete as they are.
  for (const ev of evals) {
    const refuses = ev.expected.never_calls !== undefined
      || ev.expected.last_delivery_never_calls !== undefined
      || ev.expected.reply_omits !== undefined;
    if (!refuses) continue;
    const hasServed = ev.counterpartOf !== undefined
      || evals.some((o) => o.counterpartOf === ev.id);
    if (!hasServed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Eval "${ev.id}" asserts a refusal (never_calls / reply_omits) with no served counterpart. An agent that refuses EVERYTHING passes it. Add the case that must be served and link the pair with counterpartOf`,
      });
    }
  }

  // ── Tool notes ─────────────────────────────────────────────────────────
  //
  // Keyed by capability precisely so the note survives a different binding, so
  // a key naming a capability nothing declares is a note that reaches no tool.
  // Both spellings: a requirement declares either one `capability` or a
  // `capabilities` list, and a note keyed off the list would otherwise be
  // reported as reaching no tool while reaching one perfectly well.
  const declaredCaps = new Set(
    [...data.requiredConnectors, ...(data.optionalConnectors ?? [])]
      .flatMap((r) => [r.capability, ...(r.capabilities ?? [])])
      .filter((c): c is string => typeof c === 'string' && c.length > 0),
  );
  for (const cap of Object.keys(data.toolNotes ?? {})) {
    if (!declaredCaps.has(cap)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `toolNotes has a key "${cap}", which no declared connector requirement provides. The note would be attached to no tool and read by nothing. Use a capability from requiredConnectors or optionalConnectors`,
      });
    }
  }

  // ── Capability tri-state ───────────────────────────────────────────────
  //
  // `absent` means the PLATFORM cannot do it. Prose describing it as available
  // is a promise nothing can keep, which is the failure the third state exists
  // to make visible.
  const proseAll = `${data.responsibilities}\n${data.additionalContext}`;
  for (const [cap, state] of Object.entries(data.capabilities ?? {})) {
    if (state !== 'absent') continue;
    const words = cap.split('_').filter((w) => w.length > 3);
    if (words.length > 0 && words.every((w) => proseAll.toLowerCase().includes(w))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Capability "${cap}" is declared absent — the platform cannot do it — but the prose still describes it. An agent told to do something nothing can carry out promises it and then fails. Remove the prose or change the state`,
      });
    }
  }

  // A declared map covers every capability a requirement names. The set is
  // derived from the requirements — the same `declaredCaps` the toolNotes rule
  // reads — so a map that states two capabilities absent and says nothing
  // about the six the connectors provide is a half-authored field, refused the
  // way a flow with no boundary is: a capability the hire binds without a
  // declared state is one the distiller guesses the availability of, and the
  // third state exists so that nothing is guessed. Presence itself is the
  // catalog ratchet's to hold (`KNOWN_TEMPLATES_WITHOUT_CAPABILITIES`); like
  // every field of the contract, an absent map is not failed here.
  if (data.capabilities) {
    const undeclared = [...declaredCaps].filter((cap) => data.capabilities![cap] === undefined);
    if (undeclared.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `capabilities declares no state for ${undeclared.map((c) => `"${c}"`).join(', ')}, which the connector requirements name. A declared map covers every capability a requirement provides (live / unwired / absent), or the distiller guesses whether the hire has it`,
      });
    }
  }

  // ── Headings ───────────────────────────────────────────────────────────
  //
  // Enforced at last, and only against what `sections` declares: a heading with
  // no destination is a section the distiller cannot route, so its content
  // reaches no layer of the compiled agent and nothing reports that.
  for (const heading of Object.keys(data.sections ?? {})) {
    if (!(heading in SECTION_DESTINATION)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Section "${heading}" has no destination, so nothing knows which layer of the agent it feeds and its content compiles into none of them. Move it into the section vocabulary, or classify it as a toolNote (material read while writing one call's arguments) or a flow (a named sub-workflow)`,
      });
    }
  }

  // `sections`, when present, is a VIEW of the authored prose and must compose
  // back to it. Two sources of truth for what a template says would drift, and
  // the drift would be silent: the strings still hire an agent, and the
  // sections still route.
  if (data.sections) {
    for (const [heading, body] of Object.entries(data.sections)) {
      if (!body) continue;
      if (!proseAll.includes(body.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Section "${heading}" does not appear in the authored prose. sections is a parsed view of responsibilities + additionalContext, not a second copy of them — edit the prose and re-split, or the two say different things and only one is read`,
        });
      }
    }
  }

  // ── Obligations ────────────────────────────────────────────────────────
  //
  // The same net as the three existing obligation flags: prose that promises
  // the behaviour without the flag is a promise nothing enforces. The gate is
  // in the tenant runtime and it reads the flag, not the paragraph.
  const promisesProvenance = /\b(only|never)\b[^.]{0,80}\b(records?|rows?|items?)\b[^.]{0,80}\b(you have (?:actually )?(?:read|seen)|this run has (?:read|seen))/i
    .test(proseAll);
  if (promisesProvenance && data.writesRequireProvenance !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `The prose promises the agent writes only to records it has read, and writesRequireProvenance is not set. Prose is not enforcement — the tenant runtime's write gate is, and it reads the flag. Set writesRequireProvenance: true, or drop the promise`,
    });
  }
}

// ── Request body schemas ───────────────────────────────────────────────────

const connectorMappingZodSchema = z.object({
  requirementId: z.string().min(1).max(100),
  connectorId: z.string().uuid(),
  accountRef: z.string().max(255).optional(),
});

export const fromTemplateRequestZodSchema = z.object({
  templateId: z.string().min(1).max(200),
  variables: z.record(z.string().max(10000)),
  connectorMapping: z.array(connectorMappingZodSchema),
  name: z.string().min(1).max(255),
  workforcePlan: z.string().max(255).optional(),
  previewId: z.string().max(255).optional(),
});

export const fromTemplatePreviewRequestZodSchema = z.object({
  templateId: z.string().min(1).max(200),
  variables: z.record(z.string().max(10000)),
  connectorMapping: z.array(connectorMappingZodSchema),
});

// ── Utility validator ──────────────────────────────────────────────────────

/**
 * Validates a raw unknown value as an AgentTemplate.
 * Throws a ZodError with a friendly message on failure.
 */
export function validateTemplate(raw: unknown): AgentTemplate {
  const result = agentTemplateZodSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    const err = new Error(`Template validation failed:\n${issues}`);
    (err as Error & { zodError: z.ZodError }).zodError = result.error;
    throw err;
  }
  return result.data as AgentTemplate;
}

// Export section constants for use in tests
export { RESPONSIBILITIES_SECTIONS, ADDITIONAL_CONTEXT_SECTIONS };
