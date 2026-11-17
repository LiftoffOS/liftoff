// Refuse to persist a workflow the runtime cannot run.
//
// Until now the only structural validation of workflow steps lived inside the
// distiller (`validateWorkflowSteps`). `service.create` and `service.update`
// persist whatever they are handed, so every writer that is not the distiller —
// the API, an operator edit, a future importer — bypassed every check. That is
// how typeless steps can reach the database: the distiller emits them
// correctly, the API schema strips `type`, and nothing between there and the
// database looks again.
//
// WHAT THIS REFUSES, and why each is unambiguous corruption rather than taste:
//
//   NO_OP_WORKFLOW    The runtime dispatches on delay / ask_user / llm_reason,
//                     then on toolName, then falls to an else that advances
//                     doing nothing. A workflow where EVERY step lands in that
//                     else walks its graph, executes nothing, and reports
//                     success — a fabricated success, which INV-PB-004 forbids.
//   UNKNOWN_STEP_TYPE A type no executor handles runs as a tool call when a
//                     toolName is present and as nothing otherwise. Either way
//                     what executes is not what was written.
//   DANGLING_REF      onSuccess/onFailure naming a step that does not exist
//                     strands the run mid-graph.
//   DUPLICATE_STEP_ID Two steps with one id make the runtime's step lookup
//                     ambiguous, and `onSuccess` cannot address either.
//   UNREACHABLE_STEP  The runtime hard-fails the whole run on this
//                     (`failureClass: 'validation'`), so persisting it is
//                     persisting an agent that cannot complete.
//   UNADDRESSABLE_REF A condition or template naming a root the runtime cannot
//                     resolve, or a step id that does not exist. Both fail
//                     SILENTLY and differently: an unresolvable condition is
//                     false on every run, so its branch is never taken; an
//                     unresolvable template placeholder is left in the string
//                     VERBATIM and rendered into the tool arguments. A
//                     production agent shipped
//                     `"BTC price log failed for the {{now.iso}} run"` and
//                     would have sent those characters to a person.
//                     A `loop.over` the runtime cannot resolve fails a third
//                     way: the loop runs its body ZERO times, so the step did
//                     not fail, it never happened, and nothing downstream can
//                     tell. And `output.<existingStepId>` fails a fourth: it
//                     names a LEGAL root — `output` is the previous step's
//                     output — addressed as though it were the step registry,
//                     so every root check upstream passes and the read finds
//                     nothing. The distiller's own schema documented that form
//                     for `loop.over`, and the model followed it exactly.
//
// Deliberately NOT checked here: tool-name resolution. The set of tools an agent
// will actually hold is assembled per invocation in the runtime from connector
// manifests, per-agent bindings, capability tier and vendor flags. The control
// plane cannot know it, and guessing would reject valid workflows.
//
// Callers gate this on the steps having CHANGED. An operator renaming an agent
// should not be blocked by corruption that was already stored — they are not
// the one who introduced it, and refusing their edit does not fix it.

// The event-input contract — which `input.<field>` references resolve, and the
// rule for deciding — is imported, not restated. The Tenant Runtime BUILDS the
// object from the same declaration, so this gate and that producer cannot
// disagree about a field. Restating it is what the root sets below still do, and
// the reason they can is that they are three words each; a per-connector field
// map is not, and a stale copy of it would bless a reference that fails at run
// time.
import {
  eventInputPathResolvable,
  addressableEventInputFields as addressableFields,
} from '@liftoffos/shared-types';

export interface WorkflowStepsProblem {
  code:
    | 'NO_OP_WORKFLOW'
    | 'UNKNOWN_STEP_TYPE'
    | 'DANGLING_REF'
    | 'DUPLICATE_STEP_ID'
    | 'UNREACHABLE_STEP'
    | 'UNADDRESSABLE_REF'
    | 'CAPABILITY_NEED_INCOMPLETE'
    | 'TIME_FROM_REASONING';
  stepId: string;
  message: string;
  /** The ONE step field the problem is about, set only by the sites that know
   *  it: a DANGLING_REF names the edge it found dangling, an UNADDRESSABLE_REF
   *  names the text it scanned (`condition` or `toolInputTemplate`). Every
   *  other code leaves it unset. Structured on purpose: the distiller's patch
   *  rung decides what a repair may touch from THIS, never from `message`. */
  field?: 'onSuccess' | 'onFailure' | 'condition' | 'toolInputTemplate' | 'loop';
}

