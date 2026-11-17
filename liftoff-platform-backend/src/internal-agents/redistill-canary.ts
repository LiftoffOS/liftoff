// Deciding whether a fleet-wide redistill made agents worse.
//
// The redistill machinery already exists — `redistillAgent`,
// `redistillAgentDryRun`, `redistillAllAgents`. What it lacks is a way to tell
// whether a wave HELPED, and an automatic way to put it back if it did not.
// This is that decision, as a pure function over before/after counts.
//
// TWO DESIGN CHOICES DO ALL THE WORK:
//
// 1. WHAT COUNTS AS A REGRESSION. Only failures that say something about the
//    AGENT. A provider 429, a provider 5xx, a socket reset, a bad API key, a
//    configured ceiling — none of those are evidence about the instructions we
//    just rewrote, and rolling back on them means an outage somewhere else
//    reverts our work. That mistake is invisible afterwards: the rollback looks
//    like the system working.
//
// 2. HOW MUCH EVIDENCE IS ENOUGH. Each agent is its own control, and the
//    null-hypothesis noise floor for a rate is binomial — so it is COMPUTED,
//    not sampled from a calibration run. A Bayesian beta-binomial posterior is
//    used because it is valid under optional stopping: polling as runs
//    accumulate is safe, where a repeated frequentist test would inflate the
//    false-positive rate every time it was checked.
//
// WHAT THIS CANNOT DO, stated rather than papered over. At a 5% baseline, the
// runs needed to detect a regression are roughly: 9 for a 10x rise, 36 for 5x,
// and about 340 for 2x. So this catches a BROKEN redistill quickly and cannot
// catch subtle drift at any realistic fleet volume. Lowering the threshold to
// chase 2x would trade that for false rollbacks on noise, which is worse: a
// wave that reverts at random teaches operators to disable the gate.

/** Failure classes that are evidence about the AGENT, and therefore about the
 *  instructions a redistill rewrote.
 *
 *  Mirrors the runtime's `FailureClass` union (tenant-runtime
 *  src/invocations/types.ts). Kept as a local constant rather than an import
 *  because it is a POLICY choice about which classes count, not a copy of the
 *  taxonomy — the taxonomy can grow without silently enrolling a new class in
 *  auto-rollback. */
export const AGENT_QUALITY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'task_failed',
  'recovery_declined',
  'tool_error',
  'validation',
]);

/** Failure classes that must NEVER trigger a rollback.
 *
 *  Every one of these is somebody else's outage or a ceiling we configured.
 *  Listed explicitly, rather than left as "anything not in the set above",
 *  so the exclusion is a decision on the page instead of a side effect. */
export const NON_AGENT_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'provider_capacity',
  'provider_server_error',
  'provider_network',
  'provider_auth',
  'provider_quota',
  'limit_reached',
  'context_overflow',
  'transient_infra',
]);

/** True when this failure is evidence about the agent rather than about the
 *  weather.
 *
 *  The exclusion list is consulted FIRST and wins. If a class ever ends up in
 *  both sets — the shape a careless edit takes — the safe reading is the one
 *  that does not roll anything back, and that has to be enforced rather than
 *  assumed. A test pins the two sets disjoint; this makes the mistake harmless
 *  even before the test catches it. */
export function countsAsAgentQualityFailure(failureClass: string | null | undefined): boolean {
  if (!failureClass) return false;
  if (NON_AGENT_FAILURE_CLASSES.has(failureClass)) return false;
  return AGENT_QUALITY_FAILURE_CLASSES.has(failureClass);
}

/** Observed outcomes for one agent over one window.
 *
 *  DETERMINISTIC SIGNALS ONLY. There is deliberately no field here for a judge
 *  score or a deliverable grade: those are advisory, they flag for human
 *  review, and they were never built to gate. Leaving them out of the type is
 *  a stronger guarantee than a rule saying not to use them. */
export interface CanaryWindow {
  runs: number;
  /** Runs whose failure class is agent-quality. Provider failures and ceilings
   *  are excluded upstream by `countsAsAgentQualityFailure`. */
  agentQualityFailures: number;
  /** Runs that ended by handing off to a human. A rise here is a real quality
   *  signal even when nothing failed. */
  escalations: number;
  /** Approvals a human REJECTED. The most direct statement available that the
   *  agent proposed the wrong thing. */
  hitlRejections: number;
}

export interface CanaryConfig {
  /** How much worse the after-rate must plausibly be before this is called a
   *  regression. 3 means "three times the baseline". */
  mdeMultiple: number;
  /** Posterior probability required before acting. 0.99 is deliberately high:
   *  the action is an automatic rollback of somebody's work. */
  posteriorThreshold: number;
  /** No decision at all below this many post-redistill runs. */
  minAfterRuns: number;
}

export const DEFAULT_CANARY_CONFIG: CanaryConfig = {
  mdeMultiple: 3,
  posteriorThreshold: 0.99,
  minAfterRuns: 10,
};

