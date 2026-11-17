// WooCommerce Connector Client
// Auth: HTTP Basic with consumer_key:consumer_secret
//   consumer_key  → stored as credentials.accessToken
//   consumer_secret → stored as credentials.refreshToken (pragmatic reuse — doesn't rotate)
//   store_url     → stored as credentials.instanceUrl
// Base URL: https://{store_url}/wp-json/wc/v3

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

export class WooCommerceClient implements CompensationClient {
  readonly connector = 'woocommerce';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── HTTP request helper ───────────────────────────────────────────────────

  private buildAuthHeader(consumerKey: string, consumerSecret: string): string {
    const encoded = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    return `Basic ${encoded}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const storeUrl = credentials.instanceUrl;
    if (!storeUrl) {
      throw new Error('WooCommerce credential missing store URL (instanceUrl)');
    }
    const consumerKey = credentials.accessToken;
    const consumerSecret = credentials.refreshToken;
    if (!consumerSecret) {
      throw new Error('WooCommerce credential missing consumer_secret (refreshToken)');
    }

    // Normalize store URL — strip trailing slash
    const normalizedUrl = storeUrl.replace(/\/$/, '');
    const baseUrl = `${normalizedUrl}/wp-json/wc/v3`;

    let url = `${baseUrl}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString();
      url = `${url}?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.buildAuthHeader(consumerKey, consumerSecret),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('WooCommerce API error', { status: response.status, error, path, method });
      throw new Error(`WooCommerce API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── WooCommerce API operations ────────────────────────────────────────────

  // Orders

  async listOrders(params: {
    status?: string;
    perPage?: number;
    page?: number;
  } = {}): Promise<unknown[]> {
    return this.request<unknown[]>(
      'GET',
      '/orders',
      undefined,
      {
        status: params.status ?? 'any',
        per_page: String(Math.min(params.perPage ?? 50, 100)),
        page: String(params.page ?? 1),
      },
    );
  }

  async getOrder(orderId: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/orders/${orderId}`);
  }

  async updateOrder(
    orderId: number,
    data: { status?: string; customer_note?: string },
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PUT', `/orders/${orderId}`, data as Record<string, unknown>);
  }

  // Products

  async listProducts(params: {
    perPage?: number;
    page?: number;
    status?: string;
  } = {}): Promise<unknown[]> {
    return this.request<unknown[]>(
      'GET',
      '/products',
      undefined,
      {
        per_page: String(Math.min(params.perPage ?? 50, 100)),
        page: String(params.page ?? 1),
        status: params.status ?? 'publish',
      },
    );
  }

  async getProduct(productId: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/products/${productId}`);
  }

  async createProduct(data: {
    name: string;
    regular_price: string;
    type?: string;
    description?: string;
    short_description?: string;
    stock_quantity?: number;
    manage_stock?: boolean;
    categories?: Array<{ id: number }>;
    images?: Array<{ src: string }>;
  }): Promise<Record<string, unknown>> {
    const body = {
      type: 'simple',
      ...data,
    };
    return this.request<Record<string, unknown>>('POST', '/products', body as Record<string, unknown>);
  }