const KNOWN_TYPES = new Set(['tool_call', 'llm_reason', 'delay', 'ask_user', 'capability']);

/** Roots the RUNTIME can resolve. Duplicated from the Tenant Runtime on
 *  purpose — this is a separate service and cannot import its modules — so it
 *  is written as data with the counterpart named, and pinned by a test.
 *
 *  A condition is handed `{ input, steps }` plus `item` inside a loop body; a
 *  template resolves `input | output | steps | item` and, critically, leaves
 *  ANY other placeholder in the string VERBATIM without logging. So an
 *  unlisted root is not a degraded read, it is text sent to a tool or a person:
 *  a production agent shipped `"BTC price log failed for the {{now.iso}} run"`
 *  and every check upstream of the runtime called it clean.
 *
 *  Counterparts: `CONDITION_ROOTS` and `TEMPLATE_VAR_RE` in the Tenant
 *  Runtime's `agent-execution/validate-workflow-graph.ts` and `template.ts`. */
const CONDITION_ROOTS = new Set(['input', 'steps', 'item']);
const TEMPLATE_ROOTS = new Set(['input', 'output', 'steps', 'item']);

/** A whole `{{root.path}}` placeholder and nothing else, which is the only
 *  shape `substitute` resolves as one value.
 *
 *  Counterpart: `TEMPLATE_VAR_ANCHORED` in the Tenant Runtime's `template.ts`,
 *  from which `loopCollectionRef` is built. Written out here for the same
 *  reason the root sets above are: this is a separate service and cannot
 *  import that module. */
const WHOLE_PLACEHOLDER_RE = /^\{\{(input|output|steps|item)\.([^}?]+)(\?)?\}\}$/;
/** A `loop.over` that already names its root. */
const ROOTED_PATH_RE = /^(input|output|steps|item)\./;

/** What a `loop.over` addresses once the RUNTIME's branching has been applied,
 *  or null when `substitute` will not resolve it at all.
 *
 *  The runtime accepts three forms and this mirrors all three: a whole
 *  placeholder, a rooted path, and a bare path read against the previous step's
 *  output. Counterpart: `loopCollectionRef` / `loopCollectionExpression` in the
 *  Tenant Runtime's `agent-execution/template.ts`.
 *
 *  Stating the grammar rather than a subset of it is the point. `loop.over` was
 *  checked NOWHERE, and the rule that would have covered it — "is the root
 *  readable?" — passes `output.<stepId>.<field>`, because `output` IS readable:
 *  it is the previous step's output, not a map of steps. */
function loopCollectionRef(over: string): { root: string; path: string } | null {
  const expr = WHOLE_PLACEHOLDER_RE.test(over)
    ? over
    : ROOTED_PATH_RE.test(over)
      ? `{{${over}}}`
      : `{{output.${over}}}`;
  const m = WHOLE_PLACEHOLDER_RE.exec(expr);
  return m ? { root: m[1], path: m[2] } : null;
}

/** Candidate event sources for an agent, or `[]` when its input shape is not
 *  knowable — which is every non-event trigger.
 *
 *  Exported so `create` and `update` derive them the same way. `type` and
 *  `integrationId` are both accepted as the type key because the stored shape
 *  has historical drift between them (older control-plane events and frontend
 *  writes used `integrationId`), and reading only one silently yields no
 *  candidates, which would turn the whole check off without saying so. */
export function eventSourcesForAgent(
  triggerConfig: { type?: string } | null | undefined,
  integrations: Array<{ type?: string; integrationId?: string }> | null | undefined,
): string[] {
  if (triggerConfig?.type !== 'event') return [];
  return (integrations ?? [])
    .map((i) => i.type ?? i.integrationId)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}

/** `$.<root>.<rest>` occurrences in a condition. Intentionally a scan rather
 *  than a parser: the control plane's job here is to catch a root or a step id
 *  that can never resolve, not to re-implement the runtime's predicate
 *  grammar and risk disagreeing with it about valid syntax. */
