// EVENT TOPICS must list only topics something can actually deliver.
//
// The distill prompt calls this section authoritative and tells the model to
// copy from it verbatim, so whatever appears here becomes a live trigger. It
// used to be gated on `listImplemented`, which says list() can ENUMERATE
// records — nothing about whether an event reaches an agent. The two axes are
// independent, and the wrong one was wrong both ways:
//
//   * github carries listImplemented: true (so backfill can enumerate PRs)
//     and no eventTrigger. `pr.opened` was therefore offered, a redistill
//     could take it, the runtime would then pause the agent's five-minute
//     cron, and the agent would stop posting. Nothing delivers a polled
//     github event to an agent: the poller
//     publishes connector-events-{env} in the CONTROL project and the runtime
//     subscribes to a same-named topic in the TENANT project.
//
//   * google_docs, todoist, trello and typeform carry listImplemented: false
//     with an eventTrigger set — a combination ConnectorPollingConfig documents
//     explicitly ("an entity may be event-only"). Their topics were hidden, so
//     an agent bound to them could never be given an event trigger at all.
//
// The gate is now `eventTrigger`: its slug is what connector-service arms and
// what tenant-runtime derives dispatch from, so a row carrying one has a
// receiver at the far end.
import { buildEventTopicsText } from '../distill-service';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';

type Catalog = ConnectorCatalogResponse;

function catalog(connectors: unknown[]): Catalog {
  return { connectors } as unknown as Catalog;
}

const integration = (type: string, name: string) => ({
  id: `id-${type}`,
  name,
  type,
  selectedObjects: [],
});

// The two real rows this turns on, copied in shape from
// liftoff-connector-service/src/catalog/connectors.ts.
const GITHUB = {
  type: 'github',
  polling: [
    {
      entityType: 'PullRequest',
      eventTopics: ['pr.opened', 'pr.updated', 'pr.merged'],
      listImplemented: true, // enumerable for backfill…
      // …and no eventTrigger: nothing carries the event to an agent.
    },
  ],
};

const GMAIL = {
  type: 'google_mail',
  polling: [
    {
      entityType: 'Email',
      eventTopics: ['email.received', 'mail.received'],
      listImplemented: true,
      eventTrigger: { slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    },
  ],
};

const TODOIST = {
  type: 'todoist',
  polling: [
    {
      entityType: 'Task',
      eventTopics: ['task.created'],
      listImplemented: false, // event-only: no list(), but delivery works
      eventTrigger: { slug: 'TODOIST_NEW_TASK_CREATED' },
    },
  ],
};

describe('buildEventTopicsText', () => {
  it('omits a poll-only connector, however well its list() works', () => {
    const text = buildEventTopicsText([integration('github', 'GitHub')], catalog([GITHUB]));

    expect(text).not.toContain('pr.opened');
    expect(text).toContain('none of the connected integrations can deliver');
  });

  it('lists a connector whose events are delivered', () => {
    const text = buildEventTopicsText(
      [integration('google_mail', 'Gmail')],
      catalog([GMAIL]),
    );

    expect(text).toContain('email.received');
    expect(text).toContain('mail.received');
    expect(text).toContain('Gmail (google_mail)');
  });

  it('lists an event-only connector that has no list() at all', () => {
    const text = buildEventTopicsText([integration('todoist', 'Todoist')], catalog([TODOIST]));

    expect(text).toContain('task.created');
  });

  it('keeps the deliverable rows when a connector mixes both kinds', () => {
    const mixed = {
      type: 'mixed',
      polling: [
        { entityType: 'A', eventTopics: ['a.polled'], listImplemented: true },
        {
          entityType: 'B',
          eventTopics: ['b.delivered'],
          listImplemented: false,
          eventTrigger: { slug: 'B_TRIGGER' },
        },
      ],
    };

    const text = buildEventTopicsText([integration('mixed', 'Mixed')], catalog([mixed]));

    expect(text).toContain('b.delivered');
    expect(text).not.toContain('a.polled');
  });

  it('tells the model to use cron when a bound connector delivers nothing', () => {
    const text = buildEventTopicsText(
      [integration('github', 'GitHub')],
      catalog([GITHUB, GMAIL]),
    );

    // Gmail is in the catalog but NOT bound, so it must not leak into the
    // section — the agent cannot be woken by a connector it is not bound to.
    expect(text).not.toContain('email.received');
    expect(text).toContain('Use "cron" or "manual" instead');
  });
});
