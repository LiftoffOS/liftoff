// Customer-facing copy the distiller authors is checked where it is authored.
//
// A `tool_call` step's `toolInputTemplate` is dispatched verbatim: its literal
// text IS the message the customer receives, and no runtime model ever sees it.
// The voice rules sit in the runtime policy layer because rules the platform is
// accountable for cannot depend on a model complying at generation time — and
// that placement cannot reach this text. Authored template copy is the one
// customer-facing surface owned by generation, so it is enforced at generation.
//
// Two rules, both asserted below:
//
//   1. The voice rules apply to authored copy.
//   2. An outbound body is either ONE whole interpolation — a value some step
//      composed to be the message — or literal text with no step reference.
//      Splicing a step field into prose gives the author the framing and not
//      the content, and analysis fields carry whatever that step concluded,
//      including its own failure.

import { findUnsafeCustomerFacingCopy } from '../distill-service';
import type { WorkflowStep } from '@liftoffos/shared-types';

type Entry = { name: string; description: string; categories?: string[] };
const catalog = new Map<string, Entry>([
  ['gmail__reply_to_thread', { name: 'gmail__reply_to_thread', description: 'reply', categories: ['outbound', 'write'] }],
  ['gmail__mark_as_read', { name: 'gmail__mark_as_read', description: 'ack', categories: ['write'] }],
  ['slack_send_message', { name: 'slack_send_message', description: 'post', categories: ['internalCollaboration'] }],
  // Deliberately NOT 'outbound': it posts into the workspace's own chat, and
  // that category gates external-content approvals.
  ['open_chat_thread', { name: 'open_chat_thread', description: 'deliver', categories: ['write'] }],
]);

const step = (over: Partial<WorkflowStep>): WorkflowStep => ({
  stepId: 's1', type: 'tool_call', description: 'd', ...over,
} as WorkflowStep);

const run = (s: WorkflowStep[]) => findUnsafeCustomerFacingCopy(s, catalog as never);

describe('an acknowledgement that splices a triage field into prose', () => {
  const offending = step({
    stepId: 's9b',
    toolName: 'gmail__reply_to_thread',
    toolInputTemplate: JSON.stringify({
      user_id: 'me',
      thread_id: '{{input.message.threadId}}',
      message_body: "Thanks for reaching out to Liftoff Support about {{steps.s3.issue_summary}}. A teammate is reviewing this and will reply shortly. — Liftoff Support",
    }),
  });

  it('is rejected', () => {
    expect(run([offending]).length).toBeGreaterThan(0);
  });

  it('reports both faults, not just the first', () => {
    const details = run([offending]).map((e) => e.detail);
    expect(details.some((d) => /em dash/i.test(d))).toBe(true);
    expect(details.some((d) => /splices/i.test(d))).toBe(true);
  });

  it('names the step and the offending reference', () => {
    const errors = run([offending]);
    expect(errors[0].stepId).toBe('s9b');
    expect(errors.some((x) => x.detail.includes('steps.s3.issue_summary'))).toBe(true);
  });
});

describe('what must still pass', () => {
  it('a body that is one whole interpolation of a composed message', () => {
    expect(run([step({
      toolName: 'gmail__reply_to_thread',
      toolInputTemplate: JSON.stringify({ thread_id: '{{input.message.threadId}}', message_body: '{{steps.s8.answer}}' }),
    })])).toEqual([]);
  });

  it('fixed prose with no step reference', () => {
    expect(run([step({
      toolName: 'gmail__reply_to_thread',
      toolInputTemplate: JSON.stringify({ message_body: 'Thanks for reaching out. A teammate is reviewing this and will reply shortly.' }),
    })])).toEqual([]);
  });

  it('an identifier field carrying an interpolation', () => {
    // `thread_id` is not prose. Only body-shaped keys are checked.
    expect(run([step({
      toolName: 'gmail__reply_to_thread',
      toolInputTemplate: JSON.stringify({ thread_id: '{{input.message.threadId}}', message_body: 'Fixed text.' }),
    })])).toEqual([]);
  });

  it('an internal notification splicing fields into prose', () => {
    // A colleague reading the channel needs the ids in context. This rule is
    // about what a customer reads.
    expect(run([step({
      toolName: 'slack_send_message',
      toolInputTemplate: JSON.stringify({
        channel: '#customer-support',
        text: 'Escalation on thread {{input.message.threadId}}, category {{steps.s3.type}}',
      }),
    })])).toEqual([]);
  });

  it('a non-outbound tool on the same connector', () => {
    expect(run([step({
      toolName: 'gmail__mark_as_read',
      toolInputTemplate: JSON.stringify({ thread_id: '{{input.message.threadId}}' }),
    })])).toEqual([]);
  });

  it('an llm_reason step, which authors nothing verbatim', () => {
    expect(run([step({ type: 'llm_reason', toolName: undefined, toolInputTemplate: undefined })])).toEqual([]);
  });

  it('a template that does not parse, which other checks own', () => {
    expect(run([step({ toolName: 'gmail__reply_to_thread', toolInputTemplate: '{not json' })])).toEqual([]);
  });
});

describe('the subject line is prose too', () => {
  it('catches a spliced field in the subject', () => {
    const errors = run([step({
      toolName: 'gmail__reply_to_thread',
      toolInputTemplate: JSON.stringify({ subject: 'Re: {{steps.s3.issue_summary}}', message_body: 'Fixed.' }),
    })]);
    expect(errors.some((x) => /splices/.test(x.detail))).toBe(true);
  });
});

// The voice rules follow the READER, not the workspace boundary.
//
// open_chat_thread posts into the workspace's own chat, so it is not
// 'outbound' — but a person still reads it. An agent can title its thread
// "CP checklist ready — <file>", em dash and all, and a check keyed on the
// category alone would skip it.
describe('copy a person reads inside the workspace', () => {
  const threadStep = (input: Record<string, unknown>): WorkflowStep => ({
    stepId: 's9',
    type: 'tool_call',
    description: 'announce it',
    toolName: 'open_chat_thread',
    toolInputTemplate: JSON.stringify(input),
  } as unknown as WorkflowStep);

  it('catches an em dash in the thread title', () => {
    const errs = findUnsafeCustomerFacingCopy(
      [threadStep({ title: 'CP checklist ready — Acme', body: 'It is ready.' })], catalog);
    expect(errs.length).toBeGreaterThan(0);
    expect(JSON.stringify(errs)).toMatch(/em dash/i);
  });

  it('catches an em dash in the body', () => {
    const errs = findUnsafeCustomerFacingCopy(
      [threadStep({ title: 'CP checklist ready', body: 'Ready — see the link.' })], catalog);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('passes clean copy', () => {
    const errs = findUnsafeCustomerFacingCopy(
      [threadStep({ title: 'CP checklist ready', body: 'The checklist is ready. Link below.' })], catalog);
    expect(errs).toEqual([]);
  });

  it('still ignores a tool nobody reads the arguments of', () => {
    const quiet = {
      stepId: 's2', type: 'tool_call', description: 'ack',
      toolName: 'gmail__mark_as_read',
      toolInputTemplate: JSON.stringify({ body: 'internal — not read by anyone' }),
    } as unknown as WorkflowStep;
    expect(findUnsafeCustomerFacingCopy([quiet], catalog)).toEqual([]);
  });
});
