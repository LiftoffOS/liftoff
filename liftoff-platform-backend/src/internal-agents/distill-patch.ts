// The patch rung: edits to listed fields of a rejected graph, before the
// artifact is regenerated.
//
// Today every rejection, whatever its scope, becomes the correction turn and
// the next attempt is a full large-tier `produce_agent` call told to reproduce
// everything else unchanged. A missing `onFailure` on one step costs the same
// as re-authoring the whole artifact.
//
// A patch is a set of `{ stepId, field, value }` edits. The pairs it may touch
// are exactly the fields the table below lists for each rejected error, on that
// error's step, read from the error's structured `field` and `code` and never
// from its message text. An error without a `field`, or of a type outside the
// table, makes the whole rejection non-patchable and it regenerates as today.
// No step is added, removed, retyped, renamed, or has a field unset: the format
// cannot express any of those, which is the point.
//
//   tool_call_without_failure_edge,
//   condition_without_else          onFailure                  an existing stepId other than the step's own
//   broken_reference,
//   unexecutable_graph/DANGLING_REF the named edge             an existing stepId; '' for onSuccess only
//   unknown_tool,
//   undispatchable_tool             toolName + the step's      a catalog key; the arguments tokenize
//                                   toolInputTemplate|toolInput and parse
//   tool_input_mismatch             toolInputTemplate|toolInput tokenizes and parses
//   unexecutable_graph/
//   UNADDRESSABLE_REF               condition|toolInputTemplate a condition starts with `$.`; a template
//                                   (the one the problem names) tokenizes and parses
//   unsafe_customer_copy            toolInputTemplate          tokenizes and parses (the validator re-checks)
//   description_too_long            description                length <= WORKFLOW_STEP_DESCRIPTION_MAX
//
// Everything else regenerates: tool_output_field_guessed (its repair is
// removing outputField, which the format cannot express), every obligation,
// UNREACHABLE_STEP, DUPLICATE_STEP_ID, NO_OP_WORKFLOW, UNKNOWN_STEP_TYPE,
// CAPABILITY_NEED_INCOMPLETE, the trigger analyzer's errors,
// trigger_without_capability, the capability violations, the prose fences and
// every artifact-level refusal.
//
// Fail-closed throughout. A returned edit outside the allowed pairs, a value
// that fails its constraint, a duplicated pair, a value that would unset a
// field, a missing or wrong tool call, a throw: the whole patch is discarded
// and the run takes today's path. A patch is never persisted unvalidated — the
// caller re-runs the same validators over the patched graph and only an empty
// result counts as converged.
//
// The cost is measured, not asserted. Each call is recorded in `distill_runs`
// under phase 'patch' with its token counts and model, by the caller once it
// knows whether the patch converged. The input side is bounded before the call
// by PATCH_INPUT_BUDGET_CHARS over the whole serialised request; over it there
// is no call and the run regenerates, which is the correct path for a repair
// whose context does not fit in a few fields' worth of prompt.

import type { WorkflowStep } from '@liftoffos/shared-types';
import { llmClient } from '../llm/client';
import type { LLMCompletionResponse, LLMMessage, LLMToolDefinition } from '../llm/types';
import { log } from '../infrastructure/logging';
import { WORKFLOW_STEP_DESCRIPTION_MAX } from './workflow-step-limits';
import { tokenizeTemplate } from './tool-arg-validation';
import { normalizeDistillOutput } from './distill-normalize';
// Types only. The one VALUE this module needs from the service, the field
// schema builder, is imported at call time inside fieldContracts: the service
// imports this module, and a static import back would make the pair a
// load-order cycle. The same pattern the service itself uses for its own
// cross-module calls.
import type { ToolCatalog, ValidationError } from './distill-service';

/** The tier the patch runs on. A field edit is not the large tier's work, and the
 *  large-tier regeneration is what it stands in for. One constant, so it can be
 *  lowered in one place. */
