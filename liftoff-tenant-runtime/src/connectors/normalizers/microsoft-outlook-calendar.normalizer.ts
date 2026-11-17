// Microsoft Outlook Calendar Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';

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
      data: {
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
      },
      metadata: {
        source: 'microsoft_outlook_calendar',
        syncedAt: new Date(),
        version: event.changeKey,
      },
    };
  }

  private normalizeCalendar(calendar: OutlookCalendar): NormalizedRecord {
    return {
      entityType: 'Calendar',
      externalId: calendar.id,
      data: {
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
      },
      metadata: {
        source: 'microsoft_outlook_calendar',
        syncedAt: new Date(),
        version: calendar.changeKey,
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
