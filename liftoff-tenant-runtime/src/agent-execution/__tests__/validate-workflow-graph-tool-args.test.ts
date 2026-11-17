// An authored call that cannot satisfy the tool it names.
//
// A `tool_call` step carries its arguments in the graph, and they were checked
// for JSON validity and for placeholders that resolve — never against the
// schema of the tool they are sent to. So a step could name a required argument
// that does not exist and omit one that does, pass every gate, and fail at
// dispatch instead: once per fire, forever, as a generic tool error.
//
// Graphs that call `have_i_acted_on` tend not to supply its `target`. The
// argument is declared as an object with no properties, so the shape has to be
// read out of prose, and authoring reaches for something else instead —
// `{connector, tool_name, args}` or flat identifying fields, the conventions the
// other tool calls use. `connector` is present, so the tool's first guard passes
// and the second rejects, and the duplicate-work guard never runs.
//
// A redistill does not fix it: it can come back with the same step and a
// second one shaped the same way.

import { readFileSync } from 'fs';
import { join } from 'path';
import { validateWorkflowGraph } from '../validate-workflow-graph';
import { getStandardTool } from '../../tools/standard-tools';
import type { WorkflowStep } from '../types';

const step = (o: Partial<WorkflowStep> & { stepId: string }): WorkflowStep =>
  ({ description: 'd', type: 'tool_call', ...o } as WorkflowStep);

const argErrors = (steps: WorkflowStep[]) =>
  validateWorkflowGraph(steps).filter((e) => e.code === 'MISSING_REQUIRED_TOOL_ARG');

describe('a tool_call must supply the arguments its tool requires', () => {
  it('the tool this was found on still declares target required', () => {
    // If this stops being true the cases below prove nothing, so it is asserted
    // rather than assumed.
    const schema = getStandardTool('have_i_acted_on')?.input_schema as { required?: string[] };
    expect(schema.required).toEqual(expect.arrayContaining(['connector', 'target']));
  });

  it('flags the shape every authoring of it has produced', () => {
    const found = argErrors([
      step({
        stepId: 's1b',
        toolName: 'have_i_acted_on',
        toolInput: {
          connector: 'google_docs',
          tool_name: 'google-docs-8fd9fc68__update_document_markdown',
          args: { document_id: '1aCLb' },
        },
      } as WorkflowStep),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].stepId).toBe('s1b');
    expect(found[0].message).toContain('"target"');
    // Naming what it DID supply is what makes the message actionable: the
    // author reached for a convention, and seeing both lists shows the swap.
    expect(found[0].message).toContain('"tool_name"');
  });

  it('reads a template as well as a literal', () => {
    const found = argErrors([
      step({
        stepId: 's2b',
        toolName: 'have_i_acted_on',
        toolInputTemplate: '{"connector":"version_control","repository":"{{steps.s2.repository}}"}',
      } as WorkflowStep),
    ]);
    expect(found.map((e) => e.stepId)).toEqual(['s2b']);
  });

  it('accepts a call that supplies them', () => {
    expect(argErrors([
      step({
        stepId: 's1',
        toolName: 'have_i_acted_on',
        toolInput: { connector: 'github', target: { owner: 'o', repo: 'r', pull_number: 1 } },
      } as WorkflowStep),
    ])).toEqual([]);
  });

  it('leaves a step that authors no arguments alone', () => {
    // Trigger-bound steps have theirs injected at dispatch, and a static check
    // cannot see that binding. Flagging them would refuse a working shape.
    expect(argErrors([
      step({ stepId: 's1', toolName: 'have_i_acted_on' } as WorkflowStep),
    ])).toEqual([]);
  });

  it('says nothing about a connector tool, whose schema it does not hold', () => {
    // Per-tenant and loaded from a live cache this validator does not take.
    // Answering the same question from an absence would fail every such step.
    expect(argErrors([
      step({
        stepId: 's1',
        toolName: 'my_gmail__send_email',
        toolInput: { nothing: 'relevant' },
      } as WorkflowStep),
    ])).toEqual([]);
  });

  it('does not double-report a template that is not valid JSON', () => {
    // INVALID_TEMPLATE owns that finding. Two errors for one defect sends the
    // author looking for two problems.
    const all = validateWorkflowGraph([
      step({ stepId: 's1', toolName: 'have_i_acted_on', toolInputTemplate: '{"connector":' } as WorkflowStep),
    ]);
    expect(all.filter((e) => e.code === 'MISSING_REQUIRED_TOOL_ARG')).toEqual([]);
    expect(all.some((e) => e.code === 'INVALID_TEMPLATE')).toBe(true);
  });
});

describe('the runtime treats it as step-local', () => {
  const SERVICE = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

  it('degrades the step rather than failing the whole run', () => {
    // Every graph carrying this was authored against a check that did not
    // exist. Failing those runs outright stops agents doing useful work for a
    // defect the platform never told anyone about.
    const line = SERVICE.slice(SERVICE.indexOf('const DEGRADABLE = new Set('), SERVICE.indexOf('const DEGRADABLE = new Set(') + 140);
    expect(line).toContain('MISSING_REQUIRED_TOOL_ARG');
  });
});
