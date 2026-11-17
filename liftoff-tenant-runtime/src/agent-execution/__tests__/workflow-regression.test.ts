// Stored workflows, run through the checks.
//
// A pre-flight audit can report every workflow runnable while an agent then
// executes only some of its steps and reports success. A unit test that only
// exercises synthetic fixtures cannot tell whether that has changed, because
// the fixtures are written by the same person who wrote the check. These steps
// mirror stored `internal_agents.workflow_steps` rows instead.
//
// Trimmed to the fields the validators read (stepId, type, toolName, condition,
// toolInputTemplate, outputField, onSuccess/onFailure). Step descriptions are
// dropped — they are prose the checks never look at, and several are long.

import { validateWorkflowGraph, type WorkflowInputContract } from '../validate-workflow-graph';
import type { WorkflowStep } from '../types';

const GMAIL: WorkflowInputContract = { triggerType: 'event', eventSources: ['google_mail'] };

/** A support-inbox workflow — the one the checks must catch. */
const SUPPORT_STEPS = [
  { stepId: 's1', type: 'tool_call', toolName: 'google-mail-14a82d9e__get_thread',
    toolInputTemplate: '{"id":"{{input.threadId}}"}', outputField: 'thread', onSuccess: 's2' },
  { stepId: 's2', type: 'tool_call', toolName: 'google-mail-14a82d9e__list_messages',
    toolInputTemplate: '{"query":"from:{{input.from}}","max_results":25}',
    outputField: 'priorMessages', onSuccess: 's3' },
  { stepId: 's3', type: 'llm_reason', outputField: 'triage', onSuccess: 's4' },
  { stepId: 's4', type: 'llm_reason', outputField: 'routing', onSuccess: 's5' },
  { stepId: 's5', type: 'llm_reason', outputField: 'helpSearch',
    condition: "$.steps.s4.next == 'search-help'", onSuccess: 's6' },
  { stepId: 's6', type: 'llm_reason', outputField: 'pick',
    condition: "$.steps.s4.next == 'search-help'", onSuccess: 's7' },
  { stepId: 's7', type: 'llm_reason', outputField: 'replySent',
    condition: "$.steps.s6.confidence == 'high'", onSuccess: 's8', onFailure: 's10' },
  { stepId: 's8', type: 'llm_reason', outputField: 'followupScheduled',
    condition: "$.steps.s6.confidence == 'high'", onSuccess: 's12' },
  { stepId: 's10', type: 'llm_reason', outputField: 'escalation', onSuccess: 's11' },
  { stepId: 's11', type: 'llm_reason', outputField: 'ackSent', onSuccess: 's12' },
  { stepId: 's12', type: 'tool_call', toolName: 'google-mail-14a82d9e__mark_as_read',
    toolInputTemplate: '{"id":"{{steps.s1.id}}"}', onSuccess: '' },
] as unknown as WorkflowStep[];

const TOOLS = new Set([
  'google-mail-14a82d9e__get_thread',
  'google-mail-14a82d9e__list_messages',
  'google-mail-14a82d9e__mark_as_read',
]);

describe('a stored support-inbox workflow, against the input checks', () => {
  const errors = validateWorkflowGraph(SUPPORT_STEPS, TOOLS, GMAIL);
  const codes = errors.map((e) => e.code);

  it('is REJECTED by the graph check', () => {
    expect(errors.length).toBeGreaterThan(0);
  });

  it('names s1, the step that asked Gmail for the message with id "null"', () => {
    const s1 = errors.filter((e) => e.stepId === 's1' && e.code === 'UNKNOWN_INPUT_FIELD');
    expect(s1).toHaveLength(1);
    expect(s1[0].message).toContain('input.threadId');
  });

  it('names s2, whose "from:null" query returned an empty result set', () => {
    const s2 = errors.filter((e) => e.stepId === 's2' && e.code === 'UNKNOWN_INPUT_FIELD');
    expect(s2).toHaveLength(1);
    expect(s2[0].message).toContain('input.from');
  });

  it('finds exactly the two input defects — the rest of the graph is sound', () => {
    // Both conditions read `$.steps.<id>`, which IS addressable; those branches
    // failed at run time because the producing steps could not satisfy their
    // outputField, which is a runtime contract this static check cannot see and
    // does not pretend to.
    expect(codes.filter((c) => c === 'UNKNOWN_INPUT_FIELD')).toHaveLength(2);
  });

  it('the corrected templates pass', () => {
    const fixed = JSON.parse(JSON.stringify(SUPPORT_STEPS)) as WorkflowStep[];
    fixed[0].toolInputTemplate = '{"id":"{{input.message.threadId}}"}';
    delete fixed[0].outputField;
    fixed[1].toolInputTemplate = '{"query":"from:{{input.message.from}}","max_results":25}';
    delete fixed[1].outputField;
    fixed[10].toolInputTemplate = '{"id":"{{input.message.threadId}}"}';
    expect(validateWorkflowGraph(fixed, TOOLS, GMAIL)).toEqual([]);
  });
});

describe('a workflow that threads data through step outputs', () => {
  // It never references `input` at all — it threads data through
  // `$.steps.<id>` — so the input checks must stay silent on it. A check that
  // fired here would block a healthy agent to fix a broken one.
  const CODE_REVIEWER = [
    { stepId: 's1', type: 'llm_reason', outputField: 'pr', onSuccess: 's2' },
    { stepId: 's2', type: 'llm_reason', outputField: 'gate', onSuccess: 's3' },
    { stepId: 's3', type: 'llm_reason', outputField: 'context',
      condition: "$.steps.s2.next == 'review'", onSuccess: 's4' },
    { stepId: 's4', type: 'tool_call', toolName: 'shell_exec', outputField: 'stdout',
      toolInputTemplate: '{"command":"echo hi"}', onSuccess: 's5' },
    { stepId: 's5', type: 'llm_reason', outputField: 'analysis', onSuccess: 's6' },
    { stepId: 's6', type: 'llm_reason', outputField: 'risk', onSuccess: 's7' },
    { stepId: 's7', type: 'llm_reason', outputField: 'inline', onSuccess: 's8' },
    { stepId: 's8', type: 'llm_reason', outputField: 'summary', onSuccess: 's10' },
    { stepId: 's9', type: 'llm_reason', outputField: 'escalation',
      condition: '$.steps.s6.highRisk == true', onSuccess: 's10' },
    { stepId: 's10', type: 'tool_call', toolName: 'slack_resolve_channel_by_name',
      outputField: 'id', toolInputTemplate: '{"name":"engineering"}', onSuccess: 's11' },
    { stepId: 's11', type: 'tool_call', toolName: 'slack_send_message',
      toolInputTemplate: '{"channel":"{{steps.s10.id}}","text":"ready {{steps.s1.repo}}"}',
      onSuccess: 's12' },
    { stepId: 's12', type: 'llm_reason', outputField: 'result', onSuccess: '' },
  ] as unknown as WorkflowStep[];

  it('raises no input findings on a workflow that never reads input', () => {
    const errors = validateWorkflowGraph(
      CODE_REVIEWER,
      new Set(['shell_exec', 'slack_resolve_channel_by_name', 'slack_send_message']),
      { triggerType: 'event', eventSources: ['github'] },
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });
});
