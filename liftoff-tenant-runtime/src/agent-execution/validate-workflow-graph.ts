/**
 * Validate a workflow step graph before execution.
 *
 * Checks:
 *   1. No duplicate stepIds
 *   2. All stepId references (onSuccess, onFailure) resolve to existing steps
 *   3. No unreachable steps (every step is reachable from step[0])
 *   4. Conditions parse, address a readable root, and name steps that exist
 *   5. toolInputTemplates are valid JSON AND every placeholder resolves
 *   6. loop.over resolves, and no reference addresses `output` as if it were
 *      the step registry
 *
 * ONE GRAMMAR, NOT AN IMITATION OF IT. Checks 4, 5 and 6 call the same
 * `conditionFieldPaths`, `templateRefs` and `loopCollectionRef` the
 * executor's own evaluator, substituter and loop resolver are built on, rather
 * than approximating them with local regexes.
 * Both blind spots this closes came from an approximation that was strictly
 * more permissive than the runtime:
 *
 *   - conditions were "validated" by evaluating them against `{}` and
 *     inspecting the throw. A parseable predicate returns false on empty data
 *     instead of throwing, so the check almost never ran; its fallback then
 *     accepted any `$.token`. `$.output.foo` passed, and read nothing on every
 *     run.
 *   - templates were checked by nulling `/\{\{[^}]+\}\}/g` and parsing the
 *     JSON. That pattern matches strictly MORE than `substitute()` resolves,
 *     so an unknown root parsed fine and then rendered verbatim into the tool
 *     arguments, so a template such as `{{now.iso}}` got through it.
 *
 * Returns structured errors, one per violation.
 *
 * Phase 4: pre-execution validation to surface graph errors before any tool
 * calls are made.
 */

import type { WorkflowStep } from './types';
import { resolveStepToolName } from './resolve-step-tool-name';
import { resolveToolDispatch } from './tool-dispatch-family';
import { isStandardTool, getStandardTool } from '../tools/standard-tools';
import { conditionFieldPaths } from './condition';
import { templateRefs, stringContextMap, loopCollectionRef } from './template';
import {
  EVENT_INPUT_FIELDS,
  eventInputPathResolvable,
  addressableEventInputFields,
} from '@liftoffos/runtime-shared-types';

/** Roots a CONDITION can address. `evaluateCondition` is handed
 *  `{ input, steps }` at the call site and `item` inside a loop body; any
 *  other root resolves to undefined on every run, so the condition is false
 *  forever and the branch silently never taken. */
const CONDITION_ROOTS = new Set(['input', 'steps', 'item']);


export interface WorkflowValidationError {
  code: string;          // e.g. 'DANGLING_REF', 'DUPLICATE_STEP_ID'
  stepId?: string;
  message: string;
}

/** Which `input.` paths this run's trigger will actually supply.
 *
 *  Only an event trigger has a knowable input shape, and only then because
 *  event-input-envelope.ts normalizes one. A cron or manual run carries whatever
 *  its caller passed, so `input` references are left unchecked there rather than
 *  guessed at — a validator that rejects what it merely cannot see is worse than
 *  one that admits the limit. */
export interface WorkflowInputContract {
  triggerType: 'event' | 'cron' | 'manual' | 'chat';
  /** Connector sources this run's `input` could come from.
   *
   *  A LIST, not one value, because only the executing run knows its source
   *  exactly. The pre-flight audit and the control plane's write-time gate know
   *  only which connectors the agent is bound to, and `email.received` is
   *  reachable from both Gmail and Outlook. Resolving against the union is the
   *  honest reading: a field absent from EVERY candidate cannot appear whichever
   *  one fires, which is the defect worth blocking, while a field present in one
   *  of them is not something a static check can call wrong. */
  eventSources?: string[];
}

/** Is `path` addressable on this run's `input`?
 *
 *  A thin trigger-type guard over the shared rule. The rule itself —
 *  prefix matching, the `eventData` escape hatch, what to do with a connector
 *  nobody has normalized — lives in `@liftoffos/runtime-shared-types` so the control
 *  plane's write-time gate reaches the identical verdict. */