export const PATCH_TIER = 'medium' as const;
/** Bounds the output. Edits are a handful of fields, never the artifact. */
export const PATCH_MAX_TOKENS = 4_096;
/** A policy constant, not a tuned threshold. A patch prompt carries the
 *  affected steps, their neighbours and the named tools' schemas; a repair of
 *  a few fields whose context does not fit in this is a graph problem, and
 *  regeneration is the right path for it. A wrong value here forgoes a saving
 *  and never affects correctness: above the budget the code takes today's
 *  path. */
export const PATCH_INPUT_BUDGET_TOKENS = 8_000;
/** The budget as it is enforced. This repo has no provider tokenizer; the one
 *  estimator it has is the 4-chars≈1-token approximation in
 *  src/insights/context-budget.ts, which says so. Counted over the ENTIRE
 *  serialised request: the system text, the user message and the full JSON of
 *  every tool definition sent, the patch tool's own input_schema included. A
 *  real counting mechanism, if one is ever added, replaces the estimator
 *  without changing the rule. */
export const PATCH_INPUT_BUDGET_CHARS = PATCH_INPUT_BUDGET_TOKENS * 4;
/** One patch per attempt. A second would be asked about a graph the first
 *  already failed to converge, and the correction turn is the better reader
 *  of that. */
export const MAX_PATCHES_PER_ATTEMPT = 1;
export const PATCH_TOOL_NAME = 'patch_workflow_fields';

/** `DISTILL_PATCH_ENABLED=0` switches the rung off without a deploy. It is
 *  the kill for a code defect in the rung, not a cost dial: the rung is
 *  fail-closed and its properties are the tests', so nothing measured decides
 *  whether it stays on. Default on. */
export function isDistillPatchEnabled(): boolean {
  return process.env.DISTILL_PATCH_ENABLED !== '0';
}

export type PatchField = NonNullable<ValidationError['field']>;

/** Which row of the table admitted a pair. Kept per pair because two errors can
 *  admit the same pair under different constraints, and every one of them has
 *  to hold. */
type PairRule =
  | 'edge_missing'     // onFailure that must be added: an existing id, not the step's own
  | 'edge_named'       // the edge an error names: an existing id, '' for onSuccess only
  | 'tool_name'        // a catalog key
  | 'template'         // tokenizes and parses
  | 'tool_input'       // JSON text of an object
  | 'condition'        // starts with `$.`
  | 'description';     // within the persisted cap

export interface PatchScope {
  allowed: ReadonlyArray<{ stepId: string; field: PatchField }>;
}

interface ScopeEntry {
  stepId: string;
  field: PatchField;
  rules: Set<PairRule>;
  errorTypes: Set<string>;
}

const EDGE_FIELDS: ReadonlySet<string> = new Set(['onSuccess', 'onFailure']);

/** One key per (stepId, field) pair, unambiguous whatever a step id contains. */
function pairKey(stepId: string, field: string): string {
  return JSON.stringify([stepId, field]);
}

/** The argument field a step carries, for the unknown_tool row: the template
 *  where the step has one, the object where it has that, the template where it
 *  has neither (a renamed tool may need arguments and the string form is the
 *  one the schema prefers). */
function argumentFieldOf(step: WorkflowStep): 'toolInputTemplate' | 'toolInput' {
  if (step.toolInputTemplate !== undefined && step.toolInputTemplate !== null) return 'toolInputTemplate';
  if (step.toolInput !== undefined && step.toolInput !== null) return 'toolInput';
  return 'toolInputTemplate';
}

