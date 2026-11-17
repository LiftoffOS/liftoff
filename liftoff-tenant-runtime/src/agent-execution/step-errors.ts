// How a workflow step's model turn ended when it did not end with an output.
//
// `invokeStepLLM` used to turn every step-ending condition into a plain
// `Error`: the engine's `completion outcome:'error'` and `outcome:'limit_reached'`
// both became `new Error(reason)`, so the loop's catch could not tell a runtime
// interruption (the step's own anomaly handler aborted the turn) from a budget
// stop or a person's stop — and classifying by message text is not acceptable,
// because the engines do not agree on the text (`openai-wire` names an abort
// "aborted"; codex reports "The operation was aborted").
//
// These are typed so the catch can decide by CLASS. The source of truth for the
// anomaly case is the step's own anomaly handler: when it returns
// `{ escalate: true }` it records the anomaly in the executor's closure, and
// the completion branch reads that rather than the engine's wording. The
// engines are untouched.
//
// Which of these may be salvaged (see the loop's step-salvage boundary):
// `StepInterruptedError` and `StepEngineError` are candidates;
// `StepLimitReachedError` and `StepAbortedError` never are — a budget stop and
// a person's stop are decisions, not interruptions.

import type { AnomalyContext, AnomalyKind } from './adapter/types';

/** The anomaly the step's handler escalated on, as the handler received it. */
export interface StepInterruptingAnomaly {
  kind: AnomalyKind;
  context: AnomalyContext;
  invocationId: string;
}

/** The step's own anomaly handler ended the turn: it returned
 *  `{ escalate: true }` and the engine aborted the model turn in response. */
export class StepInterruptedError extends Error {
  public readonly cause = 'anomaly_escalated' as const;
  public readonly anomaly: StepInterruptingAnomaly;
  constructor(stepId: string, anomaly: StepInterruptingAnomaly, reason: string | undefined) {
    super(reason ?? `step ${stepId} was interrupted by its anomaly handler`);
    this.name = 'StepInterruptedError';
    this.anomaly = anomaly;
  }
}

/** The run's own abort signal was raised while the step's turn was in
 *  flight — a hard timeout or a person's stop. */
export class StepAbortedError extends Error {
  public readonly cause = 'external_abort' as const;
  constructor(stepId: string, reason: string | undefined) {
    super(reason ?? `step ${stepId} was aborted`);
    this.name = 'StepAbortedError';
  }
}

/** The engine reported `outcome:'limit_reached'`: the step ran out of its
 *  configured budget mid-work. Not a fault, and never salvaged. */
export class StepLimitReachedError extends Error {
  public readonly reason: string;
  constructor(stepId: string, reason: string | undefined) {
    const text = reason ?? `step ${stepId} reached its limit before finishing`;
    super(text);
    this.name = 'StepLimitReachedError';
    this.reason = text;
  }
}

/** The engine reported `outcome:'error'` for a reason that is neither the
 *  step's own anomaly handler nor the run's abort signal. */
/**
 * The step reported work the evidence does not show.
 *
 * Thrown rather than returned so the step goes where every other step
 * failure goes: the hybrid loop's recovery machinery, which decides between
 * retrying it, escalating it and asking the person. That decision is not
 * this check's to make, because re-running a step is not free — a step that
 * really did send the message and only failed to prove it must not be
 * re-run blindly, and recovery is the part that knows how to weigh that.
 */
export class StepWorkNotDoneError extends Error {
  public readonly reason: string;
  public readonly probability: number;
  constructor(stepId: string, probability: number) {
    const text = `step ${stepId} reported its work as finished and the evidence does not show it was done`;
    super(text);
    this.name = 'StepWorkNotDoneError';
    this.reason = text;
    this.probability = probability;
  }
}

export class StepEngineError extends Error {
  public readonly reason: string;
  constructor(stepId: string, reason: string | undefined) {
    const text = reason ?? `adapter error in step ${stepId}`;
    super(text);
    this.name = 'StepEngineError';
    this.reason = text;
  }
}
