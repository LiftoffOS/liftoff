// PayPal Connector Client
// Auth: OAuth2 client_credentials (machine-to-machine, no refresh_token)
// Base URL: https://api-m.paypal.com
// Access tokens expire in ~9 hours; re-request using client_id + client_secret.

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

const PAYPAL_BASE_URL = 'https://api-m.paypal.com';

export class PayPalClient implements CompensationClient {
  readonly connector = 'paypal';
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

    let url = `${PAYPAL_BASE_URL}${path}`;
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
      logger.error('PayPal API error', { status: response.status, error, path, method });
      throw new Error(`PayPal API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  async listTransactions(params: {
    start_date: string;
    end_date: string;
    page_size?: number;
    page?: number;
  }): Promise<Record<string, unknown>> {
    const queryParams: Record<string, string> = {
      start_date: params.start_date,
      end_date: params.end_date,
      fields: 'all',
      page_size: String(params.page_size ?? 100),
      page: String(params.page ?? 1),
    };

    return this.request<Record<string, unknown>>(
      'GET',
      '/v1/reporting/transactions',
      undefined,
      queryParams,
    );
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/v2/checkout/orders/${orderId}`);
  }

  // ── Captures / Refunds ────────────────────────────────────────────────────

  async getCapture(captureId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v2/payments/captures/${captureId}`,
    );
  }

  async refundPayment(params: {
    capture_id: string;
    amount?: string;
    currency_code?: string;
    note_to_payer?: string;
  }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};

    if (params.amount) {
      body.amount = {
        value: params.amount,
        currency_code: params.currency_code ?? 'USD',
      };
    }

    if (params.note_to_payer) {
      body.note_to_payer = params.note_to_payer;
    }

    return this.request<Record<string, unknown>>(
      'POST',
      `/v2/payments/captures/${params.capture_id}/refund`,
      body,
    );
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  async listInvoices(params: {
    page_size?: number;
    page?: number;
  }): Promise<Record<string, unknown>> {
    const queryParams: Record<string, string> = {
      page: String(params.page ?? 1),
      page_size: String(params.page_size ?? 20),
      total_count_required: 'true',
    };

    return this.request<Record<string, unknown>>(
      'GET',
      '/v1/invoicing/invoices',
      undefined,
      queryParams,
    );
  }

  async getInvoice(invoiceId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v1/invoicing/invoices/${invoiceId}`,
    );
  }

  async createInvoice(params: {
    merchant_email: string;
    merchant_first_name?: string;
    merchant_last_name?: string;
    merchant_business_name?: string;
    billing_email: string;
    items: Array<{ name: string; quantity: number | string; unit_price_value: string }>;
    currency_code?: string;
    note?: string;
  }): Promise<Record<string, unknown>> {
    const currency = params.currency_code ?? 'USD';
    const body: Record<string, unknown> = {
      merchant_info: {
        email: params.merchant_email,
        first_name: params.merchant_first_name ?? '',
        last_name: params.merchant_last_name ?? '',
        ...(params.merchant_business_name
          ? { business_name: params.merchant_business_name }
          : {}),
      },
      billing_info: [{ email: params.billing_email }],
      items: params.items.map((item) => ({
        name: item.name,
        quantity: String(item.quantity),
        unit_price: { value: item.unit_price_value, currency },
      })),
      payment_term: { term_type: 'NET_30' },
      ...(params.note ? { note: params.note } : {}),
    };

    return this.request<Record<string, unknown>>('POST', '/v1/invoicing/invoices', body);
  }

  async sendInvoice(invoiceId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v1/invoicing/invoices/${invoiceId}/send`,
      {},
    );
  }

  // ── Disputes ──────────────────────────────────────────────────────────────

  async listDisputes(params: { page_size?: number }): Promise<Record<string, unknown>> {
    const queryParams: Record<string, string> = {
      page_size: String(params.page_size ?? 10),
    };

    return this.request<Record<string, unknown>>(
      'GET',
      '/v1/customer/disputes',
      undefined,
      queryParams,
    );
  }

  async getDispute(disputeId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'GET',
      `/v1/customer/disputes/${disputeId}`,
    );
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('PayPal read', { entityType, entityId });

    switch (entityType) {
      case 'transactions': {
        const startDate = payload?.start_date as string;
        const endDate = payload?.end_date as string;
        if (!startDate || !endDate) {
          throw new Error('PayPal: list_transactions requires start_date and end_date');
        }
        const data = await this.listTransactions({
          start_date: startDate,
          end_date: endDate,
          page_size: payload?.page_size as number | undefined,
          page: payload?.page as number | undefined,
        });
        return { id: 'transactions', data };
      }

      case 'order': {
        if (!entityId) throw new Error('PayPal: get_order requires order_id');
        const data = await this.getOrder(entityId);
        return { id: entityId, data };
      }

      case 'invoices': {
        const data = await this.listInvoices({
          page_size: payload?.page_size as number | undefined,
          page: payload?.page as number | undefined,
        });
        return { id: 'invoices', data };
      }

      case 'invoice': {
        if (!entityId) throw new Error('PayPal: get_invoice requires invoice_id');
        const data = await this.getInvoice(entityId);
        return { id: entityId, data };
      }

      case 'disputes': {
        const data = await this.listDisputes({
          page_size: payload?.page_size as number | undefined,
        });
        return { id: 'disputes', data };
      }

      case 'dispute': {
        if (!entityId) throw new Error('PayPal: get_dispute requires dispute_id');
        const data = await this.getDispute(entityId);
        return { id: entityId, data };
      }

      default:
        throw new Error(`PayPal: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * list('Payment', { since }) — incremental pull of payments for reactive polling.
   *
   * PayPal exposes no "modified since" payment list; the reactive source is the
   * Transaction Search reporting API:
   *   GET /v1/reporting/transactions?start_date=&end_date=&fields=all&page_size=&page=
   * It REQUIRES both start_date and end_date in RFC3339 (seconds mandatory) and
   * caps the window at 31 days. We map `since` → start_date and now → end_date,
   * clamping start_date forward to (now − 31d) when `since` is older so the API
   * accepts the request. Pagination is 1-based `page` / `total_pages`.
   */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Payment') return { records: [], hasMore: false, unsupported: true };

    const now = new Date();
    const endDate = now;
    // 31-day max window; clamp start forward if `since` is older (or absent).
    const earliestAllowed = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const requestedStart = filters?.since ?? earliestAllowed;
    const startDate = requestedStart < earliestAllowed ? earliestAllowed : requestedStart;

    const pageSize = Math.min(filters?.limit ?? 100, 500);
    const page = filters?.pageToken ? parseInt(filters.pageToken, 10) || 1 : 1;

    const response = await this.listTransactions({
      // RFC3339 with seconds — toISOString() yields e.g. 2026-06-26T00:00:00.000Z
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      page_size: pageSize,
      page,
    });

    const details = Array.isArray((response as any).transaction_details)
      ? ((response as any).transaction_details as Array<Record<string, any>>)
      : [];
    const totalPages = Number((response as any).total_pages ?? 1) || 1;
    const currentPage = Number((response as any).page ?? page) || page;
    const hasMore = currentPage < totalPages;

    return {
      records: details
        .filter((t) => t?.transaction_info?.transaction_id != null)
        .map((t) => ({
          id: String(t.transaction_info.transaction_id),
          data: t,
        })),
      nextPageToken: hasMore ? String(currentPage + 1) : undefined,
      hasMore,
    };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('PayPal create', { entityType });

    try {
      switch (entityType) {
        case 'refund': {
          const result = await this.refundPayment({
            capture_id: data.capture_id as string,
            amount: data.amount as string | undefined,
            currency_code: data.currency_code as string | undefined,
            note_to_payer: data.note_to_payer as string | undefined,
          });
          return {
            success: true,
            id: String((result as any).id ?? ''),
            data: result as Record<string, unknown>,
          };
        }

        case 'invoice': {
          const result = await this.createInvoice({
            merchant_email: data.merchant_email as string,
            merchant_first_name: data.merchant_first_name as string | undefined,
            merchant_last_name: data.merchant_last_name as string | undefined,
            merchant_business_name: data.merchant_business_name as string | undefined,
            billing_email: data.billing_email as string,
            items: data.items as Array<{
              name: string;
              quantity: number | string;
              unit_price_value: string;
            }>,
            currency_code: data.currency_code as string | undefined,
            note: data.note as string | undefined,
          });
          return {
            success: true,
            id: String((result as any).id ?? ''),
            data: result as Record<string, unknown>,
          };
        }

        case 'invoice_send': {
          if (!data.invoice_id) {
            return { success: false, id: '', error: 'PayPal: send_invoice requires invoice_id' };
          }
          const result = await this.sendInvoice(data.invoice_id as string);
          return {
            success: true,
            id: String(data.invoice_id),
            data: result as Record<string, unknown>,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `PayPal: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    _entityId: string | undefined,
    _data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('PayPal update', { entityType });
    return {
      success: false,
      error: `PayPal: update not supported for entity type "${entityType}"`,
    };
  }

  async delete(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('PayPal delete', { entityType });
    return {
      success: false,
      error: `PayPal: delete not supported for entity type "${entityType}"`,
    };
  }

  async restore(
    _entityType: string,
    _entityId: string | undefined,
    _snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    return { success: false, error: 'PayPal: restore from snapshot not supported' };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('PayPal semantic inverse', { entityType, originalAction });
    return {
      success: false,
      error: `PayPal: semantic inverse not supported for action "${originalAction}" on "${entityType}"`,
    };
  }
}
