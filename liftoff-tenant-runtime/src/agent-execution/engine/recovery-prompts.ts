/**
 * recovery-prompts — pure prompt-template module for the hybrid execution
 * engine's recovery LLM call. Per D13 in the plan, extracted from day one
 * for testability and clean separation. No service / DB / LLM dependencies.
 *
 * Every interpolated value that arrives from a TOOL or a CALLER — step output,
 * received shapes, error strings — routes through `truncateForPrompt` with a
 * per-field budget, because those have no size contract and would otherwise
 * blow the model's context window.
 *
 * Authored instructions are handled differently, and the distinction matters.
 * A step's `description` is bounded at write time (platform-backend
 * `internal-agents/workflow-step-limits.ts`) and IS the instruction the model
 * must follow, so it is never shortened here. Interpolating the whole
 * `workflowSteps` array through a byte cap used to break that: one ambitious
 * description could exceed the cap on its own, at which point the
 * shape-preserving shrink cut every string to 200 characters and a positional
 * slice dropped the tail of the workflow — so the recovery model chose a
 * `nextStepId` while unable to see the steps it was choosing between.
 *
 * The prompt therefore keeps two separate views:
 *   - the PLAN view: what the workflow is (ids, kinds, tools, short labels).
 *     Bounded by construction — at most 50 steps, each contributing a fixed
 *     label — so its size does not depend on how long the descriptions are.
 *   - the RECOVERED STEP: the failing step's objective, verbatim, because that
 *     is the text the model has to act on.
 */

import type { AnomalyContext, WorkflowStep } from '../types';
import { truncateForPrompt } from './truncate-for-prompt';
import { AGENT_VOICE_BLOCK } from '../../interactive-chat/agent-voice';
import { UNTRUSTED_CONTENT_NOTICE } from '../../workspace/untrusted-content-wrapper';
import { frameUntrusted } from '../../workspace/untrusted-content-wrapper';

/** Tenant + agent for injection SCREENING, which frameUntrusted performs
 *  alongside the framing itself. Optional so a caller that has no context still
 *  gets the delimiters; screening is the detection half and degrades on its own. */
export interface RecoveryScreenContext {
  tenantId: string;
  agentId?: string;
}

/** Bound an untrusted value and mark it as DATA in one step.
 *
 *  Every value this wraps arrived from outside this file: a connector's error
 *  text, a tool's output, a reviewer's typed reason, a person's chat message.
 *  The recovery advisor reads all of it and then writes text that is rendered
 *  to a customer, so a poisoned tool error had a straight path to steering what
 *  a person is told to go and do.
 *
 *  This was the one model call in the runtime touching tool output without it.
 *  mcp-bridge, hitl-card-content, sandbox-executor, mcp-server and
 *  routine-script all frame; the advisor interpolated raw.
 *
 *  Truncation happens BEFORE framing so the delimiters survive the byte cap
 *  intact — bounding afterwards could cut the closing delimiter off and leave
 *  an unterminated block. */
function untrusted(
  source: string,
  value: unknown,
  maxBytes: number,
  screen?: RecoveryScreenContext,
): string {
  return frameUntrusted(
    `recovery:${source}`,
    truncateForPrompt(value, maxBytes),
    undefined,
    screen ? { tenantId: screen.tenantId, agentId: screen.agentId } : undefined,
  );
}

export interface PriorRecovery {
  stepId: string;
  anomalyKind: string;
  decision: string;
  kind: 'fresh' | 'recovery_of_recovery';
}

/**
 * Characters of a description used as a step's label in the plan view.
 *
 * The plan view answers "what does this workflow consist of, and where am I in
 * it" — enough for the model to pick a `nextStepId` and understand what comes
 * after. It is not where the model reads an instruction: the step it is
 * recovering is rendered in full below, and any other step's full text is
 * available on the next iteration once execution reaches it. So this is a
 * display budget over a summary, not a bound on authored content.
 */
const PLAN_LABEL_CHARS = 200;

