// The turn that continues a run after a person decided on a gated call.
//
// The resumed half re-enters the conversational loop, which opens on whatever
// `resumeUserTurn` says and, absent one, on the OBJECTIVE again, wrapped as a
// fresh task assignment. A model handed its original task after the approved
// call already ran reads it as "do the whole thing", and does: the request goes
// out a second time, under an approval that covered it once.
//
// So the opening turn names the decision, per call, and asks for the task to
// be completed from where it stopped. What the model is told is the OUTCOME
// the dispatch recorded (completed, failed, not carried out), never a result
// it did not get: the result itself sits on the transcript as the call's tool
// result, where the model reads it the way it reads every other result.
//
// Attributed as the platform continuing the task, through the same framing
// the verify-on-stop nudge uses, because that is what it is. A person made the
// decision; the platform is the one speaking.

import { frameSystemContinuation } from './interrupt-framing';
import type { ToolCallResult } from './types';

/** The identity of a gated call, as the pause and the grant both carry it. */
export interface ContinuationCall {
  id: string;
  name: string;
}

/** One line per approved call, naming what the dispatch recorded for it. A
 *  result is matched to its call by id, never by position: the dispatcher
 *  merges results back into the approved order, but a call nothing answered
 *  is reported as exactly that rather than given its neighbour's outcome. */
function approvedOutcomeLines(calls: ContinuationCall[], results: ToolCallResult[]): string {
  const byId = new Map(results.map((r) => [r.id, r]));
  return calls
    .map((call) => {
      const r = byId.get(call.id);
      if (!r) return `- ${call.name}: no result was recorded`;
      if (r.success) return `- ${call.name}: completed`;
      return `- ${call.name}: failed (${r.error ?? 'no error text'})`;
    })
    .join('\n');
}

/** The continuation turn after an approval: the person said yes, the calls
 *  were carried out, and here is how each one ended. */
export function approvedContinuationTurn(calls: ContinuationCall[], results: ToolCallResult[]): string {
  const plural = calls.length !== 1;
  return frameSystemContinuation({
    text:
      `A person reviewed the ${plural ? 'actions' : 'action'} you proposed and approved ${plural ? 'them' : 'it'}. `
      + `${plural ? 'They have' : 'It has'} now been carried out on your behalf:\n`
      + `${approvedOutcomeLines(calls, results)}\n`
      + `The result of each call is on the transcript as that call's tool result. `
      + `Do not send or perform ${plural ? 'these actions' : 'this action'} again. `
      + 'Continue the task from this point and complete it. If nothing remains, report what was done.',
  });
}

/** The continuation turn after a rejection: the person said no, nothing was
 *  carried out, and the reason, when one was given. */
export function rejectedContinuationTurn(calls: ContinuationCall[], rejectionReason: string | undefined): string {
  const plural = calls.length !== 1;
  const reason = rejectionReason?.trim();
  return frameSystemContinuation({
    text:
      `A person reviewed the ${plural ? 'actions' : 'action'} you proposed and rejected ${plural ? 'them' : 'it'}`
      + `${reason ? `, giving this reason: ${reason}` : ''}. `
      + `${plural ? 'They were' : 'It was'} not carried out:\n`
      + `${calls.map((call) => `- ${call.name}: not carried out`).join('\n')}\n`
      + `Do not attempt ${plural ? 'these actions' : 'this action'} again. `
      + `Continue the task without ${plural ? 'them' : 'it'} and complete what you can, `
      + `or explain what cannot be completed without ${plural ? 'them' : 'it'}.`,
  });
}

/** One delegated task's outcome, as the coordinator recorded it. */
export interface DelegatedOutcome {
  childTaskId: string;
  success: boolean;
  error?: string;
}

/** The continuation turn after a delegation fan-in: the tasks the run handed
 *  out have reported, and here is how each one ended. The results themselves
 *  are on the transcript as the spawn call's tool result. */
export function delegationContinuationTurn(results: DelegatedOutcome[]): string {
  const plural = results.length !== 1;
  const lines = results.map((r) => `- ${r.childTaskId}: ${r.success ? 'completed' : `failed (${r.error ?? 'no error text'})`}`);
  return frameSystemContinuation({
    text:
      `The ${plural ? 'tasks' : 'task'} you delegated ${plural ? 'have' : 'has'} finished:\n`
      + `${lines.length > 0 ? lines.join('\n') : '- no task reported a result'}\n`
      + `${plural ? 'Their' : 'Its'} results are on the transcript as the tool result of the call that delegated them. `
      + 'Do not delegate the same work again. Continue the task from this point and complete it.',
  });
}

/** The continuation turn after a person answered the question the run asked.
 *  The question is repeated so the answer is read against it: the run resumes
 *  in a fresh turn, and a bare answer would arrive with nothing to resolve it
 *  against. */
export function clarificationContinuationTurn(question: string, answer: string): string {
  return frameSystemContinuation({
    text:
      'A person answered the question you asked.\n'
      + `Question: ${question.trim()}\n`
      + `Answer: ${answer.trim()}\n`
      + 'Continue the task with this answer and complete it. Do not ask the same question again.',
  });
}
