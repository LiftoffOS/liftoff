/**
 * A park never advances the cursor past a step that is half done.
 *
 * A loop step is the only step that can be half done: it iterates, and each
 * iteration does real work. If the wall clock runs out mid-loop and the loop
 * returns a plain `success: false`, that throws into recovery, lets the run
 * advance, and leaves the park recording a cursor one step PAST the loop it
 * abandoned. The resumed invocation then finds no registry entry for that step,
 * and the back-reference check refuses — correctly — to compute on missing
 * data. The run is unresumable from the moment it parks: the resume reports the
 * loop step missing, the work is thrown away, and the person is told it cannot
 * continue.
 *
 * "The run is BETWEEN steps: nothing is half-done" is true at a park for every
 * step except this one.
 *
 * service.ts pulls DB + engine SDKs transitively, so this asserts the source in
 * the same idiom as the other *.source tests here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

describe('the loop reports a ceiling as a position, not a failure', () => {
  it('returns parkAt carrying the item it reached', () => {
    expect(SERVICE).toMatch(/parkAt: \{\s*\n\s*stepId: step\.stepId,\s*\n\s*nextIndex: i,/);
  });

  it('carries what the completed iterations produced, so the work is not redone', () => {
    const arm = SERVICE.slice(SERVICE.indexOf('parkAt: {'), SERVICE.indexOf('parkAt: {') + 400);
    expect(arm).toContain('collected: [...collected]');
    expect(arm).toContain('itemFailures: [...itemFailures]');
    expect(arm).toContain('attempted,');
  });
});

describe('the park keeps its cursor on the loop', () => {
  it('parks at step.stepId, not at the next step', () => {
    const at = SERVICE.indexOf('if (loopResult.parkAt) {');
    expect(at).toBeGreaterThan(-1);
    const branch = SERVICE.slice(at, at + 700);
    expect(branch).toContain('resumeAtStepId: step.stepId');
    expect(branch).toContain('loopPosition: loopResult.parkAt');
  });

  it('falls back to the failure it reported when the park cannot be scheduled', () => {
    // A continuation that was not actually scheduled must never be reported as
    // one, so an unschedulable park has to behave as it did before.
    const at = SERVICE.indexOf('if (loopResult.parkAt) {');
    expect(SERVICE.slice(at, at + 900)).toMatch(/Could not schedule|fall through to the failure/);
  });
});

describe('the position is consumed once', () => {
  it('is cleared after the loop has taken it', () => {
    // Left in place it would re-seed the loop on a second entry in the same
    // invocation — a retry or a recovery — and skip items it had just redone.
    expect(SERVICE).toMatch(/loopResume: carriedLoopPosition,[\s\S]{0,80}?\);\s*\n\s*carriedLoopPosition = null;/);
  });

  it('is hydrated from the pause rather than rebuilt', () => {
    expect(SERVICE).toMatch(/let carriedLoopPosition: LoopPosition \| null = resumeState\?\.loopPosition \?\? null;/);
  });

  it('is ignored when it names a different step', () => {
    // Applying one loop's position to another would restart it part-way
    // through, silently skipping items nothing had attempted.
    expect(SERVICE).toMatch(/reasoning\?\.loopResume\?\.stepId === step\.stepId/);
  });
});
