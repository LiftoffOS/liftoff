// A rejected tool_call must be corrected, not stripped of its guarantee.
//
// A `tool_call` step dispatches ONE named tool with templated arguments: the
// dispatch is guaranteed, the arguments are checkable at authoring time, and the
// call is auditable before it runs. An `llm_reason` step is an agentic sub-loop
// — it receives the full catalog, connector tools included, and it CAN call them
// (the runtime registers the same gateway catalog for a step as for the
// conversational branch). What it cannot offer is a guarantee: whether a tool is
// called at all, and with what arguments, is the step model's discretion at
// runtime, and nothing here can check either.
//
// So retyping a step whose arguments were just rejected trades a checked,
// guaranteed action for an unchecked, discretionary one — in direct response to
// the check firing. That is what makes it evasion rather than a design choice.
//
// The line this draws matters. Told that `s9` called `schedule_followup`, which
// does not exist, a retry may return `s9` as an llm_reason. That is NOT a defect — the distill prompt explicitly prescribes
// llm_reason when no catalog tool covers the work. Rejecting it would fight the
// prompt and deadlock the loop against work no tool can do.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findDegenerateFixes } from '../distill-service';
import type { ToolCatalog } from '../distill-service';

type Shape = { type: string; toolName?: string };
const prev = (entries: Array<[string, Shape]>) => new Map<string, Shape>(entries);

 
const steps = (rows: Array<Record<string, unknown>>) => rows as any;

const catalog = (...names: string[]): ToolCatalog =>
  new Map(names.map(n => [n, { name: n, description: '' }])) as ToolCatalog;

const GMAIL = catalog(
  'google-mail-0105297e__get_thread',
  'google-mail-0105297e__list_messages',
  'google-mail-0105297e__reply_to_thread',
);

