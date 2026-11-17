// Tests for the Composio trigger registry — sanity checks on the derived
// table shape + isComposioTriggerSupported predicate. The table is derived
// purely from the catalog's polling[].eventTrigger entries; this proves the
// derivation covers every event connector, the slugs are well-formed, and
// every entry is reachable by isComposioTriggerSupported.

import {
  COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE,
  isComposioTriggerSupported,
} from './composio-trigger-registry.js';

describe('COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE', () => {
  it('every entry has a well-formed slug + connector type lookup matches isComposioTriggerSupported', () => {
    for (const [connectorType, spec] of Object.entries(COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE)) {
      expect(typeof spec.slug).toBe('string');
      // Composio slugs are UPPER_SNAKE_CASE.
      expect(spec.slug).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(isComposioTriggerSupported(connectorType)).toBe(true);
    }
  });

  it('isComposioTriggerSupported returns false for connectors not in the registry', () => {
    expect(isComposioTriggerSupported('stripe')).toBe(false);
    expect(isComposioTriggerSupported('dropbox')).toBe(false);
    expect(isComposioTriggerSupported('made_up_connector')).toBe(false);
  });

  it('covers every composio_managed connector that ships a "new event" Composio trigger', () => {
    // Derived from catalog polling[].eventTrigger — change a catalog entry, not
    // this list, to add/remove a connector. The 15 originally-hardcoded + the 5
    // catalog-native (clickup/coda/fireflies/todoist/whatsapp).
    const supported = Object.keys(COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE).sort();
    expect(supported).toEqual([
      'atlassian_confluence',
      'atlassian_jira',
      'clickup',
      'coda',
      'discord',
      'fireflies',
      'google_calendar',
      'google_docs',
      'google_drive',
      'google_mail',
      'google_sheets',
      'google_slides',
      'mailchimp',
      'microsoft_outlook_mail',
      // 'slack' is absent — native dispatch on our own Slack app, so no
      // Composio trigger.
      'todoist',
      'trello',
      'typeform',
      'whatsapp',
      'youtube',
    ]);
  });

  it('preserves each legacy trigger slug exactly (no drift from the pre-catalog map)', () => {
    // The slug + triggerConfig that connector-service passes to
    // composio.triggers.create must match what shipped before the catalog
    // migration, or arming breaks. This pins the 15 migrated rows verbatim.
    const reg = COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE;
    expect(reg.google_mail).toEqual({ slug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerConfig: { userId: 'me', labelIds: 'INBOX', interval: 1 } });
    expect(reg.microsoft_outlook_mail).toEqual({ slug: 'OUTLOOK_MESSAGE_TRIGGER', triggerConfig: undefined });
    // slack: no Composio trigger (native dispatch).
    expect(reg.slack).toBeUndefined();
    expect(reg.discord).toEqual({ slug: 'DISCORD_NEW_MESSAGE_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.google_calendar).toEqual({ slug: 'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER', triggerConfig: undefined });
    expect(reg.google_drive).toEqual({ slug: 'GOOGLEDRIVE_FILE_CREATED_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.google_docs).toEqual({ slug: 'GOOGLEDOCS_DOCUMENT_UPDATED_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.google_sheets).toEqual({ slug: 'GOOGLESHEETS_NEW_ROWS_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.google_slides).toEqual({ slug: 'GOOGLESLIDES_SLIDE_ADDED_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.atlassian_jira).toEqual({ slug: 'JIRA_NEW_ISSUE_TRIGGER', triggerConfig: undefined });
    expect(reg.atlassian_confluence).toEqual({ slug: 'CONFLUENCE_PAGE_CREATED_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.trello).toEqual({ slug: 'TRELLO_NEW_CARD_TRIGGER', triggerConfig: undefined });
    expect(reg.typeform).toEqual({ slug: 'TYPEFORM_NEW_RESPONSE', triggerConfig: undefined });
    expect(reg.youtube).toEqual({ slug: 'YOUTUBE_NEW_PLAYLIST_ITEM_TRIGGER', triggerConfig: { interval: 1 } });
    expect(reg.mailchimp).toEqual({ slug: 'MAILCHIMP_SUBSCRIBE_TRIGGER', triggerConfig: undefined });
  });

  it('polling-type triggers (the ones that take an interval) pin to interval=1', () => {
    // Webhook-type triggers don't have an interval; polling-type
    // triggers in this registry should pin to the lowest supported
    // (1 minute) so user-perceived latency is bounded.
    const polling = [
      'google_mail', // GMAIL_NEW_GMAIL_MESSAGE — poll
      'discord',
      'google_drive',
      'google_docs',
      'google_sheets',
      'google_slides',
      'atlassian_confluence',
      'youtube',
    ];
    for (const t of polling) {
      const cfg = COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE[t]?.triggerConfig as
        | { interval?: number }
        | undefined;
      expect(cfg?.interval).toBe(1);
    }
  });
});
