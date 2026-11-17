// Incumbency for flows a distillation INVENTED.
//
// Wave B gave a template's AUTHORED flows stable ids: the catalog wrote them, so
// the id is the catalog's and it survives by construction. A Custom Hire has no
// template. Its first distillation invents the decomposition — that is the
// product, not a shortfall — and the invented flows have no id to inherit.
//
// So the rule is not authored-versus-generated. It is INVENTED ONCE, THEN
// OWNED: the first distillation mints the flows, that output becomes the
// INCUMBENT, and every later distillation merges against it. The identity is
// what makes a flow a thing rather than a paragraph — it is what
// `agent_skill_metrics` is keyed on, and what lets the HRBP refine "the
// escalation flow" in conversation instead of describing it again.
//
// The measured harm of not doing this is not subtle: ~90% of agent_skill_metrics
// rows point at ids no live skill carries, because a redistill that paraphrases
// a skill's name mints a fresh id and strands every metric row behind it. Skill-
// level learning cannot accumulate across a redistill, which is most of what
// skill-level learning is for.
//
// WHEN AN ID MAY BE RE-MINTED. Only when the changed responsibilities implicate
// that flow. This is the ADR-043 discipline extended from skills to
// configuration identity, and it uses the same implication mechanism the waved
// branch cache uses: match the subject against the text, and act only on what
// the text names.
//
// The subject a flow was minted from is recorded at mint time rather than
// re-derived, for the same reason the decision record exists: re-deriving it
// from the CURRENT responsibilities would ask whether the flow suits the
// responsibilities as they are now, which is a different question and answers
// "yes" for a flow that has quietly drifted away from what it was for.

import type { Skill } from './types';

/** Words too common to identify anything. Kept short: this list exists to stop
 *  "the" and "and" matching every flow, not to do stemming. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with',
  'from', 'as', 'is', 'are', 'be', 'when', 'then', 'that', 'this', 'it', 'its',
  'not', 'no', 'any', 'all', 'each', 'per', 'into', 'out', 'up', 'down', 'over',
  'agent', 'team', 'run', 'step', 'use', 'used', 'using', 'do', 'does', 'done',
]);

/**
 * The distinctive terms a flow is about.
 *
 * Drawn from the name and description rather than the body: the body is the
 * procedure and drifts with every rewording, while the name and the retrieval
 * key say what the flow is FOR. A subject that changed when the wording changed
 * would make every rewrite look like a new flow, which is the failure being
 * fixed.
 */
export function subjectTermsFor(skill: { name?: string; description?: string }): string[] {
  const text = `${skill.name ?? ''} ${skill.description ?? ''}`.toLowerCase();
  const words = text.match(/[a-z][a-z0-9_]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP_WORDS.has(w)))].sort();
}

/**
 * Whether the responsibilities still speak to this flow's subject.
 *
 * The threshold is deliberately low. A flow is implicated when the
 * responsibilities have moved AWAY from it — when hardly any of what it was
 * about is still described — not when they have been reworded around it. Being
 * strict here would re-mint on a typo fix and put us back where we started.
 */
export function flowIsImplicated(
  mintedSubject: readonly string[],
  responsibilities: string,
): boolean {
  if (mintedSubject.length === 0) return true;
  const text = responsibilities.toLowerCase();
  const surviving = mintedSubject.filter((term) => text.includes(term)).length;
  // A third of the subject still present is enough to say the responsibilities
  // are still about this. Below that the flow is about something the
  // responsibilities no longer describe, and a fresh identity is the honest
  // answer rather than a stale one wearing the old id.
  return surviving / mintedSubject.length < 0.34;
}

export interface FlowIncumbencyResult {
  /** Incoming skills with incumbent ids carried onto the ones that kept theirs. */
  skills: Skill[];
  /** The subject each surviving flow was minted from, to record for next time. */
  subjects: Record<string, string[]>;
  /** Ids carried forward, for telemetry. */
  carried: string[];
  /** Incumbent ids re-minted because the responsibilities moved away. */
  reminted: string[];
}

/**
 * Carry incumbent flow identities onto a fresh distillation's output.
 *
 * Runs BEFORE the provenance merge, deliberately. `mergeSkillsByProvenance`
 * keys on `id` when one is present and falls back to an exact lowercased NAME
 * match otherwise, so a paraphrase — "Avoiding duplicate reviews" against
 * "Preventing duplicate reviews" — misses and mints. Assigning the incumbent id
 * first means the provenance merge sees the two as one skill, which is what it
 * would have concluded if the name had not drifted.
 *
 * Matching is by subject overlap rather than by name for exactly that reason. A
 * name is how a flow is worded this time; the subject is what it is for.
 */
export function carryFlowIncumbency(args: {
  incumbents: readonly Skill[];
  incoming: readonly Skill[];
  /** Subjects recorded when each incumbent was minted, keyed by skill id. */
  mintedSubjects: Record<string, string[]> | undefined;
  /** The responsibilities this distillation ran on. */
  responsibilities: string;
}): FlowIncumbencyResult {
  const { incumbents, incoming, responsibilities } = args;
  const mintedSubjects = args.mintedSubjects ?? {};

  // Only incumbents the responsibilities still speak to may lend an identity.
  const lendable = incumbents.filter((s) => {
    if (!s.id) return false;
    const subject = mintedSubjects[s.id] ?? subjectTermsFor(s);
    return !flowIsImplicated(subject, responsibilities);
  });

  const reminted = incumbents
    .filter((s) => s.id && !lendable.some((l) => l.id === s.id))
    .map((s) => s.id!)
    .sort();

  const claimed = new Set<string>();
  const carried: string[] = [];
  const skills = incoming.map((s) => {
    if (s.id) return s;                       // already identified
    const match = bestSubjectMatch(s, lendable, claimed);
    if (!match?.id) return s;
    claimed.add(match.id);
    carried.push(match.id);
    return { ...s, id: match.id };
  });

  const subjects: Record<string, string[]> = {};
  for (const s of skills) {
    if (s.id) subjects[s.id] = subjectTermsFor(s);
  }

  return { skills, subjects, carried: carried.sort(), reminted };
}

/**
 * The unclaimed incumbent whose subject overlaps this skill most.
 *
 * One incumbent lends to at most one incoming skill: two flows that both
 * inherited the same identity would collide in `agent_skill_metrics` and make
 * the number they produce meaningless, which is worse than the orphaning this
 * exists to fix.
 */
function bestSubjectMatch(
  skill: Skill,
  lendable: readonly Skill[],
  claimed: ReadonlySet<string>,
): Skill | undefined {
  const subject = new Set(subjectTermsFor(skill));
  if (subject.size === 0) return undefined;

  let best: Skill | undefined;
  let bestScore = 0;
  for (const candidate of lendable) {
    if (!candidate.id || claimed.has(candidate.id)) continue;
    const other = subjectTermsFor(candidate);
    if (other.length === 0) continue;
    const shared = other.filter((t) => subject.has(t)).length;
    const score = shared / Math.max(subject.size, other.length);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  // Half the subject in common. Below that these are two different flows that
  // happen to share vocabulary, and handing one the other's identity would
  // silently retarget every metric row behind it.
  return bestScore >= 0.5 ? best : undefined;
}
