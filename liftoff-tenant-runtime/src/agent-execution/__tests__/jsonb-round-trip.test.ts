/**
 * D-3.6 — JSONB round-trip test for camelCase WorkflowStep.
 *
 * Verifies that a WorkflowStep object with all Phase 3 fields survives
 * the JSON.stringify → JSON.parse cycle (simulating PostgreSQL JSONB
 * column write → read). This guards against field-name case changes,
 * silent field drops, or type coercion that could break the executor.
 */

import type { WorkflowStep } from '../types';

describe('D-3.6 — WorkflowStep JSONB round-trip', () => {
  const fullStep: WorkflowStep = {
    stepId: 'step-1',
    description: 'Read customer record',
    toolName: 'salesforce_prod__read_record',
    toolInput: { id: 'cust-123', fields: ['name', 'email'] },
    toolInputTemplate: '{"id": {{input.customerId}}}',
    outputField: 'customer.email',
    condition: '$.status == \'active\'',
    onSuccess: 'step-2',
    onFailure: 'step-error',
    loop: {
      over: 'items',
      itemVar: 'record',
      maxIterations: 50,
      collect: true,
    },
    retry: {
      maxAttempts: 3,
      backoffMs: 2000,
    },
    timeoutMs: 30000,
    requiresApproval: true,
    idempotencyKey: 'custom-key-123',
  };

  it('all camelCase field names survive JSON stringify + parse', () => {
    const serialized = JSON.stringify(fullStep);
    const deserialized = JSON.parse(serialized) as WorkflowStep;

    // Every field must be present with the exact camelCase name
    expect(deserialized.stepId).toBe('step-1');
    expect(deserialized.description).toBe('Read customer record');
    expect(deserialized.toolName).toBe('salesforce_prod__read_record');
    expect(deserialized.toolInput).toEqual({ id: 'cust-123', fields: ['name', 'email'] });
    expect(deserialized.toolInputTemplate).toBe('{"id": {{input.customerId}}}');
    expect(deserialized.outputField).toBe('customer.email');
    expect(deserialized.condition).toBe("$.status == 'active'");
    expect(deserialized.onSuccess).toBe('step-2');
    expect(deserialized.onFailure).toBe('step-error');
    expect(deserialized.loop).toEqual({
      over: 'items',
      itemVar: 'record',
      maxIterations: 50,
      collect: true,
    });
    expect(deserialized.retry).toEqual({ maxAttempts: 3, backoffMs: 2000 });
    expect(deserialized.timeoutMs).toBe(30000);
    expect(deserialized.requiresApproval).toBe(true);
    expect(deserialized.idempotencyKey).toBe('custom-key-123');
  });

  it('no snake_case field names exist after round-trip', () => {
    const serialized = JSON.stringify(fullStep);
    // The serialized JSON must NOT contain any of the old snake_case field names
    expect(serialized).not.toContain('"step_id"');
    expect(serialized).not.toContain('"tool_name"');
    expect(serialized).not.toContain('"tool_input"');
    expect(serialized).not.toContain('"on_success"');
    expect(serialized).not.toContain('"on_failure"');
  });

  it('workflow steps array round-trips cleanly', () => {
    const steps: WorkflowStep[] = [
      fullStep,
      { stepId: 'step-2', description: 'Send notification', onSuccess: '' },
      { stepId: 'step-error', description: 'Handle error', toolName: 'slack__send', onSuccess: '' },
    ];

    const serialized = JSON.stringify(steps);
    const deserialized = JSON.parse(serialized) as WorkflowStep[];

    expect(deserialized).toHaveLength(3);
    expect(deserialized[0].stepId).toBe('step-1');
    expect(deserialized[1].stepId).toBe('step-2');
    expect(deserialized[2].toolName).toBe('slack__send');
  });
});