const CONDITION_REF_RE = /\$\.([A-Za-z_]\w*)(?:\.(\w+))?/g;
/** A description that gates whether the step RUNS, as opposed to describing what
 *  it does.
 *
 *  Anchored on "only ... when/if" and "unless", because those are the phrasings
 *  that can only mean execution is conditional. Deliberately NOT a general hunt
 *  for "if": half of all step descriptions contain one ("ask if they want the
 *  summary"), and that says nothing about whether the step should fire.
 *
 *  The verb gap is the point. The first version of this matched only the
 *  adjacent forms — `only when`, `only if` — and a redistill immediately
 *  produced "Only REACHED when the target repository could not be inferred"
 *  and "Only PROCEED if s7 shows tests and lint both passing", neither with a
 *  `condition`. Both ran unconditionally, and the ask_user among them asked on
 *  every single run: the exact defect this check exists to refuse, waved
 *  through by a regex that assumed the two words would be adjacent.
 *
 *  Bounded to a short span and stopped at a sentence end OR a semicolon, so it
 *  cannot pair an "only" in one clause with an "if" in the next — "Only
 *  internal staff are included; if empty, skip" scopes its "only" to who is
 *  included, not to whether the step runs. */
const CONDITIONAL_INTENT_RE = /\bonly\b[^.!?;]{0,40}?\b(?:when|if)\b|\bunless\b/i;

/** "Does this condition reference anything at all?" — deliberately a SEPARATE,
 *  non-global regex. Reusing the `g` one for a `.test()` would advance its
 *  `lastIndex` and make the very next call skip matches, which is its own
 *  silent-and-intermittent bug. */
const CONDITION_HAS_REF_RE = /\$\.[A-Za-z_]\w*/;
/** Any `{{…}}`, so unresolvable roots are seen rather than skipped. `\{\{` is
 *  an escaped literal and is removed before scanning. */