function scopeEntries(errors: ValidationError[], steps: WorkflowStep[]): ScopeEntry[] | null {
  if (errors.length === 0) return null;
  const stepById = new Map(steps.map((s) => [String(s.stepId ?? ''), s]));
  const entries = new Map<string, ScopeEntry>();
  const admit = (stepId: string, field: PatchField, rule: PairRule, errorType: string) => {
    const key = pairKey(stepId, field);
    const existing = entries.get(key);
    if (existing) {
      existing.rules.add(rule);
      existing.errorTypes.add(errorType);
      return;
    }
    entries.set(key, { stepId, field, rules: new Set([rule]), errorTypes: new Set([errorType]) });
  };

  for (const e of errors) {
    const step = stepById.get(e.stepId);
    // An error that names no existing step (the obligations name
    // 'workflowSteps') has no field to edit.
    if (!step) return null;
    switch (e.type) {
      case 'tool_call_without_failure_edge':
      case 'condition_without_else':
        if (e.field !== 'onFailure') return null;
        admit(e.stepId, 'onFailure', 'edge_missing', e.type);
        break;
      case 'broken_reference':
        if (e.field !== 'onSuccess' && e.field !== 'onFailure') return null;
        admit(e.stepId, e.field, 'edge_named', e.type);
        break;
      case 'unexecutable_graph':
        if (e.code === 'DANGLING_REF') {
          if (e.field !== 'onSuccess' && e.field !== 'onFailure') return null;
          admit(e.stepId, e.field, 'edge_named', `${e.type}/${e.code}`);
        } else if (e.code === 'UNADDRESSABLE_REF') {
          if (e.field === 'condition') admit(e.stepId, 'condition', 'condition', `${e.type}/${e.code}`);
          else if (e.field === 'toolInputTemplate') admit(e.stepId, 'toolInputTemplate', 'template', `${e.type}/${e.code}`);
          else return null;
        } else {
          return null;
        }
        break;
      case 'unknown_tool':
      case 'undispatchable_tool': {
        if (e.field !== 'toolName') return null;
        admit(e.stepId, 'toolName', 'tool_name', e.type);
        const argField = argumentFieldOf(step);
        admit(e.stepId, argField, argField === 'toolInput' ? 'tool_input' : 'template', e.type);
        break;
      }
      case 'tool_input_mismatch':
        if (e.field === 'toolInputTemplate') admit(e.stepId, 'toolInputTemplate', 'template', e.type);
        else if (e.field === 'toolInput') admit(e.stepId, 'toolInput', 'tool_input', e.type);
        else return null;
        break;
      case 'unsafe_customer_copy':
        if (e.field !== 'toolInputTemplate') return null;
        admit(e.stepId, 'toolInputTemplate', 'template', e.type);
        break;
      case 'description_too_long':
        if (e.field !== 'description') return null;
        admit(e.stepId, 'description', 'description', e.type);
        break;
      default:
        return null;
    }
  }
  return [...entries.values()];
}

/**
 * The (stepId, field) pairs a patch may edit for this rejection, or null when
 * any error in it is outside the table or carries no `field`. Computed before
 * the call and enforced after it.
 */
export function patchScopeFor(errors: ValidationError[], steps: WorkflowStep[]): PatchScope | null {
  const entries = scopeEntries(errors, steps);
  if (!entries) return null;
  return { allowed: entries.map(({ stepId, field }) => ({ stepId, field })) };
}

export function buildPatchTool(): LLMToolDefinition {
  const fields: PatchField[] = [
    'onSuccess', 'onFailure', 'toolName', 'toolInputTemplate', 'toolInput', 'condition', 'description',
  ];
  return {
    name: PATCH_TOOL_NAME,
    description:
      'Repair the rejected workflow by editing ONLY the listed (stepId, field) pairs. Each edit '
      + 'replaces the whole value of one field on one step. Every value is a string: an edge is a '
      + 'stepId, toolInput is the JSON text of an object, toolInputTemplate is a JSON string with '
      + 'placeholders, a condition is a predicate starting with `$.`, a description is prose. Do not '
      + 'add, remove, rename or retype a step; do not touch a pair that is not listed; do not send '
      + 'an empty value except to clear onSuccess on a step that is terminal by its own text.',
    input_schema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'One entry per (stepId, field) pair that changes. A pair at most once.',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string', description: 'The step whose field changes. Must be one of the listed pairs.' },
              field: { type: 'string', enum: fields, description: 'The field that changes. Must be the field the listed pair names.' },
              value: { type: 'string', description: 'The complete new value of that field.' },
            },
            required: ['stepId', 'field', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  };
}

