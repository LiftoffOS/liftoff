// Character budgets for the unbounded values interpolated into a workflow step's
// prompt, and where their numbers come from.
//
// This file exists because the bug that produced it was a number nobody could
// justify. A step description was bounded at 500 in one place, 512 in another,
// 1000 in a third and truncated to ~200 at execution, and each of those was
// picked by intuition. So: no budget here without a stated derivation.
//
// ── What is being bounded ───────────────────────────────────────────────────
//
// A step prompt carries four things: the step's objective (authored, bounded at
// write time at 10,000 characters, passed through verbatim), the prior step's
// output, the workflow's input data, and a short instruction about the output
// field. Only the middle two arrive with no size contract, so only they are
// bounded.
//
// ── Why 8,192, and not 2,048 or 50,000 ─────────────────────────────────────
//
// Nothing persists a step output, so its distribution cannot be queried. But a
// step output is not an independent quantity: it is a tool result, usually
// narrowed by the step's `outputField`, or a prior llm_reason step's text. The
// tool-result distribution IS measured (adapter/tool-result-bound.ts): ordinary
// results run from hundreds to a few thousand characters, with a thin tail out
// to tens of thousands. Since `outputField` extraction only ever narrows, that
// distribution is an upper bound on step output. Reading the budget off it:
//
//   - 8,192 sits above p95 with room to spare, so the ordinary case passes
//     through untouched and is never summarised at all.
//   - 2,048 would sit BELOW p95. That is the measurable defect: more than one
//     handoff in twenty would be cut, positionally, with no signal.
//   - Going as high as the 50,000 tool-result bound would defeat the mechanism.
//     The tail past p99 is exactly what should route into compression and
//     workspace offload rather than a slice, and a 50,000-character prior output
//     would also crowd the objective inside the same prompt.
//
// So the tail beyond p99 gets compressed-and-parked, which loses nothing (the
// full value is readable from the workspace), and the 95%+ common case is
// untouched. `step_output_size_observed` now records the real distribution of
// the actual quantity, so the next revision of this number is a direct
// measurement rather than an inference from its upstream.
//
// Workflow input data gets the same budget for the same reason: it arrives from
// a caller (a cron payload, an event body, a delegate's arguments) with no
// contract, and it is the same kind of value in the same prompt.

import { scrubLogger } from '../../observability/scrub-logger';

/** Prior step's output, as summarised into the next step's prompt. */
export const STEP_OUTPUT_BUDGET = 8_192;

/** The run's input data, as interpolated into a step prompt. */
export const WORKFLOW_INPUT_BUDGET = 8_192;

/** The earlier-outputs section of a step prompt, as a hard bound on its final
 *  rendered text. Four per-value budgets. Most llm_reason steps name no earlier
 *  step, and very few name more than four, so four full values cover nearly
 *  every step at full size, and priority ordering covers the rest for what
 *  they name. First derivation; the metric
 *  below is what makes the next revision a measurement. */
export const EARLIER_OUTPUTS_BUDGET = 4 * STEP_OUTPUT_BUDGET;

/**
 * Record the observed size of one step-to-step handoff.
 *
 * Lives here rather than at the call site because the number it measures and the
 * number it justifies belong in the same file — a calibration signal separated
 * from the constant it calibrates is how a threshold ends up documented as
 * "measured" by a query nobody can find again.
 */
export function recordStepOutputSize(
  stepOutput: unknown,
  budget: number,
  offloaded: boolean,
  /** Who this happened to. Without it the event is a number; with it, a lead.
   *  An over-budget handoff that cannot be traced to an agent leaves the one
   *  question it raises — does that agent have a workspace? — to be answered by
   *  reasoning about capability tiers instead of by looking. Optional so a
   *  caller that genuinely lacks the ids still records the size rather than
   *  skipping the measurement. */
  ids?: { tenantId?: string; agentId?: string; invocationId?: string },
): void {
  if (stepOutput === undefined || stepOutput === null) return;
  let chars: number;
  try {
    chars = typeof stepOutput === 'string'
      ? stepOutput.length
      : (JSON.stringify(stepOutput) ?? '').length;
  } catch {
    // A circular or unserializable value has no meaningful size to report, and
    // this must never be the thing that fails a step.
    return;
  }
  if (chars === 0) return;
  const exceeded = chars > budget;
  scrubLogger.info({
    event: 'step_output_size_observed',
    metric: 'step_output.chars',
    chars,
    budget,
    exceeded,
    offloaded,
    // The state that matters and had no name: over budget AND nowhere to park
    // it means the remainder is gone, not merely summarised. Recorded as its own
    // field so it can be counted directly rather than inferred from two others.
    unrecoverable: exceeded && !offloaded,
    tenantId: ids?.tenantId,
    agentId: ids?.agentId,
    invocationId: ids?.invocationId,
  });
}

/**
 * Record the observed shape of one step prompt's earlier-outputs section.
 *
 * Same reasoning as `recordStepOutputSize`: the constant it calibrates
 * (`EARLIER_OUTPUTS_BUDGET`) lives in this file, so the measurement does too.
 * The section it measures had no signal at all while it was being cut — the
 * predecessor's hand-off was measured and read healthy on the same prompt.
 */
export function recordEarlierOutputsSection(
  stepId: string,
  section: {
    steps: number;
    shown: number;
    stubbed: number;
    omitted: number;
    chars: number;
    ceiling: number;
    prepared: number;
    objectiveChars: number;
  },
  ids?: { tenantId?: string; agentId?: string; invocationId?: string },
): void {
  scrubLogger.info({
    event: 'earlier_outputs_section_observed',
    stepId,
    steps: section.steps,
    shown: section.shown,
    stubbed: section.stubbed,
    omitted: section.omitted,
    chars: section.chars,
    ceiling: section.ceiling,
    prepared: section.prepared,
    objectiveChars: section.objectiveChars,
    tenantId: ids?.tenantId,
    agentId: ids?.agentId,
    invocationId: ids?.invocationId,
  });
}