  async updateProduct(
    productId: number,
    data: {
      name?: string;
      regular_price?: string;
      stock_quantity?: number;
      manage_stock?: boolean;
      status?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('PUT', `/products/${productId}`, data as Record<string, unknown>);
  }

  async deleteProduct(productId: number): Promise<void> {
    await this.request<void>('DELETE', `/products/${productId}`, undefined, { force: 'true' });
  }

  // Customers

  async listCustomers(params: {
    perPage?: number;
    page?: number;
  } = {}): Promise<unknown[]> {
    return this.request<unknown[]>(
      'GET',
      '/customers',
      undefined,
      {
        per_page: String(Math.min(params.perPage ?? 50, 100)),
        page: String(params.page ?? 1),
      },
    );
  }

  async getCustomer(customerId: number): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/customers/${customerId}`);
  }

  async createOrder(data: Record<string, unknown>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/orders', data as Record<string, unknown>);
  }

  async createCustomer(data: Record<string, unknown>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('POST', '/customers', data as Record<string, unknown>);
  }

  async updateCustomer(customerId: number, data: Record<string, unknown>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('PUT', `/customers/${customerId}`, data);
  }

  // Categories

  async listCategories(): Promise<unknown[]> {
    return this.request<unknown[]>('GET', '/products/categories', undefined, { per_page: '100' });
  }

  // Reports

  async getSalesReport(params: {
    period?: string;
    dateMin?: string;
    dateMax?: string;
  } = {}): Promise<unknown[]> {
    const qp: Record<string, string> = {
      period: params.period ?? 'week',
    };
    if (params.dateMin) qp.date_min = params.dateMin;
    if (params.dateMax) qp.date_max = params.dateMax;

    return this.request<unknown[]>('GET', '/reports/sales', undefined, qp);
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('WooCommerce read', { entityType, entityId });

    switch (entityType) {
      case 'orders': {
        const data = await this.listOrders({
          status: payload?.status as string | undefined,
          perPage: payload?.per_page as number | undefined,
          page: payload?.page as number | undefined,
        });
        return { id: 'orders', data: { orders: data } };
      }

      case 'order': {
        if (!entityId) throw new Error('WooCommerce: order read requires entityId');
        const data = await this.getOrder(Number(entityId));
        return { id: entityId, data };
      }

      case 'products': {
        const data = await this.listProducts({
          perPage: payload?.per_page as number | undefined,
          page: payload?.page as number | undefined,
          status: payload?.status as string | undefined,
        });
        return { id: 'products', data: { products: data } };
      }

      case 'product': {
        if (!entityId) throw new Error('WooCommerce: product read requires entityId');
        const data = await this.getProduct(Number(entityId));
        return { id: entityId, data };
      }

      case 'customers': {
        const data = await this.listCustomers({
          perPage: payload?.per_page as number | undefined,
          page: payload?.page as number | undefined,
        });
        return { id: 'customers', data: { customers: data } };
      }

      case 'customer': {
        if (!entityId) throw new Error('WooCommerce: customer read requires entityId');
        const data = await this.getCustomer(Number(entityId));
        return { id: entityId, data };
      }

      case 'categories': {
        const data = await this.listCategories();
        return { id: 'categories', data: { categories: data } };
      }

      case 'sales_report': {
        const data = await this.getSalesReport({
          period: payload?.period as string | undefined,
          dateMin: payload?.date_min as string | undefined,
          dateMax: payload?.date_max as string | undefined,
        });
        return { id: 'sales_report', data: { report: data } };
      }

      default:
        throw new Error(`WooCommerce: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * list('Order', { since }) — incremental pull of orders for reactive polling.
   *
   * Reactive WooCommerce uses native polling (no Composio; the connector is an
   * api_key sidecar). The WC REST `modified_after` filter + ascending modified
   * order gives new AND updated orders since the last sync. WC returns a bare
   * array (pagination via response headers we don't surface), so hasMore is the
   * standard full-page heuristic: a full page implies another may exist.
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Order') return { records: [], hasMore: false, unsupported: true };

    const perPage = Math.min(filters?.limit ?? 100, 100);
    const page = filters?.pageToken ? parseInt(filters.pageToken, 10) || 1 : 1;
    const query: Record<string, string> = {
      status: 'any',
      per_page: String(perPage),
      page: String(page),
      orderby: 'modified',
      order: 'asc',
    };
    if (filters?.since) query.modified_after = filters.since.toISOString();

    const orders = await this.request<Array<Record<string, unknown>>>(
      'GET',
      '/orders',
      undefined,
      query,
    );
    const arr = Array.isArray(orders) ? orders : [];
    const hasMore = arr.length === perPage;

    return {
      records: arr
        .filter((o) => o.id !== undefined && o.id !== null)
        .map((o) => ({ id: String(o.id), data: o })),
      nextPageToken: hasMore ? String(page + 1) : undefined,
      hasMore,
    };
  }

  async create(
    entityType: string,
    data: Record<string, any>,
  ): Promise<CreateResult> {
    logger.info('WooCommerce create', { entityType });

    try {
      if (entityType === 'product') {
        const result = await this.createProduct({
          name: data.name as string,
          regular_price: data.regular_price as string,
          description: data.description as string | undefined,
          short_description: data.short_description as string | undefined,
          stock_quantity: data.stock_quantity as number | undefined,
          manage_stock: data.manage_stock as boolean | undefined,
        });
        const id = String((result as Record<string, any>).id ?? '');
        return { success: true, id, data: result };
      }

      if (entityType === 'order') {
        const result = await this.createOrder(data as Record<string, unknown>);
        const id = String((result as Record<string, any>).id ?? '');
        return { success: true, id, data: result };
      }

      if (entityType === 'customer') {
        const result = await this.createCustomer(data as Record<string, unknown>);
        const id = String((result as Record<string, any>).id ?? '');
        return { success: true, id, data: result };
      }

      return {
        success: false,
        id: '',
        error: `WooCommerce: unsupported create entity type "${entityType}"`,
      };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('WooCommerce update', { entityType, entityId });

    try {
      if (entityType === 'order') {
        if (!entityId) {
          return { success: false, error: 'WooCommerce: order update requires entityId' };
        }
        const result = await this.updateOrder(Number(entityId), {
          status: data.status as string | undefined,
          customer_note: data.customer_note as string | undefined,
        });
        return { success: true, data: result };
      }

      if (entityType === 'product') {
        if (!entityId) {
          return { success: false, error: 'WooCommerce: product update requires entityId' };
        }
        const result = await this.updateProduct(Number(entityId), {
          name: data.name as string | undefined,
          regular_price: data.regular_price as string | undefined,
          stock_quantity: data.stock_quantity as number | undefined,
          manage_stock: data.manage_stock as boolean | undefined,
          status: data.status as string | undefined,
        });
        return { success: true, data: result };
      }

      if (entityType === 'customer') {
        if (!entityId) {
          return { success: false, error: 'WooCommerce: customer update requires entityId' };
        }
        const result = await this.updateCustomer(Number(entityId), data as Record<string, unknown>);
        return { success: true, data: result };
      }

      return {
        success: false,
        error: `WooCommerce: unsupported update entity type "${entityType}"`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('WooCommerce delete', { entityType, entityId });

    try {
      if (entityType === 'product') {
        if (!entityId) {
          return { success: false, error: 'WooCommerce: product delete requires entityId' };
        }
        await this.deleteProduct(Number(entityId));
        return { success: true };
      }

      return {
        success: false,
        error: `WooCommerce: unsupported delete entity type "${entityType}"`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(
    _entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    return { success: false, error: 'WooCommerce: restore requires pre-action snapshot and manual re-creation' };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create' && entityType === 'product') {
      return this.delete('product', entityId);
    }

    return {
      success: false,
      error: `WooCommerce: cannot invert "${originalAction}" on entity type "${entityType}"`,
    };
  }
}