const TEMPLATE_PLACEHOLDER_RE = /\{\{([^}]*)\}\}/g;
const TEMPLATE_ESCAPE_RE = /\\\{\\{/g;
/** `$.input.<dotted.path>` in a condition, carrying the WHOLE path.
 *  `CONDITION_REF_RE` stops after one segment, which is all a step id needs and
 *  not enough for `message.threadId`. */
const INPUT_REF_CONDITION_RE = /\$\.input\.([\w.]+)/g;

interface StepLike {
  stepId: string;
  type?: string;
  toolName?: string;
  onSuccess?: string;
  onFailure?: string;
  condition?: string;
  toolInput?: Record<string, unknown>;
  toolInputTemplate?: string;
  description?: string;
  capabilityNeed?: { operation?: string; entity?: string; mode?: string };
  loop?: { over?: string };
}

/** An argument that says WHEN the tool's own action happens — a delivery
 *  time, a send time, a schedule. Named by the verb of the action plus
 *  at/time/on, which is how every scheduling API spells it, and deliberately
 *  not any field that merely holds a time (a record's created_at, a thread's
 *  ts): those are read from somewhere, this one has to be decided. */
const SCHEDULING_ARG_RE = /^(post|send|schedule|scheduled|publish|deliver|delivery|run|fire|notify|remind|execute|dispatch)_?(at|time|on)$/i;

/** `{{steps.<id>.<field>}}` or `{{input.…}}` etc. — the roots a template value
 *  can read. A value that is not a template at all is a literal. */
const TEMPLATE_REF_RE = /\{\{\s*(input|output|steps|item)(?:\.([\w-]+))?/;

/** The top-level argument names and values of a tool_call's input, from the
 *  static object or the template. A template that does not parse as JSON
 *  still yields its `"name": value` pairs by scan — the fence must not go
 *  quiet on the graphs it is for. */
function topLevelArgs(step: StepLike): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  if (step.toolInput && typeof step.toolInput === 'object') {
    for (const [name, v] of Object.entries(step.toolInput)) {
      out.push({ name, value: typeof v === 'string' ? v : JSON.stringify(v) });
    }
  }
  if (typeof step.toolInputTemplate === 'string') {
    const re = /"([\w-]+)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}\]]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(step.toolInputTemplate)) !== null) {
      out.push({ name: m[1], value: m[2].replace(/^"|"$/g, '') });
    }
  }
  return out;
}

/** A step that reaches the runtime's terminal `else` and advances doing nothing. */
function isNoOp(step: StepLike): boolean {
  return (step.type === undefined || !KNOWN_TYPES.has(step.type)) && !step.toolName;
}

/** @param eventSources — connector types an event-triggered agent could fire on,
 *  i.e. the ones it is bound to. Enables the `{{input.<field>}}` checks, which
 *  cannot be answered without knowing what will populate `input`. Pass an empty
 *  array (the default) for cron, manual and chat agents: their input is whatever
 *  the caller passes, so every input reference is left to the author. */
export function findWorkflowStepProblems(
  steps: StepLike[],
  eventSources: string[] = [],
): WorkflowStepsProblem[] {
  const problems: WorkflowStepsProblem[] = [];
  if (steps.length === 0) return problems;

  // What each step actually publishes. A step's output is readable only under
  // the name it declared, so this is the half of a `steps.<id>.<field>` read
  // that says whether it resolves at all.
  const ids = new Set<string>();
  const seen = new Set<string>();
  // Each step's executor, for the reads whose legality depends on WHO wrote
  // the value being read.
  const typeById = new Map<string, string | undefined>();
  for (const s of steps) {
    typeById.set(s.stepId, s.type ?? (s.toolName ? 'tool_call' : undefined));
    if (seen.has(s.stepId)) {
      problems.push({
        code: 'DUPLICATE_STEP_ID',
        stepId: s.stepId,
        message: `Two steps share the id "${s.stepId}"; onSuccess cannot address either unambiguously`,
      });
    }
    seen.add(s.stepId);
    ids.add(s.stepId);
  }

  if (steps.every(isNoOp)) {
    problems.push({
      code: 'NO_OP_WORKFLOW',
      stepId: steps[0].stepId,
      message:
        'Every step is a no-op: none sets a known type and none sets a toolName. This workflow '
        + 'would walk its graph, execute nothing, and report success.',
    });
  }

  for (const s of steps) {
    if (s.type !== undefined && !KNOWN_TYPES.has(s.type)) {
      problems.push({
        code: 'UNKNOWN_STEP_TYPE',
        stepId: s.stepId,
        message: `Step "${s.stepId}" has type "${s.type}", which no executor handles`,
      });
    }
    // A capability step resolves its provider at run time from this need, so an
    // incomplete need would fail the step. operation/entity/mode are the fields
    // the discovery judge scores against and cannot be inferred.
    if (s.type === 'capability') {
      const need = s.capabilityNeed;
      if (!need || !need.operation || !need.entity || !need.mode) {
        problems.push({
          code: 'CAPABILITY_NEED_INCOMPLETE',
          stepId: s.stepId,
          message: `capability step "${s.stepId}" needs a capabilityNeed with operation, entity and mode`,
        });
      }
    }
    for (const [field, target] of [['onSuccess', s.onSuccess], ['onFailure', s.onFailure]] as const) {
      if (target && target !== '' && !ids.has(target)) {
        problems.push({
          code: 'DANGLING_REF',
          stepId: s.stepId,
          message: `${field} references non-existent step "${target}"`,
          field,
        });
      }
    }

    // A time a step made up.
    //
    // No step's model is told the date or the time, and none can do date
    // arithmetic, so an argument that says WHEN the tool acts cannot come from
    // a reasoning step's output or from a literal the author wrote: both are
    // invented. It has to be read from the trigger, the input, or a tool's own
    // result — or the tool that acts NOW is the right tool, since the schedule
    // that decides when the run happens already exists.
    if (s.type === 'tool_call' || (s.type === undefined && s.toolName)) {
      for (const { name, value } of topLevelArgs(s)) {
        if (!SCHEDULING_ARG_RE.test(name)) continue;
        const ref = TEMPLATE_REF_RE.exec(value);
        const source = ref ? ref[1] : null;
        const fromStep = source === 'steps' && ref?.[2] ? typeById.get(ref[2]) : undefined;
        const readable = source === 'input' || source === 'item'
          || (source === 'steps' && fromStep !== undefined && fromStep !== 'llm_reason');
        if (readable) continue;
        problems.push({
          code: 'TIME_FROM_REASONING',
          stepId: s.stepId,
          message:
            `Step "${s.stepId}" passes \`${name}\` ${ref ? `from ${source === 'steps' ? `reasoning step "${ref[2]}"` : 'an unreadable root'}` : 'as a literal'}, `
            + 'and no step has a clock: a reasoning step is never told the date and cannot compute one, and a time the '
            + 'author writes is made up. A time that says when the tool acts must be read from the trigger, `{{input.*}}` '
            + 'or a tool step\'s result. If the action is meant to happen when the run happens, call the tool that acts '
            + 'now instead of a scheduling tool.',
        });
      }
    }

    // An `ask_user` step that states its precondition in PROSE.
    //
    // The runtime gates a step on `condition` and never reads `description`, so
    // a step whose description says "only when s1 could not determine it" and
    // carries no condition halts EVERY run. It is the same wired-at-one-end
    // shape as an unresolvable reference: the intent is written down, in a
    // field with no executable effect.
    //
    // Example: description "Ask which repository to work in, only when step s1
    // could not determine it", no condition. Asked to summarise "all my repos"
    // -- which names every one of them -- the agent stops and asks which
    // repository, on every attempt.
    //
    // Scoped to ask_user because that is the type whose false firing interrupts
    // a person, and because the distiller's own rule already says ask_user is
    // for information the agent "genuinely cannot infer" — a description saying
    // "only when" contradicts an unconditional step by that same standard. An
    // unconditional checkpoint stays legal; it just must not claim otherwise.
    if (s.type === 'ask_user' && !s.condition && s.description
        && CONDITIONAL_INTENT_RE.test(s.description)) {
      problems.push({
        code: 'UNADDRESSABLE_REF',
        stepId: s.stepId,
        message:
          `Step describes itself as conditional ("${s.description.trim()}") but has no `
          + `\`condition\`, and the runtime gates only on \`condition\` — so it asks the person on `
          + `every run, including when the answer was already given. Put the precondition in `
          + `\`condition\` (e.g. "$.steps.s1.<field> is null"), or drop the wording.`,
        // The field the runtime reads and this step lacks. The description was
        // the evidence, the condition is what the repair sets.
        field: 'condition',
      });
    }

    // References that can never resolve at execution time.
    //
    // These are silent in DIFFERENT ways, which is why both are checked here
    // rather than left to the runtime: a bad condition root makes the
    // predicate false on every run, so the branch is simply never taken; a bad
    // template root is left in the string verbatim and rendered into the tool
    // arguments as literal `{{…}}` characters.
    if (s.condition) {
      // A condition with no `$.` reference at all is checked FIRST, as an
      // absence, because the scan below can only visit references it finds:
      // zero matches meant zero problems, and the step shipped.
      //
      // That is exactly how `output.routing.next == 'review'` and
      // `output.ticket.proceed == true` reached live backbones. Neither names a
      // root the runtime can read, so neither is merely false-on-every-run like
      // a bad root — the predicate parser THROWS `Unparseable condition
      // predicate`, which fails the step, fails the run, and keeps failing every
      // run of that agent until someone redistills it. Two dev agents were dead
      // this way, one of them for every request.
      //
      // Still not a grammar re-implementation, which this file deliberately
      // avoids: it asserts only that the condition reads SOMETHING addressable.
      // A predicate that reads nothing cannot branch on anything anyway.
      if (!CONDITION_HAS_REF_RE.test(s.condition)) {
        problems.push({
          code: 'UNADDRESSABLE_REF',
          stepId: s.stepId,
          message:
            `Condition "${s.condition}" reads no addressable value — the runtime's predicate `
            + `grammar requires a "$." path and rejects anything else, so this throws at execution `
            + `time rather than evaluating false. Use ${[...CONDITION_ROOTS].map((r) => `$.${r}`).join(', ')}.`,
          field: 'condition',
        });
      }
      for (const m of s.condition.matchAll(CONDITION_REF_RE)) {
        const [, root, ref] = m;
        if (!CONDITION_ROOTS.has(root)) {
          problems.push({
            code: 'UNADDRESSABLE_REF',
            stepId: s.stepId,
            message:
              `Condition reads "$.${root}", which is not a readable root, so it is false on every run. `
              + `Use ${[...CONDITION_ROOTS].map((r) => `$.${r}`).join(', ')}.`,
            field: 'condition',
          });
        } else if (root === 'steps' && ref && !ids.has(ref)) {
          problems.push({
            code: 'UNADDRESSABLE_REF',
            stepId: s.stepId,
            message: `Condition references step "${ref}", which does not exist in this workflow`,
            field: 'condition',
          });
        }
      }
      // `$.input.<path>` needs the WHOLE path, which CONDITION_REF_RE does not
      // carry — it captures one segment, enough for a step id and not for
      // `message.threadId`.
      for (const m of s.condition.matchAll(INPUT_REF_CONDITION_RE)) {
        const path = m[1];
        if (eventInputPathResolvable(path, eventSources)) continue;
        problems.push({
          code: 'UNADDRESSABLE_REF',
          stepId: s.stepId,
          message:
            `Condition reads "$.input.${path}", which a ${eventSources.join('/')} trigger does not `
            + 'supply, so the predicate is false on every run and the branch is never taken. '
            + `Addressable: ${addressableFields(eventSources).map((f) => `$.input.${f}`).join(', ')}.`,
          field: 'condition',
        });
      }
    }

    if (s.toolInputTemplate) {
      const scanned = s.toolInputTemplate.replace(TEMPLATE_ESCAPE_RE, '');
      for (const m of scanned.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
        const [placeholder, rawInner] = m;
        // A trailing `?` is the runtime's OPTIONAL marker, not part of the path
        // (tenant-runtime `template.ts`, OPTIONAL_MARKER). Left on, it travels
        // into the last path segment and this validator reports
        // `{{input.message.threadId?}}` as a field the trigger does not supply
        // — a false UNADDRESSABLE_REF against the one construct the prompt now
        // tells the model to emit, which the retry loop would then "fix" by
        // deleting. The marker changes what happens when a reference resolves
        // to nothing; it never changes WHICH reference it is, so every check
        // below runs on the stripped path exactly as before.
        const inner = rawInner.replace(/\?$/, '');
        const [root, ref] = inner.split('.');
        if (!TEMPLATE_ROOTS.has(root)) {
          problems.push({
            code: 'UNADDRESSABLE_REF',
            stepId: s.stepId,
            message:
              `toolInputTemplate contains "${placeholder}", which the runtime will not substitute — `
              + `it renders literally into the tool arguments. Readable roots are `
              + `${[...TEMPLATE_ROOTS].join(', ')}.`,
            field: 'toolInputTemplate',
          });
        } else if (root === 'steps' && ref && !ids.has(ref)) {
          problems.push({
            code: 'UNADDRESSABLE_REF',
            stepId: s.stepId,
            message: `toolInputTemplate references step "${ref}", which does not exist in this workflow`,
            field: 'toolInputTemplate',
          });
        } else if (root === 'input') {
          // The full path, not the single `ref` segment the destructure above
          // keeps: `{{input.message.threadId}}` needs `message.threadId`.
          const path = inner.split('.').slice(1).join('.');
          if (path && !eventInputPathResolvable(path, eventSources)) {
            problems.push({
              code: 'UNADDRESSABLE_REF',
              stepId: s.stepId,
              message:
                `toolInputTemplate reads "${placeholder}", which a ${eventSources.join('/')} trigger `
                + 'does not supply. The runtime fails the step rather than substituting a placeholder '
                + `value. Addressable: ${addressableFields(eventSources)
                  .map((f) => `{{input.${f}}}`).join(', ')}, plus {{input.eventData.*}} for the raw payload.`,
              field: 'toolInputTemplate',
            });
          }
        }
      }
    }
  }

  // A `loop.over` the runtime cannot resolve, and `output` addressed as though
  // it were the step registry.
  //
  // Both are silent in their own way. A loop whose collection never resolved
  // runs its body ZERO times: the step did not fail, it never happened, so
  // `onFailure` is not the route for it and nothing downstream can tell. And
  // `output.<existingStepId>` passes every root check there is, because
  // `output` IS a readable root — it is bound to the PREVIOUS step's output —
  // so `output.s13.cards_to_update` walks s13's own output looking for a key
  // called "s13" and finds nothing.
  //
  // A distiller schema that documents that form leads steps to name their
  // collections that way: the loop's output is never written and every check
  // upstream calls the graph clean.
  for (const s of steps) {
    const over = s.loop?.over;
    if (over !== undefined) {
      if (typeof over !== 'string' || over.trim() === '') {
        problems.push({
          code: 'UNADDRESSABLE_REF',
          stepId: s.stepId,
          message:
            'loop.over is empty, so the loop has no collection to iterate: its body runs zero '
            + 'times, the step reports no failure, and nothing downstream can tell.',
          field: 'loop',
        });
      } else if (!s.toolName && s.type !== 'llm_reason' && s.type !== 'capability') {
        // A loop the runtime cannot run a body for.
        //
        // `executeLoopStep` dispatches per item on the step's `toolName`, or on
        // `llm_reason` / `capability` through the step LLM. A looped step that
        // is neither walks its whole collection and executes NOTHING, then
        // reports success — the fabricated success INV-PB-004 forbids, reached
        // by iterating a body that does not exist.
        //
        // Counterpart: LOOP_STEP_EXECUTES_NOTHING in the Tenant Runtime's
        // `agent-execution/validate-workflow-graph.ts`.
        problems.push({
          code: 'UNADDRESSABLE_REF',
          stepId: s.stepId,
          message:
            `Step "${s.stepId}" has a loop but nothing to run per item: it names no tool and is `
            + 'not a reasoning or capability step, so the loop would iterate and execute nothing. '
            + 'Give the step a toolName, or make it type llm_reason.',
          field: 'loop',
        });
      } else {
        const ref = loopCollectionRef(over);
        if (!ref) {
          problems.push({
            code: 'UNADDRESSABLE_REF',
            stepId: s.stepId,
            message:
              `loop.over is "${over}", which the runtime will not substitute, so the loop `
              + 'iterates nothing. Use steps.<stepId>.<field>, the placeholder form '
              + '{{steps.<stepId>.<field>}}, or a bare path read against the previous step output.',
            field: 'loop',
          });
        } else if (ref.root === 'steps') {
          const [stepRef] = ref.path.split('.');
          if (stepRef && !ids.has(stepRef)) {
            problems.push({
              code: 'UNADDRESSABLE_REF',
              stepId: s.stepId,
              message: `loop.over references step "${stepRef}", which does not exist in this workflow`,
              field: 'loop',
            });
          }
        }
      }
    }

    // `output.<existingStepId>` in either place the runtime substitutes.
    //
    // Near-zero false-positive rate, and that is the whole argument for the
    // rule: a step's own output does not carry a key equal to ANOTHER step's
    // id. When it looks like that, the author meant `steps.`.
    const reads: Array<{ field: 'toolInputTemplate' | 'loop'; label: string; path: string }> = [];
    if (s.toolInputTemplate) {
      const scanned = s.toolInputTemplate.replace(TEMPLATE_ESCAPE_RE, '');
      for (const m of scanned.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
        const inner = m[1].replace(/\?$/, '');
        const [root, ...rest] = inner.split('.');
        if (root !== 'output' || rest.length === 0) continue;
        reads.push({ field: 'toolInputTemplate', label: 'toolInputTemplate', path: rest.join('.') });
      }
    }
    if (typeof over === 'string' && over.trim() !== '') {
      const ref = loopCollectionRef(over);
      if (ref?.root === 'output') reads.push({ field: 'loop', label: 'loop.over', path: ref.path });
    }
    for (const read of reads) {
      const [segment] = read.path.split('.');
      if (!segment || !ids.has(segment)) continue;
      problems.push({
        code: 'UNADDRESSABLE_REF',
        stepId: s.stepId,
        message:
          `${read.label} reads "output.${read.path}", but "output" is the PREVIOUS step's `
          + 'output, not a map of steps — so this walks that output looking for a key named '
          + `"${segment}" and finds nothing. Use "steps.${read.path}".`,
        field: read.field,
      });
    }
  }

  // Reachability from the entry step, which the runtime takes as steps[0].
  const reachable = new Set<string>([steps[0].stepId]);
  const queue = [steps[0].stepId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const step = steps.find((s) => s.stepId === id);
    if (!step) continue;
    for (const target of [step.onSuccess, step.onFailure]) {
      if (target && target !== '' && ids.has(target) && !reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const s of steps) {
    if (!reachable.has(s.stepId)) {
      problems.push({
        code: 'UNREACHABLE_STEP',
        stepId: s.stepId,
        message: `Step "${s.stepId}" cannot be reached from the entry step, and the runtime fails the whole run on this`,
      });
    }
  }

  return problems;
}

export class UnrunnableWorkflowError extends Error {
  constructor(public readonly problems: WorkflowStepsProblem[]) {
    super(
      'Workflow steps cannot be executed as written: '
      + problems.map((p) => `[${p.code}] ${p.message}`).join('; '),
    );
    this.name = 'UnrunnableWorkflowError';
  }
}

/** Throws when the steps could not run. Call only when the steps CHANGED.
 *
 *  `eventSources` defaults to empty so every existing caller keeps compiling and
 *  keeps its current behaviour; passing the agent's bound connector types turns
 *  on the input-field checks. */
export function assertWorkflowStepsExecutable(
  steps: StepLike[] | null | undefined,
  eventSources: string[] = [],
): void {
  if (!steps || steps.length === 0) return;
  const problems = findWorkflowStepProblems(steps, eventSources);
  if (problems.length > 0) throw new UnrunnableWorkflowError(problems);
}
