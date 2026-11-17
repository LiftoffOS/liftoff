// Regression: the distillation LLM sometimes emits a synonym for the loop
// variable (observed: `as` instead of the runtime's `itemVar`). The create
// schema must normalize it and strip other stray keys rather than hard-fail the
// entire agent launch with `.strict()` on one unrecognized key — that 400'd the
// Code Reviewer (and every SWE-review) template launch.
import { workflowStepLoopSchema } from '../router';

describe('workflowStepLoopSchema — distiller synonym tolerance', () => {
  it('normalizes the distiller `as` key to `itemVar` (does not 400)', () => {
    const r = workflowStepLoopSchema.safeParse({ over: 'steps.s6.prs', as: 'pr' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ over: 'steps.s6.prs', itemVar: 'pr' });
      expect((r.data as Record<string, unknown>).as).toBeUndefined();
    }
  });

  it('does not clobber an explicit itemVar when both are present', () => {
    const r = workflowStepLoopSchema.safeParse({ over: 'x', as: 'ignored', itemVar: 'kept' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.itemVar).toBe('kept');
  });

  it('strips an unrecognized key instead of rejecting', () => {
    const r = workflowStepLoopSchema.safeParse({ over: 'x', somethingNew: 1 });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).somethingNew).toBeUndefined();
  });

  it('still accepts the canonical shape', () => {
    const r = workflowStepLoopSchema.safeParse({ over: 'x', itemVar: 'y', maxIterations: 5, collect: true });
    expect(r.success).toBe(true);
  });

  it('still requires `over`', () => {
    const r = workflowStepLoopSchema.safeParse({ as: 'pr' });
    expect(r.success).toBe(false);
  });
});
