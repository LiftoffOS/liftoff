// Re-rooting `loop.over` from the root that cannot resolve to the one that can.
//
// The property the backfill needs is not "it rewrites" — it is that a SECOND
// pass changes nothing, because the script is re-runnable per environment and a
// value already rooted at `steps.` must not be touched again.

import type { WorkflowStep } from '@liftoffos/shared-types';
import { planLoopOverRewrites, unresolvableLoopOverCount } from '../loop-over-rewrite';

const step = (o: Partial<WorkflowStep> & { stepId: string }): WorkflowStep => ({
  description: `Step ${o.stepId}`,
  type: 'tool_call',
  ...o,
} as WorkflowStep);

describe('planLoopOverRewrites', () => {
  it('re-roots output.<stepId>.<field> to steps.<stepId>.<field>', () => {
    const steps = [
      step({ stepId: 's13', type: 'llm_reason', onSuccess: 's14' }),
      step({ stepId: 's14', toolName: 't', loop: { over: 'output.s13.cards_to_update' }, onSuccess: '' }),
    ];
    const plan = planLoopOverRewrites(steps);
    expect(plan.rewrites).toEqual([{ stepId: 's14', from: 'output.s13.cards_to_update', to: 'steps.s13.cards_to_update' }]);
    expect(plan.steps[1].loop?.over).toBe('steps.s13.cards_to_update');
  });

  it('a second pass changes zero values', () => {
    const steps = [
      step({ stepId: 's13', type: 'llm_reason', onSuccess: 's14' }),
      step({ stepId: 's14', toolName: 't', loop: { over: 'output.s13.cards_to_update' }, onSuccess: '' }),
    ];
    const once = planLoopOverRewrites(steps);
    const twice = planLoopOverRewrites(once.steps);
    expect(twice.rewrites).toEqual([]);
    expect(twice.skipped).toEqual([]);
    expect(twice.steps).toEqual(once.steps);
  });

  it('carries every other loop key through untouched', () => {
    const steps = [
      step({ stepId: 's1', type: 'llm_reason', onSuccess: 's2' }),
      step({
        stepId: 's2',
        toolName: 't',
        loop: { over: 'output.s1.rows', itemVar: 'row', maxIterations: 50, collect: true, continueOnItemFailure: true },
        onSuccess: '',
      }),
    ];
    const plan = planLoopOverRewrites(steps);
    expect(plan.steps[1].loop).toEqual({
      over: 'steps.s1.rows',
      itemVar: 'row',
      maxIterations: 50,
      collect: true,
      continueOnItemFailure: true,
    });
  });

  it('skips and reports a segment that names no step, rather than guessing', () => {
    const steps = [
      step({ stepId: 's1', type: 'llm_reason', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 't', loop: { over: 'output.plan.channels' }, onSuccess: '' }),
    ];
    const plan = planLoopOverRewrites(steps);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skipped).toEqual([
      { stepId: 's2', over: 'output.plan.channels', reason: '"plan" names no step in this workflow' },
    ]);
    expect(plan.steps[1].loop?.over).toBe('output.plan.channels');
  });

  it('leaves the forms that already resolve alone', () => {
    const steps = [
      step({ stepId: 's1', type: 'llm_reason', onSuccess: 's2' }),
      step({ stepId: 's2', toolName: 't', loop: { over: 'steps.s1.findings' }, onSuccess: 's3' }),
      step({ stepId: 's3', toolName: 't', loop: { over: '{{steps.s1.findings}}' }, onSuccess: 's4' }),
      // A bare path is read against the previous step's output, which is what
      // `output.<field>` with no second segment also means.
      step({ stepId: 's4', toolName: 't', loop: { over: 'items' }, onSuccess: 's5' }),
      step({ stepId: 's5', toolName: 't', loop: { over: 'output.rows' }, onSuccess: '' }),
    ];
    const plan = planLoopOverRewrites(steps);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.steps).toEqual(steps);
  });
});

describe('unresolvableLoopOverCount', () => {
  it('counts the values a stored column still carries', () => {
    expect(unresolvableLoopOverCount([
      { stepId: 's1', loop: { over: 'output.s0.a' } },
      { stepId: 's2', loop: { over: 'steps.s0.a' } },
      { stepId: 's3' },
    ])).toBe(1);
  });

  it('reads a column that is not an array as nothing to count', () => {
    expect(unresolvableLoopOverCount(null)).toBe(0);
  });
});
