// The bind rung: a rejected tool NAME re-bound to the catalog key it was
// written for, before the patch rung and before any regeneration.
//
// Passing the validators proves a value is executable, not intended, so this
// rung binds only tool names and never edges: a dangling onSuccess/onFailure
// has no signal beyond name similarity, and a wrong but valid target passes
// collectGraphErrors and changes the workflow. Edges stay with the patch rung.
//
// Two branches, one kill (DISTILL_BIND_ENABLED):
//
//   deterministic  the rejected name equals a catalog key after normalisation
//                  (case and `_`/`-`/`.` folded) or matches the explicit alias
//                  the catalog declares for that key (`vendorToolName`), AND
//                  the step's existing arguments pass the tokenize / coerce /
//                  restore check against that key's schema. No model call, no
//                  distill_runs row; one structured log line. A unique fuzzy
//                  match is NOT enough — a sole edit-distance candidate is
//                  executable, not necessarily intended.
//   Jev            catalog keys with the same connector prefix within
//                  Damerau-Levenshtein distance 2 of the normalised name whose
//                  schema accepts the step's arguments. One to five → one
//                  `ask` of the distill_bind set, Choice over the candidates
//                  plus `none`, applied only above BIND_T. Zero, or more than
//                  five, or `none`, or sub-threshold → the patch rung.
//
// The rung runs only when EVERY error in the rejection is an unknown_tool /
// undispatchable_tool with a bindable step; otherwise the patch rung handles
// the whole rejection. The acceptance is the patch rung's own (the same
// validators plus argument fit); this claims no more for the same repair.

import type { WorkflowStep } from '@liftoffos/shared-types';
import { log } from '../infrastructure/logging';
import { ask } from '../typesafe/client';
import { isDistillBindEnabled } from '../typesafe/flags';
import { asEntry, distillBindSet, type BindCandidate } from '../typesafe/questions';
import {
  coerceToolArgs,
  parseAuthoredArgs,
  restoreTemplate,
  tokenizeTemplate,
  validateToolArgs,
} from './tool-arg-validation';
import type { ToolCatalog, ValidationError } from './distill-service';

/** Candidates beyond this go to the patch rung: five near-names is a naming
 *  problem the model should see whole, not a five-way choice. */
export const MAX_FUZZY_CANDIDATES = 5;
/** Damerau-Levenshtein distance over the normalised names. */
export const FUZZY_DISTANCE = 2;

export type BindBy = 'exact' | 'alias';

export interface StepBinding {
  stepId: string;
  from: string;
  /** Set when the name is unambiguous by construction. */
  deterministic?: { to: string; by: BindBy };
  /** The Jev candidates when it is not. Empty when the rung skips this step. */
  fuzzy: BindCandidate[];
}

/** Case and separators folded, so `Send_Email`, `send-email` and `send.email`
 *  are one name. */
export function normaliseToolName(name: string): string {
  return name.toLowerCase().replace(/[-.]/g, '_').replace(/_+/g, '_');
}

/** The connector alias prefix of an aliased key (`gmail-1a2b__send_email` →
 *  `gmail-1a2b`), or '' for a bare name. */
function prefixOf(key: string): string {
  const i = key.indexOf('__');
  return i > 0 ? key.slice(0, i) : '';
}

/** Restricted Damerau-Levenshtein (optimal string alignment). Bounded: the
 *  names are short, and a distance over the bound is reported as the bound
 *  plus one. */
export function damerauLevenshtein(a: string, b: string, bound: number = FUZZY_DISTANCE): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) { d[0][j] = j; }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Does the step's authored argument source fit this schema, through the
 *  same tokenize / coerce / restore pass the validator runs? A step with no
 *  arguments fits any schema whose required set is empty. */
