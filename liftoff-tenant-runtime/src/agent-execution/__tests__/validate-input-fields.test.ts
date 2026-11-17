// Validation of `{{input.<field>}}` / `$.input.<field>` against what the
// trigger will actually supply.
//
// The gap this closes: `templateRefs` classified a placeholder as resolvable
// when its ROOT was on the whitelist, and `input` always is. It said nothing
// about the field, because before the normalized envelope there was no field
// contract to check against. So `{"id":"{{input.threadId}}"}` could be
// reported clean by the pre-flight audit and still fail at run time.

import { validateWorkflowGraph, type WorkflowInputContract } from '../validate-workflow-graph';
import type { WorkflowStep } from '../types';

const gmail: WorkflowInputContract = { triggerType: 'event', eventSources: ['google_mail'] };

function step(over: Partial<WorkflowStep>): WorkflowStep {
  return { stepId: 's1', description: 'd', type: 'tool_call', toolName: 't', ...over } as WorkflowStep;
}

describe('UNKNOWN_INPUT_FIELD — templates', () => {
  it('rejects a reference to an input field the trigger never supplies', () => {
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.threadId}}"}' })],
      undefined,
      gmail,
    );
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_INPUT_FIELD');
  });

  it('rejects the raw-payload spelling too', () => {
    // `{{input.thread_id}}` was the distiller's own worked example. It is just
    // as unresolvable: the raw keys live under `eventData`, not at the root.
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.thread_id}}"}' })],
      undefined,
      gmail,
    );
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_INPUT_FIELD');
  });

  it('accepts the normalized envelope reference', () => {
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.message.threadId}}"}' })],
      undefined,
      gmail,
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });

  it('accepts the whole message object', () => {
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"m": {{input.message}}}' })],
      undefined,
      gmail,
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });

  it('leaves the raw payload escape hatch open', () => {
    // `eventData` is deliberately still there and its shape is the connector's,
    // so an author who needs a field the envelope omits can still reach it.
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.eventData.thread_id}}"}' })],
      undefined,
      gmail,
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });

  it('rejects a mail-only field on a non-mail source', () => {
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"s":"{{input.message.subject}}"}' })],
      undefined,
      { triggerType: 'event', eventSources: ['github'] },
    );
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_INPUT_FIELD');
  });
});

describe('UNKNOWN_INPUT_FIELD — conditions', () => {
  it('rejects a predicate that could never be true', () => {
    const errors = validateWorkflowGraph(
      [step({ condition: "$.input.threadId == 'x'" })],
      undefined,
      gmail,
    );
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_INPUT_FIELD');
  });

  it('accepts an envelope predicate', () => {
    const errors = validateWorkflowGraph(
      [step({ condition: "$.input.message.from == 'a@b.c'" })],
      undefined,
      gmail,
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });
});

describe('the limits of what a static check may claim', () => {
  it('says nothing when no contract is supplied', () => {
    const errors = validateWorkflowGraph([step({ toolInputTemplate: '{"id":"{{input.anything}}"}' })]);
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });

  it('REFUSES {{input.*}} for a cron trigger, which carries no input at all', () => {
    // This case previously asserted the opposite — that a cron's input is "the
    // caller's" and therefore unknowable. That is true of a MANUAL run, where an
    // API caller can pass any object, and false of cron:
    // `scheduled-invoke-handler` posts an objective and a companion label and
    // never passes `inputData`, so `{{input.*}}` resolves to undefined on
    // every cron fire.
    //
    // Lumping the two together lets a graph reading
    // `{{input.message.threadId}}` ship with companion CRONS running it. Every
    // companion fire then fails step 1, takes the escalation branch, and marks
    // mail read without opening the mailbox.
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.whatever}}"}' })],
      undefined,
      { triggerType: 'cron' },
    );
    expect(errors.map((e) => e.code)).toContain('UNKNOWN_INPUT_FIELD');
    // And it says WHY, rather than offering alternative fields that also do not exist.
    expect(errors.find((e) => e.code === 'UNKNOWN_INPUT_FIELD')!.message)
      .toContain('a cron fire carries no input at all');
  });

  it('still says nothing for a manual trigger, whose input really is the caller\'s', () => {
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.whatever}}"}' })],
      undefined,
      { triggerType: 'manual' },
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });

  it('says nothing for a source nobody has normalized', () => {
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"id":"{{input.whatever}}"}' })],
      undefined,
      { triggerType: 'event', eventSources: ['some_new_connector'] },
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });

  it('accepts a field present in ANY candidate source', () => {
    // The static callers know only which connectors the agent is bound to, and
    // `email.received` is reachable from Gmail and Outlook. Flagging a field
    // that one of them supplies would block a valid workflow.
    const errors = validateWorkflowGraph(
      [step({ toolInputTemplate: '{"s":"{{input.message.subject}}"}' })],
      undefined,
      { triggerType: 'event', eventSources: ['github', 'google_mail'] },
    );
    expect(errors.filter((e) => e.code === 'UNKNOWN_INPUT_FIELD')).toEqual([]);
  });
});
