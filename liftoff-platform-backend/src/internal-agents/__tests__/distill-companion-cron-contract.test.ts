// A companion cron cannot fire a graph that reads `{{input.*}}`.
//
// A cron fire carries no inputData — a scheduled run posts an objective, never
// an event payload. So when the workflow graph is event-shaped, graph validation
// rejects every `{{input.message.*}}` reference before step 1 and the run fails.
// Every time, by construction, for as long as the cron exists.
//
// That is not a slow leak. Three consecutive routine failures auto-pause the
// AGENT and deregister its event trigger, so a broken companion cron silently
// switches off the event path that worked — and the agent looks paused to an
// operator who did not pause it.
//
// For example, an hourly `followup-closeout-sweep` against a graph reading
// `{{input.message.threadId}}` fails three times and pauses a Customer Support
// agent whose email trigger was healthy. A test email sent afterwards matches
// no registered agent at all.

jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { getTenantManifests: jest.fn(), getToolCatalog: jest.fn() },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findCompanionCronsThatCannotRunTheGraph } from '../distill-service';

 
const steps = (rows: Array<Record<string, unknown>>) => rows as any;
 
const trigger = (t: Record<string, unknown>) => t as any;

const EVENT_SHAPED = steps([
  { stepId: 's1', toolName: 'gmail__get_thread', toolInputTemplate: '{"user_id":"me","thread_id":"{{input.message.threadId}}"}' },
]);

const GOOD_WORK_SOURCE = {
  toolName: 'gmail__list_messages',
  toolArgs: { user_id: 'me', query: 'is:unread' },
  itemsPath: 'items',
  source: 'google_mail',
};

describe('the pairing that paused a healthy agent', () => {
  it('rejects a companion cron with no workSource against an event-shaped graph', () => {
    const out = findCompanionCronsThatCannotRunTheGraph(
      EVENT_SHAPED,
      trigger({ type: 'event', companionCrons: [{ label: 'followup-closeout-sweep', cronExpr: '0 * * * *' }] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('companion_cron_without_work_source');
    expect(out[0].detail).toContain('followup-closeout-sweep');
  });

  it('states the consequence, since a per-fire failure sounds survivable', () => {
    // It is not survivable: it takes the event trigger down with it.
    const [err] = findCompanionCronsThatCannotRunTheGraph(
      EVENT_SHAPED,
      trigger({ companionCrons: [{ label: 'sweep' }] }),
    );
    expect(err.detail).toMatch(/carries NO input/i);
    expect(err.detail).toMatch(/auto-pause/i);
    expect(err.detail).toMatch(/deregister its event trigger/i);
    // And the two ways out.
    expect(err.detail).toMatch(/workSource/);
    expect(err.detail).toMatch(/remove this\s+companionCron/i);
  });

  it('flags each offending cron', () => {
    const out = findCompanionCronsThatCannotRunTheGraph(
      EVENT_SHAPED,
      trigger({ companionCrons: [
        { label: 'followup-closeout-sweep' },
        { label: 'weekly-recurring-issues' },
        { label: 'fine', workSource: GOOD_WORK_SOURCE },
      ] }),
    );
    expect(out).toHaveLength(2);
    expect(out.map(e => e.detail.includes('fine'))).toEqual([false, false]);
  });

  it('reads $.input as well as {{input.', () => {
    const out = findCompanionCronsThatCannotRunTheGraph(
      steps([{ stepId: 's1', condition: "$.input.message.from != ''" }]),
      trigger({ companionCrons: [{ label: 'sweep' }] }),
    );
    expect(out).toHaveLength(1);
  });
});

describe('what it must not fire on', () => {
  it('accepts a companion that declares a complete workSource', () => {
    // The honest version the runtime already supports: resolve the items with a
    // listing tool, run the graph once per item, stamp inputSource so the same
    // {{input.*}} references resolve.
    expect(findCompanionCronsThatCannotRunTheGraph(
      EVENT_SHAPED,
      trigger({ companionCrons: [{ label: 'sweep', workSource: GOOD_WORK_SOURCE }] }),
    )).toEqual([]);
  });

  it('rejects a workSource missing any of the three fields the handler requires', () => {
    // scheduled-invoke-handler.ts gates the fan-out on toolName && itemsPath &&
    // source. A partial declaration falls through to the bare-cron path, which is
    // the failing case wearing the right-looking field.
    for (const partial of [
      { toolName: 'gmail__list_messages', itemsPath: 'items' },
      { toolName: 'gmail__list_messages', source: 'google_mail' },
      { itemsPath: 'items', source: 'google_mail' },
    ]) {
      expect(findCompanionCronsThatCannotRunTheGraph(
        EVENT_SHAPED,
        trigger({ companionCrons: [{ label: 'sweep', workSource: partial }] }),
      )).toHaveLength(1);
    }
  });

  it('leaves a graph that reads no input alone', () => {
    // A companion cron on a self-contained graph is ordinary and correct.
    expect(findCompanionCronsThatCannotRunTheGraph(
      steps([{ stepId: 's1', toolName: 'gmail__list_messages', toolInputTemplate: '{"user_id":"me","query":"is:unread"}' }]),
      trigger({ companionCrons: [{ label: 'sweep' }] }),
    )).toEqual([]);
  });

  it('ignores prose: a description mentioning input is not a resolved reference', () => {
    // Only toolInputTemplate and condition are what graph validation rejects on.
    // Flagging descriptions would fail agents that merely explain themselves.
    expect(findCompanionCronsThatCannotRunTheGraph(
      steps([{ stepId: 's1', type: 'llm_reason', description: 'Summarise the mail at {{input.message.threadId}}' }]),
      trigger({ companionCrons: [{ label: 'sweep' }] }),
    )).toEqual([]);
  });

  it('does nothing when there are no companion crons', () => {
    expect(findCompanionCronsThatCannotRunTheGraph(EVENT_SHAPED, trigger({ type: 'event' }))).toEqual([]);
    expect(findCompanionCronsThatCannotRunTheGraph(EVENT_SHAPED, undefined)).toEqual([]);
  });
});
