// Did the step actually do the work, or only say so?
//
// A model reporting its own success is not evidence of success. The runtime
// already refuses to let one step's model declare the whole workflow done,
// and a step that declares an output field is checked for the SHAPE of what
// it recorded. Neither of those can disagree with a step that describes the
// work convincingly and did not do it.
//
// The usual answer is to ask a second large model to grade the first, and it
// is the wrong one: it doubles the latency of every step to buy an opinion
// from the same kind of thing that just gave one, and a model asked to grade
// prose is swayed by prose. This asks a model that answers in milliseconds
// over a fixed question with a probability attached, and cannot narrate its
// way to a yes.
//
// WHAT HAPPENS ON A NO is deliberately not decided here. This answers the
// question; the caller hands an unproven step to the recovery machinery that
// already exists, which decides between retrying, escalating and asking the
// person. That matters because re-running a step is not free: a step that
// really did send the message and merely failed to prove it must not be
// re-run blindly, and recovery is the part that knows how to weigh that.

import { sanitizeBrowserText } from '@liftoffos/redact';
import { logger } from '../infrastructure/logging';
import { ask } from './client';
import {
  asEntry, WORK_DONE_CHECK_SET, WORK_DONE_EVIDENCE_MAX_CHARS, WORK_DONE_OBJECTIVE_MAX_CHARS,
} from './questions';

export interface WorkDoneEvidence {
  /** What the step was asked to do. */
  objective: string;
  /** What the step said when it finished. */
  said: string;
  /** What it did: the tools it called, in order, by name. */
  did: string[];
  /** What it recorded as its output, when it declares one. */
  recorded?: unknown;
  /** Its own report, when it made one. */
  claimed?: string;
}

export interface WorkDoneCheckInput extends WorkDoneEvidence {
  tenantId: string;
  runtimeAgentId?: string;
  invocationId?: string;
  deadlineMs: number;
}

export interface WorkDoneVerdict {
  done: boolean;
  probability: number;
}

/** How long the check may take. Past this the step stands: a check that
 *  could not run knows nothing, and holding up real work on it would be the
 *  slow self-check this exists to avoid. */
export const WORK_DONE_TIMEOUT_MS = 6_000;

/** The tools a step called, bounded and in order. Names only: an argument can
 *  carry a person's data, and the question is what was done, not with what. */
function toolTrail(did: string[]): string[] {
  return did.slice(-40);
}

/**
 * Ask whether the evidence shows the work was done.
 *
 * Answers null when the question could not be put, which the caller treats
 * as "no opinion" and lets the step stand. A check that fails closed would
 * turn a vendor outage into a runtime that cannot finish a step.
 */
export async function checkWorkDone(input: WorkDoneCheckInput): Promise<WorkDoneVerdict | null> {
  const objective = sanitizeBrowserText(input.objective, WORK_DONE_OBJECTIVE_MAX_CHARS).text.trim();
  if (!objective) return null;
  const said = sanitizeBrowserText(input.said ?? '', WORK_DONE_EVIDENCE_MAX_CHARS).text;
  const recorded = input.recorded === undefined || input.recorded === null
    ? ''
    : sanitizeBrowserText(JSON.stringify(input.recorded) ?? '', WORK_DONE_EVIDENCE_MAX_CHARS).text;

  const answered = await ask(
    WORK_DONE_CHECK_SET,
    asEntry({
      objective,
      evidence: {
        what_it_said: said,
        what_it_did: toolTrail(input.did),
        what_it_recorded: recorded,
        ...(input.claimed ? { what_it_reported: input.claimed } : {}),
      },
    }),
    {
      deadlineMs: input.deadlineMs,
      tenantId: input.tenantId,
      ...(input.runtimeAgentId ? { runtimeAgentId: input.runtimeAgentId } : {}),
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    },
  );
  if (!answered) return null;

  const probability = Number(answered.answers.work_done?.noul);
  if (!Number.isFinite(probability)) return null;
  const threshold = WORK_DONE_CHECK_SET.thresholds.DONE_T as number;
  const verdict = { done: probability >= threshold, probability };
  logger.info(
    {
      tenantId: input.tenantId, event: 'work_done_check',
      done: verdict.done, probability, tools: input.did.length,
    },
    verdict.done ? 'the evidence shows the step did the work' : 'the step reported work the evidence does not show',
  );
  return verdict;
}
