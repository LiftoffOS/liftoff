// Microsoft Outlook Calendar Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

const OutlookAddressSchema = z.object({
  street: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  countryOrRegion: z.string().optional(),
  postalCode: z.string().optional(),
});

const EventDataSchema = z.object({
  id: z.string().describe('Outlook calendar event id.'),
  subject: z.string().optional(),
  bodyPreview: z.string().optional(),
  start: z.object({ dateTime: z.string().optional(), timeZone: z.string().optional() }).optional()
    .describe('Event start — anchor for "alert N minutes before start" patterns.'),
  end: z.object({ dateTime: z.string().optional(), timeZone: z.string().optional() }).optional(),
  location: z.string().optional(),
  locationAddress: OutlookAddressSchema.optional(),
  attendees: z.array(z.object({
    name: z.string().optional(),
    address: z.string().optional(),
    response: z.string().optional(),
    type: z.string().optional(),
  })).optional(),
  organizer: z.object({ name: z.string().optional(), address: z.string().optional() }).optional(),
  isAllDay: z.boolean().optional(),
  isCancelled: z.boolean().optional(),
  isOrganizer: z.boolean().optional(),
  hasRecurrence: z.boolean(),
  showAs: z.string().optional(),
  importance: z.string().optional(),
  sensitivity: z.string().optional(),
  webLink: z.string().optional(),
  onlineMeetingUrl: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const CalendarDataSchema = z.object({
  id: z.string().describe('Outlook calendar id.'),
  name: z.string().optional(),
  color: z.string().optional(),
  isDefaultCalendar: z.boolean().optional(),
  canEdit: z.boolean().optional(),
  canShare: z.boolean().optional(),
  canViewPrivateItems: z.boolean().optional(),
  owner: z.object({ name: z.string().optional(), address: z.string().optional() }).optional(),
});

// Outlook Calendar Event structure
interface OutlookEvent {
  id: string;
  changeKey?: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  start?: {
    dateTime?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    timeZone?: string;
  };
  location?: {
    displayName?: string;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      countryOrRegion?: string;
      postalCode?: string;
    };
  };
  attendees?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
    status?: {
      response?: string;
      time?: string;
    };
    type?: string;
  }>;
  organizer?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  recurrence?: Record<string, any>;
  showAs?: string;
  importance?: string;
  sensitivity?: string;
  webLink?: string;
  onlineMeetingUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

// Outlook Calendar structure
interface OutlookCalendar {
  id: string;
  name?: string;
  color?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  canShare?: boolean;
  canViewPrivateItems?: boolean;
  owner?: {
    name?: string;
    address?: string;
  };
  changeKey?: string;
}

// List response
interface OutlookCalendarListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (OutlookEvent | OutlookCalendar)[];
}

type OutlookCalendarPayload = OutlookEvent | OutlookCalendar | OutlookCalendarListResponse;

export class MicrosoftOutlookCalendarNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_outlook_calendar';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Event: EventDataSchema,
    Calendar: CalendarDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const calendarPayload = payload as OutlookCalendarPayload;

    // Handle list response
    if (this.isListResponse(calendarPayload)) {
      for (const item of calendarPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isEvent(calendarPayload) || this.isCalendar(calendarPayload)) {
      records.push(this.normalizeItem(calendarPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: OutlookEvent | OutlookCalendar): NormalizedRecord {
    if (this.isEvent(item)) {
      return this.normalizeEvent(item);
    }
    return this.normalizeCalendar(item as OutlookCalendar);
  }

  private normalizeEvent(event: OutlookEvent): NormalizedRecord {
    return {
      entityType: 'Event',
      externalId: event.id,
      data: EventDataSchema.parse({
        id: event.id,
        subject: event.subject,
        bodyPreview: event.bodyPreview,
        start: event.start ? {
          dateTime: event.start.dateTime,
          timeZone: event.start.timeZone,
        } : undefined,
        end: event.end ? {
          dateTime: event.end.dateTime,
          timeZone: event.end.timeZone,
        } : undefined,
        location: event.location?.displayName,
        locationAddress: event.location?.address,
        attendees: event.attendees?.map(a => ({
          name: a.emailAddress?.name,
          address: a.emailAddress?.address,
          response: a.status?.response,
          type: a.type,
        })),
        organizer: event.organizer?.emailAddress ? {
          name: event.organizer.emailAddress.name,
          address: event.organizer.emailAddress.address,
        } : undefined,
        isAllDay: event.isAllDay,
        isCancelled: event.isCancelled,
        isOrganizer: event.isOrganizer,
        hasRecurrence: !!event.recurrence,
        showAs: event.showAs,
        importance: event.importance,
        sensitivity: event.sensitivity,
        webLink: event.webLink,
        onlineMeetingUrl: event.onlineMeetingUrl,
        createdAt: event.createdDateTime,
        modifiedAt: event.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_outlook_calendar',
        syncedAt: new Date(),
        version: event.changeKey ?? hashCanonicalJson(event),
      },
    };
  }

  private normalizeCalendar(calendar: OutlookCalendar): NormalizedRecord {
    return {
      entityType: 'Calendar',
      externalId: calendar.id,
      data: CalendarDataSchema.parse({
        id: calendar.id,
        name: calendar.name,
        color: calendar.color,
        isDefaultCalendar: calendar.isDefaultCalendar,
        canEdit: calendar.canEdit,
        canShare: calendar.canShare,
        canViewPrivateItems: calendar.canViewPrivateItems,
        owner: calendar.owner ? {
          name: calendar.owner.name,
          address: calendar.owner.address,
        } : undefined,
      }),
      metadata: {
        source: 'microsoft_outlook_calendar',
        syncedAt: new Date(),
        version: calendar.changeKey ?? hashCanonicalJson(calendar),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as OutlookCalendarPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isEvent(r)) return 'Event';
    if (this.isCalendar(r)) return 'Calendar';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as OutlookCalendarPayload;
    if (this.isEvent(r) || this.isCalendar(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as OutlookCalendarPayload;
    if (this.isEvent(r) || this.isCalendar(r)) return r.changeKey;
    return undefined;
  }

  private isListResponse(payload: OutlookCalendarPayload): payload is OutlookCalendarListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isEvent(payload: OutlookCalendarPayload): payload is OutlookEvent {
    return 'id' in payload && ('start' in payload || 'subject' in payload) && !('name' in payload);
  }

  private isCalendar(payload: OutlookCalendarPayload): payload is OutlookCalendar {
    return 'id' in payload && 'name' in payload && !('start' in payload);
  }
}
