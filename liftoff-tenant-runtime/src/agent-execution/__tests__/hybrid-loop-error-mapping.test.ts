// Verifies the hybrid loop's mapErrorToAnomalyContext discriminator and
// the OutputShapeMismatchError / AnomalousValueError classes.

import {
  OutputShapeMismatchError,
  AnomalousValueError,
  type WorkflowStep,
} from '../types';

describe('Hybrid execution engine — error classes', () => {
  const step: WorkflowStep = {
    stepId: 's1',
    description: 'd',
    toolName: 't',
    outputField: 'id',
  };

  it('OutputShapeMismatchError carries step + received', () => {
    const e = new OutputShapeMismatchError(step, { wrong: 'shape' });
    expect(e.name).toBe('OutputShapeMismatchError');
    expect(e.step).toBe(step);
    expect(e.received).toEqual({ wrong: 'shape' });
    expect(e.message).toContain('s1');
  });

  it('AnomalousValueError carries step, value, and reason', () => {
    const e = new AnomalousValueError(step, 'bad', 'looks-bogus');
    expect(e.name).toBe('AnomalousValueError');
    expect(e.value).toBe('bad');
    expect(e.reason).toBe('looks-bogus');
    expect(e.message).toContain('looks-bogus');
  });
});
