// Calendly Connector Client
// Auth: OAuth2 Bearer token
// Base URL: https://api.calendly.com
// Note: Most endpoints require the current user URI or organization URI.
//       CalendlyClient caches these per-instance (fetched lazily on first use).

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

// ─── Internal Calendly API types ─────────────────────────────────────────────

interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string;
  timezone: string;
  current_organization: string;
}

interface CalendlyPagination {
  count: number;
  next_page?: string;
  next_page_token?: string;
  previous_page?: string;
}

interface CalendlySingleResponse<T> {
  resource: T;
}

interface CalendlyCollectionResponse<T> {
  collection: T[];
  pagination: CalendlyPagination;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class CalendlyClient implements CompensationClient {
  readonly connector = 'calendly';
  private credentialProvider: CredentialProvider;

  // Lazily cached per-instance — fetched once then reused.
  private cachedUserUri: string | null = null;
  private cachedOrgUri: string | null = null;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── HTTP request helper ───────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const baseUrl = 'https://api.calendly.com';
    let url = `${baseUrl}${path}`;

    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString();
      url = `${url}?${qs}`;
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
      logger.error('Calendly API error', { status: response.status, error, path, method });
      throw new Error(`Calendly API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── User context helpers ──────────────────────────────────────────────────

  /**
   * Fetch and cache the current user's URI and organization URI.
   * Calendly requires these to scope most list operations.
   */
  private async ensureUserContext(): Promise<{ userUri: string; orgUri: string }> {
    if (this.cachedUserUri && this.cachedOrgUri) {
      return { userUri: this.cachedUserUri, orgUri: this.cachedOrgUri };
    }

    const resp = await this.request<CalendlySingleResponse<CalendlyUser>>('GET', '/users/me');
    this.cachedUserUri = resp.resource.uri;
    this.cachedOrgUri = resp.resource.current_organization;

    return { userUri: this.cachedUserUri, orgUri: this.cachedOrgUri };
  }

  /**
   * Extract the UUID from a full Calendly URI.
   * e.g. "https://api.calendly.com/users/abc123" → "abc123"
   */
  private extractUuid(uri: string): string {
    const parts = uri.split('/');
    return parts[parts.length - 1];
  }

  // ── Calendly API operations ───────────────────────────────────────────────

  async getCurrentUser(): Promise<Record<string, unknown>> {
    const resp = await this.request<CalendlySingleResponse<CalendlyUser>>('GET', '/users/me');
    return resp.resource as unknown as Record<string, unknown>;
  }

  async listEventTypes(activeOnly: boolean = true): Promise<unknown[]> {
    const { userUri } = await this.ensureUserContext();
    const params: Record<string, string> = {
      user: userUri,
      count: '100',
    };
    if (activeOnly) {
      params.active = 'true';
    }
    const resp = await this.request<CalendlyCollectionResponse<unknown>>(
      'GET',
      '/event_types',
      undefined,
      params,
    );
    return resp.collection;
  }

  async getEventType(eventTypeUuid: string): Promise<Record<string, unknown>> {
    const resp = await this.request<CalendlySingleResponse<Record<string, unknown>>>(
      'GET',
      `/event_types/${eventTypeUuid}`,
    );
    return resp.resource;
  }

  async listScheduledEvents(params: {
    status?: string;
    minStartTime?: string;
    maxStartTime?: string;
    count?: number;
  } = {}): Promise<unknown[]> {
    const { userUri } = await this.ensureUserContext();
    const qp: Record<string, string> = {
      user: userUri,
      count: String(Math.min(params.count ?? 100, 100)),
      sort: 'start_time:asc',
    };
    if (params.status) qp.status = params.status;
    if (params.minStartTime) qp.min_start_time = params.minStartTime;
    if (params.maxStartTime) qp.max_start_time = params.maxStartTime;

    const resp = await this.request<CalendlyCollectionResponse<unknown>>(
      'GET',
      '/scheduled_events',
      undefined,
      qp,
    );
    return resp.collection;
  }

  async getScheduledEvent(eventUuid: string): Promise<Record<string, unknown>> {
    const resp = await this.request<CalendlySingleResponse<Record<string, unknown>>>(
      'GET',
      `/scheduled_events/${eventUuid}`,
    );
    return resp.resource;
  }

  async listEventInvitees(eventUuid: string): Promise<unknown[]> {
    const resp = await this.request<CalendlyCollectionResponse<unknown>>(
      'GET',
      `/scheduled_events/${eventUuid}/invitees`,
      undefined,
      { count: '100' },
    );
    return resp.collection;
  }

  async cancelEvent(eventUuid: string, reason?: string): Promise<void> {
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    await this.request<void>('POST', `/scheduled_events/${eventUuid}/cancellation`, body);
  }

  async findEventsByInvitee(inviteeEmail: string, count: number = 100): Promise<unknown[]> {
    const { userUri } = await this.ensureUserContext();
    const resp = await this.request<CalendlyCollectionResponse<unknown>>(
      'GET',
      '/scheduled_events',
      undefined,
      {
        user: userUri,
        invitee_email: inviteeEmail,
        count: String(Math.min(count, 100)),
      },
    );
    return resp.collection;
  }

  async listOrganizationMembers(count: number = 100): Promise<unknown[]> {
    const { orgUri } = await this.ensureUserContext();
    const resp = await this.request<CalendlyCollectionResponse<unknown>>(
      'GET',
      '/organization_memberships',
      undefined,
      { organization: orgUri, count: String(Math.min(count, 100)) },
    );
    return resp.collection;
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Calendly read', { entityType, entityId });

    switch (entityType) {
      case 'current_user': {
        const data = await this.getCurrentUser();
        return { id: 'me', data };
      }

      case 'event_types': {
        const activeOnly = payload?.active_only !== false;
        const data = await this.listEventTypes(activeOnly);
        return { id: 'event_types', data: { event_types: data } };
      }

      case 'event_type': {
        if (!entityId) throw new Error('Calendly: event_type read requires entityId (UUID)');
        const data = await this.getEventType(entityId);
        return { id: entityId, data };
      }

      case 'scheduled_events': {
        const data = await this.listScheduledEvents({
          status: payload?.status as string | undefined,
          minStartTime: payload?.min_start_time as string | undefined,
          maxStartTime: payload?.max_start_time as string | undefined,
          count: payload?.count as number | undefined,
        });
        return { id: 'scheduled_events', data: { events: data } };
      }

      case 'scheduled_event': {
        if (!entityId) throw new Error('Calendly: scheduled_event read requires entityId (UUID)');
        const data = await this.getScheduledEvent(entityId);
        return { id: entityId, data };
      }

      case 'event_invitees': {
        if (!entityId) throw new Error('Calendly: event_invitees read requires entityId (event UUID)');
        const data = await this.listEventInvitees(entityId);
        return { id: entityId, data: { invitees: data } };
      }

      case 'events_by_invitee': {
        const email = payload?.invitee_email as string;
        if (!email) throw new Error('Calendly: events_by_invitee requires invitee_email');
        const data = await this.findEventsByInvitee(email, payload?.count as number | undefined);
        return { id: email, data: { events: data } };
      }

      case 'organization_members': {
        const data = await this.listOrganizationMembers(payload?.count as number | undefined);
        return { id: 'members', data: { members: data } };
      }

      default:
        throw new Error(`Calendly: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * list('Event', { since }) — incremental pull of scheduled events for reactive
   * polling.
   *
   * Calendly v2 requires `user` (or `organization`) to scope /scheduled_events;
   * we resolve the current user's URI via /users/me (cached per-instance) and
   * pass it. `min_start_time` (ISO) + `sort=start_time:asc` give events from the
   * sync cursor forward. Pagination is an opaque `next_page_token` echoed back as
   * `page_token`. Each event is keyed by the UUID tail of its `uri`.
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Event') return { records: [], hasMore: false, unsupported: true };

    const { userUri } = await this.ensureUserContext();
    const count = Math.min(filters?.limit ?? 100, 100);
    const qp: Record<string, string> = {
      user: userUri,
      count: String(count),
      sort: 'start_time:asc',
    };
    if (filters?.since) qp.min_start_time = filters.since.toISOString();
    if (filters?.pageToken) qp.page_token = filters.pageToken;

    const resp = await this.request<CalendlyCollectionResponse<Record<string, unknown>>>(
      'GET',
      '/scheduled_events',
      undefined,
      qp,
    );

    const events = Array.isArray(resp.collection) ? resp.collection : [];
    const nextPageToken = resp.pagination?.next_page_token ?? undefined;

    return {
      records: events
        .filter((ev) => typeof ev.uri === 'string' && (ev.uri as string).length > 0)
        .map((ev) => ({ id: String((ev.uri as string).split('/').pop()), data: ev })),
      nextPageToken,
      hasMore: Boolean(nextPageToken),
    };
  }

  async create(
    _entityType: string,
    _data: Record<string, any>,
  ): Promise<CreateResult> {
    return { success: false, id: '', error: 'Calendly: create operations not supported' };
  }

  async update(
    _entityType: string,
    _entityId: string | undefined,
    _data: Record<string, any>,
  ): Promise<UpdateResult> {
    return { success: false, error: 'Calendly: update operations not supported' };
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Calendly delete (cancel)', { entityType, entityId });

    try {
      if (entityType === 'scheduled_event') {
        if (!entityId) {
          return { success: false, error: 'Calendly: cancel requires entityId (event UUID)' };
        }
        await this.cancelEvent(entityId, payload?.reason as string | undefined);
        return { success: true };
      }

      return { success: false, error: `Calendly: unsupported delete entity type "${entityType}"` };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(
    _entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    return { success: false, error: 'Calendly: restore not supported — cancelled events cannot be un-cancelled' };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    return {
      success: false,
      error: `Calendly: cannot invert "${originalAction}" on entity type "${entityType}"`,
    };
  }
}
