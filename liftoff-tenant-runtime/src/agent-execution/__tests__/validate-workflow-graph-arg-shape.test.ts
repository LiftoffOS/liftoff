// Present is not the same as usable.
//
// The required-argument check asks whether a step names what the tool needs. It
// never asked whether what it names could be accepted. `have_i_acted_on`
// declares `target` as an object of identifying arguments; a redistill can
// author
//
//   {"connector":"google_docs","action":"update_document_markdown",
//    "target":"<document id>"}
//
// which names every required argument and is refused by the tool's own guard on
// every fire, because `typeof payload.target === 'object'` is false for a
// string. The duplicate-work guard the graph is built around never runs, and
// the step reads as correctly authored everywhere except at dispatch.

import { validateWorkflowGraph } from '../validate-workflow-graph';
import { getStandardTool } from '../../tools/standard-tools';
import type { WorkflowStep } from '../types';

const shapeErrors = (steps: WorkflowStep[]) =>
  validateWorkflowGraph(steps).filter((e) => e.code === 'WRONG_TYPE_TOOL_ARG');

const step = (over: Partial<WorkflowStep>): WorkflowStep => ({
  stepId: 's1',
  description: 'd',
  type: 'tool_call',
  onSuccess: '',
  ...over,
} as WorkflowStep);

describe('an authored argument must be a shape the tool can accept', () => {
  it('the tool this was found on still declares target an object', () => {
    const schema = getStandardTool('have_i_acted_on')?.input_schema as
      { properties?: Record<string, { type?: string }> };
    expect(schema?.properties?.target?.type).toBe('object');
  });

  it('flags a call whose argument shape does not match the tool', () => {
    const errors = shapeErrors([step({
      toolName: 'have_i_acted_on',
      toolInput: {
        connector: 'google_docs',
        action: 'update_document_markdown',
        target: '1ISydz_W62ijKhCbSWEz5OEwy3ZSXTacaLAf-x6A73CU',
      },
    } as Partial<WorkflowStep>)]);
    expect(errors).toHaveLength(1);
    expect(errors[0].stepId).toBe('s1');
    expect(errors[0].message).toContain('"target" must be object, not string');
  });

  it('the required-argument check alone would have passed it', () => {
    const missing = validateWorkflowGraph([step({
      toolName: 'have_i_acted_on',
      toolInput: { connector: 'google_docs', target: 'a-string' },
    } as Partial<WorkflowStep>)]).filter((e) => e.code === 'MISSING_REQUIRED_TOOL_ARG');
    expect(missing).toEqual([]);
  });

  it('accepts the object form', () => {
    expect(shapeErrors([step({
      toolName: 'have_i_acted_on',
      toolInput: {
        connector: 'google_docs',
        target: { document_id: '1ISydz_W62ijKhCbSWEz5OEwy3ZSXTacaLAf-x6A73CU' },
      },
    } as Partial<WorkflowStep>)])).toEqual([]);
  });

  it('does not judge a placeholder that occupies the whole value', () => {
    // What it resolves to is decided at dispatch, so there is no type here to
    // judge — and judging it as the string the template is written in would
    // reject every templated object argument in the fleet.
    expect(shapeErrors([step({
      toolName: 'have_i_acted_on',
      toolInputTemplate: '{"connector":"google_docs","target":{{steps.s0.target}}}',
    } as Partial<WorkflowStep>)])).toEqual([]);
  });

  it('still judges a value that merely interpolates a placeholder', () => {
    // Interpolation always yields a string, so this one does have a type.
    const errors = shapeErrors([step({
      toolName: 'have_i_acted_on',
      toolInputTemplate: '{"connector":"google_docs","target":"doc-{{steps.s0.id}}"}',
    } as Partial<WorkflowStep>)]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('"target" must be object, not string');
  });

  it.each([
    ['string for object', { connector: 'x', target: 'y' }, '"target" must be object, not string'],
    ['array for object', { connector: 'x', target: ['y'] }, '"target" must be object, not array'],
    ['number for string', { connector: 1, target: {} }, '"connector" must be string, not number'],
  ])('names the offending argument and both types (%s)', (_label, toolInput, expected) => {
    const errors = shapeErrors([step({ toolName: 'have_i_acted_on', toolInput } as Partial<WorkflowStep>)]);
    expect(errors[0].message).toContain(expected);
  });

  it('says nothing about a connector tool, whose schema it does not hold', () => {
    expect(shapeErrors([step({
      toolName: 'google-docs-8fd9fc68__update_document_markdown',
      toolInput: { document_id: 1234 },
    } as Partial<WorkflowStep>)])).toEqual([]);
  });

  it('leaves a step that authors no arguments alone', () => {
    expect(shapeErrors([step({ toolName: 'have_i_acted_on' } as Partial<WorkflowStep>)])).toEqual([]);
  });

  it('reports the missing argument instead when one is absent, never both', () => {
    const all = validateWorkflowGraph([step({
      toolName: 'have_i_acted_on',
      toolInput: { connector: 1 },
    } as Partial<WorkflowStep>)]);
    expect(all.filter((e) => e.code === 'MISSING_REQUIRED_TOOL_ARG')).toHaveLength(1);
    expect(all.filter((e) => e.code === 'WRONG_TYPE_TOOL_ARG')).toEqual([]);
  });
});

describe('the runtime treats it as step-local', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'), 'utf8',
  );

  it('degrades the step rather than failing the whole run', () => {
    const block = SRC.slice(SRC.indexOf('const DEGRADABLE = new Set('), SRC.indexOf('const fatal ='));
    expect(block).toContain('WRONG_TYPE_TOOL_ARG');
  });
});
