/**
 * Minimal mustache-like template substituter for WorkflowStep toolInputTemplate.
 *
 * Supports:
 *   {{input.X}}   — from the workflow's initial inputData
 *   {{output.X}}  — from the previous step's result (stepOutput)
 *   {{steps.<id>.X}} — from ANY completed step, keyed by stepId. Prefer this:
 *                    it survives a step being reordered or inserted, which
 *                    silently changes what {{output.X}} refers to.
 *   {{item.X}}    — from the current loop iteration item
 *   {{....X?}}    — trailing `?` marks the reference OPTIONAL: absent at
 *                   runtime renders nothing rather than failing the step, so
 *                   one clause of a message can be conditional. It does NOT
 *                   excuse a reference that can never resolve — see
 *                   OPTIONAL_MARKER below.
 *   \{\{          — literal {{ escape (applied after substitution)
 *
 * Security:
 *   - Pure string manipulation. NO eval, NO Function(), NO access to globals.
 *   - JSON-safe substitution: values are JSON.stringify'd before insertion
 *     so attacker-controlled strings cannot inject JSON sibling fields.
 *   - Prototype-pollution hardening via getByPath (rejects __proto__ etc.).
 *   - Template size cap: 16KB source, 64KB output.
 *
 * NON-GOALS (do NOT add these — they turn into execution contexts):
 *   - Filter/pipe syntax ({{output.X | uppercase}})
 *   - Expression evaluation inside {{ }}
 *   - Conditional rendering ({{#if}})
 *   - Nested template includes
 */

import { getByPath } from './get-by-path';
import { serializeForPrompt } from './engine/truncate-for-prompt';
import { TemplateResolutionError } from './types';

const MAX_TEMPLATE_SOURCE_BYTES = 16 * 1024;  // 16KB
const MAX_TEMPLATE_OUTPUT_BYTES = 64 * 1024;  // 64KB

/** Template variable pattern: {{input.X}}, {{output.X.Y}}, {{steps.<id>.X}},
 *  {{item.Z}}.
 *
 *  The root is an explicit whitelist, which is why adding `steps` is a code
 *  change rather than data: an unlisted root is left in the string verbatim
 *  rather than resolved, so a template referencing a step would have rendered
 *  the literal `{{steps.s1.prId}}` into the tool arguments.
 *
 *  A trailing `?` — `{{steps.s7.escalation_reason?}}` — marks the reference
 *  OPTIONAL: absent at runtime renders nothing instead of failing the step.
 *  See OPTIONAL_MARKER below for why it exists and what it deliberately does
 *  not cover. `?` cannot appear in a path, so excluding it from the path class
 *  costs nothing. */
const TEMPLATE_VAR_RE = /\{\{(input|output|steps|item)\.([^}?]+)(\?)?\}\}/g;

/* OPTIONAL_MARKER — `{{steps.s7.reason?}}`
 *
 * The language could say "this value is required" and nothing else, so a
 * message with one conditional clause was inexpressible. A code-review
 * notification is the case that needs it: the template says to name the risky
 * surface WHEN there is one, and the distiller can only flatten that into an
 * unconditional `{{steps.s7.escalation_reason}}`. On the common path — a pull
 * request touching nothing sensitive — s7 reports null, the null guard fires
 * correctly, and the whole notification dies. The clean review is the one
 * nobody hears about.
 *
 * `condition` is the wrong tool: it guards a WHOLE step, and the notification
 * must always send. The missing unit is a clause inside one message.
 *
 * WHAT IT MEANS: absent at runtime. Inside a string literal an absent optional
 * renders as NOTHING, so the clause simply is not said — which is the product
 * requirement (a review with no risky surface must not announce that it found
 * none). In a bare JSON token position it renders `null`, the JSON way to say
 * absent, matching what a nullable field already accepts there today.
 *
 * The value carries the whole clause, not a fragment. `"... {{steps.s7.note?}}"`
 * works because s7 writes the sentence; `"Risk: {{steps.s7.level?}}"` leaves a
 * dangling "Risk: " and is the author's error, not the marker's.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER: a reference that can never resolve. An
 * unknown root, an unknown step id, an input field the trigger does not supply
 * — those stay hard validation errors with or without the marker. They are
 * authoring defects, and absent-at-runtime is not what they are. Letting `?`
 * silence them would turn every one of them into permanent silence, which is
 * the failure mode this codebase already pays for elsewhere. `?` changes what
 * happens when a RESOLVABLE reference has no value on this run, and nothing
 * else.
 *
 * NOT a step toward conditionals. There is still no expression evaluation, no
 * `{{#if}}`, no filters — see NON-GOALS at the top of this file. This is one
 * bit on a reference, not a branch. */