const PATCH_SYSTEM_PROMPT =
  'You repair one rejected workflow graph by editing named fields on named steps. You are shown '
  + 'the rejection, the pairs you may change, the affected steps with the steps they connect to, '
  + 'the tools those steps name, and the contract for each field you may change. Change nothing '
  + 'else. Keep every step id, type and tool that is not named. Answer with exactly one call to '
  + `${PATCH_TOOL_NAME}.`;

type SchemaWithProperties = { properties?: Record<string, { description?: unknown }> };

/** The description text for a step field, from the same schema the author was
 *  handed, so the patcher reads the contract the author read. The tool_call
 *  variant first; the other variants where a field only exists there. */
async function fieldContracts(tenantId: string, fields: ReadonlySet<PatchField>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let variants: SchemaWithProperties[] = [];
  try {
    const { buildProduceAgentFieldSchemas } = await import('./distill-service');
    const schema = buildProduceAgentFieldSchemas(tenantId).workflowSteps as {
      items?: { oneOf?: SchemaWithProperties[] };
    };
    variants = schema.items?.oneOf ?? [];
  } catch {
    variants = [];
  }
  for (const field of fields) {
    for (const variant of variants) {
      const description = variant.properties?.[field]?.description;
      if (typeof description === 'string' && description.length > 0) {
        out[field] = description;
        break;
      }
    }
  }
  return out;
}

/** The step a `loop.over` path iterates, when it names one: the path is
 *  `steps.<stepId>.<field>`, written bare or as the placeholder
 *  `{{steps.<stepId>.<field>}}`.
 *
 *  The placeholder form is the one the distiller's own exemplar emits, so a
 *  bare-only match would omit the source step from the patch context of every
 *  correctly authored loop.
 *
 *  `output` stays in the alternation for graphs stored with
 *  `output.<stepId>.<field>` paths; it resolves to nothing at run time, and a
 *  step this cannot name is a step the repair model never sees. */
function loopSourceStep(step: WorkflowStep): string | undefined {
  const over = step.loop?.over;
  if (typeof over !== 'string') return undefined;
  const bare = over.replace(/^\{\{/, '').replace(/\}\}$/, '').replace(/^\$\./, '');
  const m = /^(?:output|steps)\.([^.]+)/.exec(bare);
  return m?.[1];
}

/** The affected steps plus every step they reference or are referenced by,
 *  through `onSuccess`, `onFailure` and `loop`. */
function stepsInContext(scope: ReadonlyArray<{ stepId: string }>, steps: WorkflowStep[]): WorkflowStep[] {
  const affected = new Set(scope.map((p) => p.stepId));
  const wanted = new Set<string>(affected);
  for (const s of steps) {
    const id = String(s.stepId ?? '');
    const loopSource = loopSourceStep(s);
    if (affected.has(id)) {
      if (s.onSuccess) wanted.add(s.onSuccess);
      if (s.onFailure) wanted.add(s.onFailure);
      if (loopSource) wanted.add(loopSource);
    }
    if ((s.onSuccess && affected.has(s.onSuccess)) || (s.onFailure && affected.has(s.onFailure))
      || (loopSource && affected.has(loopSource))) {
      wanted.add(id);
    }
  }
  return steps.filter((s) => wanted.has(String(s.stepId ?? '')));
}

