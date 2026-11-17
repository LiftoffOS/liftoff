/**
 * Everything a pause carries is read back by the resume.
 *
 * The writer (`carriedLoopState`) and the reader were two hand-written lists in
 * two files, and they had already drifted: the payload carried `stepReplay` and
 * `cloud-tasks-handler`'s continuation branch never read it. So every
 * wall-clock continuation dropped the ledger whose whole job is to stop a
 * resumed step re-dispatching calls it had already completed — on exactly the
 * long, interrupted runs most likely to repeat themselves. Nothing failed; the
 * guarantee simply became a coincidence.
 *
 * This is the ratchet for that class. Write a field, and the build fails until
 * something reads it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CARRIED_RESUME_KEYS, readCarriedResumeState, carriedLoopState } from '../service';
import { StepReplayLedger } from '../step-replay-ledger';

/** A loop state with every field populated, so the writer emits all of them. */
function fullLoopState() {
  return {
    stepOutputs: { s1: { a: 1 } },
    enteredSteps: new Set(['s1', 's2']),
    unsatisfiedSteps: new Set(['s2']),
    salvagedSteps: new Set(['s1']),
    salvageNotes: { s1: { missing: ['x'] } },
    stepReplay: (() => {
      // A REAL ledger with a real recorded call: the writer serialises it and
      // emits nothing for an empty one, so a stub here would make the
      // round-trip assertions below pass without stepReplay ever appearing.
      const l = new StepReplayLedger('s1');
      l.record(
        [{ id: 'c1', name: 'google-docs__create_document_markdown', input: { title: 't' }, result: { id: 'd1' }, success: true }],
        () => true,   // the call is mutating, which is what the ledger holds
      );
      return new Map([['s1', l]]);
    })(),
    perStepRecoveries: { s1: 1 },
    totalRecoveries: 1,
    recoveryHistory: [{ stepId: 's1', anomalyKind: 'tool_error', decision: 'continue', kind: 'fresh' as const }],
    loopPosition: { stepId: 's7', nextIndex: 2, collected: [1, 2], itemFailures: [], attempted: 2 },
  } as unknown as Parameters<typeof carriedLoopState>[0];
}

describe('the writer and the key list agree', () => {
  it('every key the writer emits is declared', () => {
    const written = Object.keys(carriedLoopState(fullLoopState()));
    for (const key of written) {
      expect(CARRIED_RESUME_KEYS as readonly string[]).toContain(key);
    }
  });

  it('every declared key is actually emitted when the state holds it', () => {
    // The other direction: a key declared and never written would make the
    // reader look complete while carrying nothing.
    const written = new Set(Object.keys(carriedLoopState(fullLoopState())));
    for (const key of CARRIED_RESUME_KEYS) {
      expect(written.has(key)).toBe(true);
    }
  });

  it('includes stepReplay, the field the reader had lost', () => {
    expect(CARRIED_RESUME_KEYS as readonly string[]).toContain('stepReplay');
    expect(Object.keys(carriedLoopState(fullLoopState()))).toContain('stepReplay');
  });

  it('includes loopPosition, so a half-done loop can resume where it stopped', () => {
    expect(Object.keys(carriedLoopState(fullLoopState()))).toContain('loopPosition');
  });
});

describe('the reader is the writer’s inverse', () => {
  it('round-trips every carried field', () => {
    const written = carriedLoopState(fullLoopState()) as unknown as Record<string, unknown>;
    const read = readCarriedResumeState(written) as Record<string, unknown>;
    for (const key of Object.keys(written)) expect(read[key]).toEqual(written[key]);
  });

  it('leaves an absent field ABSENT rather than defaulting it', () => {
    // "The pause did not carry this" and "the pause carried nothing for this"
    // are different facts, and the resume-time reference check reports the
    // first as a loud failure. Defaulting here would silence it.
    const read = readCarriedResumeState({ stepOutputs: { s1: 1 } }) as Record<string, unknown>;
    expect('stepReplay' in read).toBe(false);
    expect('loopPosition' in read).toBe(false);
  });

  it('ignores keys it does not own', () => {
    const read = readCarriedResumeState({ somethingElse: 1 }) as Record<string, unknown>;
    expect(read).toEqual({});
  });

  it('survives a missing payload', () => {
    expect(readCarriedResumeState(undefined)).toEqual({});
    expect(readCarriedResumeState(null)).toEqual({});
  });
});

describe('the continuation branch uses the reader, not a list of its own', () => {
  const HANDLER = readFileSync(join(__dirname, '..', '..', 'handlers', 'cloud-tasks-handler.ts'), 'utf8');

  it('spreads readCarriedResumeState into carryOver', () => {
    expect(HANDLER).toMatch(/\.\.\.readCarriedResumeState\(/);
  });

  it('does not name the carried fields one by one any more', () => {
    // The shape that lost stepReplay. A field listed here is a field that can
    // be forgotten here.
    const branch = HANDLER.slice(HANDLER.indexOf("objective: payload.objective ?? 'run-continuation'"));
    const head = branch.slice(0, 1200);
    for (const key of ['stepOutputs:', 'enteredSteps:', 'unsatisfiedSteps:', 'salvagedSteps:', 'salvageNotes:']) {
      expect(head).not.toContain(`payload.${key.slice(0, -1)},`);
    }
  });
});
