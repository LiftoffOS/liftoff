// A run pushed off the side of its graph is not a run that finished.
//
// `onFailure` is the ELSE branch of a `condition`. When the predicate does not
// hold the executor sets `currentStepId = step.onFailure || ''`, and an empty
// string ends the while loop. Everything downstream is skipped. Nothing failed
// to produce a declared output, so `unsatisfiedSteps` stays empty and the
// function returned `success: true` from the bottom.
//
// Prod shape, agent e8af341f: a router chose "escalate", its single guarded
// successor tested for "search-help", and the run stopped there. No escalation,
// no teammate notified, no acknowledgement to the customer, not even a
// mark-as-read — and a green outcome on the invocation. That is the reported
// symptom exactly: it looked like it was doing its work and never completed it.
//
// Ending a run because a branch does not apply is a legitimate pattern. Ending
// it INVISIBLY is the defect, so this reports rather than forbids.
//
// Source-level: the behaviour lives mid-way through a many-hundred-line executor
// whose loop needs a live gateway, a catalog and a tenant to enter.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

describe('the dead end is recorded where it happens', () => {
  it('records a step whose condition failed and had no else-edge', () => {
    const block = SRC.slice(
      SRC.indexOf('if (!conditionMet) {'),
      SRC.indexOf('if (!conditionMet) {') + 500,
    );
    expect(block).toContain('if (!step.onFailure) conditionDeadEnds.add(step.stepId);');
  });

  it('does not record one when an else-edge exists', () => {
    // Guarded on `!step.onFailure`, so the ordinary if/else — s6 routing its
    // low-confidence case to the Slack escalation — records nothing.
    const block = SRC.slice(
      SRC.indexOf('if (!conditionMet) {'),
      SRC.indexOf('if (!conditionMet) {') + 500,
    );
    expect(block).toMatch(/if \(!step\.onFailure\) conditionDeadEnds\.add/);
    expect(block).toContain("currentStepId = step.onFailure || '';");
  });
});

describe('the end-of-graph accounting stops calling it success', () => {
  const tail = SRC.slice(SRC.indexOf('const conditionDeadEnds = new Set<string>();'));

  it('escalates when the only fault is a dead end', () => {
    const block = tail.slice(
      tail.indexOf('if (unsatisfiedSteps.size === 0 && conditionDeadEnds.size > 0) {'),
      tail.indexOf('if (unsatisfiedSteps.size > 0) {'),
    );
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain("terminalState: 'escalated'");
    expect(block).toContain("outcome: 'escalated'");
    expect(block).toContain('hybrid_loop.condition_dead_end');
  });

  it('names the steps, so the graph can be fixed without a repro', () => {
    const block = tail.slice(
      tail.indexOf('if (unsatisfiedSteps.size === 0 && conditionDeadEnds.size > 0) {'),
      tail.indexOf('if (unsatisfiedSteps.size > 0) {'),
    );
    expect(block).toContain('[...conditionDeadEnds].join');
    expect(block).toMatch(/ELSE branch of a condition/i);
    // Say whose fault it is: an operator reading this should not go hunting for
    // a decision the run made, because it did not make one.
    expect(block).toMatch(/defect in the workflow graph, not a decision the run made/i);
  });

  it('still reports the unsatisfied-output case, and mentions a dead end alongside it', () => {
    // The two faults can co-occur. The unsatisfied branch keeps priority — it is
    // the more specific complaint — but must not swallow the dead end.
    const block = tail.slice(
      tail.indexOf('if (unsatisfiedSteps.size > 0) {'),
      tail.indexOf('if (unsatisfiedSteps.size > 0) {') + 1200,
    );
    expect(block).toContain('const deadNote =');
    expect(block).toContain('conditionDeadEnds.size > 0');
    expect(block).toContain('${deadNote}');
  });

  it('leaves a clean run reporting plain success', () => {
    // No dead ends and no unsatisfied outputs must still fall through to the
    // unconditional success return; this check must not become a new way to
    // fail a healthy run.
    const success = tail.slice(tail.indexOf("outcome: 'success'"));
    expect(success).toContain('success: true');
    expect(success.slice(0, 400)).not.toContain('escalated');
  });
});
