// Composio trigger dispatch table — paired with connector-service's
// src/oauth/composio-trigger-registry.ts. Maps the Composio trigger
// slug (carried in webhook payload metadata.trigger_slug) back to our
// internal (source, entityType) so resolveEventTopics() can route it
// to event-registered agents.
//
// Adding a new connector type to the event-driven path requires:
//   1. Add the row to connector-service/src/oauth/composio-trigger-registry.ts
//      (slug + triggerConfig) — connector-service uses it to call
//      composio.triggers.create.
//   2. Add the matching row here — tenant-runtime uses it to dispatch.
//
// The two tables MUST stay in sync. If a row exists here but not there,
// no trigger is ever created so nothing fires. If a row exists there
// but not here, Composio webhooks land at platform-backend and are
// silently dropped (logged as "unknown trigger slug, ignoring" in
// handleComposioTriggerFired).

export interface ComposioTriggerDispatch {
  /** Internal connector source name — feeds resolveEventTopics's lookup
   *  in routingMap, plus the dynamic-prefix topic `${source}.${entityType}`. */
  source: string;
  /** Entity type carried as `entityType` in our internal connector-event
   *  envelope. Must match the entityType used by the connector's
   *  `polling` map in the catalog (see liftoff-connector-service/src/
   *  catalog/connectors.ts) so the eventTopic aliases resolve. */
  entityType: string;
}

export const COMPOSIO_TRIGGER_DISPATCH: Record<string, ComposioTriggerDispatch> = {
  // Mail
  GMAIL_NEW_GMAIL_MESSAGE: { source: 'google_mail', entityType: 'Email' },
  OUTLOOK_MESSAGE_TRIGGER: { source: 'microsoft_outlook_mail', entityType: 'Email' },

  // Chat
  SLACK_RECEIVE_MESSAGE: { source: 'slack', entityType: 'Message' },
  DISCORD_NEW_MESSAGE_TRIGGER: { source: 'discord', entityType: 'Message' },

  // Calendar
  GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CHANGE_TRIGGER: {
    source: 'google_calendar',
    entityType: 'CalendarEvent',
  },

  // Drive / Docs
  GOOGLEDRIVE_FILE_CREATED_TRIGGER: { source: 'google_drive', entityType: 'File' },
  GOOGLEDOCS_DOCUMENT_UPDATED_TRIGGER: { source: 'google_docs', entityType: 'Document' },
  GOOGLESHEETS_NEW_ROWS_TRIGGER: { source: 'google_sheets', entityType: 'Sheet' },
  GOOGLESLIDES_SLIDE_ADDED_TRIGGER: { source: 'google_slides', entityType: 'Slide' },

  // Project / tickets
  JIRA_NEW_ISSUE_TRIGGER: { source: 'atlassian_jira', entityType: 'Issue' },
  CONFLUENCE_PAGE_CREATED_TRIGGER: { source: 'atlassian_confluence', entityType: 'Page' },
  TRELLO_NEW_CARD_TRIGGER: { source: 'trello', entityType: 'Card' },

  // Forms / media / marketing
  TYPEFORM_NEW_RESPONSE: { source: 'typeform', entityType: 'FormResponse' },
  YOUTUBE_NEW_PLAYLIST_ITEM_TRIGGER: { source: 'youtube', entityType: 'Video' },
  MAILCHIMP_SUBSCRIBE_TRIGGER: { source: 'mailchimp', entityType: 'Subscriber' },

  // Newly wired (also declared in the connector-service catalog; kept here as a
  // manually-maintained boot/fetch-failure fallback snapshot). This map cannot be
  // machine-checked against the catalog from this repo — keep it in sync by hand.
  CLICKUP_TASK_CREATED: { source: 'clickup', entityType: 'Task' },
  TODOIST_NEW_TASK_CREATED: { source: 'todoist', entityType: 'Task' },
  CODA_NEW_CODA_PAGE: { source: 'coda', entityType: 'Page' },
  FIREFLIES_TRANSCRIPTION_COMPLETE: { source: 'fireflies', entityType: 'MeetingNotes' },
  WHATSAPP_MESSAGE_STATUS_UPDATED_TRIGGER: { source: 'whatsapp', entityType: 'Message' },
};

// Catalog-derived dispatch — the single source of truth. Populated from the
// connector-service catalog (each polling entry's eventTrigger.slug →
// { source: connectorType, entityType }) by loadEventTopicsFromCatalog(), so
// adding an event connector requires NO edit here. Merged with the hardcoded
// table above (which stays as a boot-time fallback until the catalog loads and
// until every legacy connector is migrated onto its catalog eventTrigger).
let catalogDispatch: Record<string, ComposioTriggerDispatch> = {};

export function setCatalogTriggerDispatch(map: Record<string, ComposioTriggerDispatch>): void {
  catalogDispatch = map;
}

/** Resolve a trigger slug to its (source, entityType): catalog-derived first,
 *  then the hardcoded fallback. Use this instead of indexing the maps directly. */
export function resolveComposioTriggerDispatch(slug: string): ComposioTriggerDispatch | undefined {
  return catalogDispatch[slug] ?? COMPOSIO_TRIGGER_DISPATCH[slug];
}
