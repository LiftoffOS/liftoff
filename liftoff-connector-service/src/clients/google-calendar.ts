// Google Calendar Connector Client
// Per Section 11 & 12: Real Google Calendar API implementation

import {
  CompensationClient,
  CredentialProvider,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';
import { makeConnectorTransport, type HttpMethod } from './connector-transport.js';

export class GoogleCalendarClient implements CompensationClient {
  readonly connector = 'google_calendar';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://www.googleapis.com/calendar/v3';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    // Query params are passed SEPARATELY rather than pre-baked into `path`,
    // because Composio's proxy takes them as structured `parameters` and signs
    // the endpoint itself. `list()` needs this; it used to sidestep `request()`
    // entirely and issue its own bearer-token fetch, which is exactly the
    // defect this parameter exists to remove.
    options: { query?: Record<string, string> } = {},
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // ONE transport, chosen once. See google-mail.ts for the same change and
    // clients/connector-transport.ts for why the choice no longer lives here.
    const transport = makeConnectorTransport(credentials, this.connector);
    const response = await transport({
      method: method.toUpperCase() as HttpMethod,
      url: `${this.baseUrl}${path}`,
      body,
      query: options.query,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Calendar API error', { status: response.status, error, path });
      throw new Error(`Google Calendar API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Google Calendar read', { entityType, entityId });

    switch (entityType) {
      case 'events': {
        const p = payload ?? {};
        const calendarId = (p.calendarId as string | undefined) ?? 'primary';
        const query: Record<string, string> = {
          maxResults: String(p.maxResults ?? 100),
          singleEvents: 'true',
          orderBy: 'startTime',
        };
        if (p.timeMin) query.timeMin = String(p.timeMin);
        if (p.timeMax) query.timeMax = String(p.timeMax);
        // Was a hand-rolled proxy-then-fetch pair, because `request()` did not
        // take query params. It does now, so this is the one transport again —
        // which also removes the second raw-bearer site on this client.
        const body = await this.request<{ items: Array<Record<string, any>>; nextPageToken?: string }>(
          'GET',
          `/calendars/${calendarId}/events`,
          undefined,
          { query },
        );
        return { id: 'events', data: { events: body.items, nextPageToken: body.nextPageToken } };
      }

      case 'calendars': {
        const result = await this.request<{ items: Array<Record<string, any>> }>('GET', '/users/me/calendarList');
        return { id: 'calendars', data: { calendars: result.items } };
      }

      case 'event': {
        if (!entityId) throw new Error('entityId required for event');
        // entityId format: "calendarId/eventId"
        const [calendarId, eventId] = this.parseEventId(entityId);
        const data = await this.request<Record<string, any>>(
          'GET',
          `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.etag,
          lastModified: new Date(data.updated),
        };
      }

      case 'calendar': {
        if (!entityId) throw new Error('entityId required for calendar');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/calendars/${encodeURIComponent(entityId)}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.etag,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'CalendarEvent') return { records: [], hasMore: false, unsupported: true };

    // Through `request()`, for the same reason Gmail's list() now is: this
    // method issued its own bearer-token fetch, and a composio_managed
    // connector has no bearer token to give it. Gmail is where that surfaced —
    // 401 on every poll for hours, with the connector still reading `active` —
    // and Calendar carried the identical shape, unnoticed only because this
    // tenant has no Calendar connector bound.
    const query: Record<string, string> = {
      singleEvents: 'true',
      maxResults: String(filters?.limit ?? 250),
    };
    if (filters?.since) query.updatedMin = filters.since.toISOString();
    if (filters?.pageToken) query.pageToken = filters.pageToken;

    const body = await this.request<{ items?: Record<string, unknown>[]; nextPageToken?: string }>(
      'GET',
      '/calendars/primary/events',
      undefined,
      { query },
    );
    return {
      records: (body.items ?? []).map(e => ({
        id: String(e['id']),
        data: e,
        lastModified: e['updated'] ? new Date(e['updated'] as string) : undefined,
      })),
      nextPageToken: body.nextPageToken,
      hasMore: !!body.nextPageToken,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Google Calendar create', { entityType });

    try {
      switch (entityType) {
        case 'event': {
          const calendarId = data.calendarId || 'primary';
          const { calendarId: _, ...eventData } = data;

          const result = await this.request<{ id: string; etag: string }>(
            'POST',
            `/calendars/${encodeURIComponent(calendarId)}/events`,
            eventData
          );

          return {
            success: true,
            id: `${calendarId}/${result.id}`,
            data: result,
          };
        }

        case 'calendar': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/calendars',
            data
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Calendar update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'event': {
          const [calendarId, eventId] = this.parseEventId(entityId);
          const result = await this.request<{ etag: string }>(
            'PATCH',
            `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
            data
          );

          return {
            success: true,
            versionToken: result.etag,
            data: result,
          };
        }

        case 'calendar': {
          const result = await this.request<{ etag: string }>(
            'PATCH',
            `/calendars/${encodeURIComponent(entityId)}`,
            data
          );

          return {
            success: true,
            versionToken: result.etag,
            data: result,
          };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Google Calendar delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'event': {
          const [calendarId, eventId] = this.parseEventId(entityId);
          await this.request<void>(
            'DELETE',
            `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`
          );
          return { success: true };
        }

        case 'calendar': {
          await this.request<void>(
            'DELETE',
            `/calendars/${encodeURIComponent(entityId)}`
          );
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Google Calendar restore from snapshot', { entityType, entityId });

    if (entityType === 'event') {
      // Restore event to previous state
      const restoreData: Record<string, any> = {};

      if (snapshot.summary) restoreData.summary = snapshot.summary;
      if (snapshot.description) restoreData.description = snapshot.description;
      if (snapshot.location) restoreData.location = snapshot.location;
      if (snapshot.start) restoreData.start = snapshot.start;
      if (snapshot.end) restoreData.end = snapshot.end;
      if (snapshot.attendees) restoreData.attendees = snapshot.attendees;

      return this.update(entityType, entityId, restoreData);
    }

    return {
      success: false,
      error: `Cannot restore Google Calendar ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Google Calendar semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'event') {
          // Delete the created event
          const calendarId = originalResponse.organizer?.email || 'primary';
          const eventId = originalResponse.id || entityId;
          const id = entityId.includes('/') ? entityId : `${calendarId}/${eventId}`;
          return this.delete('event', id);
        }
        if (entityType === 'calendar') {
          return this.delete('calendar', entityId || originalResponse.id);
        }
        break;

      case 'delete':
        // Cannot restore deleted events without snapshot
        return {
          success: false,
          error: 'Cannot restore deleted Google Calendar events without snapshot data',
        };

      case 'update':
        // Would need snapshot to restore previous state
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Google Calendar action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  private parseEventId(entityId: string): [string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts.slice(1).join('/')];
    }
    return ['primary', entityId];
  }
}
