// An eventTopic nothing delivers must be rejected, not trusted.
//
// EVENT TOPICS already lists only deliverable topics and the prompt says so
// twice. That is not enough. Two redistills of the same role on the same
// build can read the same empty section and diverge: one correctly chooses a
// cron, the other emits `eventTopic: pr.opened` anyway — justifying it with,
// say, "both bound version-control connectors" for an agent bound to github
// and slack. There is no second version-control connector; the reasoning is
// confabulated along with the topic.
//
// The losing side of that coin flip is an agent that never runs again, and
// nothing downstream notices: the Cloud Scheduler job is paused, the runtime
// registers the agent for a topic no publisher writes to, and every layer
// reports success. So the rule is enforced here as well as asked for.
import {
  __findUndeliverableTriggersForTest as findUndeliverableTriggers,
  __coerceUndeliverableTriggerForTest as coerceUndeliverableTrigger,
} from '../distill-service';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';

const catalog = (connectors: unknown[]) =>
  ({ connectors } as unknown as ConnectorCatalogResponse);

const bind = (type: string) => ({ id: `id-${type}`, name: type, type, selectedObjects: [] });

// What the FE actually writes: the connector type under `integrationId`, with
// no `type` at all. redistill-service normalizes this; the create path does not.
const bindAsFrontendWrites = (integrationId: string) =>
  ({ id: `id-${integrationId}`, name: integrationId, integrationId, selectedObjects: [] }) as never;

