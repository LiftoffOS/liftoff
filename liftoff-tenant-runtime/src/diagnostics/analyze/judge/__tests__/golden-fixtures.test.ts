// Structural integrity of the synthetic golden set. This does NOT call the LLM
// judges (that is the `--calibrate --golden` job). It guarantees the ground-truth
// set is well-formed and balanced so a κ run against it is meaningful: every judged
// dimension needs BOTH pass and fail exemplars, or Cohen's κ is degenerate.

import { GOLDEN_FIXTURES, goldenLabeledSet } from '../golden-fixtures';
import { computeCohenKappa } from '../calibrate';

describe('golden set — structural integrity', () => {
  it('every fixture has a unique id, an inline run, and a rationale', () => {
    const ids = new Set<string>();
    for (const f of GOLDEN_FIXTURES) {
      expect(f.id).toBeTruthy();
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.run).toBeTruthy();
      expect(f.rationale.length).toBeGreaterThan(20);
    }
  });

  it('every fixture carries at least one ground-truth label', () => {
    for (const f of GOLDEN_FIXTURES) {
      const labeled =
        f.goalPass != null || f.conformancePass != null || f.argAppropriatenessPass != null;
      expect(labeled).toBe(true);
    }
  });

  it('every inline run is an interactive conversation (so the LLM judge fires)', () => {
    for (const f of GOLDEN_FIXTURES) {
      const msgs = f.run.trajectory.messages;
      expect(msgs.some((m) => m.role === 'user')).toBe(true);
      expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
    }
  });

  it.each([
    ['goal', (n: number) => GOLDEN_FIXTURES.filter((f) => f.goalPass === !!n)],
    ['conformance', (n: number) => GOLDEN_FIXTURES.filter((f) => f.conformancePass === !!n)],
    ['argAppropriateness', (n: number) => GOLDEN_FIXTURES.filter((f) => f.argAppropriatenessPass === !!n)],
  ] as const)('dimension %s has both pass and fail exemplars', (_dim, pick) => {
    expect(pick(1).length).toBeGreaterThan(0); // at least one pass
    expect(pick(0).length).toBeGreaterThan(0); // at least one fail
  });

  it('goldenLabeledSet() returns the fixtures as LabeledRun[]', () => {
    const set = goldenLabeledSet();
    expect(set.length).toBe(GOLDEN_FIXTURES.length);
    expect(set[0].run).toBeTruthy();
  });

  it('κ sanity: perfect judge agreement on the labels yields κ = 1', () => {
    // Simulate a judge that agrees with every goal label → κ must be 1.
    const pairs = GOLDEN_FIXTURES.filter((f) => f.goalPass != null).map((f) => ({
      human: f.goalPass!,
      judge: f.goalPass!,
    }));
    expect(computeCohenKappa(pairs)).toBeCloseTo(1, 5);
  });
});
