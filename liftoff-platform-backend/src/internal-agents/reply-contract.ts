// A graph that acts must say what it produces.
//
// Example: an agent is asked to review a pull request. It runs, succeeds,
// posts a substantive review to GitHub, and replies nothing. The person sees
// their own message and silence.
//
// Every layer below the graph can be working. The turn persists, the tools
// dispatch, the review lands. What is missing is that NOTHING ANYWHERE SAYS
// reporting back is part of the job — so nothing is missing when it does not
// happen. Three fixes sit at the wrong altitude: making the thread non-empty,
// having the platform write a line on the agent's behalf, and teaching the chat
// prompt to ask for the answer.
//
// The first two are the platform impersonating the agent. The third is a
// prompt rule, which is a hope: it costs nothing when it works and is the kind
// of instruction a model trades away under pressure. This is the same
// requirement expressed as a CONTRACT, at the only place that reaches every
// agent — the graph the distiller writes.
//
// WHY `expectedOutput` AND NOT A TERMINAL STEP TYPE. CrewAI's per-task
// `expected_output` and the OpenAI Agents SDK's `output_type` both make
// "finished with no answer" impossible by construction, and neither adds a node
// kind to do it. A declared output is also honest about the many graphs whose
// last act genuinely IS the answer: a step that posts a review to a person can
// declare that and satisfy this without an extra hop.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not demand a chat reply. An
// autonomous cron agent has no one waiting, and its terminal output feeds a
// digest rather than a thread. The property is weaker and truer: whatever a
// graph finishes by doing, it must have declared what that produces.

import type { WorkflowStep } from './types';
import { isAnnounceTool } from './announce-gating';

export interface ReplyContractProblem {
  stepId: string;
  message: string;
}

/**
 * Is somebody waiting for this workflow to answer?
 *
 * `manual` means a person asked and is watching a thread. `cron` and `event`
 * fire on their own, and their output feeds a digest rather than a reader.
 *
 * This distinction is the whole reason the producer rule below is conditional.
 * A first attempt applied it to every graph and was reverted before shipping,
 * because it would have added a model call to every cron fire to write a summary
 * with no reader — a real cost paid forever to close a gap that only exists when
 * someone is waiting.
 *
 * Unknown or absent types are treated as HAVING a reader. Distillation defaults
 * toward cron, so guessing the other way would silently exempt the exact graphs
 * this is for whenever the type is missing or new.
 */
function hasReader(triggerConfig: { type?: string } | undefined): boolean {
  const type = triggerConfig?.type;
  if (type === 'cron' || type === 'event') return false;
  return true;
}

/** Steps that end the run: no `onSuccess`, or an explicit empty one. The graph
 *  language treats an empty string as terminate. */
function isTerminal(step: WorkflowStep): boolean {
  const next = (step as { onSuccess?: string }).onSuccess;
  return next === undefined || next === null || next === '';
}

/** Steps that only decide, and never produce anything a person receives.
 *  Requiring a declared output from a `delay` would be noise. */
const NON_PRODUCING_TYPES = new Set(['delay']);

/**
 * Terminal steps that finish the work without declaring what it produced.
 *
 * Reported per step rather than per graph so the retry feedback can name the
 * one that needs the line, the way the other distiller rules do.
 *
 * `ask_user` is exempt: its output IS the question, the runtime surfaces it as
 * a first-class pause, and a graph that ends by asking has not finished.
 */
export function findMissingReplyContract(
  steps: WorkflowStep[],
  triggerConfig?: { type?: string },
): ReplyContractProblem[] {
  if (!Array.isArray(steps) || steps.length === 0) return [];

  const readerWaiting = hasReader(triggerConfig);
  const out: ReplyContractProblem[] = [];
  for (const step of steps) {
    if (!isTerminal(step)) continue;
    const type = (step as { type?: string }).type ?? '';
    if (NON_PRODUCING_TYPES.has(type) || type === 'ask_user') continue;

    // DECLARING AN OUTPUT IS NOT PRODUCING ONE.
    //
    // A `tool_call` step's output is the TOOL's response. It cannot write a
    // summary, so a graph ending on `github__create_review` that declares "a
    // summary of what the review found" has made a promise no step in it can
    // keep — the original defect wearing a contract.
    //
    // Only enforced when someone is waiting. On a cron or event graph the
    // terminal action IS the outcome and there is no reader, so demanding a
    // reporting step would buy a model call per fire and nothing else.
    //
    // The exception, even with a reader: a tool whose whole purpose is telling a
    // person something. There the call IS the report. Same predicate the
    // announce gate uses, so the two rules cannot drift on what counts as
    // telling someone.
    if (
      readerWaiting
      && type === 'tool_call'
      && !isAnnounceTool((step as { toolName?: string }).toolName)
    ) {
      out.push({
        stepId: step.stepId,
        message:
          `Step ${step.stepId} ends the workflow with a tool call, so nothing in this workflow `
          + 'produces an answer for the person who asked. A tool_call step outputs the TOOL\'s '
          + 'response, not a report. Add a final `llm_reason` step that reads the earlier steps '
          + 'and writes what happened in their terms, and put the `expectedOutput` on that step. '
          + 'If the tool call itself is what tells them (a message to a channel, a notification), '
          + 'that is already the report and no extra step is needed.',
      });
      continue;
    }

    const declared = (step as { expectedOutput?: string }).expectedOutput;
    if (typeof declared === 'string' && declared.trim().length > 0) continue;

    out.push({
      stepId: step.stepId,
      message:
        `Step ${step.stepId} ends the workflow but does not declare an \`expectedOutput\`. ` +
        'Add one line saying what this workflow produces for the person who asked, in their ' +
        'terms. If the work lands somewhere else (a pull request, a document, a channel), the ' +
        'output is what they are TOLD, not the fact that it happened: "a short summary of what ' +
        'the review found and what to do about it" rather than "the review is posted". A ' +
        'workflow that acts and then reports nothing leaves the person unable to tell finished ' +
        'work from a request that never ran.',
    });
  }
  return out;
}
