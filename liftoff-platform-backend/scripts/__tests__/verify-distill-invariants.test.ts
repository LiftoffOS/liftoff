// Unit tests for the distill regression invariants harness.
// I7 asserts the hybrid execution engine retired `produce_workflow` from
// distillation: the tool-registration call site offers only `produce_agent`,
// and the optional structured backbone rides on the same tool's output.

import { checkI7 } from '../verify-distill-invariants';

describe('I7 — produce_workflow tool is not offered to the LLM', () => {
  it('passes when only produce_agent is offered', () => {
    const result = checkI7(['produce_agent']);
    expect(result.pass).toBe(true);
  });

  it('fails when produce_workflow appears in the offered tool list', () => {
    const result = checkI7(['produce_agent', 'produce_workflow']);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/produce_workflow/);
  });

  it('passes on an empty tool list (degenerate but not a regression)', () => {
    const result = checkI7([]);
    expect(result.pass).toBe(true);
  });
});