/** Escaped literal: \{\{ → {{ (applied after substitution) */
const LITERAL_ESCAPE_RE = /\\\{\\{/g;

/** Any `{{…}}` occurrence, resolvable or not. */
const ANY_PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;

/** TEMPLATE_VAR_RE anchored to a whole placeholder. DERIVED from it rather
 *  than written out again — a second copy of the root list is precisely how
 *  validation and execution drift apart. */
const TEMPLATE_VAR_ANCHORED = new RegExp(`^${TEMPLATE_VAR_RE.source}$`);

export interface TemplateRefs {
  /** Placeholders the runtime will substitute. `optional` is the trailing `?`
   *  marker — it changes ONLY what happens when the reference resolves to
   *  nothing at runtime, never whether the reference is structurally valid, so
   *  every caller here keeps checking optional refs exactly as it checks the
   *  rest. */
  resolvable: Array<{ root: string; path: string; optional: boolean }>;
  /** Placeholders `substitute()` will leave in the string VERBATIM, because
   *  their root is not one it knows. These are silent: `.replace()` only runs
   *  its callback on a match, so nothing is logged and the raw `{{…}}` text
   *  reaches the tool arguments. */
  unresolvable: string[];
}

/** What a template actually references, split by whether the runtime can
 *  resolve it.
 *
 *  Exists because the graph validator checked templates with a PERMISSIVE
 *  pattern (`/\{\{[^}]+\}\}/g` → null → JSON.parse) while `substitute` uses a
 *  RESTRICTIVE one. Anything matching the first but not the second passed
 *  validation and then rendered literally — `{{now.iso}}`, for one, got
 *  through that way, and every check called it clean. */
/** For each index, whether it sits inside a JSON string literal.
 *
 *  A single left-to-right pass tracking quote parity, honouring backslash
 *  escapes so `"a \" b"` does not read as two strings. Placeholders contain no
 *  quotes, so they cannot perturb the count. */
export function stringContextMap(template: string): boolean[] {
  const inStr = new Array<boolean>(template.length).fill(false);
  let inside = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '\\') {
      inStr[i] = inside;
      if (i + 1 < template.length) inStr[i + 1] = inside;
      i++;
      continue;
    }
    if (ch === '"') {
      // The quote itself belongs to the boundary, not the interior.
      inStr[i] = false;
      inside = !inside;
      continue;
    }
    inStr[i] = inside;
  }
  return inStr;
}

export function templateRefs(template: string): TemplateRefs {
  // Blank escaped literals first: a deliberate `\{\{` is not a placeholder and
  // must not be reported as a broken reference.
  const scanned = template.replace(LITERAL_ESCAPE_RE, '');
  const resolvable: Array<{ root: string; path: string; optional: boolean }> = [];
  const unresolvable: string[] = [];

  for (const [placeholder] of scanned.matchAll(ANY_PLACEHOLDER_RE)) {
    const m = TEMPLATE_VAR_ANCHORED.exec(placeholder);
    if (m) resolvable.push({ root: m[1], path: m[2], optional: m[3] === '?' });
    else unresolvable.push(placeholder);
  }

  return { resolvable, unresolvable };
}

