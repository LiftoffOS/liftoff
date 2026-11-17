// Cal.com Connector Client
// Auth: API key via query param (?apiKey={key}) on every request.
// The api_key is stored as credentials.accessToken.
// Base URL: https://api.cal.com/v1
// No OAuth — API key only, no refresh needed.

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

// ─── Client ──────────────────────────────────────────────────────────────────

export class CalComClient implements CompensationClient {
  readonly connector = 'cal_com';
  private credentialProvider: CredentialProvider;

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
    const apiKey = credentials.accessToken;
    const baseUrl = 'https://api.cal.com/v1';

    // API key always appended as query param
    const params = new URLSearchParams({ apiKey, ...queryParams });
    const url = `${baseUrl}${path}?${params.toString()}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Cal.com API error', { status: response.status, error, path, method });
      throw new Error(`Cal.com API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Cal.com API operations ────────────────────────────────────────────────

  async getProfile(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/me');
  }

  async listEventTypes(): Promise<unknown[]> {
    const resp = await this.request<{ event_types: unknown[] }>('GET', '/event-types');
    return resp.event_types ?? [];
  }

  async getEventType(eventTypeId: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/event-types/${eventTypeId}`);
  }

  async updateEventType(
    eventTypeId: number,
    data: {
      title?: string;
      description?: string;
      length?: number;
      hidden?: boolean;
      slotInterval?: number;
    },
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PATCH', `/event-types/${eventTypeId}`, data as Record<string, unknown>);
  }

  async listBookings(params: {
    status?: string;
    take?: number;
    skip?: number;
  } = {}): Promise<unknown[]> {
    const qp: Record<string, string> = {
      take: String(Math.min(params.take ?? 50, 100)),
      skip: String(params.skip ?? 0),
    };
    if (params.status) qp.status = params.status;

    const resp = await this.request<{ bookings: unknown[] }>(
      'GET',
      '/bookings',
      undefined,
      qp,
    );
    return resp.bookings ?? [];
  }

  async getBooking(bookingId: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/bookings/${bookingId}`);
  }

  async cancelBooking(bookingId: number): Promise<void> {
    await this.request<void>('DELETE', `/bookings/${bookingId}`);
  }

  async listSchedules(): Promise<unknown[]> {
    const resp = await this.request<{ schedules: unknown[] }>('GET', '/schedules');
    return resp.schedules ?? [];
  }

  async listTeamMembers(take: number = 50): Promise<unknown[]> {
    const resp = await this.request<{ users: unknown[] }>(
      'GET',
      '/users',
      undefined,
      { take: String(Math.min(take, 100)) },
    );
    return resp.users ?? [];
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Cal.com read', { entityType, entityId });

    switch (entityType) {
      case 'profile': {
        const data = await this.getProfile();
        return { id: 'me', data };
      }

      case 'event_types': {
        const data = await this.listEventTypes();
        return { id: 'event_types', data: { event_types: data } };
      }

      case 'event_type': {
        if (!entityId) throw new Error('Cal.com: event_type read requires entityId');
        const data = await this.getEventType(Number(entityId));
        return { id: entityId, data };
      }

      case 'bookings': {
        const data = await this.listBookings({
          status: payload?.status as string | undefined,
          take: payload?.take as number | undefined,
        });
        return { id: 'bookings', data: { bookings: data } };
      }

      case 'booking': {
        if (!entityId) throw new Error('Cal.com: booking read requires entityId');
        const data = await this.getBooking(Number(entityId));
        return { id: entityId, data };
      }

      case 'schedules': {
        const data = await this.listSchedules();
        return { id: 'schedules', data: { schedules: data } };
      }

      case 'team_members': {
        const data = await this.listTeamMembers(payload?.take as number | undefined);
        return { id: 'members', data: { members: data } };
      }

      default:
        throw new Error(`Cal.com: unsupported read entity type "${entityType}"`);
    }
  }

  /** Enumerate the things a Cal.com account holds. The four enumerators below
   *  already existed; `list` simply never reached them, so a caller asking what
   *  this account contains was told "nothing" rather than being served. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const rows = (data: unknown[]) =>
      data.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r.id ?? r.uid ?? ''), data: r };
      });

    switch (entityType) {
      case 'event_type':
      case 'event_types':
        return { records: rows(await this.listEventTypes()), hasMore: false };

      case 'booking':
      case 'bookings':
        return {
          records: rows(await this.listBookings({ take: filters?.limit ?? 100 })),
          hasMore: false,
        };

      case 'schedule':
      case 'schedules':
        return { records: rows(await this.listSchedules()), hasMore: false };

      case 'team_member':
      case 'team_members':
        return {
          records: rows(await this.listTeamMembers(filters?.limit ?? 50)),
          hasMore: false,
        };

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }

  async create(
    _entityType: string,
    _data: Record<string, any>,
  ): Promise<CreateResult> {
    return { success: false, id: '', error: 'Cal.com: create operations not supported via this client' };
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Cal.com update', { entityType, entityId });

    try {
      if (entityType === 'event_type') {
        if (!entityId) {
          return { success: false, error: 'Cal.com: event_type update requires entityId' };
        }
        const result = await this.updateEventType(Number(entityId), {
          title: data.title as string | undefined,
          description: data.description as string | undefined,
          length: data.length as number | undefined,
          hidden: data.hidden as boolean | undefined,
          slotInterval: data.slotInterval as number | undefined,
        });
        return { success: true, data: result };
      }

      return { success: false, error: `Cal.com: unsupported update entity type "${entityType}"` };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Cal.com delete (cancel)', { entityType, entityId });

    try {
      if (entityType === 'booking') {
        if (!entityId) {
          return { success: false, error: 'Cal.com: booking cancel requires entityId' };
        }
        await this.cancelBooking(Number(entityId));
        return { success: true };
      }

      return { success: false, error: `Cal.com: unsupported delete entity type "${entityType}"` };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(
    _entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    return { success: false, error: 'Cal.com: restore not supported — cancelled bookings cannot be un-cancelled' };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    return {
      success: false,
      error: `Cal.com: cannot invert "${originalAction}" on entity type "${entityType}"`,
    };
  }
}
