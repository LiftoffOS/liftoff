// Re-rooting a stored `loop.over` that addresses `output.<stepId>.<field>`.
//
// `output` is bound to the PREVIOUS step's output, not to a map of steps, so
// `output.s13.cards_to_update` walks `s13Output["s13"]["cards_to_update"]` and
// throws. The loop iterates zero times, and the work it existed to do is never
// done. The distiller's schema offered that form; `steps.<stepId>.<field>` is
// the one that resolves.
//
// Separated from the one-shot script that applies it because the property that
// matters — a second pass changes nothing — is a property of this function, and
// the script cannot be exercised without a database.

import type { WorkflowStep } from '@liftoffos/shared-types';

/** `output.<segment>.<rest>` — the whole point is the SECOND segment, which the
 *  author meant as a stepId and which `output` cannot carry. A bare
 *  `output.<field>` is the previous step's own output read correctly, and is
 *  left alone. */
const UNRESOLVABLE_LOOP_OVER_RE = /^output\.([^.]+)\.(.+)$/;

export interface LoopOverRewrite {
  stepId: string;
  from: string;
  to: string;
}

export interface LoopOverSkip {
  stepId: string;
  over: string;
  reason: string;
}

export interface LoopOverPlan {
  /** The steps with every rewritable `loop.over` re-rooted, and nothing else
   *  touched. Identical to the input when there is nothing to rewrite. */
  steps: WorkflowStep[];
  rewrites: LoopOverRewrite[];
  skipped: LoopOverSkip[];
}

/** Plan the re-rooting for one graph.
 *
 *  Idempotent by construction: a value already rooted at `steps.` does not
 *  match, so a second pass over the output yields no rewrites. */
export function planLoopOverRewrites(steps: WorkflowStep[]): LoopOverPlan {
  const stepIds = new Set(steps.map((s) => String(s.stepId ?? '')));
  const rewrites: LoopOverRewrite[] = [];
  const skipped: LoopOverSkip[] = [];
  const next = steps.map((step) => {
    const over = step.loop?.over;
    if (typeof over !== 'string') return step;
    const m = UNRESOLVABLE_LOOP_OVER_RE.exec(over);
    if (!m) return step;
    const [, segment, rest] = m;
    // The rewrite is only correct if the author did mean a stepId. A segment
    // naming no step is a different defect, and guessing at it would write a
    // path that resolves to nothing just as surely as the one it replaced.
    if (!stepIds.has(segment)) {
      skipped.push({
        stepId: String(step.stepId ?? ''),
        over,
        reason: `"${segment}" names no step in this workflow`,
      });
      return step;
    }
    const to = `steps.${segment}.${rest}`;
    rewrites.push({ stepId: String(step.stepId ?? ''), from: over, to });
    // ONLY `loop.over`. Every other key on `loop` — `continueOnItemFailure`,
    // `maxIterations`, `collect`, `itemVar` — and every other field on the step
    // is carried through untouched.
    return { ...step, loop: { ...step.loop!, over: to } };
  });
  return { steps: next, rewrites, skipped };
}

/** How many `loop.over` values in a stored column still address
 *  `output.<stepId>.<field>`. Counted from the rows rather than tallied by the
 *  loop that wrote them, so the report measures the database. */
export function unresolvableLoopOverCount(raw: unknown): number {
  const steps = Array.isArray(raw) ? (raw as WorkflowStep[]) : [];
  return steps.filter(
    (s) => typeof s.loop?.over === 'string' && UNRESOLVABLE_LOOP_OVER_RE.test(s.loop.over),
  ).length;
}
