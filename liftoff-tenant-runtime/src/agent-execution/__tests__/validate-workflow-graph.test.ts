/**
 * Phase 4 — validateWorkflowGraph tests: graph validation covering
 * dangling references, duplicate stepIds, loop collections, unreachable steps,
 * and condition parsing.
 */

import { validateWorkflowGraph } from '../validate-workflow-graph';
import type { WorkflowStep } from '../types';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Steps carry a type because a graph of pure no-ops is not a workflow: the
// executor's final `else` advances without doing anything, so an all-no-op graph
// walks to completion having executed nothing. These fixtures exercise graph
// STRUCTURE, so they describe steps that would actually run.
function makeStep(overrides: Partial<WorkflowStep> & { stepId: string }): WorkflowStep {
  return {
    description: `Step ${overrides.stepId}`,
    type: 'llm_reason',
    ...overrides,
  };
}

describe('Phase 4 — validateWorkflowGraph', () => {
  it('valid linear graph passes with no errors', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1', onSuccess: 'step2' }),
      makeStep({ stepId: 'step2', onSuccess: 'step3' }),
      makeStep({ stepId: 'step3' }),
    ];
    expect(validateWorkflowGraph(steps)).toEqual([]);
  });

  it('valid branching graph passes', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'start', onSuccess: 'a', onFailure: 'b' }),
      makeStep({ stepId: 'a' }),
      makeStep({ stepId: 'b' }),
    ];
    expect(validateWorkflowGraph(steps)).toEqual([]);
  });

  it('detects dangling onSuccess reference', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1', onSuccess: 'nonexistent' }),
    ];
    const errors = validateWorkflowGraph(steps);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('DANGLING_REF');
    expect(errors[0].message).toContain('nonexistent');
  });

  it('detects dangling onFailure reference', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1', onFailure: 'missing' }),
    ];
    const errors = validateWorkflowGraph(steps);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('DANGLING_REF');
    expect(errors[0].message).toContain('missing');
  });

  it('detects duplicate stepId', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'dup', onSuccess: 'dup' }),
      makeStep({ stepId: 'dup' }),
    ];
    const errors = validateWorkflowGraph(steps);
    const dupErrors = errors.filter(e => e.code === 'DUPLICATE_STEP_ID');
    expect(dupErrors).toHaveLength(1);
    expect(dupErrors[0].message).toContain('dup');
  });

  it('two sequential loop steps are legal', () => {
    // The same fixture the old `detects nested loops` case asserted an error
    // on. Nothing here is nested: `executeLoopStep` iterates ONE step's own
    // tool over `loop.over` and has no notion of a body, `WorkflowStep` has no
    // sub-step field, and `onSuccess` is what runs AFTER the loop. So the
    // check called every downstream step a body step, and a graph with two
    // loops anywhere on one forward path never executed a single step.
    //
    // For example, a loop s14 over the cards to update and a loop s15 over the
    // cards to create, with `s14.onSuccess === 's15'`, would die before step 1
    // with `[NESTED_LOOP] Step "s15" has a loop inside the body of loop step
    // "s14"`.
    const steps: WorkflowStep[] = [
      makeStep({
        stepId: 'outer',
        loop: { over: 'items' },
        onSuccess: 'inner',
      }),
      makeStep({
        stepId: 'inner',
        loop: { over: 'sub_items' },
      }),
    ];
    expect(validateWorkflowGraph(steps)).toEqual([]);
  });

  describe('loop.over', () => {
    // The field that was validated NOWHERE. A graph that could not iterate
    // passed every pre-flight check, while a graph that runs correctly was
    // refused by the nested-loop check above.
    it('accepts every form the executor resolves', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 's1', onSuccess: 's2' }),
        makeStep({ stepId: 's2', loop: { over: 'steps.s1.findings' }, onSuccess: 's3' }),
        makeStep({ stepId: 's3', loop: { over: '{{steps.s1.findings}}' }, onSuccess: 's4' }),
        makeStep({ stepId: 's4', loop: { over: 'items' }, onSuccess: 's5' }),
        makeStep({ stepId: 's5', loop: { over: '{{input.message.ids}}' } }),
      ];
      expect(validateWorkflowGraph(steps)).toEqual([]);
    });

    it('reports a collection the runtime will not substitute', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', loop: { over: '{{now.iso}}' } }),
      ]);
      const loopErrors = errors.filter(e => e.code === 'UNRESOLVABLE_LOOP_COLLECTION');
      expect(loopErrors).toHaveLength(1);
      expect(loopErrors[0].stepId).toBe('s1');
    });

    it('reports a collection naming a step that does not exist', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', loop: { over: '{{steps.ghost.rows}}' } }),
      ]);
      expect(errors.filter(e => e.code === 'UNRESOLVABLE_LOOP_COLLECTION')).toHaveLength(1);
    });

    it('refuses a loop on a step with nothing to run per item', () => {
      // `executeLoopStep` dispatches on `toolName`, or on llm_reason /
      // capability through invokeStepLLM. A looped step that is neither walks
      // its collection and executes NOTHING, then reports success.
      const errors = validateWorkflowGraph([
        { stepId: 's1', description: 'gather', type: 'delay', loop: { over: 'items' } } as WorkflowStep,
      ]);
      const hit = errors.filter(e => e.code === 'LOOP_STEP_EXECUTES_NOTHING');
      expect(hit).toHaveLength(1);
      expect(hit[0].stepId).toBe('s1');
    });

    it('accepts a loop on a reasoning step, which the executor now runs per item', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', onSuccess: 's2' }),
        makeStep({ stepId: 's2', type: 'llm_reason', loop: { over: 'steps.s1.competitors' } }),
      ]);
      expect(errors).toEqual([]);
    });

    it('reports an empty collection rather than iterating nothing quietly', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', loop: { over: '  ' } }),
      ]);
      expect(errors.filter(e => e.code === 'UNRESOLVABLE_LOOP_COLLECTION')).toHaveLength(1);
    });
  });

  describe('`output` addressed as if it were the step registry', () => {
    // The live defect: `output` IS a readable root, so the existing rule passed
    // `output.s13.cards_to_update` — which walks s13's own output looking for a
    // key called "s13". Zero iterations, and no check said anything.
    it('reports it in a loop collection', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's13', onSuccess: 's14' }),
        makeStep({ stepId: 's14', loop: { over: 'output.s13.cards_to_update' } }),
      ]);
      const named = errors.filter(e => e.code === 'OUTPUT_ROOT_NAMES_A_STEP');
      expect(named).toHaveLength(1);
      expect(named[0].stepId).toBe('s14');
      expect(named[0].message).toContain('steps.s13.cards_to_update');
    });

    it('reports it in a tool template', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', onSuccess: 's2' }),
        makeStep({
          stepId: 's2', type: 'tool_call', toolName: 't',
          toolInputTemplate: '{"rows":{{output.s1.rows}}}',
        }),
      ]);
      const named = errors.filter(e => e.code === 'OUTPUT_ROOT_NAMES_A_STEP');
      expect(named).toHaveLength(1);
      expect(named[0].message).toContain('steps.s1.rows');
    });

    it('says nothing about an `output` path that names no step', () => {
      // `output.plan.channels` reads the previous step's own `plan` key, which
      // is exactly what `output` means. Only a segment that IS another step's
      // id is evidence the author meant the registry.
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', onSuccess: 's2' }),
        makeStep({ stepId: 's2', loop: { over: 'output.plan.channels' } }),
      ]);
      expect(errors.filter(e => e.code === 'OUTPUT_ROOT_NAMES_A_STEP')).toEqual([]);
    });

    it('says nothing about a bare path, which is read against that same output', () => {
      const errors = validateWorkflowGraph([
        makeStep({ stepId: 's1', onSuccess: 's2' }),
        makeStep({ stepId: 's2', loop: { over: 'rows' } }),
      ]);
      expect(errors).toEqual([]);
    });
  });

  it('detects unreachable steps', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1' }),
      makeStep({ stepId: 'orphan' }),
    ];
    const errors = validateWorkflowGraph(steps);
    const unreachable = errors.filter(e => e.code === 'UNREACHABLE_STEP');
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].stepId).toBe('orphan');
  });

  it('treats empty-string onSuccess/onFailure as terminal (not flagged)', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1', onSuccess: '', onFailure: '' }),
    ];
    const errors = validateWorkflowGraph(steps);
    expect(errors).toEqual([]);
  });

  it('detects invalid condition without $. reference', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1', condition: 'not a valid condition' }),
    ];
    const errors = validateWorkflowGraph(steps);
    const condErrors = errors.filter(e => e.code === 'INVALID_CONDITION');
    expect(condErrors).toHaveLength(1);
  });

  it('rejects an unnamespaced condition, which reads nothing at runtime', () => {
    // This used to assert the opposite, and the reasoning it recorded is
    // exactly the hole: "$.status will run fine — status is undefined, so it
    // returns false. No error." Returning false on EVERY run is not a passing
    // condition, it is a branch that can never be taken. The evaluator is
    // handed { input, steps }, so the workflow author meant `$.input.status`.
    const errors = validateWorkflowGraph([
      makeStep({ stepId: 'step1', condition: "$.status == 'open'" }),
    ]);
    expect(errors.map(e => e.code)).toEqual(['INVALID_CONDITION_ROOT']);
  });

  it('passes the same condition once it names its root', () => {
    expect(validateWorkflowGraph([
      makeStep({ stepId: 'step1', condition: "$.input.status == 'open'" }),
    ])).toEqual([]);
  });

  it('handles empty step array', () => {
    expect(validateWorkflowGraph([])).toEqual([]);
  });

  it('accumulates multiple errors', () => {
    const steps: WorkflowStep[] = [
      makeStep({ stepId: 'step1', onSuccess: 'missing1', onFailure: 'missing2' }),
      makeStep({ stepId: 'step1' }), // duplicate
      makeStep({ stepId: 'island' }), // unreachable
    ];
    const errors = validateWorkflowGraph(steps);
    // Should have: 1 duplicate, 2 dangling refs, 1 unreachable
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  // D-4.7: Tool name resolution
  describe('tool name resolution (D-4.7)', () => {
    it('tool name in catalog passes validation', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 'step1', toolName: 'salesforce__read_record' }),
      ];
      const catalog = new Set(['salesforce__read_record', 'slack__send_message']);
      const errors = validateWorkflowGraph(steps, catalog);
      expect(errors.filter(e => e.code === 'UNRESOLVABLE_TOOL')).toHaveLength(0);
    });

    it('tool name NOT in catalog produces UNRESOLVABLE_TOOL error', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 'step1', toolName: 'nonexistent__tool' }),
      ];
      const catalog = new Set(['salesforce__read_record']);
      const errors = validateWorkflowGraph(steps, catalog);
      const toolErrors = errors.filter(e => e.code === 'UNRESOLVABLE_TOOL');
      expect(toolErrors).toHaveLength(1);
      expect(toolErrors[0].stepId).toBe('step1');
      expect(toolErrors[0].message).toContain('nonexistent__tool');
    });

    it('validation still works when availableToolNames is not provided (backward compat)', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 'step1', toolName: 'anything__goes' }),
      ];
      const errors = validateWorkflowGraph(steps);
      expect(errors.filter(e => e.code === 'UNRESOLVABLE_TOOL')).toHaveLength(0);
    });

    it('skips tool name check when catalog is empty (no manifests loaded)', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 'step1', toolName: 'anything__goes' }),
      ];
      const errors = validateWorkflowGraph(steps, new Set());
      expect(errors.filter(e => e.code === 'UNRESOLVABLE_TOOL')).toHaveLength(0);
    });
  });

  // D-4.8: Template JSON structure validation
  describe('template JSON validation (D-4.8)', () => {
    it('flags toolInputTemplate that is not valid JSON', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 's1', toolInputTemplate: 'not json at all' }),
      ];
      const errors = validateWorkflowGraph(steps);
      expect(errors).toContainEqual(expect.objectContaining({ code: 'INVALID_TEMPLATE', stepId: 's1' }));
    });

    it('accepts valid toolInputTemplate with variables', () => {
      const steps: WorkflowStep[] = [
        makeStep({
          stepId: 's1',
          toolInputTemplate: '{"channel": {{input.channel}}, "text": {{output.summary}}}',
        }),
      ];
      const errors = validateWorkflowGraph(steps);
      expect(errors.filter(e => e.code === 'INVALID_TEMPLATE')).toHaveLength(0);
    });

    it('valid template with no variables passes', () => {
      const steps: WorkflowStep[] = [
        makeStep({
          stepId: 'step1',
          toolInputTemplate: '{"channel": "general", "text": "hello"}',
        }),
      ];
      const errors = validateWorkflowGraph(steps);
      expect(errors.filter(e => e.code === 'INVALID_TEMPLATE')).toHaveLength(0);
    });

    it('step without template is not checked', () => {
      const steps: WorkflowStep[] = [
        makeStep({ stepId: 'step1' }),
      ];
      const errors = validateWorkflowGraph(steps);
      expect(errors.filter(e => e.code === 'INVALID_TEMPLATE')).toHaveLength(0);
    });
  });

  describe('capability steps', () => {
    it('a capability step is a known type — not UNKNOWN_STEP_TYPE, not a no-op', () => {
      const steps: WorkflowStep[] = [
        {
          stepId: 's1',
          description: 'Enrich the lead',
          type: 'capability',
          capabilityNeed: { operation: 'enrich person', entity: 'profiles', mode: 'public_data' },
        },
      ];
      const errors = validateWorkflowGraph(steps);
      expect(errors.filter(e => e.code === 'UNKNOWN_STEP_TYPE')).toHaveLength(0);
      expect(errors.filter(e => e.code === 'NO_OP_WORKFLOW')).toHaveLength(0);
    });

    it('an all-capability graph is not flagged as executing nothing', () => {
      const steps: WorkflowStep[] = [
        { stepId: 's1', description: 'Look it up', type: 'capability',
          capabilityNeed: { operation: 'search posts', entity: 'posts', mode: 'public_data' } },
      ];
      expect(validateWorkflowGraph(steps)).toEqual([]);
    });
  });
});
