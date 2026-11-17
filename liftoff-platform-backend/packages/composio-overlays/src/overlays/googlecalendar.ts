// googlecalendar overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.
//
// Write-provenance declarations below are in CANONICAL shape. Nothing here
// translates input or output, so the canonical names ARE Composio's: `idArgs`
// name arguments off each tool's input_parameters, and `returnsIds` paths are
// read against `data` off its output_parameters.
//
// Those paths are Composio's, not Google's, and the two disagree. Google's
// calendarList.list returns `items`; Composio returns `calendars`. Its
// events.insert returns the event at the top level; Composio nests it under
// `response_data`. A declaration written from Google's reference would compile,
// match nothing, and read as a tool that declares no provenance — which is
// indistinguishable from one nobody covered.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

// ── Vendor shapes, for the normalisers below ─────────────────────────────
//
// Composio hands back Google's own resources under its own wrappers, and the
// canonical shape flattens both. Everything is optional: an untitled event has
// no `summary`, an event with no guests has no `attendees`, and an all-day
// event carries `date` where a timed one carries `dateTime`.

interface GoogleEventTime { date?: string; dateTime?: string; timeZone?: string }
interface GoogleEvent {
  id?: string;
  summary?: string;
  htmlLink?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: Array<{ email?: string; responseStatus?: string }>;
}

/** One timestamp string from Google's two-shaped time. All-day events carry a
 *  date and no dateTime; the canonical shape is a single string either way. */
function eventTime(t: GoogleEventTime | undefined): string {
  return t?.dateTime ?? t?.date ?? '';
}

function projectEvent(e: GoogleEvent): {
  id: string; summary: string; start: string; end: string;
  attendees: Array<{ email: string; responseStatus: string }>;
} {
  return {
    id: e.id ?? '',
    summary: e.summary ?? '',
    start: eventTime(e.start),
    end: eventTime(e.end),
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? '',
      responseStatus: a.responseStatus ?? '',
    })),
  };
}

export const GOOGLECALENDAR_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLECALENDAR_LIST_CALENDARS: {
    stableName: 'list_calendars',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'calendar', path: 'items[].id' }],
    translateOutput: (r) => {
      const resp = r as { calendars?: Array<{ id?: string; summary?: string; primary?: boolean }> };
      return {
        items: (resp.calendars ?? []).map((c) => ({
          id: c.id ?? '',
          name: c.summary ?? '',
          // Google sets `primary` only on the primary calendar rather than
          // false on the others, so an absent flag is a real answer.
          primary: c.primary === true,
        })),
      };
    },
  },
  GOOGLECALENDAR_GET_CALENDAR: {
    stableName: 'get_calendar',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'calendar', path: 'id' }],
    translateOutput: (r) => {
      const resp = r as { calendar_data?: { id?: string; summary?: string; timeZone?: string } };
      return {
        id: resp.calendar_data?.id ?? '',
        name: resp.calendar_data?.summary ?? '',
        timeZone: resp.calendar_data?.timeZone,
      };
    },
  },
  GOOGLECALENDAR_EVENTS_LIST: {
    stableName: 'list_events',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'event', path: 'items[].id' }],
    translateOutput: (r) => {
      const resp = r as { items?: GoogleEvent[]; nextPageToken?: string };
      return {
        items: (resp.items ?? []).map(projectEvent),
        nextPageToken: resp.nextPageToken,
      };
    },
  },
  GOOGLECALENDAR_FIND_EVENT: {
    stableName: 'find_event',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'event', path: 'items[].id' }],
    translateOutput: (r) => {
      // Doubly nested, and not a typo: Composio wraps the result in
      // `event_data`, whose own documented `event_data` key holds the matches.
      const resp = r as {
        event_data?: { event_data?: GoogleEvent[]; nextPageToken?: string };
      };
      return {
        items: (resp.event_data?.event_data ?? []).map(projectEvent),
        nextPageToken: resp.event_data?.nextPageToken,
      };
    },
  },
  GOOGLECALENDAR_FIND_FREE_SLOTS: { stableName: 'find_free_slots', categoryOverrides: ["read"] },
  GOOGLECALENDAR_FREE_BUSY_QUERY: { stableName: 'free_busy', categoryOverrides: ["read"] },
  GOOGLECALENDAR_GET_CURRENT_DATE_TIME: { stableName: 'get_current_datetime', categoryOverrides: ["read"] },
  GOOGLECALENDAR_CREATE_EVENT: {
    stableName: 'create_event',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'event', path: 'id' }],
    translateOutput: (r) => {
      const resp = r as { response_data?: GoogleEvent };
      return {
        id: resp.response_data?.id ?? '',
        htmlLink: resp.response_data?.htmlLink ?? '',
      };
    },
  },
  GOOGLECALENDAR_UPDATE_EVENT: {
    stableName: 'update_event',
    categoryOverrides: ['write'],
    idArgs: ['event_id'],
    returnsIds: [{ entityType: 'event', path: 'id' }],
    translateOutput: (r) => {
      const resp = r as { response_data?: GoogleEvent };
      return {
        id: resp.response_data?.id ?? '',
        htmlLink: resp.response_data?.htmlLink ?? '',
      };
    },
  },
  GOOGLECALENDAR_QUICK_ADD: {
    stableName: 'quick_add_event',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'event', path: 'id' }],
    translateOutput: (r) => {
      const resp = r as { event?: GoogleEvent };
      return {
        id: resp.event?.id ?? '',
        htmlLink: resp.event?.htmlLink ?? '',
      };
    },
  },
  GOOGLECALENDAR_DELETE_EVENT: {
    stableName: 'delete_event',
    categoryOverrides: ['write', 'destructive'],
    idArgs: ['event_id'],
  },
};

export const GOOGLECALENDAR_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
