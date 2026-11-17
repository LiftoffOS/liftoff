// The steps and their hash have to travel together, and the decision about what
// to store has to distinguish three cases that a boolean cannot.

import {
  decideWorkflowStepsArrival,
  computeWorkflowStepsHash,
} from '../workflow-steps-arrival';
import type { WorkflowStep } from '../../agent-execution/types';

const STEPS = [
  { id: 's1', type: 'llm_reason', instruction: 'read the diff' },
  { id: 's2', type: 'tool_call', instruction: 'post the comment' },
] as unknown as WorkflowStep[];

describe('deciding what to persist when steps arrive', () => {
  it('stores steps whose hash matches', () => {
    const d = decideWorkflowStepsArrival({
      workflowSteps: STEPS,
      workflowStepsHash: computeWorkflowStepsHash(STEPS),
    });
    expect(d).toEqual({ action: 'set', steps: STEPS });
  });

  it('refuses steps whose hash does not match, rather than storing them unverified', () => {
    // THE point of the hash. `verifyWorkflowStepsHash` would also catch this,
    // but only after a run had started from steps already known to be wrong.
    const d = decideWorkflowStepsArrival({
      workflowSteps: STEPS,
      workflowStepsHash: 'deadbeef'.repeat(8),
    });
    expect(d.action).toBe('leave');
    expect(d).toMatchObject({ reason: 'hash_mismatch' });
  });

  it('notices a single mutated field', () => {
    // A tamper check that only caught wholesale replacement would not be worth
    // the column.
    const tampered = JSON.parse(JSON.stringify(STEPS)) as typeof STEPS;
    (tampered[1] as unknown as { instruction: string }).instruction = 'delete the branch';
    const d = decideWorkflowStepsArrival({
      workflowSteps: tampered,
      workflowStepsHash: computeWorkflowStepsHash(STEPS),
    });
    expect(d.action).toBe('leave');
  });

  it('accepts steps that carry no hash yet', () => {
    // The control plane pins the hash on review, so steps can legitimately
    // exist before anyone has reviewed them. Refusing those would make the
    // feature unusable until a review happened.
    const d = decideWorkflowStepsArrival({ workflowSteps: STEPS });
    expect(d).toEqual({ action: 'set', steps: STEPS });
  });

  it('leaves stored steps alone when the field is absent', () => {
    // A publisher that predates this field sends nothing. Treating absent as
    // "no steps" would wipe them on every event from an older instance during
    // a rollout.
    expect(decideWorkflowStepsArrival({})).toEqual({ action: 'leave', reason: 'absent' });
    expect(decideWorkflowStepsArrival({ workflowStepsHash: 'abc' }))
      .toEqual({ action: 'leave', reason: 'absent' });
  });

  it('clears stored steps when the control plane explicitly has none', () => {
    // Absent and empty are different facts. Without this, removing a workflow
    // upstream would leave it executing here forever.
    expect(decideWorkflowStepsArrival({ workflowSteps: null })).toEqual({ action: 'clear' });
    expect(decideWorkflowStepsArrival({ workflowSteps: [] })).toEqual({ action: 'clear' });
  });
});

describe('the hash itself', () => {
  it('ignores key order, because JSON round-trips do not preserve it', () => {
    const a = [{ id: 's1', type: 'llm_reason' }] as unknown as WorkflowStep[];
    const b = [{ type: 'llm_reason', id: 's1' }] as unknown as WorkflowStep[];
    expect(computeWorkflowStepsHash(a)).toBe(computeWorkflowStepsHash(b));
  });

  it('does not ignore step order, because a sequence is the whole point', () => {
    const forward = STEPS;
    const reversed = [STEPS[1], STEPS[0]] as unknown as WorkflowStep[];
    expect(computeWorkflowStepsHash(forward)).not.toBe(computeWorkflowStepsHash(reversed));
  });

  it('matches the control plane byte for byte on a known value', () => {
    // Both sides compute sha256 over JSON with object keys sorted at every
    // level. If they ever drift, a correct payload gets rejected as tampered
    // and the feature silently turns itself off again — so this pins the exact
    // algorithm rather than trusting two copies to stay equal.
    const expected = require('crypto')
      .createHash('sha256')
      .update(JSON.stringify(STEPS, (_k: string, v: unknown) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            sorted[k] = (v as Record<string, unknown>)[k];
          }
          return sorted;
        }
        return v;
      }))
      .digest('hex');
    expect(computeWorkflowStepsHash(STEPS)).toBe(expected);
  });
});
