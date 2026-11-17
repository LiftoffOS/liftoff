// Square Connector Client
// Auth: OAuth2 Bearer token
// Base URL: https://connect.squareup.com/v2
// Required header: Square-Version: 2024-01-17

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
import { bearerFor } from './composio-transport.js';
import { logger } from '../infra/logging.js';
import { randomUUID } from 'crypto';

const SQUARE_BASE_URL = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-01-17';

export class SquareClient implements CompensationClient {
  readonly connector = 'square';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Internal request helper ───────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    let url = `${SQUARE_BASE_URL}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString();
      url = `${url}?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'square')}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Square API error', { status: response.status, error, path, method });
      throw new Error(`Square API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Locations ─────────────────────────────────────────────────────────────

  async listLocations(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/locations');
  }

  async getLocation(locationId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/locations/${locationId}`);
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  async searchOrders(params: {
    location_id: string;
    state?: string;
    created_after?: string;
    created_before?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      location_ids: [params.location_id],
      query: {
        filter: {
          ...(params.state
            ? { state_filter: { states: [params.state] } }
            : {}),
          ...(params.created_after || params.created_before
            ? {
                date_time_filter: {
                  created_at: {
                    ...(params.created_after ? { start_at: params.created_after } : {}),
                    ...(params.created_before ? { end_at: params.created_before } : {}),
                  },
                },
              }
            : {}),
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      limit: params.limit ?? 100,
      ...(params.cursor ? { cursor: params.cursor } : {}),
    };

    return this.request<Record<string, unknown>>('POST', '/orders/search', body);
  }

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/orders/${orderId}`);
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  async listPayments(params: {
    location_id: string;
    begin_time?: string;
    end_time?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Record<string, unknown>> {
    const queryParams: Record<string, string> = {
      location_id: params.location_id,
    };
    if (params.begin_time) queryParams.begin_time = params.begin_time;
    if (params.end_time) queryParams.end_time = params.end_time;
    if (params.limit) queryParams.limit = String(params.limit);
    if (params.cursor) queryParams.cursor = params.cursor;

    return this.request<Record<string, unknown>>('GET', '/payments', undefined, queryParams);
  }

  async getPayment(paymentId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/payments/${paymentId}`);
  }

  // ── Refunds ───────────────────────────────────────────────────────────────

  async createRefund(params: {
    payment_id: string;
    amount_cents: number;
    currency?: string;
    reason?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      idempotency_key: randomUUID(),
      payment_id: params.payment_id,
      amount_money: {
        amount: params.amount_cents,
        currency: params.currency ?? 'USD',
      },
      ...(params.reason ? { reason: params.reason } : {}),
    };

    return this.request<Record<string, unknown>>('POST', '/refunds', body);
  }

  // ── Customers ─────────────────────────────────────────────────────────────

  async listCustomers(params: { limit?: number; cursor?: string }): Promise<Record<string, unknown>> {
    const queryParams: Record<string, string> = {};
    if (params.limit) queryParams.limit = String(params.limit);
    if (params.cursor) queryParams.cursor = params.cursor;

    return this.request<Record<string, unknown>>('GET', '/customers', undefined, queryParams);
  }

  async getCustomer(customerId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/customers/${customerId}`);
  }

  async createCustomer(data: {
    given_name?: string;
    family_name?: string;
    email_address?: string;
    phone_number?: string;
    note?: string;
    reference_id?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (data.given_name) body.given_name = data.given_name;
    if (data.family_name) body.family_name = data.family_name;
    if (data.email_address) body.email_address = data.email_address;
    if (data.phone_number) body.phone_number = data.phone_number;
    if (data.note) body.note = data.note;
    if (data.reference_id) body.reference_id = data.reference_id;

    return this.request<Record<string, unknown>>('POST', '/customers', body);
  }

  async updateCustomer(
    customerId: string,
    data: {
      given_name?: string;
      family_name?: string;
      email_address?: string;
      phone_number?: string;
    },
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (data.given_name) body.given_name = data.given_name;
    if (data.family_name) body.family_name = data.family_name;
    if (data.email_address) body.email_address = data.email_address;
    if (data.phone_number) body.phone_number = data.phone_number;

    return this.request<Record<string, unknown>>('PUT', `/customers/${customerId}`, body);
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  async listCatalogItems(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/catalog/list', undefined, {
      types: 'ITEM,ITEM_VARIATION,CATEGORY',
    });
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Square read', { entityType, entityId });

    switch (entityType) {
      case 'location': {
        if (entityId) {
          const data = await this.getLocation(entityId);
          return { id: entityId, data };
        }
        const data = await this.listLocations();
        return { id: 'locations', data };
      }

      case 'locations': {
        const data = await this.listLocations();
        return { id: 'locations', data };
      }

      case 'order': {
        if (!entityId) throw new Error('Square: get_order requires order_id');
        const data = await this.getOrder(entityId);
        return { id: entityId, data };
      }

      case 'orders': {
        const locationId = payload?.location_id as string;
        if (!locationId) throw new Error('Square: search_orders requires location_id');
        const data = await this.searchOrders({
          location_id: locationId,
          state: payload?.state as string | undefined,
          created_after: payload?.created_after as string | undefined,
          created_before: payload?.created_before as string | undefined,
          limit: payload?.limit as number | undefined,
          cursor: payload?.cursor as string | undefined,
        });
        return { id: 'orders', data };
      }

      case 'payment': {
        if (!entityId) throw new Error('Square: get_payment requires payment_id');
        const data = await this.getPayment(entityId);
        return { id: entityId, data };
      }

      case 'payments': {
        const locationId = payload?.location_id as string;
        if (!locationId) throw new Error('Square: list_payments requires location_id');
        const data = await this.listPayments({
          location_id: locationId,
          begin_time: payload?.begin_time as string | undefined,
          end_time: payload?.end_time as string | undefined,
          limit: payload?.limit as number | undefined,
          cursor: payload?.cursor as string | undefined,
        });
        return { id: 'payments', data };
      }

      case 'customer': {
        if (!entityId) throw new Error('Square: get_customer requires customer_id');
        const data = await this.getCustomer(entityId);
        return { id: entityId, data };
      }

      case 'customers': {
        const data = await this.listCustomers({
          limit: payload?.limit as number | undefined,
          cursor: payload?.cursor as string | undefined,
        });
        return { id: 'customers', data };
      }

      case 'catalog_items': {
        const data = await this.listCatalogItems();
        return { id: 'catalog', data };
      }

      default:
        throw new Error(`Square: unsupported read entity type "${entityType}"`);
    }
  }

  /** Enumerate a Square account.
   *
   *  Payments and orders are per-location, so they need `filters.folderId` to
   *  carry the location id. Absent that this returns empty WITHOUT the
   *  unsupported marker: the client can enumerate them, the request just did
   *  not say where. Callers discover locations by listing 'location' first. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const f = filters as Record<string, unknown> | undefined;
    const locationId = f?.folderId as string | undefined;
    // Square wraps every collection in a named envelope and returns a `cursor`
    // for the next page, so unwrap by key rather than expecting a bare array.
    const rows = (envelope: Record<string, unknown>, key: string): ListResult => {
      const data = (envelope[key] as unknown[] | undefined) ?? [];
      const cursor = envelope.cursor as string | undefined;
      return {
        records: data.map(row => {
          const r = row as Record<string, any>;
          return { id: String(r.id ?? ''), data: r };
        }),
        hasMore: !!cursor,
        nextPageToken: cursor,
      };
    };

    switch (entityType) {
      case 'location':
      case 'locations':
        return rows(await this.listLocations(), 'locations');

      case 'customer':
      case 'customers':
        return rows(
          await this.listCustomers({
            limit: filters?.limit ?? 100,
            cursor: filters?.pageToken,
          }),
          'customers',
        );

      case 'catalog_item':
      case 'catalog_items':
        return rows(await this.listCatalogItems(), 'objects');

      case 'payment':
      case 'payments':
        if (!locationId) return { records: [], hasMore: false };
        return rows(await this.listPayments({ location_id: locationId }), 'payments');

      case 'order':
      case 'orders':
        if (!locationId) return { records: [], hasMore: false };
        return rows(await this.searchOrders({ location_id: locationId }), 'orders');

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Square create', { entityType });

    try {
      switch (entityType) {
        case 'customer': {
          const result = await this.createCustomer(data);
          const customer = (result as any).customer ?? result;
          return {
            success: true,
            id: String(customer.id ?? ''),
            data: result as Record<string, unknown>,
          };
        }

        case 'refund': {
          const result = await this.createRefund({
            payment_id: data.payment_id as string,
            amount_cents: data.amount_cents as number,
            currency: data.currency as string | undefined,
            reason: data.reason as string | undefined,
          });
          const refund = (result as any).refund ?? result;
          return {
            success: true,
            id: String(refund.id ?? ''),
            data: result as Record<string, unknown>,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Square: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Square update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'customer': {
          if (!entityId) {
            return { success: false, error: 'Square: update_customer requires customer_id' };
          }
          const result = await this.updateCustomer(entityId, {
            given_name: data.given_name as string | undefined,
            family_name: data.family_name as string | undefined,
            email_address: data.email_address as string | undefined,
            phone_number: data.phone_number as string | undefined,
          });
          return { success: true, data: result as Record<string, unknown> };
        }

        default:
          return {
            success: false,
            error: `Square: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Square delete', { entityType, entityId });
    return {
      success: false,
      error: `Square: delete not supported for entity type "${entityType}"`,
    };
  }

  async restore(
    _entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    return { success: false, error: 'Square: restore from snapshot not supported' };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Square semantic inverse', { entityType, originalAction, entityId });
    return {
      success: false,
      error: `Square: semantic inverse not supported for action "${originalAction}" on "${entityType}"`,
    };
  }
}
