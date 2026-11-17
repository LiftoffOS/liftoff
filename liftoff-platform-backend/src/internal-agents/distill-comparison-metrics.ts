/**
 * Structural quality metrics for comparing two distillations of one input.
 *
 * Shared by the dev A/B harness and by production shadow mode, for the same
 * reason the two arms share one field-description source: a comparison whose
 * two halves measure quality slightly differently is not a comparison. If the
 * shadow's skills-restate rate were computed by one function and the harness's
 * by another, the two would disagree eventually, and the disagreement would look
 * like a finding.
 *
 * All four are deliberately cheap and deterministic — regex and set arithmetic,
 * no model call. The one metric that does need a model, the blinded pairwise
 * judge, is run separately and in a batch precisely because it is neither.
 */
import type { DistillOutput } from './distill-service';

/** Lowercase, strip punctuation, collapse whitespace. */
export function normaliseLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fraction of skills whose name restates a workflow step.
 *
 * The headline quality risk of splitting: `skills` generated without sight of
 * the graph lists the steps back as skill names. The v5 and v7 prompt rewrites
 * were both about this, in the single-call arm, so the single arm is not at zero
 * either — the number is only meaningful as a difference between the arms.
 *
 * Token overlap rather than string equality because the failure is paraphrase:
 * "Triaging the ticket" against a step described as "Triage incoming ticket".
 * Returns null when there is nothing to measure, so an absent graph is not
 * silently scored as a perfect zero.
 */
export function skillsRestateStepsRate(output: DistillOutput | undefined): number | null {
  if (!output) return null;
  const steps = output.workflowSteps ?? [];
  const skills = output.skills ?? [];
  if (steps.length === 0 || skills.length === 0) return null;

  const stepTokens = steps.map((s) => new Set(normaliseLabel(
    [(s as { stepId?: string }).stepId ?? '', (s as { description?: string }).description ?? ''].join(' '),
  ).split(' ').filter(Boolean)));

  let restated = 0;
  for (const skill of skills) {
    const tokens = new Set(normaliseLabel(skill.name ?? '').split(' ').filter(Boolean));
    if (tokens.size === 0) continue;
    const matches = stepTokens.some((step) => {
      let shared = 0;
      for (const t of tokens) if (step.has(t)) shared++;
      // Over half a skill's name appearing in one step's text is the signal the
      // prompt rewrites were chasing. Below that it is ordinary shared domain
      // vocabulary, and flagging it would drown the metric in noise.
      return shared / tokens.size > 0.5;
    });
    if (matches) restated++;
  }
  return restated / skills.length;
}

/**
 * Fraction of instructionsMd sentences repeated from the system prompt.
 *
 * instructionsMd is told the system prompt is already loaded and not to repeat
 * its identity text. In one call the model can see what it wrote; split across
 * branches it is working from a seed, so this is the check that the seed does
 * its job.
 *
 * Sentence level, not token level: shared vocabulary between an agent's identity
 * and its operating guide is expected and correct, a shared sentence is a
 * repeat. Short fragments are ignored — a six-word floor keeps headings and list
 * markers from counting as repetition.
 */
export function identityLeakageRate(output: DistillOutput | undefined): number | null {
  if (!output?.instructionsMd || !output.systemPrompt) return null;
  const sentences = (text: string) => text
    .split(/[.\n]/)
    .map((s) => normaliseLabel(s))
    .filter((s) => s.split(' ').length >= 6);
  const promptSentences = new Set(sentences(output.systemPrompt));
  const mdSentences = sentences(output.instructionsMd);
  if (mdSentences.length === 0 || promptSentences.size === 0) return null;
  const repeated = mdSentences.filter((s) => promptSentences.has(s)).length;
  return repeated / mdSentences.length;
}

/**
 * Did the two arms make the same STEP 1 decision?
 *
 * The single most important agreement metric. The whole system prompt is built
 * around emit-or-omit, and two arms disagreeing about it have produced two
 * different agents, not two wordings of one.
 */
