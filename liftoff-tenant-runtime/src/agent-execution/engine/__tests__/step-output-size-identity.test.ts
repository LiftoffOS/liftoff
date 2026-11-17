// A size event without an identity is a number; with one it is a lead.
//
// An over-budget step handoff that cannot be traced to an agent leaves the one
// question it raises — does that agent have a workspace? — to be answered by
// reasoning about capability tiers instead of by looking.

const logged: Array<Record<string, unknown>> = [];
jest.mock('../../../observability/scrub-logger', () => ({
  scrubLogger: { info: (p: Record<string, unknown>) => { logged.push(p); } },
}));

import { recordStepOutputSize, STEP_OUTPUT_BUDGET } from '../prompt-budgets';

beforeEach(() => { logged.length = 0; });

describe('the step-output size event', () => {
  it('carries who it happened to', () => {
    recordStepOutputSize('x'.repeat(50), STEP_OUTPUT_BUDGET, false,
      { tenantId: 't-1', agentId: 'a-1', invocationId: 'i-1' });

    expect(logged[0]).toMatchObject({ tenantId: 't-1', agentId: 'a-1', invocationId: 'i-1' });
  });

  it('names the state that matters: over budget AND nowhere to park it', () => {
    // Two existing booleans could express this, which is exactly why nobody
    // counted it. It gets its own field so it can be queried directly.
    recordStepOutputSize('x'.repeat(STEP_OUTPUT_BUDGET + 1), STEP_OUTPUT_BUDGET, false);
    expect(logged[0]).toMatchObject({ exceeded: true, offloaded: false, unrecoverable: true });
  });

  it('is not unrecoverable when the value was parked', () => {
    recordStepOutputSize('x'.repeat(STEP_OUTPUT_BUDGET + 1), STEP_OUTPUT_BUDGET, true);
    expect(logged[0]).toMatchObject({ exceeded: true, offloaded: true, unrecoverable: false });
  });

  it('is not unrecoverable when the value fit', () => {
    recordStepOutputSize('x'.repeat(10), STEP_OUTPUT_BUDGET, false);
    expect(logged[0]).toMatchObject({ exceeded: false, unrecoverable: false });
  });

  it('still records the size when the caller has no ids', () => {
    // The measurement is worth more than the attribution; a caller that cannot
    // supply ids must not silently stop measuring.
    recordStepOutputSize('x'.repeat(30), STEP_OUTPUT_BUDGET, false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ chars: 30 });
  });

  it('never throws on a value it cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => recordStepOutputSize(circular, STEP_OUTPUT_BUDGET, false)).not.toThrow();
    expect(logged).toHaveLength(0);
  });
});
