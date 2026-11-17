// Google Calendar Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Google Calendar API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const CalendarEventDataSchema = z.object({
  id: z.string().describe('Google Calendar event id.'),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  status: z.string().optional(),
  htmlLink: z.string().optional(),
  startDateTime: z.string().optional().describe('Event start RFC3339 — anchor for "alert N minutes before start" patterns.'),
  startDate: z.string().optional(),
  startTimeZone: z.string().optional(),
  endDateTime: z.string().optional(),
  endDate: z.string().optional(),
  endTimeZone: z.string().optional(),
  isAllDay: z.boolean(),
  isRecurring: z.boolean(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  sequence: z.number().optional(),
  organizer: z.object({
    email: z.string().optional(),
    displayName: z.string().optional(),
    self: z.boolean().optional(),
  }).optional(),
  creator: z.object({
    email: z.string().optional(),
    displayName: z.string().optional(),
    self: z.boolean().optional(),
  }).optional(),
  attendees: z.array(z.object({
    email: z.string().optional(),
    displayName: z.string().optional(),
    responseStatus: z.string().optional(),
    optional: z.boolean().optional(),
    resource: z.boolean().optional(),
    organizer: z.boolean().optional(),
  })).optional(),
  attendeeCount: z.number(),
  hasConference: z.boolean(),
  hangoutLink: z.string().optional(),
  conferenceType: z.string().optional(),
  conferenceUri: z.string().optional(),
  visibility: z.string().optional(),
  transparency: z.string().optional(),
  showAs: z.string(),
  hasReminders: z.boolean(),
  reminders: z.array(z.object({ method: z.string(), minutes: z.number() })).optional(),
  hasAttachments: z.boolean(),
  attachments: z.array(z.object({
    title: z.string().optional(),
    mimeType: z.string().optional(),
    fileUrl: z.string().optional(),
  })).optional(),
  iCalUID: z.string().optional(),
  colorId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const CalendarNotificationDataSchema = z.object({
  id: z.string().describe('Google Calendar push-notification channel id.'),
  resourceId: z.string(),
  resourceUri: z.string(),
  resourceState: z.string(),
  channelId: z.string(),
  expiration: z.string().optional(),
  requiresFetch: z.boolean(),
});

// Google Calendar API Event structure
interface GoogleCalendarEvent {
  id: string;
  kind: string;
  etag: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  creator?: {
    id?: string;
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  organizer?: {
    id?: string;
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  start?: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
  };
  end?: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
  };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
  };
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  iCalUID?: string;
  sequence?: number;
  attendees?: Array<{
    id?: string;
    email?: string;
    displayName?: string;
    organizer?: boolean;
    self?: boolean;
    resource?: boolean;
    optional?: boolean;
    responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
    comment?: string;
    additionalGuests?: number;
  }>;
  attendeesOmitted?: boolean;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: Record<string, any>;
    entryPoints?: Array<{
      entryPointType: string;
      uri?: string;
      label?: string;
    }>;
    conferenceSolution?: {
      name?: string;
      iconUri?: string;
      key?: {
        type: string;
      };
    };
    conferenceId?: string;
    notes?: string;
  };
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{
      method: string;
      minutes: number;
    }>;
  };
  attachments?: Array<{
    fileId?: string;
    fileUrl?: string;
    title?: string;
    mimeType?: string;
    iconLink?: string;
  }>;
}

// Google Calendar Push Notification payload
interface GoogleCalendarPushNotification {
  kind: string;
  resourceId: string;
  resourceUri: string;
  resourceState: 'sync' | 'exists' | 'not_exists';
  channelId: string;
  expiration?: string;
}

// Google Calendar List response
interface GoogleCalendarListResponse {
  kind: string;
  etag: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items: GoogleCalendarEvent[];
}

type GoogleCalendarPayload =
  | GoogleCalendarEvent
  | GoogleCalendarListResponse
  | GoogleCalendarPushNotification;

export class GoogleCalendarNormalizer implements ConnectorNormalizer {
  connectorType = 'google_calendar';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    CalendarEvent: CalendarEventDataSchema,
    CalendarNotification: CalendarNotificationDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const calPayload = payload as GoogleCalendarPayload;

    // Handle list response with multiple events
    if (this.isListResponse(calPayload)) {
      for (const event of calPayload.items) {
        if (event.status !== 'cancelled') {
          records.push(this.normalizeEvent(event));
        }
      }
      return records;
    }

    // Handle push notification (just returns metadata, actual event needs to be fetched)
    if (this.isPushNotification(calPayload)) {
      records.push(this.normalizePushNotification(calPayload));
      return records;
    }

    // Handle single event
    if (this.isEvent(calPayload)) {
      if (calPayload.status !== 'cancelled') {
        records.push(this.normalizeEvent(calPayload));
      }
      return records;
    }