async function buildPatchUserMessage(params: {
  errors: ValidationError[];
  scope: PatchScope;
  steps: WorkflowStep[];
  catalog: ToolCatalog;
  tenantId: string;
}): Promise<string> {
  const { errors, scope, steps, catalog, tenantId } = params;
  const rejection = errors.map((e) => `- Step "${e.stepId}": ${e.detail}`).join('\n');
  const pairs = scope.allowed.map((p) => `- ${p.stepId}.${p.field}`).join('\n');
  const affectedIds = new Set(scope.allowed.map((p) => p.stepId));
  const context = stepsInContext(scope.allowed, steps);
  const stepLines = context
    .map((s) => `${affectedIds.has(String(s.stepId ?? '')) ? '' : '(read-only) '}${JSON.stringify(s)}`)
    .join('\n');
  // Every id in the graph, one line: an edge repair (a missing onFailure, a
  // dangling reference) has to name a step, and the right target — the
  // escalation, the closing report — is often not a neighbour of the affected
  // step. Without this the model guesses an id, the constraint refuses it, and
  // the rung forgoes the saving on exactly the repairs it exists for.
  const index = steps
    .map((s) => `${String(s.stepId ?? '')} (${String(s.type ?? 'tool_call')})`)
    .join(', ');
  const toolNames = [...new Set(context.map((s) => s.toolName).filter((n): n is string => typeof n === 'string' && n.length > 0))];
  const toolLines = toolNames
    .map((name) => {
      const entry = catalog.get(name);
      if (!entry) return `- ${name}: not in the catalog`;
      return `- ${JSON.stringify({ name: entry.name, description: entry.description, input_schema: entry.input_schema })}`;
    })
    .join('\n');
  const contracts = await fieldContracts(tenantId, new Set(scope.allowed.map((p) => p.field)));
  const contractLines = Object.entries(contracts).map(([f, d]) => `- ${f}: ${d}`).join('\n');

  return `REJECTED. The workflow graph was rejected for these reasons:\n${rejection}\n\n`
    + `You may change ONLY these stepId.field pairs, and nothing else:\n${pairs}\n\n`
    + `The affected steps and the steps they connect to. Steps marked (read-only) are shown for `
    + `context and must not change:\n${stepLines}\n\n`
    + `Every step id in the graph, for edge values: ${index}\n\n`
    + (toolLines.length > 0 ? `The tools those steps name:\n${toolLines}\n\n` : '')
    + (contractLines.length > 0 ? `The contract for each field you may change:\n${contractLines}\n\n` : '')
    + `Call ${PATCH_TOOL_NAME} once with the edits.`;
}

interface Edit { stepId: string; field: PatchField; value: string }

function parseEdits(input: unknown): Edit[] | undefined {
  const edits = (input as { edits?: unknown } | undefined)?.edits;
  if (!Array.isArray(edits)) return undefined;
  const out: Edit[] = [];
  for (const raw of edits) {
    const e = raw as { stepId?: unknown; field?: unknown; value?: unknown };
    if (typeof e?.stepId !== 'string' || typeof e?.field !== 'string' || typeof e?.value !== 'string') {
      return undefined;
    }
    out.push({ stepId: e.stepId, field: e.field as PatchField, value: e.value });
  }
  return out;
}

