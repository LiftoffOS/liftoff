// Cross-step addressing: what the distiller's schema, its exemplar and the
// shared-types comment all described, and none of them had.
//
// Before this, `evaluateCondition` received the bare previous `stepOutput` and
// `TemplateContext` had no `steps` slot. Two consequences, both silent:
//
//   1. No step could reference an earlier one. A nine-step workflow had to
//      thread every value forward by hand, and `outputField` narrowing threw
//      the rest away permanently.
//   2. A predecessor that extracted a SCALAR made a condition unwritable.
//      `getByPath` returns undefined for a non-object root, and parsePredicate
//      requires a field path — so there was no expression at all for "the
//      previous step returned true".
//
// Both surfaces now read one context: { input, steps, item }.

import { evaluateCondition } from '../condition';
import { substitute } from '../template';

describe('conditions over the step registry', () => {
  const ctx = {
    input: { status: 'approved', threshold: 10 },
    steps: {
      gate: true,                              // a scalar output
      risk: { escalate: true, score: 42 },
      fetch: { records: [{ id: 'a' }, { id: 'b' }] },
    },
  };

  it('reaches any completed step by id', () => {
    expect(evaluateCondition("$.steps.risk.escalate == true", ctx)).toBe(true);
    expect(evaluateCondition("$.steps.risk.score > 40", ctx)).toBe(true);
  });

  it('addresses a step whose output is a bare scalar', () => {
    // THE case that had no expression. `outputField: 'proceed'` leaves
    // stepOutput as a boolean; `$.proceed` against it resolves to undefined
    // forever. Through the registry the root is an object, so the step is
    // addressable by name.
    expect(evaluateCondition("$.steps.gate == true", ctx)).toBe(true);
  });

  it('reaches the workflow input explicitly', () => {
    expect(evaluateCondition("$.input.status == 'approved'", ctx)).toBe(true);
    expect(evaluateCondition("$.input.status == 'rejected'", ctx)).toBe(false);
  });

  it('is false, not thrown, for a step that has not run yet', () => {
    // A forward reference is a workflow-authoring mistake, but a run must not
    // die on it mid-flight — the branch simply does not take.
    expect(evaluateCondition("$.steps.notyet.field == true", ctx)).toBe(false);
  });

  it('still supports the combinators over the new roots', () => {
    expect(evaluateCondition("$.steps.risk.escalate == true && $.input.status == 'approved'", ctx)).toBe(true);
    expect(evaluateCondition("$.steps.gate == false || $.steps.risk.score > 40", ctx)).toBe(true);
  });

  it('reads an array element through the registry', () => {
    expect(evaluateCondition("$.steps.fetch.records.0.id == 'a'", ctx)).toBe(true);
  });
});

describe('toolInputTemplate over the step registry', () => {
  const ctx = {
    input: { ticket: 'ENG-1' },
    output: { latest: 'previous-step' },
    steps: { s1: { prId: 42 }, s5: { verdict: 'approve' } },
  };

  it('reaches an earlier step by id', () => {
    // Values are JSON.stringify'd on insertion — a deliberate injection
    // defence, so an attacker-controlled string cannot introduce JSON sibling
    // fields into the tool arguments. Strings arrive quoted; numbers do not.
    expect(substitute('{{steps.s1.prId}}', ctx)).toBe('42');
    expect(substitute('{{steps.s5.verdict}}', ctx)).toBe('"approve"');
  });

  it('leaves the previous-step and input roots working', () => {
    // `output` keeps meaning the previous step; nothing stored changes meaning
    // because of this addition.
    expect(substitute('{{output.latest}}', ctx)).toBe('"previous-step"');
    expect(substitute('{{input.ticket}}', ctx)).toBe('"ENG-1"');
  });

  it('quotes a step value the same way it quotes every other root', () => {
    // The injection defence must not have a hole at the new root.
    expect(substitute('{{steps.s5.verdict}}', ctx))
      .toBe(substitute('{{output.latest}}', { output: { latest: 'approve' } }));
  });

  it('uses the same names as the condition syntax', () => {
    // The whole point: one mental model. A generator that learns
    // `steps.<id>.<field>` writes it correctly on both surfaces, and cannot
    // conflate them, because there is nothing left to conflate.
    expect(substitute('{{steps.s1.prId}}', ctx)).toBe('42');
    expect(evaluateCondition('$.steps.s1.prId == 42', ctx)).toBe(true);
  });
});