export interface TemplateContext {
  input?: unknown;
  output?: unknown;
  item?: unknown;
  /** Every completed step's output, keyed by stepId — `{{steps.s3.total}}`.
   *
   *  `output` reaches only the PREVIOUS step, and `outputField` narrowing
   *  replaces it outright, so a step extracting a scalar left everything else
   *  unreachable. This is the same registry the condition evaluator receives,
   *  so one addressing model serves both surfaces. */
  steps?: Record<string, unknown>;
}

/**
 * How a substituted value reads in PROSE (`jsonContext: false`) — a step's
 * objective, a salvage prompt, a message body.
 *
 * `String(value)` is right for a scalar and silently wrong for everything
 * else: an object renders `[object Object]` and an array of objects renders
 * `[object Object],[object Object]`. A description saying "Summarise
 * {{steps.s1.products}}" then reaches the model asking it to summarise the
 * literal words "[object Object]" — the exact failure the resolution exists to
 * prevent, which is that an instruction names material the model was never
 * given. It was invisible until a web result was framed on its way in and the
 * frame came back wrapped around nothing.
 *
 * Structures go through `serializeForPrompt`, which is the one way a runtime
 * value becomes prompt text everywhere else in this engine. A scalar is
 * untouched, so every existing prose reference renders byte for byte as it
 * did; an array of scalars gains its brackets and quotes, which is the same
 * change and the same reason — `a,b` cannot be told from one element
 * containing a comma.
 */
function renderForProse(value: unknown): string {
  return value !== null && typeof value === 'object' ? serializeForPrompt(value) : String(value);
}

export interface SubstituteOptions {
  jsonContext?: boolean;
  /** PROMPT-ONLY: wrap a substituted value's rendering before it goes into the
   *  text. Called with the string this placeholder would have produced, plus
   *  the root and path it read, and whatever it returns is written instead.
   *
   *  It exists so a web result interpolated into a step's objective can be
   *  marked as DATA the same way the prior-output and earlier-outputs sections
   *  mark it. It is NOT a filter or an expression: it cannot see the template,
   *  cannot choose which placeholder is substituted, and is never consulted for
   *  an absent or null reference — there is no content there to frame.
   *
   *  Deliberately ignored in JSON context. A frame is prose around a value, and
   *  prose inside a tool's JSON arguments is not a marking, it is a corruption
   *  — so the one thing that could turn this into a defect is refused at the
   *  boundary rather than left to every caller to remember. */
  renderValue?: (rendered: string, root: string, path: string) => string;
}

/**
 * Substitute template variables in a string.
 *
 * In JSON context mode (the default for toolInputTemplate), substituted
 * values are JSON.stringify'd so that string values are properly quoted
 * and escaped. This prevents JSON injection where an attacker-controlled
 * value like `general"}, "evil": "x` could break out of its field.
 *
 * @param template — the template string with {{...}} placeholders
 * @param context  — the substitution context { input, output, item }
 * @param options  — { jsonContext: true } for JSON-safe substitution (default true),
 *                   plus the prompt-only `renderValue` hook above
 * @returns the substituted string
 * @throws Error if template exceeds size caps
 */