    return records;
  }

  private normalizeEvent(event: GoogleCalendarEvent): NormalizedRecord {
    return {
      entityType: 'CalendarEvent',
      externalId: event.id,
      data: CalendarEventDataSchema.parse({
        id: event.id,
        // Core event data
        summary: event.summary,
        description: event.description,
        location: event.location,
        status: event.status,
        htmlLink: event.htmlLink,

        // Time information
        startDateTime: event.start?.dateTime,
        startDate: event.start?.date,
        startTimeZone: event.start?.timeZone,
        endDateTime: event.end?.dateTime,
        endDate: event.end?.date,
        endTimeZone: event.end?.timeZone,
        isAllDay: !!event.start?.date && !event.start?.dateTime,

        // Recurrence
        isRecurring: !!event.recurrence || !!event.recurringEventId,
        recurrence: event.recurrence,
        recurringEventId: event.recurringEventId,
        sequence: event.sequence,

        // Organizer and creator
        organizer: event.organizer
          ? {
              email: event.organizer.email,
              displayName: event.organizer.displayName,
              self: event.organizer.self,
            }
          : undefined,
        creator: event.creator
          ? {
              email: event.creator.email,
              displayName: event.creator.displayName,
              self: event.creator.self,
            }
          : undefined,

        // Attendees
        attendees: event.attendees?.map((a) => ({
          email: a.email,
          displayName: a.displayName,
          responseStatus: a.responseStatus,
          optional: a.optional,
          resource: a.resource,
          organizer: a.organizer,
        })),
        attendeeCount: event.attendees?.length || 0,

        // Conference/Video call
        hasConference: !!event.conferenceData || !!event.hangoutLink,
        hangoutLink: event.hangoutLink,
        conferenceType: event.conferenceData?.conferenceSolution?.name,
        conferenceUri: event.conferenceData?.entryPoints?.find(
          (e) => e.entryPointType === 'video'
        )?.uri,

        // Visibility and transparency
        visibility: event.visibility,
        transparency: event.transparency,
        showAs: event.transparency === 'transparent' ? 'free' : 'busy',

        // Reminders
        hasReminders: !event.reminders?.useDefault || !!event.reminders?.overrides?.length,
        reminders: event.reminders?.overrides,

        // Attachments
        hasAttachments: !!event.attachments?.length,
        attachments: event.attachments?.map((a) => ({
          title: a.title,
          mimeType: a.mimeType,
          fileUrl: a.fileUrl,
        })),

        // Metadata
        iCalUID: event.iCalUID,
        colorId: event.colorId,
        createdAt: event.created,
        updatedAt: event.updated,
      }),
      metadata: {
        source: 'google_calendar',
        syncedAt: new Date(),
        version: event.updated ?? hashCanonicalJson(event),
        etag: event.etag,
      },
    };
  }

  private normalizePushNotification(
    notification: GoogleCalendarPushNotification
  ): NormalizedRecord {
    return {
      entityType: 'CalendarNotification',
      externalId: notification.channelId,
      data: CalendarNotificationDataSchema.parse({
        id: notification.channelId,
        resourceId: notification.resourceId,
        resourceUri: notification.resourceUri,
        resourceState: notification.resourceState,
        channelId: notification.channelId,
        expiration: notification.expiration,
        requiresFetch: true, // Indicates that the actual event data needs to be fetched
      }),
      metadata: {
        source: 'google_calendar',
        syncedAt: new Date(),
        version: hashCanonicalJson(notification),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as GoogleCalendarPayload;
    if (this.isListResponse(r)) return 'CalendarEventList';
    if (this.isPushNotification(r)) return 'CalendarNotification';
    if (this.isEvent(r)) return 'CalendarEvent';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as GoogleCalendarPayload;
    if (this.isListResponse(r)) return r.etag || '';
    if (this.isPushNotification(r)) return r.channelId;
    if (this.isEvent(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as GoogleCalendarPayload;
    if (this.isEvent(r)) return r.updated;
    if (this.isListResponse(r)) return r.etag;
    return undefined;
  }

  private isListResponse(payload: GoogleCalendarPayload): payload is GoogleCalendarListResponse {
    return (
      'kind' in payload &&
      payload.kind === 'calendar#events' &&
      'items' in payload
    );
  }

  private isPushNotification(
    payload: GoogleCalendarPayload
  ): payload is GoogleCalendarPushNotification {
    return (
      'resourceState' in payload &&
      'channelId' in payload
    );
  }

  private isEvent(payload: GoogleCalendarPayload): payload is GoogleCalendarEvent {
    return (
      'kind' in payload &&
      (payload.kind === 'calendar#event' || !('items' in payload)) &&
      'id' in payload
    );
  }
}
