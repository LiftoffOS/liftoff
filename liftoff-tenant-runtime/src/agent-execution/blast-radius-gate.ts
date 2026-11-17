// Blast-radius gating, shared by both HITL gate sites.
//
// `checkHitlGate` is reached from exactly two places: the per-tool-call path
// (canUseTool time, always a single-element array) and the batched dispatch
// path (a genuinely multi-call array). Both have to be covered, and covering
// them separately is how one of them ends up with a subtly different rule. So
// the measurement, the mode switch, the logging and the accumulation all live
// here, and each site calls one function.
//
// Rollout is a three-position switch:
//
//   off      nothing runs. Zero cost, zero risk.
//   shadow   measure and LOG the decision. Nothing changes for anyone. This is
//            how the thresholds get calibrated: they are placeholders until a
//            real distribution of write batches has been observed.
//   enforce  a plan over the bounds gates for human approval.
//
// The accumulation rule matters as much as the measurement: totals advance
// only for calls that were actually DISPATCHED. A run that pauses for approval
// and resumes must not be charged twice for the work the operator approved.
//
// Totals are PERSISTED per invocation rather than held in process memory. Three
// dispatch paths reach a connector — the LLM loop, the batched workflow path,
// and agent-authored sandbox code arriving over HTTP from the sidecar — and the
// third may land on a different pod. An in-memory counter would report a
// per-call number as a run total there, which is coverage that looks complete
// and under-counts by however much already happened. The in-process copy on
// ExecutionState remains as a read-through cache so the common path does not
// pay a round trip per decision.

import type { GateReason } from '@liftoffos/governance-types';
import { logger } from '../infrastructure/logging';
import { readRunTotals, incrementRunTotals } from './blast-radius-store';
import {
  DEFAULT_QUANTIFIER_THRESHOLDS,
  quantifyPlan,
  type PlanQuantification,
  type QuantifiedCall,
  type QuantifierThresholds,
  type RunningTotals,
} from '../tool-gateway/plan-quantifier';

/** Why a call gated, when it gated on size.
 *
 *  THE ONE PLACE this value is asserted into `GateReason`, and the only cast in
 *  the feature. The canonical union lives in `@liftoffos/governance-types` so
 *  the runtime, the governance simulator and the review queue cannot disagree
 *  about what a reason means; `blast_radius` is in that package's source and
 *  ships in 0.5.0. Until this repo's dependency moves to it, the installed
 *  0.4.0 typing does not yet carry the member.
 *
 *  Asserting once here rather than at each emitting site is deliberate: every
 *  downstream signature stays honestly typed as `GateReason`, and the whole
 *  release seam is one line to delete rather than a cast to hunt for in three
 *  files.
 *
 *  A reason may only be EMITTED once `Liftoff-React` knows the value: the
 *  review queue renders reasons through a static `Record<GateReason, string>`,
 *  and an unlabelled reason draws an EMPTY line exactly where the card is
 *  supposed to say why a person is being asked. `blast_radius` is labelled
 *  there ("Large-scale change", ReviewQueuePage.tsx), so enforce mode may
 *  emit it; a NEW reason added here inherits the same prerequisite. */
// Annotated, not asserted. `as GateReason` was load-bearing: the union is
// declared in @liftoffos/governance-types, this repo pinned `^0.4.0`, and
// `blast_radius` was added in 0.5.0 — which a caret on a 0.x version cannot
// reach. So the shared constant the package's own comment calls impossible to
// drift from had drifted, and a type assertion absorbed the difference silently
// instead of failing the build. With the pin at ^0.6.0 this is a real check
// again: rename the member upstream and this line stops compiling.
export const BLAST_RADIUS_GATE_REASON: GateReason = 'blast_radius';

export type QuantifierMode = 'off' | 'shadow' | 'enforce';

/** Resolved per call rather than at module load so a revision's env change
 *  takes effect without a code path depending on import order, and so tests
 *  can move the switch. */
export function quantifierMode(): QuantifierMode {
  const raw = (process.env.QUANTIFIER_MODE ?? 'off').trim().toLowerCase();
  return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}

/** Thresholds, env-overridable so shadow-mode calibration lands as
 *  configuration rather than a deploy. */
export function quantifierThresholds(): QuantifierThresholds {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxEntitiesTouched: num(process.env.QUANTIFIER_MAX_ENTITIES, DEFAULT_QUANTIFIER_THRESHOLDS.maxEntitiesTouched),
    maxDestructiveOps: num(process.env.QUANTIFIER_MAX_DESTRUCTIVE, DEFAULT_QUANTIFIER_THRESHOLDS.maxDestructiveOps),
    maxClearedFields: num(process.env.QUANTIFIER_MAX_CLEARED_FIELDS, DEFAULT_QUANTIFIER_THRESHOLDS.maxClearedFields),
    maxEntitiesPerBatch: num(process.env.QUANTIFIER_MAX_PER_BATCH, DEFAULT_QUANTIFIER_THRESHOLDS.maxEntitiesPerBatch),
  };
}

const ZERO_TOTALS: RunningTotals = { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 };

/** The subset of ExecutionState this needs. Narrow on purpose: the helper is
 *  then testable without constructing a whole run. */
