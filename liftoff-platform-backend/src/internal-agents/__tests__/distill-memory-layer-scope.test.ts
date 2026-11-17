// A memory layer is a VALUE the runtime's policy refuses, not a missing or
// wrong-typed argument — so the required-argument check and the shape check
// both pass it, and the call is refused at dispatch on every fire.
//
// Example: a graph's s8 saves the week's competitor snapshot to `role` and its
// s4 reads it back from `role`. If the agent may not write `role`, the write is
// refused every time ("Agent attempted to write to unauthorized memory layer",
// requested_layer="role"), the read returns nothing, and the week-over-week
// comparison the whole design rests on can never work.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findMemoryStepsOutsideScope } from '../distill-service';
import { DEFAULT_MEMORY_SCOPE } from '../memory-scope';
import type { WorkflowStep } from '../types';
import type { MemoryScope } from '../types';

const step = (over: Partial<WorkflowStep>): WorkflowStep => ({
  stepId: 's1', description: 'd', type: 'tool_call', onSuccess: 's2', onFailure: 's9', ...over,
} as WorkflowStep);

const ROLE_GRANTED: MemoryScope = { readableLayers: ['role'], writableLayers: ['role'] };

describe('a memory step may only name a layer the hire is granted', () => {
  it('flags the save that was refused on every fire', () => {
    const errors = findMemoryStepsOutsideScope([step({
      stepId: 's8',
      toolName: 'memory_save',
      toolInput: { layer: 'role', content: 'snapshot', tags: ['weekly-sweep'] },
    } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('memory_layer_outside_scope');
    expect(errors[0].stepId).toBe('s8');
    expect(errors[0].detail).toContain('"role"');
    expect(errors[0].detail).toContain('It can write: individual');
  });

  it('flags the read of the same layer, which returned nothing instead of erroring', () => {
    const errors = findMemoryStepsOutsideScope([step({
      stepId: 's4',
      toolName: 'memory_retrieve',
      toolInput: { query: 'last week snapshot', layers: ['role'] },
    } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE);
    expect(errors).toHaveLength(1);
    expect(errors[0].detail).toContain('It can read: global, individual');
  });

  // The template that grants role is the reason the distiller authored it.
  it('allows the same steps when the template grants the layer', () => {
    const steps = [
      step({ stepId: 's8', toolName: 'memory_save', toolInput: { layer: 'role', content: 'x' } } as Partial<WorkflowStep>),
      step({ stepId: 's4', toolName: 'memory_retrieve', toolInput: { query: 'q', layers: ['role'] } } as Partial<WorkflowStep>),
    ];
    expect(findMemoryStepsOutsideScope(steps, ROLE_GRANTED)).toEqual([]);
  });

  it('names every denied layer when a read asks for several', () => {
    const errors = findMemoryStepsOutsideScope([step({
      toolName: 'memory_retrieve',
      toolInput: { query: 'q', layers: ['global', 'role', 'conversation'] },
    } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE);
    expect(errors[0].detail).toContain('"role"');
    expect(errors[0].detail).toContain('"conversation"');
    expect(errors[0].detail).not.toContain('"global"');
  });

  it('reads a templated call as well as a literal one', () => {
    const errors = findMemoryStepsOutsideScope([step({
      toolName: 'memory_save',
      toolInputTemplate: '{"layer":"role","content":"{{steps.s6.competitors}}"}',
    } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE);
    expect(errors).toHaveLength(1);
  });

  it('leaves a layer that arrives at runtime alone', () => {
    expect(findMemoryStepsOutsideScope([step({
      toolName: 'memory_save',
      toolInputTemplate: '{"layer":"{{steps.s2.layer}}","content":"x"}',
    } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE)).toEqual([]);
  });

  it('says nothing about a step that authors no arguments', () => {
    expect(findMemoryStepsOutsideScope(
      [step({ toolName: 'memory_save' } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE,
    )).toEqual([]);
  });

  it('says nothing about any other tool', () => {
    expect(findMemoryStepsOutsideScope([step({
      toolName: 'have_i_acted_on', toolInput: { connector: 'x', target: { id: '1' } },
    } as Partial<WorkflowStep>)], DEFAULT_MEMORY_SCOPE)).toEqual([]);
  });

  // An undeclared side is the runtime's default to decide, not this check's.
  it('stays quiet when the scope declares nothing for that direction', () => {
    expect(findMemoryStepsOutsideScope(
      [step({ toolName: 'memory_save', toolInput: { layer: 'role', content: 'x' } } as Partial<WorkflowStep>)],
      { readableLayers: ['global'] },
    )).toEqual([]);
  });
});

// A gap the unit tests above cannot see.
//
// An agent can be redistilled with the check in place and its
// `memory_save layer:"role"` still survive. The competitive-intelligence
// template grants `writableLayers: [role]`, so validating against the TEMPLATE
// passes — while an agent created before templates were applied to the hire
// path still carries the platform default and would be refused at dispatch.
// The check has to ask the question dispatch asks.
describe('a redistill is judged by the scope the agent HAS', () => {
  const src = (rel: string) =>
    require('fs').readFileSync(require('path').join(__dirname, '..', rel), 'utf8');

  it('prefers the agent\'s own scope over the template that seeded the graph', () => {
    expect(src('distill-service.ts'))
      .toContain('input.currentMemoryScope ?? templateMemoryScope ?? DEFAULT_MEMORY_SCOPE');
  });

  it('and the redistill path supplies it', () => {
    // buildDistillInputFromAgent, which the redistill path and the shared
    // team update both call.
    expect(src('redistill-service.ts')).toContain('currentMemoryScope: agent.memoryScope');
  });

  it('flags the save when the agent is narrower than its template', () => {
    // The exact disagreement: template grants role, agent does not have it.
    const errors = findMemoryStepsOutsideScope(
      [step({ stepId: 's8', toolName: 'memory_save', toolInput: { layer: 'role', content: 'x' } } as Partial<WorkflowStep>)],
      { readableLayers: ['global', 'individual'], writableLayers: ['individual'] },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].detail).toContain('It can write: individual');
  });
});