export function substitute(
  template: string,
  context: TemplateContext,
  options: SubstituteOptions = { jsonContext: true },
): string {
  if (template.length > MAX_TEMPLATE_SOURCE_BYTES) {
    throw new Error(
      `Template source exceeds ${MAX_TEMPLATE_SOURCE_BYTES} byte cap (got ${template.length})`,
    );
  }

  const jsonContext = options.jsonContext !== false;

  // Where the JSON string literals are, so a placeholder can be substituted as
  // CONTENT rather than as a whole token.
  //
  // Everything used to be replaced with `JSON.stringify(value)`, which emits a
  // quoted token. Inside a string literal — `{"id":"{{input.threadId}}"}` —
  // that yields `{"id":""abc123""}`, which is not JSON, and the step dies. It
  // also made a composed string inexpressible: `"Review ready for {{a}} by
  // {{b}}"` cannot be built from whole tokens at all. Both shapes are what a
  // workflow author naturally writes.
  //
  // The injection defence is unchanged, because it never depended on the
  // quoting: inside a string the value is escaped with the same
  // `JSON.stringify` and its surrounding quotes stripped, so a hostile
  // `general"}, "evil": "x` becomes `general\"}, \"evil\": \"x` and stays one
  // string. Outside a string it is still emitted as a full JSON token, so
  // numbers, booleans and objects keep their type.
  const inString = jsonContext ? stringContextMap(template) : null;

  // The optional marker is a capture group, so `offset` is the FIFTH argument
  // here, not the fourth. Getting that wrong is silent: `inString?.[offset]`
  // would index on the string "?" and read undefined, which reads as "not in a
  // string" and switches off both the null guard and the escaped-content
  // encoding for every placeholder in the file.
  const result = template.replace(TEMPLATE_VAR_RE, (
    _match, root: string, path: string, optionalMark: string | undefined, offset: number,
  ) => {
    const optional = optionalMark === '?';

    /** What an optional reference renders when there is nothing to render.
     *
     *  Inside a string literal: nothing at all, so the clause is not said.
     *  In a bare token position: the JSON `null` token — the same value a
     *  nullable field already accepts there, so an optional reference never
     *  produces invalid JSON. */
    const absent = () => (jsonContext && !inString?.[offset] ? 'null' : '');

    const rootObj = context[root as keyof TemplateContext];
    if (rootObj === undefined) {
      // An empty root is absence, not an authoring defect: `input` is empty on
      // every cron fire. The structural defects the marker must NOT silence —
      // an unknown root, an unknown step, an input field the trigger cannot
      // supply — are caught by the graph validator before a run starts, and it
      // ignores the marker entirely.
      if (optional) return absent();
      // Substituting a placeholder we cannot resolve invents a value. The old
      // `'null'` looked like the JSON null token but, inside a string literal —
      // which is where a workflow author naturally writes an id,
      // `{"id":"{{input.threadId}}"}` — it is the four-character STRING "null".
      // That is schema-valid, so it passes every check and reaches the vendor:
      // Gmail answers `400 Invalid id value` and the run takes that as a tool
      // failure rather than the authoring defect it is.
      //
      // Throwing instead fails the step BEFORE the call, and the hybrid loop
      // maps a template throw to the `template_expansion` anomaly, so recovery
      // sees the real cause and can supply the value.
      // Two different failures, and the message has to tell them apart.
      //
      // The first version listed `Object.keys(context)` as "readable roots",
      // which includes a key whose value is undefined — so a run with no
      // `input` produced: `references the root "input", which this run does
      // not carry. Readable roots: input, output, steps.` It named `input` as
      // both missing and available, which is the one thing a reader needs the
      // message to disambiguate.
      // Only roots TEMPLATE_VAR_RE matches reach here — input/output/steps/item
      // — so every root at this point is a valid one that happens to be empty.
      // An unrecognised root is never substituted at all: it renders verbatim
      // and is caught at dispatch by the unsubstituted-template guard.
      const present = (Object.keys(context) as Array<keyof TemplateContext>)
        .filter((k) => context[k] !== undefined);
      throw new TemplateResolutionError(
        `${root}.${path}`,
        `Template variable {{${root}.${path}}} reads the root "${root}", which is a valid root but `
        + `is empty on this run`
        + (root === 'input'
          ? ' — `input` is the trigger payload, and this run carried none. A cron fire never carries one'
          : '')
        + `. Roots carrying data here: ${present.join(', ') || '(none)'}.`,
      );
    }

    const value = getByPath(rootObj, path);

    if (value === undefined) {
      if (optional) return absent();
      throw new TemplateResolutionError(
        `${root}.${path}`,
        `Template variable {{${root}.${path}}} resolved to undefined — "${root}" carries no `
        + `"${path}". Substituting a placeholder value here would send it onward as though it `
        + `were real.`,
      );
    }

    // `null` is not text. Interpolating it into a sentence is the same defect
    // the `undefined` guard above exists to prevent — "substituting a
    // placeholder value here would send it onward as though it were real" —
    // and a check that tests only for undefined lets it through.
    //
    // A step that declares "selected=false with all other fields null if not"
    // has, on a tick with no pull request, every field a real, present null.
    // String(null) is "null", so a later Slack template renders:
    //
    //     Code review ready — null#null: null
    //     Author: @null
    //     Risk: null
    //
    // and posts it. Nothing is wrong with the tool, the connector or the
    // template — the step simply had no pull request and said so in nulls.
    //
    // Scoped to interpolation INTO A STRING. A bare {{x}} in a JSON context is
    // a whole field, and `null` is a legal, meaningful value for a nullable
    // one; refusing it there would break templates that correctly pass null.
    // Inside a string literal there is no such reading: the author is building
    // prose, and "null" is never the prose they meant.
    if (value === null && (!jsonContext || inString?.[offset])) {
      // The marker is what tells these two apart, and only the author can. A
      // step that ran and had nothing to report is the SAME null whether the
      // message needed it or merely offered it; nothing at runtime can see the
      // difference. `?` is the author saying which one this is.
      if (optional) return absent();
      throw new TemplateResolutionError(
        `${root}.${path}`,
        `Template variable {{${root}.${path}}} resolved to null, and it is being interpolated `
        + `into text. "null" is not a value anyone meant to say — the step that produced `
        + `"${root}.${path}" ran but had nothing to report. Guard this step on the producing `
        + `step's result instead of formatting its empty output.`,
        // The producing step RAN and said nothing is there, which is a fact the
        // author's own failure branch may be the answer to. See
        // `TemplateResolutionError.producedNull`.
        true,
      );
    }

    // JSON-safe: stringify the value so strings are quoted and special chars escaped.
    // This means the template author writes {"channel": {{input.channel}}} and
    // the substituter emits {"channel": "general"} — the value is a proper JSON token.
    if (jsonContext) {
      const encoded = JSON.stringify(value);
      if (inString?.[offset]) {
        // Inside a string literal the surrounding quotes already exist, so emit
        // the ESCAPED CONTENT. A non-string value is rendered as its text, which
        // is what interpolating it into a sentence means.
        const asText = typeof value === 'string' ? encoded : JSON.stringify(String(value));
        return asText.slice(1, -1);
      }
      return encoded;
    }

    const rendered = renderForProse(value);
    return options.renderValue ? options.renderValue(rendered, root, path) : rendered;
  });

  // Apply literal escapes: \{\{ → {{
  const final = result.replace(LITERAL_ESCAPE_RE, '{{');

  if (final.length > MAX_TEMPLATE_OUTPUT_BYTES) {
    throw new Error(
      `Template output exceeds ${MAX_TEMPLATE_OUTPUT_BYTES} byte cap (got ${final.length})`,
    );
  }

  return final;
}

