// A tool call with no `onFailure` hands its failure to the recovery model.
//
// Unset does not mean "this cannot fail". It means the throw leaves the graph
// and the recovery model re-reasons about a step the author never planned to
// lose. On a step the rest of the graph depends on, that is the whole workflow
// improvising around a hole.
//
// Example: `s1` is the duplicate guard the graph is built around: `s2` reads
// the verdict, `s3` gates the entire competitor sweep on `s2`. If `s1` carries
// no onFailure and the guard is refused at dispatch — say it passes `target` as
// a string where the tool declares an object — there is no designed path at
// all, and the graph's one real decision is made from a value nobody produced.
// The run can escalate repeatedly while telling the person, calmly, that the
// work was already done.
//
// The rule codifies what well-formed graphs already do: every tool_call
// carries an onFailure, and the only steps without are terminal llm_reason
// closers.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findToolCallsWithoutFailureEdge } from '../distill-service';
import type { WorkflowStep } from '../types';

const step = (over: Partial<WorkflowStep>): WorkflowStep => ({
  stepId: 's1', description: 'd', type: 'tool_call', onSuccess: 's2', ...over,
} as WorkflowStep);

describe('a tool_call must declare where a failure goes', () => {
  it('flags a have_i_acted_on guard with no failure edge', () => {
    const errors = findToolCallsWithoutFailureEdge([step({
      stepId: 's1',
      toolName: 'have_i_acted_on',
      toolInput: { connector: 'google_docs', target: { document_id: 'x' } },
    } as Partial<WorkflowStep>)]);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('tool_call_without_failure_edge');
    expect(errors[0].stepId).toBe('s1');
    expect(errors[0].detail).toContain('have_i_acted_on');
  });

  it('accepts the same step once it has one', () => {
    expect(findToolCallsWithoutFailureEdge([step({
      stepId: 's1', toolName: 'have_i_acted_on', onFailure: 's2',
    } as Partial<WorkflowStep>)])).toEqual([]);
  });

  it('flags every offender, not just the first', () => {
    const errors = findToolCallsWithoutFailureEdge([
      step({ stepId: 's1', toolName: 'a__b' } as Partial<WorkflowStep>),
      step({ stepId: 's2', toolName: 'c__d' } as Partial<WorkflowStep>),
    ]);
    expect(errors.map((e) => e.stepId)).toEqual(['s1', 's2']);
  });

  // Recovery is the proper business of a reasoning step, and demanding an
  // else-edge on every one of them would be noise. A CONDITION on an llm_reason
  // is a different matter and findConditionsWithoutElse already owns it.
  it.each([
    ['llm_reason', { type: 'llm_reason' }],
    ['ask_user', { type: 'ask_user' }],
    ['delay', { type: 'delay' }],
  ])('says nothing about a %s step', (_label, over) => {
    expect(findToolCallsWithoutFailureEdge([step({
      stepId: 's1', toolName: undefined, ...over,
    } as Partial<WorkflowStep>)])).toEqual([]);
  });

  it('treats an untyped step carrying a toolName as the tool_call it is', () => {
    const errors = findToolCallsWithoutFailureEdge([step({
      stepId: 's1', type: undefined, toolName: 'slack_send_message',
    } as Partial<WorkflowStep>)]);
    expect(errors).toHaveLength(1);
  });
});

// Calibration, kept in the suite so a later widening has to argue with
// healthy graphs rather than with an opinion.
describe('it codifies what the healthy graphs already do', () => {
  // Shapes typical of graphs whose failure handling is complete (code review,
  // customer support, web research, price reporting). Every tool_call in them
  // routes its failure.
  const healthy: WorkflowStep[] = [
    step({ stepId: 's1', toolName: 'trigger__pr_get', onFailure: 's_fail' } as Partial<WorkflowStep>),
    step({ stepId: 's2', toolName: 'google-mail-0105297e__get_thread', onFailure: 's14' } as Partial<WorkflowStep>),
    step({ stepId: 's3', toolName: 'slack_resolve_channel_by_name', onFailure: 's8' } as Partial<WorkflowStep>),
    step({ stepId: 's4', toolName: 'google-sheets-2b820bc9__append_values', onFailure: 's6' } as Partial<WorkflowStep>),
    // The closers those graphs legitimately leave unset.
    step({ stepId: 's_fail', type: 'llm_reason', toolName: undefined, onSuccess: '' } as Partial<WorkflowStep>),
    step({ stepId: 's15', type: 'llm_reason', toolName: undefined, onSuccess: '' } as Partial<WorkflowStep>),
  ];

  it('passes a graph built the way the good ones are', () => {
    expect(findToolCallsWithoutFailureEdge(healthy)).toEqual([]);
  });

  it('and flags the shape the thin ones have', () => {
    const thin = [...healthy, step({ stepId: 's9', toolName: 'google-slides-d0bcff6d__create_slides_from_markdown', onFailure: undefined } as Partial<WorkflowStep>)];
    expect(findToolCallsWithoutFailureEdge(thin).map((e) => e.stepId)).toEqual(['s9']);
  });
});
