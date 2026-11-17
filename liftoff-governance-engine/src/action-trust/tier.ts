// Trust-tier computation for the "earned autonomy" ledger.
//
// PURE + SHADOW. computeTier() is a deterministic function of the current
// (runs, passes, rejects) counts for one (tenant, agent, action_class). It is
// recomputed from scratch on every rollup, so tier movement — including
// DEMOTION — is entirely mechanical: when a well-behaved agent's action starts
// getting rejected/failing, its pass-rate falls and the recomputed tier drops.
//
// Nothing here is wired into checkHitlGate() or any admission path. A later
// change may let tier === 'auto' auto-clear an otherwise-gated routine action.
//
// Tiers (ascending trust):
//   'watch' — insufficient evidence, OR demoted (pass-rate below DEMOTE).
//   'queue' — enough evidence to trust for the interactive queue, but not to
//             auto-clear (building history, or pass-rate between DEMOTE and
//             PROMOTE).
//   'auto'  — high, well-established pass-rate; candidate to auto-clear a
//             routine gated action once enforcement is wired.

export type TrustTier = 'watch' | 'queue' | 'auto';

// ─────────────────────────────────────────────────────────────────────────
// PROVISIONAL — calibrate from shadow data before enforcement.
//
// These thresholds are first-pass guesses (loosely, Fable's 95% / 20-run
// suggestion). They MUST NOT be treated as final: run the rollup in shadow,
// look at the real distribution of per-(agent, action_class) pass-rates and
// run counts, and re-derive each cutoff from that measured data before any
// gate consults `tier`. Do not ship first-guess thresholds into enforcement.
// ─────────────────────────────────────────────────────────────────────────

/** Minimum graded runs before an (agent, action_class) can reach 'auto'.
 *  PROVISIONAL — calibrate from shadow data before enforcement. */
export const MIN_RUNS_FOR_AUTO = 20;

/** Minimum graded runs before an (agent, action_class) can leave 'watch'
 *  (i.e. earn 'queue'). Below this we have too little evidence to trust.
 *  PROVISIONAL — calibrate from shadow data before enforcement. */
export const MIN_RUNS_FOR_QUEUE = 5;

/** Pass-rate at/above which (with enough runs) an action reaches 'auto'.
 *  PROVISIONAL — calibrate from shadow data before enforcement. */
export const PROMOTE_PASS_RATE = 0.95;

/** Pass-rate below which an action is DEMOTED to 'watch', regardless of how
 *  much history it has. This is the mechanical demotion signal.
 *  PROVISIONAL — calibrate from shadow data before enforcement. */
export const DEMOTE_PASS_RATE = 0.8;

/**
 * Pass-rate for a graded window. `runs` is the denominator (passes + rejects);
 * returns 0 when there are no graded outcomes yet.
 */
export function passRateOf(runs: number, passes: number): number {
  if (runs <= 0) return 0;
  return passes / runs;
}

/**
 * Compute the trust tier for one (tenant, agent, action_class) from its
 * current counts. Pure and total — safe to call with any non-negative ints.
 *
 * Ordering matters:
 *   1. Too little evidence            → 'watch'
 *   2. Pass-rate below DEMOTE         → 'watch'  (mechanical demotion)
 *   3. Enough runs AND pass-rate high → 'auto'
 *   4. Otherwise                      → 'queue'
 *
 * `rejects` is accepted for symmetry / future signals; today it only enters
 * via the pass-rate denominator (runs = passes + rejects).
 */
export function computeTier(runs: number, passes: number, rejects: number): TrustTier {
  // Defensive clamp — never let bad inputs produce a spuriously high tier.
  const safeRuns = Math.max(0, Math.floor(runs));
  const safePasses = Math.max(0, Math.floor(passes));
  void rejects;

  if (safeRuns < MIN_RUNS_FOR_QUEUE) return 'watch';

  const rate = passRateOf(safeRuns, safePasses);

  if (rate < DEMOTE_PASS_RATE) return 'watch';

  if (safeRuns >= MIN_RUNS_FOR_AUTO && rate >= PROMOTE_PASS_RATE) return 'auto';

  return 'queue';
}
