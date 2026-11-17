// The distiller may only surface a tool as a workflow STEP if the runtime can
// dispatch it as one. find_teammates violated that — surfaced as step-eligible
// while the structured executor had no dispatch arm — so the first self-serve
// subscriber's agent failed graph validation on every message. These pin the
// contract so it cannot silently regress.

import {
  RUNTIME_DISPATCHABLE_BUILTINS,
  DISTILLER_INJECTED_BUILTINS,
  isUndispatchableStepTool,
  __internalValidateWorkflowSteps as validateWorkflowSteps,
  type ToolCatalog,
} from '../distill-service';
import type { WorkflowStep } from '../types';

describe('distiller ↔ runtime dispatch contract', () => {
  it('every builtin the distiller injects is runtime-dispatchable', () => {
    // MIRROR check against tenant-runtime BUILTIN_DISPATCH_NAMES. If someone
    // adds a collaboration tool to the distiller catalog without wiring a
    // runtime dispatch arm, this fails here instead of at a customer's turn.
    for (const name of DISTILLER_INJECTED_BUILTINS) {
      expect(RUNTIME_DISPATCHABLE_BUILTINS.has(name)).toBe(true);
    }
  });

  it('the three peer-collaboration tools are in the dispatchable set', () => {
    for (const name of ['find_teammates', 'send_agent_message', 'read_agent_messages']) {
      expect(RUNTIME_DISPATCHABLE_BUILTINS.has(name)).toBe(true);
    }
  });
});

describe('isUndispatchableStepTool', () => {
  it('is false for every real injected builtin (subset holds by construction)', () => {
    for (const name of DISTILLER_INJECTED_BUILTINS) {
      expect(isUndispatchableStepTool(name)).toBe(false);
    }
  });

  it('is false for a connector / non-injected tool it has no opinion on', () => {
    expect(isUndispatchableStepTool('gmail-1a2b__send')).toBe(false);
    expect(isUndispatchableStepTool('shell_exec')).toBe(false);
  });

  it('fires on the regression: an injected builtin the runtime never wired', () => {
    // Simulate the exact past failure with crafted sets — a tool the distiller
    // injects but that is absent from the runtime dispatcher.
    expect(isUndispatchableStepTool('new_collab_tool', ['new_collab_tool'], new Set())).toBe(true);
    // And it clears the moment the runtime gains the arm.
    expect(isUndispatchableStepTool('new_collab_tool', ['new_collab_tool'], new Set(['new_collab_tool']))).toBe(false);
  });
});

describe('validateWorkflowSteps dispatchability guard', () => {
  const catalog: ToolCatalog = new Map([
    ['find_teammates', { name: 'find_teammates', description: 'discover teammates' }],
  ]);

  it('accepts a find_teammates tool_call step now that the runtime dispatches it', () => {
    const steps: WorkflowStep[] = [
      { stepId: 's1', type: 'tool_call', toolName: 'find_teammates', onSuccess: '', onFailure: null } as WorkflowStep,
    ];
    const errors = validateWorkflowSteps(steps, catalog);
    expect(errors.some((e) => e.type === 'undispatchable_tool')).toBe(false);
  });
});
