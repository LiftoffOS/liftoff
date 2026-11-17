// The earlier-outputs section gets the calibration signal the predecessor's
// hand-off already has. The event is the one the schema registers, with the
// fields the ceiling's next revision is derived from, and the two things that
// were described but not measured in the first draft: how many entries only
// the omission notice counted, and how long the resolved objective — the
// other data path into the same prompt — actually was.

const logged: Array<Record<string, unknown>> = [];
jest.mock('../../../observability/scrub-logger', () => ({
  scrubLogger: { info: (p: Record<string, unknown>) => { logged.push(p); } },
}));

import { recordEarlierOutputsSection, EARLIER_OUTPUTS_BUDGET, STEP_OUTPUT_BUDGET } from '../prompt-budgets';
import { LogSchemas } from '../../../observability/log-schemas';

beforeEach(() => { logged.length = 0; });

describe('the earlier-outputs section event', () => {
  it('is the registered literal event, carrying objectiveChars and omitted, and validates against its schema', () => {
    recordEarlierOutputsSection('s6', {
      steps: 4, shown: 4, stubbed: 0, omitted: 0, chars: 8_500,
      ceiling: EARLIER_OUTPUTS_BUDGET, prepared: 0, objectiveChars: 1_200,
    }, { tenantId: 't-1', agentId: 'a-1', invocationId: 'i-1' });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'earlier_outputs_section_observed',
      stepId: 's6',
      steps: 4, shown: 4, stubbed: 0, omitted: 0, chars: 8_500,
      ceiling: EARLIER_OUTPUTS_BUDGET, prepared: 0, objectiveChars: 1_200,
      tenantId: 't-1', agentId: 'a-1', invocationId: 'i-1',
    });
    expect(() => LogSchemas.earlier_outputs_section_observed.parse(logged[0])).not.toThrow();
  });

  it('the ceiling is four per-value budgets', () => {
    expect(EARLIER_OUTPUTS_BUDGET).toBe(4 * STEP_OUTPUT_BUDGET);
  });
});
