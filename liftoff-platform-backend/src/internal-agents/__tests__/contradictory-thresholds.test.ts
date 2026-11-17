// The layer table's measure: one policy stated twice with different numbers.
//
// This is not a redundancy metric. Redundancy is two copies that agree and it
// costs tokens; this costs correctness. The model resolves the conflict
// arbitrarily and differently on different turns, and NEITHER COPY LOOKS WRONG
// ON ITS OWN — so no reviewer reading either artifact finds anything. It only
// exists as a relation between two artifacts, which is why it is a metric over
// the corpus rather than a fence on one output.
//
// The measure is deliberately narrow. A policy is a keyword plus a number, and
// a contradiction is the same keyword carrying disjoint numbers across the two
// layers. Reading it more broadly would report every number that happens to
// differ between the artifacts, which is most of them, and a metric that fires
// on everything is one nobody reads.

import { contradictoryThresholdRate } from '../distill-comparison-metrics';
import type { DistillOutput } from '../distill-service';

const out = (userInstructions: string, instructionsMd: string): DistillOutput =>
  ({ userInstructions, instructionsMd }) as unknown as DistillOutput;

describe('contradictoryThresholdRate', () => {
  it('is null when either layer is missing', () => {
    // Scoring a missing artifact as "no contradictions" would report the
    // emptiest output as the best one.
    expect(contradictoryThresholdRate(out('retry 3 times', ''))).toBeNull();
    expect(contradictoryThresholdRate(out('', 'retry 3 times'))).toBeNull();
    expect(contradictoryThresholdRate(undefined)).toBeNull();
  });

  it('is null when the layers share no policy', () => {
    // Nothing to contradict. Zero would claim a clean result was measured.
    expect(contradictoryThresholdRate(out('retry 3 times', 'be polite'))).toBeNull();
  });

  it('scores zero when the layers agree', () => {
    expect(contradictoryThresholdRate(out('Retry 3 times.', 'Retry up to 3 times.'))).toBe(0);
  });

  it('catches the same policy with different numbers', () => {
    const r = contradictoryThresholdRate(out('Retry 3 times.', 'Retry 5 times.'));
    expect(r).toBe(1);
  });

  it('treats a superset as agreement, not contradiction', () => {
    // {3} against {3,5} shares a value: the agent was not told two
    // incompatible things, it was told one of them twice.
    expect(contradictoryThresholdRate(out('Retry 3 times.', 'Retry 3 times, then 5.'))).toBe(0);
  });

  it('does not cross sentence boundaries', () => {
    // A policy and its number are written together. Crossing sentences turns
    // an adjacent unrelated figure into a false contradiction.
    const r = contradictoryThresholdRate(out(
      'Retry 3 times. There are 9 repositories.',
      'Retry 3 times. There are 4 environments.',
    ));
    expect(r).toBe(0);
  });

  it('ignores numbers that are facts rather than policies', () => {
    // "3 repositories" is a fact about the world; "retry 3 times" is a rule.
    // Only the second can contradict.
    expect(contradictoryThresholdRate(out(
      'Work across 4 repositories.',
      'Work across 9 repositories.',
    ))).toBeNull();
  });

  it('reports a FRACTION of shared policies, not a count', () => {
    // Two shared policies, one contradicting.
    const r = contradictoryThresholdRate(out(
      'Retry 3 times. Escalate after 2 failures.',
      'Retry 5 times. Escalate after 2 failures.',
    ));
    expect(r).toBe(0.5);
  });
});