// Real rows, copied in shape from liftoff-connector-service/src/catalog/connectors.ts.
const GITHUB = {
  type: 'github',
  polling: [{
    entityType: 'PullRequest',
    eventTopics: ['pr.opened', 'pr.updated', 'pr.merged'],
    listImplemented: true, // enumerable, but no eventTrigger: nothing delivers it
  }],
};
const GMAIL = {
  type: 'google_mail',
  polling: [{
    entityType: 'Email',
    eventTopics: ['email.received', 'mail.received'],
    listImplemented: true,
    eventTrigger: { slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
  }],
};

describe('findUndeliverableTriggers', () => {
  it('rejects a GitHub topic against a Gmail-only catalog trigger, and says what would work', () => {
    const errors = findUndeliverableTriggers(
      { type: 'event', eventTopic: 'pr.opened', reasoning: 'r' },
      [bind('github')],
      catalog([GITHUB, GMAIL]),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('trigger_without_capability');
    expect(errors[0].stepId).toBe('eventTopic "pr.opened"');
    expect(errors[0].detail).toContain('would never fire');
    // Gmail is deliverable but NOT bound, so it must not be offered as an option.
    expect(errors[0].detail).toContain('No connector bound to this agent can deliver any event');
  });

  it('accepts a topic a bound connector actually delivers', () => {
    expect(findUndeliverableTriggers(
      { type: 'event', eventTopic: 'email.received', reasoning: 'r' },
      [bind('google_mail')],
      catalog([GITHUB, GMAIL]),
    )).toEqual([]);
  });

  it('names the deliverable topics when the agent has some', () => {
    const errors = findUndeliverableTriggers(
      { type: 'event', eventTopic: 'pr.opened', reasoning: 'r' },
      [bind('github'), bind('google_mail')],
      catalog([GITHUB, GMAIL]),
    );
    expect(errors[0].detail).toContain('email.received, mail.received');
  });

  // The drift redistill-service warns about in buildIntegrationInfos: keying on
  // `.type` alone made an unnormalized binding look like a connector that
  // delivers nothing. Before the gate that meant an empty EVENT TOPICS section;
  // with the gate it would rewrite a working trigger to an hourly cron.
  it('reads a binding the frontend wrote under integrationId', () => {
    expect(findUndeliverableTriggers(
      { type: 'event', eventTopic: 'email.received', reasoning: 'r' },
      [bindAsFrontendWrites('google_mail')],
      catalog([GITHUB, GMAIL]),
    )).toEqual([]);
  });

  it('still rejects an undeliverable topic on an integrationId-shaped binding', () => {
    const errors = findUndeliverableTriggers(
      { type: 'event', eventTopic: 'pr.opened', reasoning: 'r' },
      [bindAsFrontendWrites('github')],
      catalog([GITHUB, GMAIL]),
    );
    expect(errors).toHaveLength(1);
  });

  it('rejects a reactive subscription on a connector with no delivery', () => {
    const errors = findUndeliverableTriggers(
      {
        type: 'cron',
        cronExpr: '*/5 * * * *',
        reasoning: 'r',
        reactiveSubscriptions: [{ label: 'pr-updated', source: { connectorRef: 'github' } }],
      } as never,
      [bind('github')],
      catalog([GITHUB, GMAIL]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].stepId).toBe('subscription "pr-updated"');
  });

  it('leaves a cron trigger alone', () => {
    expect(findUndeliverableTriggers(
      { type: 'cron', cronExpr: '*/5 * * * *', reasoning: 'r' },
      [bind('github')],
      catalog([GITHUB]),
    )).toEqual([]);
  });

  // A failed catalog fetch means we do not know what delivers. "Unknown" must
  // not read as "nothing" and rewrite every trigger in the fleet.
  it('says nothing when there is no catalog to check against', () => {
    expect(findUndeliverableTriggers(
      { type: 'event', eventTopic: 'pr.opened', reasoning: 'r' },
      [bind('github')],
      undefined,
    )).toEqual([]);
  });

  // An empty catalog carries the same amount of knowledge as a missing one, and
  // cannot be a real state for an agent with bindings — a real catalog lists
  // many connectors. Treating it as "nothing delivers" would make the gate fire
  // on every fixture that does not care about the connector catalog: a smoke
  // test mocking `{ connectors: [] }` would burn a retry it has no second LLM
  // response for. The distinction that matters is between "the
  // catalog told us nothing" and "the catalog lists this agent's connectors and
  // none of them deliver"; only the second justifies rewriting a trigger.
  it('says nothing when the catalog is present but empty', () => {
    expect(findUndeliverableTriggers(
      { type: 'event', eventTopic: 'stripe.charge.completed', reasoning: 'r' },
      [bind('stripe')],
      catalog([]),
    )).toEqual([]);
  });
});

describe('coerceUndeliverableTrigger', () => {
  it('turns a dead event trigger into a cron that runs', () => {
    const out = coerceUndeliverableTrigger(
      { type: 'event', eventTopic: 'pr.opened', reasoning: 'reactive PRs' },
      [bind('github')],
      catalog([GITHUB]),
    ) as { type: string; cronExpr?: string; eventTopic?: string; reasoning: string };

    expect(out.type).toBe('cron');
    expect(out.cronExpr).toBe('0 * * * *');
    expect(out.eventTopic).toBeUndefined();
    // The reasoning has to survive — whoever reads this agent later needs to
    // know the cadence is a placeholder and why it is there at all.
    expect(out.reasoning).toContain('placeholder');
    expect(out.reasoning).toContain('reactive PRs');
  });

  it('keeps companion crons across the coercion', () => {
    const out = coerceUndeliverableTrigger(
      {
        type: 'event',
        eventTopic: 'pr.opened',
        reasoning: 'r',
        companionCrons: [{ label: 'digest', cronExpr: '0 9 * * 1' }],
      } as never,
      [bind('github')],
      catalog([GITHUB]),
    ) as unknown as { companionCrons?: Array<{ label: string }> };

    expect(out.companionCrons).toEqual([{ label: 'digest', cronExpr: '0 9 * * 1' }]);
  });

  it('drops subscriptions that cannot fire and keeps the ones that can', () => {
    const out = coerceUndeliverableTrigger(
      {
        type: 'event',
        eventTopic: 'pr.opened',
        reasoning: 'r',
        reactiveSubscriptions: [
          { label: 'gh', source: { connectorRef: 'github' } },
          { label: 'mail', source: { connectorRef: 'google_mail' } },
        ],
      } as never,
      [bind('github'), bind('google_mail')],
      catalog([GITHUB, GMAIL]),
    ) as unknown as { reactiveSubscriptions?: Array<{ label: string }> };

    expect(out.reactiveSubscriptions?.map(s => s.label)).toEqual(['mail']);
  });

  it('returns a healthy trigger untouched, by identity', () => {
    const healthy = { type: 'event' as const, eventTopic: 'email.received', reasoning: 'r' };
    expect(coerceUndeliverableTrigger(healthy, [bind('google_mail')], catalog([GMAIL])))
      .toBe(healthy);
  });

  it('does not rewrite anything when there is no catalog', () => {
    const unknown = { type: 'event' as const, eventTopic: 'pr.opened', reasoning: 'r' };
    expect(coerceUndeliverableTrigger(unknown, [bind('github')], undefined)).toBe(unknown);
  });

  it('does not rewrite anything when the catalog is empty', () => {
    const unknown = { type: 'event' as const, eventTopic: 'pr.opened', reasoning: 'r' };
    expect(coerceUndeliverableTrigger(unknown, [bind('github')], catalog([]))).toBe(unknown);
  });
});