function inputPathIsResolvable(path: string, contract: WorkflowInputContract): boolean {
  // A cron fire carries no `input` AT ALL, and that is not a guess.
  // `scheduled-invoke-handler` posts an objective and a companion label; it
  // never passes `inputData`, so `{{input.<anything>}}` resolves to undefined
  // on every cron run there has ever been.
  //
  // This was previously lumped in with `manual` as "carries whatever its caller
  // passed, so leave it unchecked". That is true of manual — an API caller can
  // pass any object — and false of cron, and the difference is exactly the
  // defect it let through: a support graph that reads
  // `{{input.message.threadId}}` may also be run by companion CRONS. Every one
  // of those fires fails step 1, takes the escalation branch, and marks the
  // mail read without ever opening the mailbox.
  if (contract.triggerType === 'cron') return false;
  if (contract.triggerType !== 'event') return true;
  return eventInputPathResolvable(path, contract.eventSources ?? []);
}

/** Stands in for a `{{...}}` that occupied a whole value.
 *
 *  Such a value has no authoring-time type — what it resolves to is decided at
 *  dispatch — so the shape check below must skip it rather than judge it as the
 *  string the template happens to be written in. Chosen to be un-authorable: no
 *  real argument contains a NUL. A placeholder INSIDE a larger string is not
 *  this case and keeps its type, because interpolation always yields a string. */
const WHOLE_VALUE_PLACEHOLDER = '\u0000{{}}\u0000';

function authoredArgs(step: WorkflowStep): Record<string, unknown> | null {
  const literal = (step as { toolInput?: Record<string, unknown> }).toolInput;
  if (literal && typeof literal === 'object' && !Array.isArray(literal)) {
    return literal;
  }
  const template = step.toolInputTemplate;
  if (typeof template !== 'string' || template.trim() === '') return null;
  try {
    // The same substitution the JSON-validity check below performs, so the two
    // agree about which templates parse at all: a placeholder inside a string
    // becomes a bare token, one in a value position becomes a quoted one.
    const inStr = stringContextMap(template);
    const rendered = template.replace(
      /\{\{[^}]+\}\}/g,
      (_m, offset: number) => (inStr[offset]
        ? '{{}}'
        : JSON.stringify(WHOLE_VALUE_PLACEHOLDER)),
    );
    const parsed: unknown = JSON.parse(rendered);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Unparseable. The JSON-validity check below owns that finding; reporting a
    // missing argument as well would be two errors for one defect.
    return null;
  }
}

/** The top-level argument names a step authors, or null when it authors none.
 *
 *  Two fields carry them and only one was ever inspected: `toolInput` is a
 *  literal object, `toolInputTemplate` is JSON with `{{...}}` placeholders.
 *
 *  Null rather than an empty set for "authored none", because the two mean
 *  different things: no arguments at all is a step whose arguments arrive at
 *  dispatch, while an empty object is an author saying this call takes none. */
function authoredArgKeys(step: WorkflowStep): Set<string> | null {
  const args = authoredArgs(step);
  return args === null ? null : new Set(Object.keys(args));
}

/** Whether an authored value can satisfy a JSON-Schema `type`.
 *
 *  Top-level and single-typed only. Nested shape, enums and formats are the
 *  authoring gate's job in the control plane, which validates the whole schema
 *  with ajv; this is the runtime's last line for graphs authored before that
 *  gate existed, and its narrowness is deliberate — a second thorough
 *  implementation is a second thing to keep in step with the first. */
function satisfiesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