/** Why an edit fails its row's constraint, or undefined when it holds. */
function constraintViolation(
  edit: Edit,
  entry: ScopeEntry,
  steps: WorkflowStep[],
  catalog: ToolCatalog,
): string | undefined {
  const ids = new Set(steps.map((s) => String(s.stepId ?? '')));
  const isEdge = EDGE_FIELDS.has(edit.field);
  // Unsetting is not an edit the format admits. The one blank the table
  // allows is onSuccess under the named-edge row, checked below.
  if (!isEdge && edit.value.length === 0) return `${edit.stepId}.${edit.field}: empty value would unset the field`;

  for (const rule of entry.rules) {
    switch (rule) {
      case 'edge_missing':
        if (!ids.has(edit.value)) return `${edit.stepId}.${edit.field}: "${edit.value}" is not a step in the graph`;
        if (edit.value === edit.stepId) return `${edit.stepId}.${edit.field}: points at its own step`;
        break;
      case 'edge_named':
        if (edit.value === '') {
          if (edit.field !== 'onSuccess') return `${edit.stepId}.${edit.field}: empty value is allowed on onSuccess only`;
        } else if (!ids.has(edit.value)) {
          return `${edit.stepId}.${edit.field}: "${edit.value}" is not a step in the graph`;
        }
        break;
      case 'tool_name':
        if (!catalog.has(edit.value)) return `${edit.stepId}.toolName: "${edit.value}" is not a catalog key`;
        break;
      case 'template':
        if (tokenizeTemplate(edit.value) === undefined) return `${edit.stepId}.toolInputTemplate: does not tokenize and parse`;
        break;
      case 'tool_input': {
        let parsed: unknown;
        try { parsed = JSON.parse(edit.value); } catch { return `${edit.stepId}.toolInput: not JSON`; }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return `${edit.stepId}.toolInput: not the JSON text of an object`;
        }
        break;
      }
      case 'condition':
        if (!edit.value.startsWith('$.')) return `${edit.stepId}.condition: must start with "$."`;
        break;
      case 'description':
        if (edit.value.length > WORKFLOW_STEP_DESCRIPTION_MAX) {
          return `${edit.stepId}.description: ${edit.value.length} characters, over ${WORKFLOW_STEP_DESCRIPTION_MAX}`;
        }
        break;
    }
  }
  return undefined;
}

export interface PatchCallRecord {
  startedAt: Date;
  endedAt: Date;
  provider?: string;
  model?: string;
  usage?: LLMCompletionResponse['usage'];
  /** Set when the call threw; the caller records the row as an error. */
  error?: string;
}

export interface PatchResult {
  /** The graph to validate next: the patched, normalised steps when
   *  `applied`, the input steps by identity otherwise. */
  steps: WorkflowStep[];
  applied: boolean;
  usage?: LLMCompletionResponse['usage'];
  rejectedReason?: string;
  /** Present whenever a call was made (or attempted), absent when the budget
   *  skipped it. The caller writes the distill_runs row from it once it knows
   *  whether the patched graph converged. */
  call?: PatchCallRecord;
}

/**
 * Ask the medium tier for edits within `scope`, enforce the scope and the
 * table's constraints on what comes back, and apply. Never throws: a failure
 * of any kind returns `applied: false` and the caller takes today's path.
 */