export interface BlastRadiusRunState {
  blastRadiusTotals?: RunningTotals;
  context: {
    tenantId: string;
    agentId: string;
    invocationId?: string;
  };
}

/** Totals for this run, preferring the in-process copy and falling back to the
 *  persisted row.
 *
 *  The fallback is what makes a resumed run — or a run whose sandbox code has
 *  been dispatching from another pod — measure against everything that already
 *  happened rather than against zero. */
async function totalsFor(state: BlastRadiusRunState): Promise<RunningTotals> {
  if (state.blastRadiusTotals) return state.blastRadiusTotals;
  if (!state.context.invocationId) return ZERO_TOTALS;
  const persisted = await readRunTotals(state.context.tenantId, state.context.invocationId);
  state.blastRadiusTotals = persisted;
  return persisted;
}

export interface BlastRadiusDecision {
  /** True only in enforce mode, and only when a bound was crossed. */
  shouldGate: boolean;
  /** Statements of what was measured. Present in shadow mode too, so the log
   *  says what WOULD have been shown to a person. */
  reasons: string[];
  quantification: PlanQuantification;
}

/**
 * Measure a batch and decide.
 *
 * Does NOT advance the run's totals — `commitBlastRadius` does, after the
 * calls are actually dispatched.
 */
/** The calls a plan's size is measured over: the ones that change something.
 *
 *  The quantifier asks how much a plan CHANGES, and its bounds were set
 *  against write batches. A read — a page fetched, a record listed — changes
 *  nothing, so it carries no blast radius; measured anyway, a run that read
 *  thirty pages one call at a time asked a person to approve a "large-scale
 *  change" that consisted of reading. A call whose effect the catalog could
 *  not resolve stays measured: the bound fails closed, not open. */
function changing(calls: QuantifiedCall[]): QuantifiedCall[] {
  return calls.filter((c) => c.effect !== 'read');
}

export async function evaluateBlastRadius(
  state: BlastRadiusRunState,
  calls: QuantifiedCall[],
  label: string,
): Promise<BlastRadiusDecision | null> {
  const mode = quantifierMode();
  const measured = changing(calls);
  if (mode === 'off' || measured.length === 0) return null;

  const quantification = quantifyPlan(measured, await totalsFor(state), quantifierThresholds());

  if (quantification.decision === 'confirm_required') {
    logger.info(
      {
        metric: 'blast_radius.threshold_crossed',
        mode,
        label,
        tenant_id: state.context.tenantId,
        agent_id: state.context.agentId,
        invocation_id: state.context.invocationId,
        tools: calls.map((c) => c.name),
        batch: quantification.batch,
        cumulative: quantification.cumulative,
        snapshot_unavailable: quantification.snapshotUnavailable,
        reasons: quantification.reasons,
        enforced: mode === 'enforce',
      },
      mode === 'enforce'
        ? 'blast radius: pausing for approval'
        : 'blast radius: would have paused for approval (shadow)',
    );
  } else {
    // Shadow mode has to log the PROCEEDING batches too. A log that only fires
    // on the tail says nothing about where the thresholds should sit, and
    // calibrating from crossings alone would only ever ratchet them looser.
    //
    // AT INFO IN SHADOW, deliberately. The deployment's level is `info`, so a
    // debug line is written nowhere — the observations would not exist and the
    // calibration window would produce a distribution of one tail. Gathering
    // that distribution IS what shadow mode is for, and it is time-bounded:
    // TOOL_RESULT_MAX_CHARS was set from n=6043 observations the same way.
    // In enforce mode the distribution is no longer being gathered, so this
    // drops back to debug rather than emitting a line per tool call forever.
    const emit = mode === 'shadow' ? logger.info.bind(logger) : logger.debug.bind(logger);
    emit(
      {
        metric: 'blast_radius.observed',
        mode,
        label,
        tenant_id: state.context.tenantId,
        agent_id: state.context.agentId,
        invocation_id: state.context.invocationId,
        batch: quantification.batch,
        cumulative: quantification.cumulative,
      },
      'blast radius: observed',
    );
  }

  return {
    shouldGate: mode === 'enforce' && quantification.decision === 'confirm_required',
    reasons: quantification.reasons,
    quantification,
  };
}

/**
 * Advance the run's totals, AFTER the calls were dispatched.
 *
 * Called on the dispatch path rather than the decision path so a batch that
 * gated (and was never executed) does not inflate the totals a later resume
 * measures against.
 */
export async function commitBlastRadius(
  state: BlastRadiusRunState,
  calls: QuantifiedCall[],
): Promise<void> {
  const measured = changing(calls);
  if (quantifierMode() === 'off' || measured.length === 0) return;

  const before = await totalsFor(state);
  const q = quantifyPlan(measured, before, quantifierThresholds());
  state.blastRadiusTotals = q.cumulative;

  if (!state.context.invocationId) return;
  // The persisted row is the authority across pods and across a resume. The
  // increment is atomic, so two paths dispatching concurrently in one run add
  // rather than overwrite — a last-write-wins update would silently discard
  // whichever half lost the race, and the discarded half is exactly the
  // evidence the gate needs.
  const persisted = await incrementRunTotals(
    state.context.tenantId,
    state.context.invocationId,
    q.batch,
  );
  if (persisted) state.blastRadiusTotals = persisted;
}
