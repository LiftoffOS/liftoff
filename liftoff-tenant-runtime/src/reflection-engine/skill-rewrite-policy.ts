// When the reflection engine may rewrite a skill's DESCRIPTION.
//
// A description decides what a skill MATCHES. Rewriting it wrongly does not
// corrupt the guidance, it silently removes working guidance from the runs that
// needed it — a failure with no error and no symptom except worse answers
// later. So the bar is higher than for an instruction rewrite.
//
// The rule lives here, alone, because it is read in two places that must not
// drift: the reflection PROMPT states it (so the model does not spend a rewrite
// it cannot use) and reflection-engine/service.ts ENFORCES it (so a model that
// ignores the instruction changes nothing). Two constants that have to agree
// eventually stop agreeing; this file is the reason there is only one.
//
// Deliberately a leaf module — no imports — so infrastructure/vertex-ai.ts can
// read it without creating a cycle back through the reflection service.

/**
 * Settled autonomous runs required before `usefulness_score <= 0` may unlock a
 * description rewrite.
 *
 * WHAT THIS NUMBER IS FOR, which is narrower than it looks:
 *
 * `usefulness_score` is 0 for a skill nobody has ever settled AND for a skill
 * with equal wins and losses. The value cannot tell those apart, and the vast
 * majority of skills sit there. So
 * `<= 0` alone read "never observed" as "persistent misfire" and authorised a
 * rewrite for almost the whole catalogue. Excluding the never-observed case is
 * this gate's entire job. It is not a tuned misfire detector and should not be
 * mistaken for one.
 *
 * DO NOT CALIBRATE IT FROM INTERNAL DATA. Internal usage is a handful of agents
 * driven by the operator, with a few skills settled heavily and most never.
 * That distribution describes testing, not customer usage, and a threshold
 * fitted to it would launder a guess as evidence. The number stays a stated
 * floor until there is a representative population to argue from — and note
 * that every new tenant starts at zero observations regardless, so "day 1"
 * recurs forever and the gate must be correct with no data at all.
 *
 * WHY LEAVING IT UNCALIBRATED IS SAFE. A wrong rewrite is bounded:
 *   - `operator` skills are refused outright (isProtected in skill-feedback-service)
 *   - `distilled` skills are replaced wholesale by the next Save that changes
 *     prose, which re-runs distillation — so a wrong rewrite there is erased,
 *     not permanent
 *   - only `learned` skills carry a rewrite durably, and they are the rarer slice
 * The exposure that remains is real but small, which is why this stays a floor
 * rather than growing into a statistical test.
 *
 * 5 is the stated floor: the smallest count at which a negative net score
 * cannot come from a single unlucky pair, rounded up for the word "persistent"
 * to mean anything. Override via SKILL_REWRITE_MIN_OBSERVATIONS. Raise it
 * freely; lowering it below 3 re-admits the noise this exists to exclude.
 */
export const MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE = Number(
  process.env.SKILL_REWRITE_MIN_OBSERVATIONS ?? 5,
);

/**
 * May the reflection engine rewrite this skill's description?
 *
 * Fails CLOSED on absent evidence. A skill the reflection context does not
 * carry (not in this run's injected set, or a row the lookup missed) has no
 * score to judge, and "we do not know" must not read as "go ahead".
 */
export function mayRewriteDescription(
  skill: { usefulnessScore: number; observationCount: number } | undefined,
): boolean {
  if (!skill) return false;
  return (
    skill.usefulnessScore <= 0
    && skill.observationCount >= MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE
  );
}