export function argumentsFit(step: WorkflowStep, inputSchema: unknown): boolean {
  const source = step.toolInputTemplate ?? step.toolInput;
  if (source === undefined || source === null) {
    const required = ((inputSchema as { required?: string[] } | undefined)?.required ?? []);
    return required.length === 0;
  }
  let args: unknown;
  if (typeof source === 'string') {
    const tokenized = tokenizeTemplate(source);
    if (!tokenized) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(tokenized.json); } catch { return false; }
    const { args: coerced } = coerceToolArgs(inputSchema, parsed);
    // The restore must round-trip: a coercion that lost a placeholder is not
    // a fit. The template is then judged with its placeholders VISIBLE, the
    // way the distiller's own gate judges it, so a placeholder in a field
    // the schema types as a number (`"issue_number": "{{steps.s1.number}}"`,
    // the shape of most steps that read an earlier one) is exempt rather
    // than a type error. Judged on the tokenised form, every such step was
    // "not a fit" and the rung never offered it a candidate.
    const restored = restoreTemplate(coerced, tokenized.tokens);
    if (restored === undefined) return false;
    args = parseAuthoredArgs(restored);
    if (args === undefined) return false;
  } else {
    const parsed = parseAuthoredArgs(source as Record<string, unknown>);
    if (parsed === undefined) return false;
    args = coerceToolArgs(inputSchema, parsed).args;
  }
  return validateToolArgs(inputSchema, args).length === 0;
}

const BINDABLE_ERROR_TYPES: ReadonlySet<ValidationError['type']> = new Set(['unknown_tool', 'undispatchable_tool']);

/**
 * The deterministic part, also used alone by landing change 1. Returns null
 * when the rung must not run: any error outside the two bindable types, an
 * error naming no step, a step with no tool name, or a step for which
 * neither branch has anything to offer.
 */
export function bindCandidatesFor(
  errors: ValidationError[],
  steps: WorkflowStep[],
  catalog: ToolCatalog,
  opts?: { isUndispatchable?: (key: string) => boolean },
): StepBinding[] | null {
  if (errors.length === 0) return null;
  if (!errors.every((e) => BINDABLE_ERROR_TYPES.has(e.type))) return null;
  const stepById = new Map(steps.map((s) => [String(s.stepId ?? ''), s]));
  const undispatchable = opts?.isUndispatchable ?? (() => false);

  const byNormalised = new Map<string, string>();
  const byAlias = new Map<string, string>();
  for (const [key, entry] of catalog) {
    if (undispatchable(key)) continue;
    byNormalised.set(normaliseToolName(key), key);
    // The one explicit alias the catalog declares for a key: the vendor's own
    // tool name, when it differs from the aliased key.
    if (entry.vendorToolName && normaliseToolName(entry.vendorToolName) !== normaliseToolName(key)) {
      byAlias.set(normaliseToolName(entry.vendorToolName), key);
    }
  }

  const out: StepBinding[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    if (seen.has(e.stepId)) continue;
    seen.add(e.stepId);
    const step = stepById.get(e.stepId);
    if (!step || typeof step.toolName !== 'string' || step.toolName.length === 0) return null;
    const from = step.toolName;
    const norm = normaliseToolName(from);

    // Deterministic: exact after normalisation, then the declared alias.
    const exact = byNormalised.get(norm);
    if (exact && exact !== from && argumentsFit(step, catalog.get(exact)?.input_schema)) {
      out.push({ stepId: e.stepId, from, deterministic: { to: exact, by: 'exact' }, fuzzy: [] });
      continue;
    }
    const alias = byAlias.get(norm);
    if (alias && alias !== from && argumentsFit(step, catalog.get(alias)?.input_schema)) {
      out.push({ stepId: e.stepId, from, deterministic: { to: alias, by: 'alias' }, fuzzy: [] });
      continue;
    }

    // Fuzzy: same connector prefix, within distance 2, arguments fit.
    const prefix = prefixOf(from);
    const fuzzy: BindCandidate[] = [];
    for (const [key, entry] of catalog) {
      if (key === from || undispatchable(key)) continue;
      if (prefixOf(key) !== prefix) continue;
      if (damerauLevenshtein(norm, normaliseToolName(key)) > FUZZY_DISTANCE) continue;
      if (!argumentsFit(step, entry.input_schema)) continue;
      fuzzy.push({ key, description: entry.description, ...(entry.input_schema ? { inputSchema: entry.input_schema } : {}) });
    }
    if (fuzzy.length === 0 || fuzzy.length > MAX_FUZZY_CANDIDATES) return null;
    out.push({ stepId: e.stepId, from, fuzzy });
  }
  return out.length > 0 ? out : null;
}