export async function patchWorkflowSteps(params: {
  steps: WorkflowStep[];
  errors: ValidationError[];
  scope: PatchScope;
  catalog: ToolCatalog;
  tenantId: string;
  agentId?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
}): Promise<PatchResult> {
  const { steps, errors, scope, catalog, tenantId, agentId, sessionId, runId, attempt } = params;
  const base = { tenantId, agentId, runId, attempt };

  // The full rule set behind the scope's pairs, recomputed from the same
  // errors so the enforcement below cannot be handed a looser scope than the
  // one the table admits.
  const entries = scopeEntries(errors, steps);
  if (!entries) {
    return { steps, applied: false, rejectedReason: 'scope: rejection is not patchable' };
  }
  const entryFor = new Map(entries.map((en) => [pairKey(en.stepId, en.field), en]));

  const tools = [buildPatchTool()];
  const system = PATCH_SYSTEM_PROMPT;
  const user = await buildPatchUserMessage({ errors, scope, steps, catalog, tenantId });
  const chars = system.length + user.length + JSON.stringify(tools).length;
  if (chars > PATCH_INPUT_BUDGET_CHARS) {
    log.info({ metric: 'distill.patch.skipped', reason: 'input_budget', chars, budget: PATCH_INPUT_BUDGET_CHARS, ...base },
      'Patch prompt over the input budget; regenerating instead');
    return { steps, applied: false, rejectedReason: `skipped: input_budget (${chars} chars)` };
  }

  const messages: LLMMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const startedAt = new Date();
  let response: LLMCompletionResponse;
  try {
    response = await llmClient.complete({
      messages,
      tier: PATCH_TIER,
      maxTokens: PATCH_MAX_TOKENS,
      temperature: 0,
      tools,
      toolChoice: { name: PATCH_TOOL_NAME },
    }, undefined, {
      tenantId,
      ...(agentId && { agentId }),
      ...(sessionId && { sessionId }),
      purpose: 'distill_patch',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ metric: 'distill.patch.error', error: message, ...base }, 'Patch call threw; regenerating instead');
    return {
      steps, applied: false, rejectedReason: `error: ${message}`,
      call: { startedAt, endedAt: new Date(), error: message },
    };
  }
  const call: PatchCallRecord = {
    startedAt,
    endedAt: new Date(),
    provider: response.provider,
    model: response.model,
    usage: response.usage,
  };
  const discard = (reason: string): PatchResult => {
    log.warn({ metric: 'distill.patch.discarded', reason, ...base }, 'Patch discarded; regenerating instead');
    return { steps, applied: false, usage: response.usage, rejectedReason: reason, call };
  };

  if (response.stopReason === 'max_tokens') return discard('truncated at max_tokens');
  const toolCall = response.toolCalls?.[0];
  if (!toolCall) return discard('no tool call');
  if (toolCall.name !== PATCH_TOOL_NAME) return discard(`unexpected tool: ${toolCall.name}`);
  const edits = parseEdits(toolCall.input);
  if (!edits) return discard('malformed edits');
  if (edits.length === 0) return discard('no edits');

  // Enforcement: every edit matches an allowed pair, once, and holds its
  // row's constraint; one failure discards the whole patch.
  const seen = new Set<string>();
  for (const edit of edits) {
    const key = pairKey(edit.stepId, edit.field);
    const entry = entryFor.get(key);
    if (!entry) return discard(`edit outside the allowed pairs: ${edit.stepId}.${edit.field}`);
    if (seen.has(key)) return discard(`duplicated pair: ${edit.stepId}.${edit.field}`);
    seen.add(key);
    const violation = constraintViolation(edit, entry, steps, catalog);
    if (violation) return discard(`constraint: ${violation}`);
  }

  // Apply. Steps not named are carried by identity; a named step is a shallow
  // copy with the field replaced, then given the same boundary repair the raw
  // artifact gets (normalizeDistillOutput, on the graph slice). The untouched
  // steps were normalised on the way in and are not copied again: the
  // normaliser is per step, so running it over the edited ones alone is the
  // same repair, and identity is what says the model never touched the rest.
  const editsByStep = new Map<string, Edit[]>();
  for (const edit of edits) {
    const list = editsByStep.get(edit.stepId) ?? [];
    list.push(edit);
    editsByStep.set(edit.stepId, list);
  }
  const editedSteps: WorkflowStep[] = [];
  for (const s of steps) {
    const list = editsByStep.get(String(s.stepId ?? ''));
    if (!list) continue;
    const copy: Record<string, unknown> = { ...s };
    for (const edit of list) {
      copy[edit.field] = edit.field === 'toolInput'
        ? (JSON.parse(edit.value) as Record<string, unknown>)
        : edit.value;
    }
    editedSteps.push(copy as unknown as WorkflowStep);
  }
  const normalised = normalizeDistillOutput({ workflowSteps: editedSteps }, { tenantId }).workflowSteps;
  const normalisedEdited = Array.isArray(normalised) ? (normalised as WorkflowStep[]) : [];
  if (normalisedEdited.length !== editedSteps.length) return discard('normalisation dropped an edited step');
  const byId = new Map(normalisedEdited.map((s) => [String(s.stepId ?? ''), s]));
  const patched: WorkflowStep[] = steps.map((s) => byId.get(String(s.stepId ?? '')) ?? s);

  for (const edit of edits) {
    const entry = entryFor.get(pairKey(edit.stepId, edit.field))!;
    log.info({
      metric: 'distill.patch.applied',
      stepId: edit.stepId,
      field: edit.field,
      errorType: [...entry.errorTypes].join(','),
      ...base,
    }, 'Applied a patch edit to a rejected workflow step');
  }

  return { steps: patched, applied: true, usage: response.usage, call };
}