/**
 * Apply a WorkflowStep's toolInputTemplate to produce resolved toolInput.
 *
 * If the step has a toolInputTemplate, it is substituted and parsed as JSON,
 * then merged with any static toolInput (static values take precedence on
 * key collision — the template provides defaults, static overrides).
 *
 * If there is no toolInputTemplate, returns the static toolInput as-is.
 */
export function applyTemplate(
  step: { toolInput?: Record<string, unknown>; toolInputTemplate?: string },
  context: TemplateContext,
): Record<string, unknown> {
  const staticInput = step.toolInput || {};

  if (!step.toolInputTemplate) {
    return staticInput;
  }

  const rendered = substitute(step.toolInputTemplate, context, { jsonContext: true });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rendered);
  } catch (err) {
    throw new Error(
      `Template produced invalid JSON after substitution: ${(err as Error).message}. ` +
      `Rendered: ${rendered.slice(0, 200)}`,
    );
  }

  // Static toolInput overrides template values on key collision.
  return { ...parsed, ...staticInput };
}

/** The placeholder `resolveLoopCollection` turns a `loop.over` into. */
function loopCollectionExpression(over: string): string {
  return TEMPLATE_VAR_ANCHORED.test(over)
    ? over
    : /^(input|output|steps|item)\./.test(over)
      ? `{{${over}}}`
      // Bare path. Relative to the previous step's output, which is what this
      // field has always meant and what the existing graphs and tests rely on.
      : `{{output.${over}}}`;
}