export function graphDecisionAgrees(
  a: DistillOutput | undefined,
  b: DistillOutput | undefined,
): boolean | null {
  if (!a || !b) return null;
  const emitted = (o: DistillOutput) => Array.isArray(o.workflowSteps) && o.workflowSteps.length > 0;
  return emitted(a) === emitted(b);
}

/** Did the two arms pick the same primary trigger type? */
export function triggerTypeAgrees(
  a: DistillOutput | undefined,
  b: DistillOutput | undefined,
): boolean | null {
  if (!a || !b) return null;
  return a.triggerConfig?.type === b.triggerConfig?.type;
}

/**
 * Policies stated in more than one layer with DIFFERENT numbers.
 *
 * The layer table's whole purpose, measured. A rule belongs in exactly one
 * layer, chosen by how often it is needed; the failure it prevents is the same
 * policy written twice with different thresholds — a threshold in
 * `userInstructions` and another for the same policy in `instructionsMd`.
 *
 * That is not redundancy. Redundancy is two copies that agree, and it costs
 * tokens. This costs correctness: the model resolves the conflict arbitrarily,
 * differently on different turns, and NEITHER COPY LOOKS WRONG ON ITS OWN, so
 * no reviewer reading either artifact finds anything. It is only visible as a
 * relation between two artifacts, which is why it needs a metric rather than a
 * fence.
 *
 * The measure is deliberately narrow: a policy is a KEYWORD plus a NUMBER, and
 * a contradiction is the same keyword carrying different numbers in the two
 * layers. It is not trying to understand the policy, only to notice that the
 * agent has been told two things. A broader reading would report every number
 * that happens to differ between the artifacts, which is most of them.
 *
 * Returns null when either layer is absent — a comparison needs both halves,
 * and scoring a missing artifact as "no contradictions" would report the
 * emptiest output as the best one.
 */
export function contradictoryThresholdRate(output: DistillOutput | undefined): number | null {
  if (!output) return null;
  const a = (output.userInstructions ?? '').trim();
  const b = (output.instructionsMd ?? '').trim();
  if (!a || !b) return null;

  const left = thresholdsByKeyword(a);
  const right = thresholdsByKeyword(b);
  const shared = [...left.keys()].filter((k) => right.has(k));
  if (shared.length === 0) return null;

  const contradictory = shared.filter((k) => {
    const l = left.get(k)!;
    const r = right.get(k)!;
    // Disagreement, not mere difference: a keyword carrying {3} in one layer
    // and {3, 5} in the other is a superset, and the shared value means the
    // agent was not told two incompatible things about it.
    return ![...l].some((v) => r.has(v));
  });

  return contradictory.length / shared.length;
}

/** Words that introduce a policy a number can attach to. Deliberately short:
 *  every entry here is a word whose number is a RULE rather than a fact about
 *  the world, so "3 repositories" does not become a policy and "retry 3 times"
 *  does. */
const POLICY_WORDS = [
  'retry', 'retries', 'attempt', 'attempts', 'timeout', 'wait', 'delay',
  'limit', 'max', 'maximum', 'minimum', 'min', 'threshold', 'cap',
  'escalate', 'escalation', 'batch', 'page', 'per', 'within', 'after', 'before',
] as const;

/**
 * Map each policy word appearing in a text to the set of numbers stated near it.
 *
 * "Near" is the same sentence, because a policy and its number are written
 * together and crossing sentence boundaries turns an adjacent unrelated figure
 * into a false contradiction.
 */
function thresholdsByKeyword(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sentence of text.split(/[.\n;]+/)) {
    const lower = sentence.toLowerCase();
    const numbers = [...lower.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((m) => m[1]);
    if (numbers.length === 0) continue;
    // The FIRST policy word only. One sentence states one policy, and
    // "escalate after 2 failures" contains two words from the list — counting
    // it twice inflates the denominator and dilutes a real contradiction into
    // a smaller-looking rate. Consistent with using the sentence as the
    // proximity unit in the first place.
    const word = POLICY_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(lower));
    if (!word) continue;
    const set = out.get(word) ?? new Set<string>();
    for (const n of numbers) set.add(n);
    out.set(word, set);
  }
  return out;
}