describe('a tool that exists, abandoned after its arguments were rejected', () => {
  it('rejects a tool_call that came back as llm_reason', () => {
    const out = findDegenerateFixes(
      steps([{ stepId: 's2', type: 'llm_reason', outputField: 'messages' }]),
      prev([['s2', { type: 'tool_call', toolName: 'google-mail-0105297e__list_messages' }]]),
      new Set(['s2']),
      GMAIL,
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('action_downgraded_to_reasoning');
    expect(out[0].stepId).toBe('s2');
    // Name the tool that was abandoned, so the model restores it without guessing.
    expect(out[0].detail).toContain('google-mail-0105297e__list_messages');
    expect(out[0].detail).toMatch(/EXISTS in the catalog/);
    expect(out[0].detail).toMatch(/the fix is its arguments, not its type/);
  });

  it('states the real cost, not that llm_reason cannot act', () => {
    // An llm_reason step CAN call connector tools. Telling the model otherwise
    // would be false, and a correction built on a false premise teaches the
    // wrong rule everywhere else it applies.
    const [err] = findDegenerateFixes(
      steps([{ stepId: 's2', type: 'llm_reason' }]),
      prev([['s2', { type: 'tool_call', toolName: 'google-mail-0105297e__list_messages' }]]),
      new Set(['s2']),
      GMAIL,
    );
    expect(err.detail).toMatch(/may call tools but is not required to/i);
    expect(err.detail).toMatch(/discretionary/i);
    expect(err.detail).not.toMatch(/performs no external action/i);
    expect(err.detail).not.toMatch(/always succeeds/i);
  });

  it('rejects a tool_call that was deleted outright', () => {
    const out = findDegenerateFixes(
      steps([{ stepId: 's1', type: 'tool_call', toolName: 'google-mail-0105297e__get_thread' }]),
      prev([
        ['s1', { type: 'tool_call', toolName: 'google-mail-0105297e__get_thread' }],
        ['s6', { type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' }],
      ]),
      new Set(['s6']),
      GMAIL,
    );
    expect(out).toHaveLength(1);
    expect(out[0].stepId).toBe('s6');
    expect(out[0].detail).toMatch(/DELETED/);
  });
});

describe('the sanctioned fallback, which must not be fought', () => {
  it('allows llm_reason to replace a tool that does not exist', () => {
    // `schedule_followup` is not in the catalog. The prompt tells the model to
    // reason when no tool covers the work, so this is compliance, not evasion.
    const out = findDegenerateFixes(
      steps([{ stepId: 's9', type: 'llm_reason', outputField: 'followup' }]),
      prev([['s9', { type: 'tool_call', toolName: 'schedule_followup' }]]),
      new Set(['s9']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });

  it('allows dropping a step that named a tool that does not exist', () => {
    const out = findDegenerateFixes(
      steps([]),
      prev([['s9', { type: 'tool_call', toolName: 'schedule_followup' }]]),
      new Set(['s9']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });
});

describe('what it must not fire on', () => {
  it('accepts the actual repair — same type, same tool, fixed arguments', () => {
    const out = findDegenerateFixes(
      steps([{
        stepId: 's1',
        type: 'tool_call',
        toolName: 'google-mail-0105297e__get_thread',
        toolInputTemplate: '{"user_id":"me","thread_id":"{{input.message.threadId}}"}',
      }]),
      prev([['s1', { type: 'tool_call', toolName: 'google-mail-0105297e__get_thread' }]]),
      new Set(['s1']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });

  it('leaves steps nobody complained about alone', () => {
    // Re-planning an unmentioned step is the model's prerogative. Scoping to the
    // named ids is what keeps this from fighting legitimate restructuring.
    const out = findDegenerateFixes(
      steps([{ stepId: 's4', type: 'llm_reason' }]),
      prev([['s4', { type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' }]]),
      new Set(['s9']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });

  it('does not fire on the first attempt, when there is nothing to compare', () => {
    expect(
      findDegenerateFixes(steps([{ stepId: 's1', type: 'llm_reason' }]), prev([]), new Set(['s1']), GMAIL),
    ).toEqual([]);
    expect(
      findDegenerateFixes(
        steps([{ stepId: 's1', type: 'llm_reason' }]),
        prev([['s1', { type: 'tool_call', toolName: 'google-mail-0105297e__get_thread' }]]),
        new Set(),
        GMAIL,
      ),
    ).toEqual([]);
  });

  it('ignores a step that was never a tool_call', () => {
    const out = findDegenerateFixes(
      steps([{ stepId: 's3', type: 'llm_reason' }]),
      prev([['s3', { type: 'llm_reason' }]]),
      new Set(['s3']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });

  it('treats a returned step with no explicit type as the tool_call it defaults to', () => {
    // `type` is optional and defaults to tool_call throughout the schema, so the
    // most common corrected shape omits it. Reading the absent field as "not a
    // tool_call" would flag every such repair as a downgrade and deadlock the
    // loop on the exact response being asked for.
    const out = findDegenerateFixes(
      steps([{
        stepId: 's2',
        toolName: 'google-mail-0105297e__list_messages',
        toolInputTemplate: '{"user_id":"me","query":"from:x"}',
      }]),
      prev([['s2', { type: 'tool_call', toolName: 'google-mail-0105297e__list_messages' }]]),
      new Set(['s2']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });
});

// Renumbering is its own defect, judged first. A repair is asked for in place,
// by id; a graph that comes back with the rejected ids gone and ids that never
// existed before has been rewritten, and every verdict above would then be
// about the wrong step — the have_i_acted_on that moved from s1 to s0 read as
// "downgraded" while it was still a tool_call. Tool-name presence proves
// nothing either way: two steps can send different emails, and deleting the
// rejected one while the other stays is still a deletion.
describe('the ids must survive the repair', () => {
  it('names a renumbered graph as renumbered, not as a downgrade', () => {
    const out = findDegenerateFixes(
      steps([
        { stepId: 's0', type: 'tool_call', toolName: 'google-mail-0105297e__list_messages' },
        { stepId: 's1', type: 'llm_reason' },
        { stepId: 's2', type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' },
      ]),
      prev([
        ['s1', { type: 'tool_call', toolName: 'google-mail-0105297e__list_messages' }],
        ['s2', { type: 'llm_reason' }],
        ['s3', { type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' }],
      ]),
      new Set(['s1', 's3']),
      GMAIL,
    );
    expect(out.map((e) => e.type)).toEqual(['steps_renumbered_on_retry']);
    expect(out[0].detail).toContain('"s0"');
    expect(out[0].detail).toMatch(/Keep the step ids you were given/);
  });

  it('a rejected step deleted while another step still uses the same tool is still a deletion', () => {
    const out = findDegenerateFixes(
      steps([
        // The internal notification survives; the customer reply that was
        // rejected is gone. Same tool, different action.
        { stepId: 's4', type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' },
      ]),
      prev([
        ['s3', { type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' }],
        ['s4', { type: 'tool_call', toolName: 'google-mail-0105297e__reply_to_thread' }],
      ]),
      new Set(['s3']),
      GMAIL,
    );
    expect(out.map((e) => e.type)).toEqual(['action_downgraded_to_reasoning']);
    expect(out[0].detail).toContain('DELETED');
  });

  it('a new step added beside intact rejected ids is not renumbering', () => {
    const out = findDegenerateFixes(
      steps([
        { stepId: 's1', type: 'tool_call', toolName: 'google-mail-0105297e__list_messages', onFailure: 's9' },
        { stepId: 's9', type: 'llm_reason' },
      ]),
      prev([['s1', { type: 'tool_call', toolName: 'google-mail-0105297e__list_messages' }]]),
      new Set(['s1']),
      GMAIL,
    );
    expect(out).toEqual([]);
  });
});
