import { deliversEvents } from '../event-deliverability';


// A connector can deliver events two ways, and this knew only one.
//
// `eventTrigger` carries a Composio slug. A connector delivering through its OWN
// webhook could not say so, was read as unable to deliver, and the distiller
// turned reactive responsibilities into cron polling — then invented head-SHA
// dedupe to make polling sound. That invented property does not hold: a bot can
// review one pull request many times at one head SHA.
describe('native webhook delivery counts too', () => {
  it('accepts a connector that publishes from its own webhook', () => {
    // GitHub: the App webhook delivers pull_request onto connector-events.
    expect(deliversEvents({ listImplemented: true, nativeEventDelivery: true })).toBe(true);
  });

  it('accepts it even with listImplemented false', () => {
    // Slack's shape exactly: no list method, no Composio slug, and it pushes.
    expect(deliversEvents({ listImplemented: false, nativeEventDelivery: true })).toBe(true);
  });

  it('still accepts a Composio trigger slug', () => {
    expect(deliversEvents({ eventTrigger: { slug: 'JIRA_NEW_ISSUE_TRIGGER' } })).toBe(true);
  });

  it('still refuses a row with neither', () => {
    // listImplemented says the POLL method exists, which is a different
    // question and the confusion this predicate was written to end.
    expect(deliversEvents({ listImplemented: true })).toBe(false);
    expect(deliversEvents({})).toBe(false);
  });

  it('treats an explicit false as no', () => {
    expect(deliversEvents({ nativeEventDelivery: false })).toBe(false);
  });
});
