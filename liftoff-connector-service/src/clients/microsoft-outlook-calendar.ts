// Microsoft Outlook Calendar Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for Calendar

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

export class MicrosoftOutlookCalendarClient implements CompensationClient {
  readonly connector = 'microsoft_outlook_calendar';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { query?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();
    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft Outlook Calendar API error', { status: response.status, error, path });
      throw new Error(`Microsoft Outlook Calendar API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft Outlook Calendar read', { entityType, entityId });

    switch (entityType) {
      case 'events': {
        const p = payload ?? {};
        const calendarId = p.calendarId as string | undefined;
        const path = calendarId ? `/me/calendars/${calendarId}/events` : '/me/events';
        const query: Record<string, string> = { $top: String(p.pageSize ?? 100) };
        if (p.filter) query.$filter = String(p.filter);
        const result = await this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
          'GET', path, undefined, { query }
        );
        return { id: 'events', data: { events: result.value, nextPageToken: result['@odata.nextLink'] } };
      }

      case 'calendars': {
        const result = await this.request<{ value: Array<Record<string, any>> }>('GET', '/me/calendars');
        return { id: 'calendars', data: { calendars: result.value } };
      }

      case 'event': {
        if (!entityId) throw new Error('entityId required for event');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/events/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.changeKey,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'calendar': {
        if (!entityId) throw new Error('entityId required for calendar');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/calendars/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.changeKey,
          lastModified: undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'CalendarEvent') return { records: [], hasMore: false, unsupported: true };
    const credentials = await this.credentialProvider();
    const query: Record<string, string> = { $top: String(filters?.limit ?? 100) };
    if (filters?.since) {
      query['$filter'] = `lastModifiedDateTime ge ${filters.since.toISOString()}`;
    }
    // If pageToken is a full nextLink URL use it directly; otherwise fall through to base
    const url = filters?.pageToken
      ? filters.pageToken
      : `${this.baseUrl}/me/events?${new URLSearchParams(query)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`Microsoft Outlook Calendar list failed: ${resp.status}`);
    const body = (await resp.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string };
    const nextLink = body['@odata.nextLink'];
    return {
      records: (body.value ?? []).map(e => ({
        id: String(e['id']),
        data: e,
        lastModified: e['lastModifiedDateTime'] ? new Date(e['lastModifiedDateTime'] as string) : undefined,
      })),
      nextPageToken: nextLink,
      hasMore: !!nextLink,
    };
  }

  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft Outlook Calendar create', { entityType });

    try {
      switch (entityType) {
        case 'event': {
          const calendarId = data.calendarId || 'calendar';
          const result = await this.request<{ id: string }>(
            'POST',
            `/me/calendars/${calendarId}/events`,
            {
              subject: data.subject,
              body: data.body ? {
                contentType: data.body.contentType || 'Text',
                content: data.body.content,
              } : undefined,
              start: {
                dateTime: data.start,
                timeZone: data.timeZone || 'UTC',
              },
              end: {
                dateTime: data.end,
                timeZone: data.timeZone || 'UTC',
              },
              location: data.location ? { displayName: data.location } : undefined,
              attendees: data.attendees?.map((email: string) => ({
                emailAddress: { address: email },
                type: 'required',
              })),
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'calendar': {
          const result = await this.request<Record<string, any>>(
            'POST',
            '/me/calendars',
            { name: data.name, color: data.color },
          );

          return {
            success: true,
            id: result.id as string,
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
    logger.info('Microsoft Outlook Calendar update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'event': {
          const updateData: Record<string, any> = {};
          if (data.subject) updateData.subject = data.subject;
          if (data.start) updateData.start = { dateTime: data.start, timeZone: data.timeZone || 'UTC' };
          if (data.end) updateData.end = { dateTime: data.end, timeZone: data.timeZone || 'UTC' };
          if (data.location) updateData.location = { displayName: data.location };

          const result = await this.request<{ changeKey: string }>(
            'PATCH',
            `/me/events/${entityId}`,
            updateData
          );

          return {
            success: true,
            versionToken: result.changeKey,
            data: result,
          };
        }

        case 'calendar': {
          if (!entityId) throw new Error('update_calendar: id required');
          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/me/calendars/${entityId}`,
            { name: data.name, color: data.color },
          );
          return { success: true, data: result };
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
    logger.info('Microsoft Outlook Calendar delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'event': {
          await this.request<void>('DELETE', `/me/events/${entityId}`);
          return { success: true };
        }

        case 'calendar': {
          await this.request<void>('DELETE', `/me/calendars/${entityId}`);
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
    logger.info('Microsoft Outlook Calendar restore from snapshot', { entityType, entityId });

    if (entityType === 'event') {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft Outlook Calendar ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft Outlook Calendar semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['event', 'calendar'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted calendar items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft Outlook Calendar action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listEvents(options: {
    calendarId?: string;
    pageSize?: number;
    skipToken?: string;
    startDateTime?: string;
    endDateTime?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const calendarId = options.calendarId || 'calendar';
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    if (options.startDateTime) {
      query.startDateTime = options.startDateTime;
    }
    if (options.endDateTime) {
      query.endDateTime = options.endDateTime;
    }
    if (options.skipToken) {
      query.$skiptoken = options.skipToken;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      `/me/calendars/${calendarId}/events`,
      undefined,
      { query }
    );
  }
}
