// A comparison against a value the run does not carry is not a decision.
//
// `evalPredicate` coerces with `String(actual)`, so an absent left side becomes
// the string "undefined" and compares like any other value. The predicate is
// false, the else-edge is taken, and downstream nothing can tell that apart
// from the author's own branch being chosen deliberately.
//
// Two graph shapes fail through that one mechanism, with opposite blast radius:
//
//   a research sweep   `$.steps.s2.proceed == 'yes'`
//     guard produced nothing -> predicate false -> skips the whole sweep.
//
//   a report builder   `$.steps.s1.window_known == false`
//     window step produced nothing -> predicate false -> skips ASKING the
//     user and builds a deck with no reporting window.
//
// Which one a graph gets depends only on which side of the predicate the author
// put the safe path on, which is why flipping a polarity is not the fix and the
// enumerating test below asserts exactly that.

import { unresolvedComparisonPaths, evaluateCondition } from '../condition';
import { ConditionInputMissingError } from '../types';
import type { WorkflowStep } from '../types';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('unresolvedComparisonPaths', () => {
  const data = {
    input: { threadId: 't1' },
    steps: { s1: { present: false, zero: 0, empty: '', nulled: null }, s2: {} },
  };

  it('names a path the run does not carry', () => {
    expect(unresolvedComparisonPaths("$.steps.s2.proceed == 'yes'", data)).toEqual(['steps.s2.proceed']);
  });

  it('names a path into a step that produced nothing at all', () => {
    expect(unresolvedComparisonPaths('$.steps.s9.done == true', data)).toEqual(['steps.s9.done']);
  });

  it('names an unresolved workflow input', () => {
    expect(unresolvedComparisonPaths("$.input.message.from == 'x'", data)).toEqual(['input.message.from']);
  });

  // The distinction the whole fix rests on: a value that IS there and happens to
  // be falsy is a value, and the predicate over it is a real decision.
  it.each([
    ['false', '$.steps.s1.present == false'],
    ['zero', '$.steps.s1.zero > 1'],
    ['empty string', "$.steps.s1.empty == 'x'"],
    ['null', '$.steps.s1.nulled == 1'],
  ])('treats a present but falsy value (%s) as carried', (_label, condition) => {
    expect(unresolvedComparisonPaths(condition, data)).toEqual([]);
  });

  // Absence is the question these ask, so an unresolved path is their input.
  it.each([
    '$.steps.s2.channel is null',
    '$.steps.s2.channel is not null',
  ])('exempts the null-check predicate %s', (condition) => {
    expect(unresolvedComparisonPaths(condition, data)).toEqual([]);
  });

  it('reports every unresolved path in a compound condition', () => {
    expect(
      unresolvedComparisonPaths("$.steps.s2.a == '1' && $.steps.s2.b == '2'", data),
    ).toEqual(['steps.s2.a', 'steps.s2.b']);
  });

  it('does not flag the resolved half of a compound condition', () => {
    expect(
      unresolvedComparisonPaths('$.steps.s1.present == false && $.steps.s2.b == 2', data),
    ).toEqual(['steps.s2.b']);
  });

  it('throws on an unparseable predicate, exactly as evaluateCondition does', () => {
    expect(() => unresolvedComparisonPaths('not a condition', data)).toThrow();
    expect(() => evaluateCondition('not a condition', data)).toThrow();
  });
});

// The property that makes this a platform fix rather than a graph edit.
describe('the defect does not depend on which way the predicate is written', () => {
  const noOutput = { input: {}, steps: { s1: {} } };

  it.each([
    ['== false  (report builder: skips asking the user)',
      '$.steps.s1.window_known == false', false, 'steps.s1.window_known'],
    ['!= true   (the polarity flip that reads safer)',
      '$.steps.s1.window_known != true', true, 'steps.s1.window_known'],
    ["== 'yes'  (research sweep: skips the sweep)",
      "$.steps.s1.proceed == 'yes'", false, 'steps.s1.proceed'],
    ["!= 'no'   (its flip)",
      "$.steps.s1.proceed != 'no'", true, 'steps.s1.proceed'],
  ])('%s is flagged, whatever it evaluates to', (_label, condition, evaluatesTo, path) => {
    // Both polarities silently produce an ANSWER from data that is not there,
    // and they disagree — which is the whole problem, since nothing downstream
    // can see that the disagreement is about nothing.
    expect(evaluateCondition(condition, noOutput)).toBe(evaluatesTo);
    // Both are caught, so no graph needs its condition rewritten by hand.
    expect(unresolvedComparisonPaths(condition, noOutput)).toEqual([path]);
  });
});

describe('ConditionInputMissingError', () => {
  const step = { stepId: 's3', description: '' } as WorkflowStep;

  it('names the step and every unresolved path', () => {
    const err = new ConditionInputMissingError(step, ['steps.s2.proceed', 'input.week']);
    expect(err.message).toContain('s3');
    expect(err.message).toContain('$.steps.s2.proceed');
    expect(err.message).toContain('$.input.week');
    expect(err.paths).toEqual(['steps.s2.proceed', 'input.week']);
  });
});

// Source-level, for the same reason the dead-end suite is: the behaviour sits
// mid-way through an executor whose loop needs a live gateway, a catalog and a
// tenant to enter.
describe('the executor routes it to recovery, not down the else-edge', () => {
  const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

  it('checks for unresolved inputs before evaluating the predicate', () => {
    const block = SRC.slice(
      SRC.indexOf('const missingConditionInputs = unresolvedComparisonPaths('),
      SRC.indexOf('const conditionMet = evaluateCondition('),
    );
    expect(block.length).toBeGreaterThan(100);
    expect(block).toContain('conditionInputsMissing = missingConditionInputs;');
  });

  it('exempts a path into a step the cursor never entered', () => {
    const block = SRC.slice(
      SRC.indexOf('const missingConditionInputs = unresolvedComparisonPaths('),
      SRC.indexOf('const conditionMet = evaluateCondition('),
    );
    expect(block).toContain('!enteredSteps.has(referenced)');
  });

  it('throws from inside the execution try so the step never runs', () => {
    expect(SRC).toContain('throw new ConditionInputMissingError(step, conditionInputsMissing);');
  });

  it('classifies it as a contract defect, which is what keeps it off onFailure', () => {
    // A condition with no input is UNCONDITIONALLY a defect: the comparison was
    // never made, so there is no else-case for the author to have meant. The
    // template half beside it is narrower — a reference the producing step
    // reported as null is the author's to branch on — and that narrowing must
    // not reach this one.
    expect(SRC).toMatch(/\|\|\s*e instanceof ConditionInputMissingError\b/);
    expect(SRC).not.toMatch(/ConditionInputMissingError && !/);
  });

  it('maps it to a recovery bucket rather than leaving it unclassified', () => {
    const block = SRC.slice(SRC.indexOf('if (error instanceof ConditionInputMissingError) {'));
    expect(block.slice(0, 300)).toContain("kind: 'template_expansion'");
  });
});