export interface BindCallRecord {
  startedAt: Date;
  endedAt: Date;
  provider: 'typesafe';
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
}

export interface BindResult {
  /** The graph to validate next: the re-bound steps when `applied`, the
   *  input steps by identity otherwise. */
  steps: WorkflowStep[];
  applied: boolean;
  /** One record per Jev call made — one per fuzzy step, since each step is
   *  its own Choice — for the one distill_runs row per LLM call the recorder
   *  keeps. Empty on the deterministic branch, which makes no LLM call and
   *  writes no row. */
  calls: BindCallRecord[];
  rejectedReason?: string;
}

function rebind(steps: WorkflowStep[], stepId: string, to: string): WorkflowStep[] {
  return steps.map((s) => (String(s.stepId ?? '') === stepId ? { ...s, toolName: to } : s));
}

/**
 * Apply the plan: the deterministic bindings with a log line each, then one
 * Jev call per fuzzy step (the set is one Choice over that step's candidates).
 * Returns the patch rung's shape. Never throws.
 */
export async function bindWorkflowSteps(params: {
  steps: WorkflowStep[];
  errors: ValidationError[];
  candidates: StepBinding[];
  tenantId: string;
  agentId?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
}): Promise<BindResult> {
  const { candidates, tenantId, agentId, sessionId, runId, attempt } = params;
  if (!isDistillBindEnabled()) {
    return { steps: params.steps, applied: false, calls: [], rejectedReason: 'disabled' };
  }
  let steps = params.steps;
  let applied = false;
  const calls: BindCallRecord[] = [];
  const stepById = new Map(steps.map((s) => [String(s.stepId ?? ''), s]));

  for (const binding of candidates) {
    if (binding.deterministic) {
      steps = rebind(steps, binding.stepId, binding.deterministic.to);
      applied = true;
      log.info({
        metric: 'distill.rebind',
        runId,
        attempt,
        stepId: binding.stepId,
        from: binding.from,
        to: binding.deterministic.to,
        by: binding.deterministic.by,
        tenantId,
        agentId,
      }, 'Re-bound a rejected tool name to the catalog key it names');
      continue;
    }
    if (binding.fuzzy.length === 0) continue;
    const step = stepById.get(binding.stepId);
    const set = distillBindSet(binding.fuzzy);
    const startedAt = new Date();
    const result = await ask(
      set,
      asEntry({
        step: {
          description: step?.description ?? '',
          toolName: binding.from,
          arguments: step?.toolInputTemplate ?? step?.toolInput ?? null,
        },
        candidates: binding.fuzzy.map((c) => ({ key: c.key, description: c.description, inputSchema: c.inputSchema ?? null })),
      }),
      {
        deadlineMs: 3_000,
        attemptTimeoutMs: 2_000,
        maxRetries: 1,
        purpose: 'distill_bind',
        tenantId,
        ...(agentId ? { agentId } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    );
    calls.push({
      startedAt,
      endedAt: new Date(),
      provider: 'typesafe',
      ...(result ? { model: result.model, usage: result.usage } : { error: 'unavailable' }),
    });
    if (!result) continue;
    const answer = result.answers.binding;
    const p = answer.probabilities[answer.choice] ?? 0;
    const bindT = set.thresholds.BIND_T as number;
    if (answer.choice === 'none' || p < bindT || !binding.fuzzy.some((c) => c.key === answer.choice)) {
      log.info({
        metric: 'distill.bind.declined', runId, attempt, stepId: binding.stepId, from: binding.from,
        choice: answer.choice, probability: p, tenantId, agentId,
      }, 'Jev bound nothing for this step; the patch rung follows');
      continue;
    }
    steps = rebind(steps, binding.stepId, answer.choice);
    applied = true;
    log.info({
      metric: 'distill.bind.applied', runId, attempt, stepId: binding.stepId, from: binding.from,
      to: answer.choice, probability: p, tenantId, agentId,
    }, 'Jev bound a rejected tool name to a catalog key');
  }

  return { steps, applied, calls, ...(applied ? {} : { rejectedReason: 'nothing bound' }) };
}