export function validateWorkflowGraph(
  steps: WorkflowStep[],
  availableToolNames?: Set<string>,
  inputContract?: WorkflowInputContract,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const stepIds = new Set(steps.map(s => s.stepId));

  // Check for duplicate stepIds
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.stepId)) {
      errors.push({
        code: 'DUPLICATE_STEP_ID',
        stepId: step.stepId,
        message: `Duplicate stepId: "${step.stepId}"`,
      });
    }
    seen.add(step.stepId);
  }

  // A workflow that cannot do anything, and would report success for it.
  //
  // The executor dispatches on `delay` / `ask_user` / `llm_reason`, then on
  // `toolName`, and everything else falls to a final `else` that advances to the
  // next step doing nothing. So a step with no type and no toolName is a silent
  // no-op, not a crash — which is fine for one placeholder among real steps, and
  // is a fabricated success when it is ALL of them: the run walks the graph,
  // executes nothing, and completes successfully. INV-TR-004 exists to forbid
  // exactly that shape of lie.
  //
  // Not hypothetical: a distiller can emit steps carrying only description,
  // stepId, onSuccess and outputField, and such an agent never runs anything,
  // because the branch that would run it never fires.
  const KNOWN_TYPES = new Set(['tool_call', 'llm_reason', 'delay', 'ask_user', 'capability']);
  const isNoOp = (step: WorkflowStep): boolean =>
    (step.type === undefined || !KNOWN_TYPES.has(step.type)) && !step.toolName;

  if (steps.length > 0 && steps.every(isNoOp)) {
    errors.push({
      code: 'NO_OP_WORKFLOW',
      stepId: steps[0].stepId,
      message:
        `Every step is a no-op: none sets a known type and none sets a toolName. `
        + `This workflow would walk its graph, execute nothing, and report success.`,
    });
  }

  // A type no executor handles. With a toolName the step still runs as a tool
  // call, silently ignoring what the author asked for; without one it is a
  // no-op. Either way the emitted intent is not what executes.
  for (const step of steps) {
    if (step.type !== undefined && !KNOWN_TYPES.has(step.type)) {
      errors.push({
        code: 'UNKNOWN_STEP_TYPE',
        stepId: step.stepId,
        message: `Step "${step.stepId}" has type "${step.type}", which no executor handles`,
      });
    }
  }

  for (const step of steps) {
    // Check onSuccess reference
    if (step.onSuccess && step.onSuccess !== '' && !stepIds.has(step.onSuccess)) {
      errors.push({
        code: 'DANGLING_REF',
        stepId: step.stepId,
        message: `onSuccess references non-existent step "${step.onSuccess}"`,
      });
    }
    // Check onFailure reference
    if (step.onFailure && step.onFailure !== '' && !stepIds.has(step.onFailure)) {
      errors.push({
        code: 'DANGLING_REF',
        stepId: step.stepId,
        message: `onFailure references non-existent step "${step.onFailure}"`,
      });
    }

    // Check the condition parses AND addresses something that exists.
    //
    // The parse half used to run `evaluateCondition(cond, {})` and inspect the
    // throw. That reported almost nothing: against empty data a parseable
    // predicate simply returns false, so the catch ran only for broken syntax,
    // and its `/\$\.\w/` fallback accepted any `$.token` at all. `$.output.foo`
    // — the pre-registry syntax — passed both, then read nothing on every run.
    if (step.condition) {
      let paths: string[] | null = null;
      try {
        paths = conditionFieldPaths(step.condition);
      } catch (err) {
        errors.push({
          code: 'INVALID_CONDITION',
          stepId: step.stepId,
          message: `Condition does not parse: ${(err as Error).message}`,
        });
      }

      for (const path of paths ?? []) {
        const [root, ref] = path.split('.');
        if (!CONDITION_ROOTS.has(root)) {
          errors.push({
            code: 'INVALID_CONDITION_ROOT',
            stepId: step.stepId,
            message:
              `Condition addresses "$.${path}", but "${root}" is not a readable root. `
              + `Use ${[...CONDITION_ROOTS].map(r => `$.${r}`).join(', ')}.`,
          });
        } else if (root === 'steps' && ref && !stepIds.has(ref)) {
          errors.push({
            code: 'UNKNOWN_STEP_REF',
            stepId: step.stepId,
            message: `Condition references step "${ref}", which does not exist in this workflow`,
          });
        }
      }
    }
  }

  // Check reachability: BFS from step[0]
  if (steps.length > 0) {
    const reachable = new Set<string>();
    const queue = [steps[0].stepId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const step = steps.find(s => s.stepId === id);
      if (!step) continue;
      if (step.onSuccess && step.onSuccess !== '' && !reachable.has(step.onSuccess)) {
        queue.push(step.onSuccess);
      }
      if (step.onFailure && step.onFailure !== '' && !reachable.has(step.onFailure)) {
        queue.push(step.onFailure);
      }
    }

    for (const step of steps) {
      if (!reachable.has(step.stepId)) {
        errors.push({
          code: 'UNREACHABLE_STEP',
          stepId: step.stepId,
          message: `Step "${step.stepId}" is not reachable from the entry step`,
        });
      }
    }
  }

  // D-4.7: Check tool name resolution against available catalog.
  // Only enforce when the catalog is non-empty — an empty set means the
  // catalog could not be loaded (e.g. no manifests), not that zero tools exist.
  if (availableToolNames && availableToolNames.size > 0) {
    for (const step of steps) {
      if (!step.toolName) continue;
      // Retired by the trigger-bound pass: it will not run, so its name is not
      // a claim about anything. `trigger__<op>` is an operation and no catalog
      // holds one.
      if (step.__triggerBoundSkip) continue;
      // Resolved rather than matched, so a step that named a connector alias
      // before that connector was reconnected is not treated as broken. The
      // alias is per-instance and a reconnect mints a new one; bindings already
      // survive that through resolveCurrentId, and step toolNames did not.
      const resolution = resolveStepToolName(step.toolName, availableToolNames);
      if (resolution.kind === 'ambiguous') {
        // Two accounts of the same connector offer this function. Choosing one
        // would route the step to whichever the resolver happened to find,
        // which is how a run reads the wrong inbox — so this is an error a
        // person resolves, not a guess we make.
        errors.push({
          code: 'AMBIGUOUS_TOOL',
          stepId: step.stepId,
          message:
            `Tool "${step.toolName}" matches more than one connected account `
            + `(${resolution.candidates.join(', ')}). Name the account explicitly.`,
        });
      } else if (resolution.kind === 'unknown' && resolveToolDispatch(step.toolName, isStandardTool).kind !== 'builtin') {
        // A dispatchable builtin (search, delegate_to_agent, find_teammates,
        // send_agent_message, read_agent_messages) is a UNIVERSAL platform tool,
        // not a per-agent connector — mcp-server registers it for every agent
        // and the executor dispatches it from its __builtin: branch. It is
        // legitimately absent from availableToolNames, which buildToolsSchema
        // builds from connectors / sandbox / standard / external-agent tools and
        // does NOT enumerate the platform callbacks. So a builtin resolves
        // 'unknown' here while being fully executable, and the UNDISPATCHABLE
        // check below — authoritative for builtins, and independent of the
        // catalog — is what actually vets it. Reporting UNRESOLVABLE for one is
        // a false positive that failed EVERY turn of the first self-serve
        // subscriber's agent, whose graph wired a find_teammates step. The
        // membership check still fires for a genuinely missing connector/sandbox
        // tool, which is the only thing it was ever meant to catch.
        errors.push({
          code: 'UNRESOLVABLE_TOOL',
          stepId: step.stepId,
          message: `Tool "${step.toolName}" is not in the agent's available tool catalog`,
        });
      }
    }
  }

  // Being in the catalog is not the same as being executable.
  //
  // These are two different questions and only the first was ever asked. A name
  // can be in the catalog and still have no subsystem that dispatches it: for
  // the whole life of the structured executor, every sandbox primitive, every
  // agent_slack and agent_teams tool, and `delegate_to_agent` validated clean
  // and then failed at dispatch with "no handler registered for standard tool".
  // A pre-flight audit that asks only the catalog question reports such steps
  // runnable.
  //
  // Checked independently of `availableToolNames`: dispatchability is a static
  // property of the runtime, not of what this agent happens to be bound to, so
  // it holds even when the catalog could not be loaded and the membership check
  // above is skipped.
  for (const step of steps) {
    if (!step.toolName) continue;
    const dispatch = resolveToolDispatch(step.toolName, isStandardTool);
    if (dispatch.kind === 'unresolved') {
      errors.push({
        code: 'UNDISPATCHABLE_TOOL',
        stepId: step.stepId,
        message:
          `Tool "${step.toolName}" resolves to no dispatch family — not a connector `
          + `(<alias>__<function>), sandbox primitive, agent_slack/agent_teams tool, `
          + `built-in, or standard tool. The step would fail at dispatch.`,
      });
    }
  }

  // An authored call that cannot satisfy the tool it names.
  //
  // The step above asks whether a tool NAME can be dispatched. Nothing asked
  // whether the ARGUMENTS could be. A `tool_call` step carries its arguments in
  // the graph — literally in `toolInput`, or as a template — and they were
  // checked for JSON validity and for placeholders that resolve, never against
  // the schema of the tool they are being sent to. A step naming a required
  // argument that does not exist, and omitting one that does, passed every gate
  // and failed at dispatch instead: once per fire, forever, as a generic tool
  // error with no step attached.
  //
  // A graph that calls `have_i_acted_on` rarely supplies its `target`
  // correctly. The argument is declared as an object with no properties, so
  // the shape has to be inferred from prose, and authorings infer something
  // else —
  // `{connector, tool_name, args}` or flat identifying fields, the conventions
  // the other tool calls use. `connector` is present so the tool's first guard
  // passes and the second rejects, so the duplicate-work guard those agents
  // rely on never runs.
  //
  // A redistill does not fix it. It can come back with the same step plus a
  // second one shaped the same way, because nothing refuses it at authoring
  // time either.
  //
  // STANDARD TOOLS ONLY. Their schemas are platform-defined and statically
  // knowable from this module. A connector tool's schema comes from a live
  // per-tenant cache this validator does not take, so asking the same question
  // of one would mean answering it from an absence.
  //
  // A step that authors NO arguments is left alone: trigger-bound steps have
  // theirs injected at dispatch (`{...authored, ...bound.args}`), and a static
  // check cannot see that binding. The property asserted is narrower and still
  // catches the whole observed class — a step that supplies arguments must
  // supply the required ones.
  for (const step of steps) {
    if (!step.toolName || !isStandardTool(step.toolName)) continue;
    const authored = authoredArgKeys(step);
    if (authored === null) continue;

    const schema = getStandardTool(step.toolName)?.input_schema as
      { required?: unknown } | undefined;
    const required = Array.isArray(schema?.required)
      ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];
    const missing = required.filter((r) => !authored.has(r));
    if (missing.length > 0) {
      errors.push({
        code: 'MISSING_REQUIRED_TOOL_ARG',
        stepId: step.stepId,
        message:
          `Step ${step.stepId} calls "${step.toolName}" without its required `
          + `argument${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}. `
          + `It supplies ${[...authored].map((k) => `"${k}"`).join(', ') || 'nothing'}. `
          + 'The call is refused by the tool on every fire, so the step never does what it '
          + 'was written to do.',
      });
      continue;
    }

    // PRESENT IS NOT THE SAME AS USABLE, and the check above only ever asked
    // the first question.
    //
    // `have_i_acted_on` declares `target` as an object of identifying
    // arguments. A graph that supplies `"target": "<a document id>"` names every
    // required argument, passes the check above, and is then refused by the
    // tool's own guard on every fire — `typeof payload.target === 'object'` is
    // false for a string, so the handler returns an error and the duplicate-work
    // guard never runs. The step reads as authored correctly everywhere except
    // at dispatch.
    //
    // Top-level, single-typed properties only. The control plane's authoring
    // gate validates the whole schema with ajv and is the right place for nested
    // shape, enums and formats; this is the runtime's last line for graphs
    // authored before that gate existed.
    const properties = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)
      ?.properties;
    if (!properties) continue;

    const args = authoredArgs(step);
    if (!args) continue;

    const wrongType: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      const declared = properties[key]?.type;
      if (typeof declared !== 'string') continue;
      // A `{{...}}` occupying the whole value resolves at dispatch and has no
      // type to judge here.
      if (value === WHOLE_VALUE_PLACEHOLDER) continue;
      if (!satisfiesJsonType(value, declared)) {
        wrongType.push(`"${key}" must be ${declared}, not ${
          Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
        }`);
      }
    }
    if (wrongType.length === 0) continue;

    errors.push({
      code: 'WRONG_TYPE_TOOL_ARG',
      stepId: step.stepId,
      message:
        `Step ${step.stepId} calls "${step.toolName}" with ${wrongType.join('; ')}. `
        + 'The argument is present, so nothing reads as missing, and the tool refuses the '
        + 'call on every fire anyway.',
    });
  }

  // D-4.8: Validate toolInputTemplate produces valid JSON structure.
  // Replace all {{...}} placeholders with null, then attempt JSON.parse.
  // Catches malformed JSON that the permissive substitute() engine would miss.
  for (const step of steps) {
    if (step.toolInputTemplate) {
      try {
        // Model what substitution ACTUALLY emits, which is not `null`.
        //
        // Nulling every placeholder turned `{"id":"{{input.threadId}}"}` into
        // `{"id":"null"}` — valid, and the check passed. The runtime used to
        // emit a quoted token there, producing `{"id":""abc""}`, which is not
        // JSON, and steps carrying that shape passed every check. A placeholder
        // inside a string is now substituted as escaped CONTENT, so the
        // faithful stand-in is a bare word inside a string and a JSON token
        // outside one.
        const inStr = stringContextMap(step.toolInputTemplate);
        const rendered = step.toolInputTemplate.replace(
          /\{\{[^}]+\}\}/g,
          (_m, offset: number) => (inStr[offset] ? 'X' : '"X"'),
        );
        JSON.parse(rendered);
      } catch {
        errors.push({
          code: 'INVALID_TEMPLATE',
          stepId: step.stepId,
          message: `toolInputTemplate is not valid JSON (after substituting variables with null): "${step.toolInputTemplate.slice(0, 100)}"`,
        });
      }

      // The JSON check above nulls out ANY `{{…}}`, so it says nothing about
      // whether the runtime can actually resolve them — `substitute()` matches
      // a strict root whitelist and leaves everything else in the string
      // verbatim, without logging. A string such as
      // `"price log failed for the {{now.iso}} run"` passes every check and
      // would be posted literally.
      const refs = templateRefs(step.toolInputTemplate);
      for (const bad of refs.unresolvable) {
        errors.push({
          code: 'INVALID_TEMPLATE_REF',
          stepId: step.stepId,
          message:
            `toolInputTemplate contains "${bad}", which the runtime will not substitute — `
            + `it renders literally. Readable roots are input, output, steps, item.`,
        });
      }
      for (const ref of refs.resolvable) {
        if (ref.root === 'input' && inputContract) {
          // The root whitelist above says `input` is substitutable; it says
          // nothing about whether THIS run will carry the field. That gap is
          // what shipped `{"id":"{{input.threadId}}"}` on an event payload with
          // no `threadId` at any depth, and every check called it clean.
          if (!inputPathIsResolvable(ref.path, inputContract)) {
            errors.push({
              code: 'UNKNOWN_INPUT_FIELD',
              stepId: step.stepId,
              // Two different reasons a field is unaddressable, and the message
              // has to say which. A cron fire carries no `input` object at all,
              // so listing "addressable fields" for it would be nonsense — the
              // answer is not "a different field", it is "not from a cron".
              message: inputContract.triggerType === 'cron'
                ? `toolInputTemplate reads {{input.${ref.path}}}, but a cron fire carries no `
                  + 'input at all — scheduled runs post an objective, never an inputData payload. '
                  + 'Read the value from an earlier step, or run this graph from its event trigger.'
                : `toolInputTemplate reads {{input.${ref.path}}}, which a `
                  + `${(inputContract.eventSources ?? []).join('/')} trigger does not supply. `
                  + `Addressable: ${addressableEventInputFields(inputContract.eventSources ?? [])
                    .map((f) => `input.${f}`).join(', ')}, plus input.eventData.* for the raw payload.`,
            });
          }
          continue;
        }
        if (ref.root !== 'steps') continue;
        const [stepRef] = ref.path.split('.');
        if (stepRef && !stepIds.has(stepRef)) {
          errors.push({
            code: 'UNKNOWN_STEP_REF',
            stepId: step.stepId,
            message: `toolInputTemplate references step "${stepRef}", which does not exist in this workflow`,
          });
        }
      }
    }
  }

  // ── loop.over, and `output` addressed as if it were the step registry ──
  //
  // `loop.over` was validated NOWHERE. Check 4 covers `condition`, check 5
  // covers `toolInputTemplate`, and the loop's collection was never scanned at
  // all — while a graph that runs correctly was refused by a nested-loop check
  // that this executor's model cannot even express.
  //
  // And scanning it under the existing rule would not have been enough. That
  // rule asks "is the root readable?", and `output` IS readable: it is bound to
  // the PREVIOUS step's output. So `output.s13.cards_to_update` walks
  // s13Output["s13"]["cards_to_update"], finds nothing, and throws — while
  // every check upstream called it clean. The distiller's own schema documented
  // that form, so the model followed it exactly.
  //
  // A loop whose collection never resolved ran its body ZERO times. The step
  // did not fail; it never happened, and `onFailure` is not the route for it —
  // which is why both codes here are fatal rather than degradable.
  for (const step of steps) {
    const over = step.loop?.over;
    if (over === undefined) continue;
    if (typeof over !== 'string' || over.trim() === '') {
      errors.push({
        code: 'UNRESOLVABLE_LOOP_COLLECTION',
        stepId: step.stepId,
        message: 'loop.over is empty, so the loop has no collection to iterate and its body runs zero times.',
      });
      continue;
    }
    // A loop the executor cannot run a body for.
    //
    // `executeLoopStep` dispatches per item on the step's `toolName`, or on
    // `llm_reason` / `capability` through `invokeStepLLM`. A looped step that is
    // neither walks its whole collection and executes NOTHING, then reports
    // success — the fabricated success INV-TR-004 forbids, reached by iterating
    // a body that does not exist. No runnable graph carries this shape, so it
    // is refused outright rather than baselined.
    if (!step.toolName && step.type !== 'llm_reason' && step.type !== 'capability') {
      errors.push({
        code: 'LOOP_STEP_EXECUTES_NOTHING',
        stepId: step.stepId,
        message:
          `Step "${step.stepId}" has a loop but nothing to run per item: it names no tool and `
          + 'is not a reasoning or capability step, so the loop would iterate and execute nothing. '
          + 'Give the step a toolName, or make it type llm_reason.',
      });
      continue;
    }

    // What the executor's OWN branching makes of this string. An imitation of
    // it is exactly what this defect came from.
    const ref = loopCollectionRef(over);
    if (!ref) {
      errors.push({
        code: 'UNRESOLVABLE_LOOP_COLLECTION',
        stepId: step.stepId,
        message:
          `loop.over is "${over}", which the runtime will not substitute, so the loop `
          + 'iterates nothing. Use steps.<stepId>.<field>, the placeholder form '
          + '{{steps.<stepId>.<field>}}, or a bare path read against the previous step output.',
      });
      continue;
    }
    if (ref.root === 'steps') {
      const [stepRef] = ref.path.split('.');
      if (stepRef && !stepIds.has(stepRef)) {
        errors.push({
          code: 'UNRESOLVABLE_LOOP_COLLECTION',
          stepId: step.stepId,
          message: `loop.over references step "${stepRef}", which does not exist in this workflow`,
        });
      }
    }
  }

  // `output.<existingStepId>` — a legal root addressed as though it were the
  // step registry.
  //
  // Near-zero false-positive rate, and that is the whole argument for it: a
  // step's own output does not carry a key equal to ANOTHER step's id. When it
  // does look like that, the author meant `steps.`.
  for (const step of steps) {
    const reads: Array<{ field: string; root: string; path: string }> = [];
    if (step.toolInputTemplate) {
      for (const r of templateRefs(step.toolInputTemplate).resolvable) {
        reads.push({ field: 'toolInputTemplate', root: r.root, path: r.path });
      }
    }
    if (typeof step.loop?.over === 'string' && step.loop.over.trim() !== '') {
      const r = loopCollectionRef(step.loop.over);
      if (r) reads.push({ field: 'loop.over', root: r.root, path: r.path });
    }
    for (const read of reads) {
      if (read.root !== 'output') continue;
      const [segment] = read.path.split('.');
      if (!segment || !stepIds.has(segment)) continue;
      errors.push({
        code: 'OUTPUT_ROOT_NAMES_A_STEP',
        stepId: step.stepId,
        message:
          `${read.field} reads "output.${read.path}", but "output" is the PREVIOUS step's `
          + 'output, not a map of steps — so this walks that output looking for a key named '
          + `"${segment}" and finds nothing. Use "steps.${read.path}".`,
      });
    }
  }

  // Conditions read the same `input` root through a different parser, so the
  // same contract binds. `$.input.<field>` that the trigger cannot supply is a
  // predicate that is false on every run — the branch is dead, and nothing
  // about a dead branch is visible at runtime.
  if (inputContract) {
    for (const step of steps) {
      if (!step.condition) continue;
      for (const path of conditionFieldPaths(step.condition)) {
        const [root, ...rest] = path.split('.');
        if (root !== 'input' || rest.length === 0) continue;
        if (inputPathIsResolvable(rest.join('.'), inputContract)) continue;
        errors.push({
          code: 'UNKNOWN_INPUT_FIELD',
          stepId: step.stepId,
          message:
            `condition reads $.input.${rest.join('.')}, which a `
            + `${(inputContract.eventSources ?? []).join('/')} trigger does not supply — `
            + 'the predicate would be false on every run and the branch never taken.',
        });
      }
    }
  }

  return errors;
}