export type CanaryDecision = 'pass' | 'insufficient_evidence' | 'rollback';

export interface CanaryVerdict {
  decision: CanaryDecision;
  /** P(after-rate > mdeMultiple x before-rate), from the posterior. */
  posteriorProbability: number;
  beforeRate: number;
  afterRate: number;
  afterRuns: number;
  /** Plain statement of what was measured and what it means. */
  rationale: string;
}

/** Every signal that counts against an agent, as one rate. Combining them is
 *  deliberate: a redistill that trades failures for escalations has not
 *  improved anything, and three separately-underpowered tests would miss it. */
function badOutcomes(w: CanaryWindow): number {
  return w.agentQualityFailures + w.escalations + w.hitlRejections;
}

/**
 * P(X > Y) for two Beta posteriors, by direct summation over the standard
 * identity. Exact for integer parameters, which these always are: the priors
 * are Beta(1,1) and the updates are counts.
 */
function probabilityGreater(a1: number, b1: number, a2: number, b2: number): number {
  // P(X1 > X2) where Xi ~ Beta(ai, bi), using the series
  //   sum_{i=0}^{a1-1} B(a2+i, b1+b2) / ((b1+i) * B(1+i, b1) * B(a2, b2))
  // computed in log space so the factorials do not overflow.
  let total = 0;
  for (let i = 0; i < a1; i++) {
    total += Math.exp(
      lnBeta(a2 + i, b1 + b2) - Math.log(b1 + i) - lnBeta(1 + i, b1) - lnBeta(a2, b2),
    );
  }
  return Math.min(1, Math.max(0, total));
}

function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/** Lanczos approximation. Accurate to ~15 significant figures for a > 0, which
 *  is far more than a 0.99 threshold needs. */
function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Decide whether a redistilled agent got worse.
 *
 * Returns `insufficient_evidence` rather than `pass` when there is not enough
 * data. The two are different claims, and reporting the second when only the
 * first is true is how a wave gets declared safe on four runs.
 */
export function evaluateRedistillCanary(
  before: CanaryWindow,
  after: CanaryWindow,
  config: CanaryConfig = DEFAULT_CANARY_CONFIG,
): CanaryVerdict {
  const beforeBad = badOutcomes(before);
  const afterBad = badOutcomes(after);
  const beforeRate = before.runs > 0 ? beforeBad / before.runs : 0;
  const afterRate = after.runs > 0 ? afterBad / after.runs : 0;

  if (after.runs < config.minAfterRuns) {
    return {
      decision: 'insufficient_evidence',
      posteriorProbability: 0,
      beforeRate,
      afterRate,
      afterRuns: after.runs,
      rationale:
        `${after.runs} run${after.runs === 1 ? '' : 's'} since the redistill, ` +
        `below the ${config.minAfterRuns} needed for any conclusion. Not a pass — ` +
        'nothing has been shown either way.',
    };
  }

  // Beta(1,1) priors: uniform, so the posterior is driven entirely by the
  // observed counts and a window with no data does not smuggle in an opinion.
  const afterPosterior = { a: afterBad + 1, b: after.runs - afterBad + 1 };

  // P(after > mde x before), evaluated by comparing the after-posterior against
  // the before-posterior scaled by the multiple. Scaling the COUNT rather than
  // the rate keeps both sides integer-parameterised, which is what makes the
  // summation identity below exact rather than approximate.
  const scaledBeforeBad = Math.min(before.runs, Math.round(beforeBad * config.mdeMultiple));
  const scaledBefore = { a: scaledBeforeBad + 1, b: before.runs - scaledBeforeBad + 1 };

  const posteriorProbability = probabilityGreater(
    afterPosterior.a, afterPosterior.b,
    scaledBefore.a, scaledBefore.b,
  );

  if (posteriorProbability >= config.posteriorThreshold) {
    return {
      decision: 'rollback',
      posteriorProbability,
      beforeRate,
      afterRate,
      afterRuns: after.runs,
      rationale:
        `Poor outcomes rose from ${(beforeRate * 100).toFixed(1)}% to ${(afterRate * 100).toFixed(1)}% ` +
        `over ${after.runs} runs. The probability that this is at least a ` +
        `${config.mdeMultiple}x regression rather than noise is ` +
        `${(posteriorProbability * 100).toFixed(1)}%.`,
    };
  }

  return {
    decision: 'pass',
    posteriorProbability,
    beforeRate,
    afterRate,
    afterRuns: after.runs,
    rationale:
      `No ${config.mdeMultiple}x regression detected over ${after.runs} runs ` +
      `(${(beforeRate * 100).toFixed(1)}% → ${(afterRate * 100).toFixed(1)}%). ` +
      'This bar catches a broken redistill, not subtle drift — a change smaller than ' +
      `${config.mdeMultiple}x would need far more runs than a fleet produces.`,
  };
}
