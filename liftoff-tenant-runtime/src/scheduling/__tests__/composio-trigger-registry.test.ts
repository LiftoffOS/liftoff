import {
  COMPOSIO_TRIGGER_DISPATCH,
  setCatalogTriggerDispatch,
  resolveComposioTriggerDispatch,
} from '../composio-trigger-registry';

describe('COMPOSIO_TRIGGER_DISPATCH', () => {
  it('every entry has a non-empty source + entityType', () => {
    for (const [slug, dispatch] of Object.entries(COMPOSIO_TRIGGER_DISPATCH)) {
      // Slugs are UPPER_SNAKE_CASE (Composio convention).
      expect(slug).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(dispatch.source).toBeTruthy();
      expect(dispatch.entityType).toBeTruthy();
      expect(typeof dispatch.source).toBe('string');
      expect(typeof dispatch.entityType).toBe('string');
    }
  });

  it('covers the fallback snapshot of connectors with composio triggers', () => {
    const slugs = Object.keys(COMPOSIO_TRIGGER_DISPATCH).sort();
    expect(slugs).toEqual([
      'CLICKUP_TASK_CREATED',
      'CODA_NEW_CODA_PAGE',
      'CONFLUENCE_PAGE_CREATED_TRIGGER',
      'DISCORD_NEW_MESSAGE_TRIGGER',
      'FIREFLIES_TRANSCRIPTION_COMPLETE',
      'GMAIL_NEW_GMAIL_MESSAGE',
      'GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER',
      'GOOGLEDOCS_DOCUMENT_UPDATED_TRIGGER',
      'GOOGLEDRIVE_FILE_CREATED_TRIGGER',
      'GOOGLESHEETS_NEW_ROWS_TRIGGER',
      'GOOGLESLIDES_SLIDE_ADDED_TRIGGER',
      'JIRA_NEW_ISSUE_TRIGGER',
      'MAILCHIMP_SUBSCRIBE_TRIGGER',
      'OUTLOOK_MESSAGE_TRIGGER',
      'SLACK_RECEIVE_MESSAGE',
      'TODOIST_NEW_TASK_CREATED',
      'TRELLO_NEW_CARD_TRIGGER',
      'TYPEFORM_NEW_RESPONSE',
      'WHATSAPP_MESSAGE_STATUS_UPDATED_TRIGGER',
      'YOUTUBE_NEW_PLAYLIST_ITEM_TRIGGER',
    ]);
  });

  it('resolveComposioTriggerDispatch prefers the catalog-derived map then the fallback', () => {
    // catalog wins on conflict...
    setCatalogTriggerDispatch({ SLACK_RECEIVE_MESSAGE: { source: 'slack', entityType: 'Msg' }, NEW_ONE: { source: 'x', entityType: 'Y' } });
    expect(resolveComposioTriggerDispatch('SLACK_RECEIVE_MESSAGE')).toEqual({ source: 'slack', entityType: 'Msg' });
    expect(resolveComposioTriggerDispatch('NEW_ONE')).toEqual({ source: 'x', entityType: 'Y' });
    // ...and the hardcoded fallback covers slugs the (empty) catalog lacks.
    setCatalogTriggerDispatch({});
    expect(resolveComposioTriggerDispatch('GMAIL_NEW_GMAIL_MESSAGE')).toEqual({ source: 'google_mail', entityType: 'Email' });
    expect(resolveComposioTriggerDispatch('UNKNOWN_SLUG')).toBeUndefined();
  });

  it('mail/chat dispatches use the conventional Email/Message entityTypes the polling map uses', () => {
    expect(COMPOSIO_TRIGGER_DISPATCH.GMAIL_NEW_GMAIL_MESSAGE).toEqual({
      source: 'google_mail', entityType: 'Email',
    });
    expect(COMPOSIO_TRIGGER_DISPATCH.OUTLOOK_MESSAGE_TRIGGER).toEqual({
      source: 'microsoft_outlook_mail', entityType: 'Email',
    });
    expect(COMPOSIO_TRIGGER_DISPATCH.SLACK_RECEIVE_MESSAGE).toEqual({
      source: 'slack', entityType: 'Message',
    });
  });
});
