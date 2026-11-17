// The prompt half and the enforcing half must agree about what can deliver an
// event. When they disagree, a redistill becomes IMPOSSIBLE to satisfy.
//
//   prompt half   (buildEventTopicsText) → eventTrigger !== undefined  → 19 rows
//   analyzer half (Rule 6)               → listImplemented === true    → 87 rows
//
// For the 68 rows in between — GitHub's PullRequest among them — the model was
// shown "EVENT TOPICS — none of the connected integrations can deliver an event
// to an agent. Use cron or manual instead", then had its cron trigger REJECTED
// by Rule 6 and was ordered to "copy one topic VERBATIM" from that empty list.
// Three retries, then a 500.
//
// An agent bound to GitHub could then not be redistilled at all. The failure
// presents as a bad agent config; it is a contradiction between two views of
// the same catalog. An agent whose responsibilities happen to say "every 5
// minutes" escapes only because that trips the explicit-cron-intent escape and
// skips Rule 6.
//
// listImplemented is a different axis and the two are independent in BOTH
// directions, so neither implies the other:
//   listImplemented: true,  no eventTrigger   → advertised, never delivered (GitHub PR)
//   listImplemented: false, eventTrigger set  → deliverable, never offered (Confluence)
import { deliversEvents } from '../event-deliverability';
import { analyzeTriggerConfig } from '../trigger-config-analyzer';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';

describe('deliversEvents', () => {
  it('keys on eventTrigger, not listImplemented', () => {
    expect(deliversEvents({ eventTrigger: { slug: 'GMAIL_NEW_GMAIL_MESSAGE' } })).toBe(true);
    expect(deliversEvents({})).toBe(false);
  });

  it('is true for a deliverable row whose list method is NOT implemented', () => {
    // Confluence in the live catalog. Gating on listImplemented would hide a
    // topic that genuinely fires.
    expect(deliversEvents({ eventTrigger: { slug: 'CONFLUENCE_PAGE_CREATED_TRIGGER' } })).toBe(true);
  });
});

/** GitHub as the live catalog actually declares it: topics and
 *  listImplemented: true, but NO eventTrigger — advertised, never delivered. */
const catalogWithGithub = {
  connectors: [{
    type: 'github',
    polling: [{
      entityType: 'PullRequest',
      eventTopics: ['pr.opened', 'pr.updated', 'pr.merged'],
      listImplemented: true,
    }],
  }],
  version: '',
  categoryLabels: {},
} as unknown as ConnectorCatalogResponse;

const reactiveCronOutput = {
  triggerConfig: { type: 'cron', cronExpr: '0 * * * *', reasoning: 'poll for new PRs' },
} as never;

describe('Rule 6 against the real GitHub shape', () => {
  const responsibilities = 'Review newly opened pull requests and post a summary.';

  it('does NOT reject cron when nothing can actually deliver', () => {
    // The regression: GitHub has listImplemented topics and no eventTrigger, so
    // the model is correctly told there is nothing to subscribe to. Rejecting
    // its cron here demands a topic that does not exist.
    const violations = analyzeTriggerConfig(
      reactiveCronOutput, new Set(['github']), catalogWithGithub, responsibilities,
    );
    expect(violations.map((v) => v.rule)).not.toContain('cron_trigger_with_event_topic_available');
  });

  it('still rejects cron when a topic IS deliverable', () => {
    // The rule must keep working — this is not about switching it off.
    const deliverable = {
      ...catalogWithGithub,
      connectors: [{
        type: 'github',
        polling: [{
          entityType: 'PullRequest',
          eventTopics: ['pr.opened'],
          listImplemented: true,
          eventTrigger: { slug: 'GITHUB_PR_OPENED' },
        }],
      }],
    } as unknown as ConnectorCatalogResponse;

    const violations = analyzeTriggerConfig(
      reactiveCronOutput, new Set(['github']), deliverable, responsibilities,
    );
    expect(violations.map((v) => v.rule)).toContain('cron_trigger_with_event_topic_available');
  });

  it('offers only topics the model was actually shown', () => {
    // The retry feedback quotes the available topics. If it can name one the
    // prompt withheld, the retry is unsatisfiable by construction.
    const deliverable = {
      connectors: [{
        type: 'github',
        polling: [
          { entityType: 'PullRequest', eventTopics: ['pr.opened'], listImplemented: true, eventTrigger: { slug: 'X' } },
          { entityType: 'Issue', eventTopics: ['issue.created'], listImplemented: true },
        ],
      }],
      version: '', categoryLabels: {},
    } as unknown as ConnectorCatalogResponse;

    const v = analyzeTriggerConfig(
      reactiveCronOutput, new Set(['github']), deliverable, responsibilities,
    ).find((x) => x.rule === 'cron_trigger_with_event_topic_available');

    expect(v).toBeDefined();
    expect(v!.message).toContain('pr.opened');
    // issue.created has no eventTrigger — it must not be offered.
    expect(v!.message).not.toContain('issue.created');
  });
});
