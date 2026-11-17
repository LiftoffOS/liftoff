// An announcement must be conditional on the work having happened.
//
// The Code Reviewer posted ~15 "Review ready" messages about one pull request
// in a morning and produced exactly ONE actual review. Its graph reads:
//
//   s8  llm_reason   outputField: inlineResult    -> s9
//   s9  llm_reason   outputField: summaryPosted   -> s10
//   s10 tool_call    slack send                   (no condition)
//
// s9 already declares `summaryPosted`. Nothing reads it.
//
// The subtle part, and the reason this is a distiller rule rather than a bug in
// one graph: s8 and s9 are `llm_reason` steps, so their success means THE MODEL
// FINISHED REASONING, not that the comment posted. The GitHub write failed
// inside them — an out-of-diff line position — the step still "succeeded", and
// s10 dutifully announced work that had not happened. Gating s10 on s8/s9
// "succeeding" would have changed nothing; they did succeed.
//
// So the property is: a step that ANNOUNCES an outcome must be reachable only
// through a condition that reads the acting step's declared output. The graph
// language already has exactly this — the same agent's s3 gates on
// `$.steps.s2.selected == true` — it simply was not applied to the announcement.
//
// Withheld as a reject rather than a prompt preference, for the same reason
// Rule 6 became deterministic: a soft preference the distiller can ignore is a
// defect class this codebase has been bitten by repeatedly.

import type { WorkflowStep } from './types';

/** Tools whose purpose is to tell a human something happened. */
const ANNOUNCE_TOOL_PATTERNS: RegExp[] = [
  /^slack_(send_message|reply_in_thread|send_dm|update_message)$/,
  /^notifications_send$/,
  /__(send_message|post_message|send_dm|reply_in_thread|send_email|send_mail)$/,
];

export function isAnnounceTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return ANNOUNCE_TOOL_PATTERNS.some((re) => re.test(toolName));
}

export interface AnnounceGateProblem {
  stepId: string;
  actingStepId: string;
  outputField: string;
  message: string;
}

/** Announce steps that fire regardless of whether the work landed.
 *
 *  Reports only when there is something concrete to gate on: the acting step
 *  declares an `outputField`. Without one there is no fact to test, and
 *  demanding a condition the author cannot write would be noise — that is a
 *  different defect (an acting step that records nothing) and is not smuggled
 *  in here.
 */
export function findUngatedAnnouncements(steps: WorkflowStep[]): AnnounceGateProblem[] {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const out: AnnounceGateProblem[] = [];

  for (const step of steps) {
    if (!isAnnounceTool(step.toolName)) continue;
    // Already gated: a condition on the announce step itself is the author
    // having done exactly what this rule asks for.
    if (step.condition) continue;

    // Who routes into it, and did they record whether the work happened?
    for (const pred of steps) {
      if (pred.onSuccess !== step.stepId) continue;
      const field = (pred as { outputField?: string }).outputField;
      if (!field) continue;
      // A condition anywhere on the predecessor already tests something.
      if (pred.condition) continue;
      // The predecessor may itself be a gate that reads the field.
      const ref = `steps.${pred.stepId}.${field}`;
      if (steps.some((s) => s.condition?.includes(ref))) continue;

      out.push({
        stepId: step.stepId,
        actingStepId: pred.stepId,
        outputField: field,
        message:
          `Step ${step.stepId} announces an outcome but is reachable unconditionally from `
          + `${pred.stepId}, which records \`${field}\`. An llm_reason step SUCCEEDS when the `
          + `model finishes reasoning, not when its tool calls land — so ${pred.stepId} can `
          + `succeed with the work having failed, and ${step.stepId} then reports work that `
          + `never happened. Gate it: give ${step.stepId} a condition on `
          + `\`$.steps.${pred.stepId}.${field}\`, and route the negative case to a step that `
          + `says nothing was posted rather than to the announcement.`,
      });
      break;
    }
  }
  return out;
}