/** What a `loop.over` ACTUALLY addresses once the executor's own branching has
 *  been applied to it, or null when `substitute` will not resolve it at all.
 *
 *  Exported so the graph validator judges the same string the executor will
 *  resolve, through the same two regexes, rather than approximating them.
 *  `loop.over` was validated nowhere, and the one rule that would have covered
 *  it — "is the root readable?" — passes `output.<stepId>.<field>`, because
 *  `output` IS a readable root: it is bound to the PREVIOUS step's output. The
 *  defect is a legal root addressed as though it were the step registry, and no
 *  imitation of this branching would have caught it — a second answer to "what
 *  does `steps.s5` mean" is how the validator and the executor drifted apart
 *  before. */
export function loopCollectionRef(over: string): { root: string; path: string } | null {
  const m = TEMPLATE_VAR_ANCHORED.exec(loopCollectionExpression(over));
  return m ? { root: m[1], path: m[2] } : null;
}

/**
 * Resolve a loop's collection to a value, using the SAME addressing as every
 * other field.
 *
 * `loop.over` was the one field that never learned the template language. It
 * went straight to `getByPath(stepOutput, over)`, so it accepted only a bare
 * dot-path relative to the previous step's output — while the distiller's
 * schema, its worked exemplar and the `loop.collect` comment in shared-types
 * all describe stepId-keyed addressing. A loop authored against the documented
 * model could not resolve:
 *
 *   review graph    s8   over: "{{steps.s5.findings}}"
 *                        → getByPath walks stepOutput["{{steps"] → undefined
 *   report graph    s3   over: "output.plan.channels"
 *                        → walks stepOutput["output"] → undefined, because
 *                          stepOutput IS the output; the root is implied
 *
 * Both fail the same way: zero iterations, a step failure, and `onFailure`.
 * For a review graph that means publishing a review whose summary announces
 * "Blocking issues: 1" with no comment attached to the diff, on every run.
 * Nothing is wrong with the tool or the connector.
 *
 * Three accepted forms, so no authored graph has to change:
 *   {{steps.s5.findings}}   a whole placeholder, the documented form
 *   output.plan.channels    a rooted path (input / output / steps / item)
 *   items                   a bare path, relative to the previous step's output
 *
 * Everything routes through `substitute`, deliberately. A second resolver here
 * would be a second answer to "what does steps.s5 mean", and two answers is how
 * the validator and the executor drifted apart before.
 *
 * Throws `TemplateResolutionError` when the reference cannot be resolved, which
 * is what makes the failure honest. The hybrid loop treats that as a CONTRACT
 * DEFECT rather than a business failure, so it routes to recovery instead of the
 * author's `onFailure` branch — the rule the executor already applies to
 * templates: "A step whose INPUTS could not be built was never attempted, and
 * `onFailure` is not the right route for it." A loop whose collection never
 * resolved ran its body zero times. The step did not fail; it never happened.
 */
export function resolveLoopCollection(over: string, context: TemplateContext): unknown {
  const expr = loopCollectionExpression(over);

  // jsonContext, and the expression is a whole placeholder rather than text
  // around one — so `substitute` emits the value as a complete JSON token and
  // this round-trips objects and arrays with their types intact.
  const rendered = substitute(expr, context, { jsonContext: true });
  try {
    return JSON.parse(rendered);
  } catch {
    // Resolved to something that is not JSON. Not a resolution failure, so it
    // is not a contract defect — hand it back and let the caller's
    // "did not resolve to an array" check report it as the shape problem it is.
    return undefined;
  }
}