/** Collapse a description to one readable line for the plan view. */
function planLabel(description: string): string {
  const oneLine = (description ?? '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PLAN_LABEL_CHARS) return oneLine;
  return `${oneLine.slice(0, PLAN_LABEL_CHARS)}…(+${oneLine.length - PLAN_LABEL_CHARS} chars)`;
}

/**
 * Render the workflow as a numbered list of steps.
 *
 * Deliberately hand-built rather than serialised: JSON of the array is both
 * larger and less legible, and serialising is what forced a byte cap in the
 * first place. Every step is named — the model selects `nextStepId` from this
 * list, so a step it cannot see is a step it cannot route to.
 */
function buildPlanView(workflowSteps: WorkflowStep[], currentStepId: string): string {
  if (workflowSteps.length === 0) {
    return '(No multi-step plan — this run is executing a single step.)';
  }
  return workflowSteps
    .map((step, index) => {
      // A step that sets toolName without setting type is a tool_call by
      // back-compat default (see WorkflowStep.type).
      const kind = step.type ?? (step.toolName ? 'tool_call' : 'llm_reason');
      const tool = step.toolName ? `: ${step.toolName}` : '';
      const marker = step.stepId === currentStepId ? ' ← current step' : '';
      return `${index + 1}. ${step.stepId} [${kind}${tool}]${marker} — ${planLabel(step.description)}`;
    })
    .join('\n');
}

/**
 * Build the full recovery prompt for the LLM. See plan §"Recovery prompt
 * template (engine/recovery-prompts.ts)" for the structure rationale.
 */
export function buildRecoveryPrompt(
  anomaly: AnomalyContext,
  workflowSteps: WorkflowStep[],
  stepOutput: unknown,
  currentStepId: string,
  priorRecoveries: PriorRecovery[],
  perStepRecoveries: number,
  totalRecoveries: number,
  /** Structured tool-error contract when the anomaly came from a classified
   *  connector failure (ToolExecutionError). Lets the recovery LLM start from
   *  the classified cause + suggested recovery instead of re-deriving it. */
  toolErrorContract?: { code: string; recovery: string },
  /** Tenant + agent, for the injection screening frameUntrusted runs on every
   *  untrusted value below. Absent in unit tests and older callers, which still
   *  get the framing. */
  screen?: RecoveryScreenContext,
  /** Facts the caller authored for this decision. `selfAnswerHint` is the ask
   *  check's fixed sentence (ask-check.ts) when the advisor's previous
   *  `ask_user` asked for a value the run already holds: rendered here, in the
   *  state section, and never into the conversation's messages. */
  facts?: { selfAnswerHint?: string },
): string {
  const planView = buildPlanView(workflowSteps, currentStepId);
  // The prior step's output is tool data by definition.
  const truncatedOutput = untrusted('step_output', stepOutput, 2048, screen);
  // Our own loop's record, but it quotes the tool errors that produced it, so a
  // poisoned one re-enters here on the next attempt. Framed for that reason.
  const truncatedHistory = priorRecoveries
    .slice(-3)
    .map(r => untrusted('prior_recovery', r, 256, screen))
    .join('\n');

  // The array is the source of truth for the plan; the anomaly's own step is the
  // fallback for single-step and chat-mode recoveries that pass no array.
  const recoveredStep =
    workflowSteps.find(step => step.stepId === currentStepId) ?? anomaly.step;

  return [
    `You are running an autonomous workflow on behalf of a user. Something needs your attention.`,
    ``,
    `# The workflow you're executing`,
    `Current step: ${currentStepId}`,
    planView,
    ``,
    // Verbatim, and in its own section: for an llm_reason step this text IS the
    // prompt, and for a tool_call step it is the acceptance criteria the model
    // needs in order to judge whether a retry would satisfy the objective.
    `# The step you're recovering, in full`,
    `Step "${recoveredStep.stepId}" objective:`,
    recoveredStep.description,
    ``,
    `# What just happened at step "${currentStepId}"`,
    anomalySpecific(anomaly, screen),
    ...(toolErrorContract
      ? [
          ``,
          `# Classified cause (from the connector error contract)`,
          `- Error class: ${toolErrorContract.code}`,
          `- Recommended next step: ${truncateForPrompt(toolErrorContract.recovery, 512)}`,
        ]
      : []),
    ``,
    `# State at the moment of failure`,
    `- Prior step's output: ${truncatedOutput}`,
    `- Number of recovery attempts so far on this step: ${perStepRecoveries}`,
    `- Total recovery attempts this run: ${totalRecoveries}`,
    ...(facts?.selfAnswerHint ? [`- ${facts.selfAnswerHint}`] : []),
    priorRecoveries.length > 0
      ? `- Recent recovery history (most recent first):\n${truncatedHistory}\n  If the same step has failed multiple times, prefer escalating with a meaningful message instead of retrying.`
      : `- No prior recovery attempts.`,
    ``,
    `# Decide`,
    `Record your decision by calling the \`recovery_decision\` tool exactly once. It is your`,
    `ONLY tool call — do not invoke the workflow's tools directly; propose them in \`toolCalls\`.`,
    `Set \`decision\` to one of:`,
    `- continue: retry the step (optionally with modified tool inputs in toolCalls; optionally jump forward to nextStepId)`,
    `- complete: the workflow has met its objective; output a final result`,
    `- escalate: someone has to act before this can continue; provide escalationReason, whoCanUnblock and requestedAction`,
    `- fail: terminal failure; provide failureReason`,
    `- ask_user: you need specific information from the user to continue; provide userQuestion (plain text)`,
    ``,
    `Decision priority:`,
    `- If you've already recovered this step 3+ times without success, prefer escalate over continue.`,
    `- If the user needs to provide context to continue (e.g. "which sheet?"), prefer ask_user.`,
    `- If the failure is environmental (auth, kill-switch, downstream service down), prefer escalate with whoCanUnblock='platform' — nobody in the customer's workspace can fix a broken connector or an unreachable provider.`,
    `- Use whoCanUnblock='customer' only when someone in their workspace can genuinely clear it: grant access, unpause an agent, choose between options, supply a value. If unsure, say platform.`,
    `- If the failure is parameter-related (you can figure out a better input), prefer continue with modified toolCalls.`,
    `- If you've gathered enough output already and the rest is optional, complete with the gathered output.`,
    ``,
    // Three of the fields above are read verbatim by a CUSTOMER, and until this
    // section existed nothing in this prompt said so. The advisor was treated as
    // platform machinery — the call site said as much in a comment — while
    // `requestedAction` and `escalationReason` were being concatenated into the
    // question on the review page and `userQuestion` was being rendered there
    // whole. The result read exactly like internal machinery talking: raw
    // credential ids, HTTP status codes, vendor exception names.
    //
    // The rules below are the same block every customer-facing surface already
    // carries (chat, autonomous runs, Liftoff, Insights). Naming the audience is
    // the load-bearing half: a model that does not know a person is reading
    // writes a log line, and a log line is what was shipping.
    `# Who reads what you write`,
    `\`userQuestion\`, \`requestedAction\` and \`escalationReason\` are shown to a person`,
    `in this workspace, word for word, on a page where they are being asked to act.`,
    `They are not log lines and they are not for us. Write them to that person:`,
    `say what to do and why it is needed, and leave out anything they cannot act on`,
    `— internal identifiers, status codes, exception class names, stack traces.`,
    `Name the connection or the document they know by name, not the record we`,
    `store it under. Every other field on the tool is ours and may stay technical.`,
    // The reason is also the RECORD when the run ends rather than parks, and a
    // record has to be true. An advisor handed three "internal error" texts for
    // three guessed addresses wrote "the web fetching service could not
    // retrieve any of the target URLs" beside thirty pages the same step had
    // fetched. It had observed three tool results and described a platform.
    `In escalationReason, state only what the tool results showed. Do not describe`,
    `platform state you did not observe: three failed calls are three failed calls,`,
    `not a service that is down.`,
    ``,
    AGENT_VOICE_BLOCK,
    ``,
    // The advisor is handed the failing step's tool error, the prior step
    // output and any message a person sent mid-run, each of them framed by
    // `untrusted()` below. Without this block the markers arrive unexplained.
    UNTRUSTED_CONTENT_NOTICE,
  ].join('\n');
}

function anomalySpecific(a: AnomalyContext, screen?: RecoveryScreenContext): string {
  switch (a.kind) {
    case 'tool_error':
      return `Step "${a.step.stepId}" called ${a.step.toolName ?? '(no tool)'} and got: ${untrusted('tool_error', a.error, 1024, screen)}. The tool call ran, but returned an error.`;
    case 'hitl_rejected':
      return `Step "${a.step.stepId}" was rejected by the human reviewer with reason: ${untrusted('anomaly_reason', a.reason, 1024, screen)}. The tool was in sensitive category "${a.matchedCategory ?? '(unspecified)'}". The user has declined this specific action; consider an alternative or escalate.`;
    case 'guardrail_blocked':
      return `Step "${a.step.stepId}"'s output was blocked by an output guardrail: ${untrusted('anomaly_reason', a.reason, 1024, screen)}. The tool produced output that violated a policy. Consider whether you can refine the inputs to produce acceptable output, or escalate.`;
    case 'snapshot_unavailable':
      return `Step "${a.step.stepId}" could not fetch the required prior state: ${untrusted('anomaly_reason', a.reason, 1024, screen)}. Underlying data may be temporarily unreachable. Retry, wait-and-retry, or escalate.`;
    case 'timeout':
      return `Step "${a.step.stepId}" exceeded its ${a.elapsedMs}ms timeout. The remote system may be slow or unresponsive. Retry, or escalate if you suspect a structural problem.`;
    case 'admission_denied':
      return `Step "${a.step.stepId}" was blocked by an admission policy: ${untrusted('anomaly_reason', a.reason, 1024, screen)}. This is typically a kill-switch or rate-limit. Retry is not appropriate; escalate.`;
    case 'template_expansion':
      return `Step "${a.step.stepId}" referenced "${a.reference}" in its tool-input template but that path didn't resolve in the prior step's output. Either the prior step returned an unexpected shape, or the template references the wrong path. Inspect and propose retry with modified toolCalls.`;
    case 'output_shape': {
      // Three call sites reach this now, and the wording has to be true for all
      // of them: a TOOL result missing its outputField, an LLM_REASON output
      // missing it, and an adapter reporting malformed_output — which carries
      // no field name at all, so `expected: ''` used to render the sentence
      // `expected outputField ""`. The old text named only "the tool result"
      // and "the remote API", which was wrong for the LLM branch and described
      // the one case that, until the tool branch stopped silently swallowing
      // the miss, could never actually arrive here.
      const what = a.expected
        ? `expected to find the field "${a.expected}" on step "${a.step.stepId}"'s output, but it was missing or undefined`
        : `could not read step "${a.step.stepId}"'s output in the shape the workflow declares`;
      return `The workflow ${what}. Received: ${untrusted('received_output', a.received, 2048, screen)}. `
        + `Either the step produced a different shape than the workflow declares — a remote API changing its envelope, an error returned where data was expected, or a reasoning step answering in prose — or the declared field path is simply wrong. `
        + `The value above is what the step ACTUALLY produced, so check whether what you need is present under a different path before retrying: the call already succeeded and its side effects already happened. Decide between retrying with modified inputs, continuing without the field, and escalating.`;
    }
    case 'anomalous_value':
      return `Step "${a.step.stepId}"'s output failed semantic validation: ${untrusted('anomaly_reason', a.reason, 1024, screen)}. Value: ${untrusted('anomalous_value', a.value, 2048, screen)}. The value parsed correctly but doesn't make sense for what the step was supposed to produce.`;
    case 'user_message_during_run':
      // Sliced rather than run through truncateForPrompt: that JSON-quotes its
      // input, which reads as `"Ada Lovelace" sent a message` in prose.
      return `${a.senderDisplayName ? `${a.senderDisplayName.slice(0, 128)} sent a message` : 'The user sent a message'} while you were running step "${a.step.stepId}": ${untrusted('user_message', a.userMessage, 2048, screen)}. This is an interrupt — they may be redirecting, clarifying, or asking a question. Threads are shared, so this may be someone other than whoever started the run. Respond by either continuing your current plan with their input incorporated, pivoting, escalating, or asking them a follow-up clarification.`;
    case 'llm_reason_failure':
      // The objective is not repeated here: it appears verbatim in "The step
      // you're recovering, in full" above. It used to be inlined at a 512-byte
      // cap, which shrank an authored instruction to ~200 characters — the same
      // defect as the old whole-array cap, in a second place.
      return `Step "${a.step.stepId}" was an LLM reasoning step that failed: ${untrusted('tool_error', a.error, 1024, screen)}. Its objective is stated in full above. You may not be able to retry an LLM-reasoning step the same way and expect a different result; consider modifying inputs or escalating.`;
    case 'user_answered_clarification':
      return `You previously asked the user: ${untrusted('original_question', a.originalQuestion, 2048, screen)}. They answered: ${untrusted('user_answer', a.userAnswer, 2048, screen)}. Continue the workflow incorporating this answer. If the answer is a cancellation or refusal, prefer 'fail' with an appropriate failureReason. If the answer is unrelated to your question, ask a follow-up clarification.`;
    case 'recovery_proposal_rejected':
      // The names are catalog names the runtime resolved, not model text, so
      // they are rendered plainly rather than as untrusted content.
      return `Your previous proposal for step "${a.step.stepId}" was NOT executed. It named ${a.rejected.length === 1 ? 'a tool' : 'tools'} that recovery may not call: ${a.rejected.map((n) => `"${n}"`).join(', ')}. `
        + `A repair of a step may call ONLY a tool this workflow already names in one of its steps, or a read-only tool (a lookup that changes nothing). `
        + `A write to anything the workflow never names is a new action nobody approved, not a repair, so the whole proposal was rejected rather than run in part. `
        + `Propose again using only those tools, or escalate if the step cannot be repaired within them.`;
  }
}
