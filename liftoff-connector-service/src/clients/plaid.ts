// Plaid Connector Client
// Read-only financial data client. Plaid is an analytics/data product —
// it surfaces bank account data but cannot initiate mutations on the user's
// behalf. All write operations throw a structured "read-only" error.
//
// Auth: body-based — client_id + secret + access_token go in the POST body,
// NOT as a Bearer token. See mcp-servers/plaid/API_REFERENCE.md for details.

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

// Plaid environments
type PlaidEnv = 'sandbox' | 'production';

function getPlaidBaseUrl(env: PlaidEnv): string {
  return env === 'sandbox'
    ? 'https://sandbox.plaid.com'
    : 'https://production.plaid.com';
}

// Plaid app-level credentials (developer account, not user tokens).
// These are distinct from the per-user access_token stored in the credential store.
export interface PlaidAppCredentials {
  clientId: string;
  secret: string;
}

function getPlaidAppCredentials(): PlaidAppCredentials {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set');
  }
  return { clientId, secret };
}

// Raw Plaid API error shape
interface PlaidApiError {
  error_type: string;
  error_code: string;
  error_message: string;
  display_message: string | null;
  request_id?: string;
}

export class PlaidClient implements CompensationClient {
  readonly connector = 'plaid';
  private credentialProvider: CredentialProvider;
  private env: PlaidEnv;

  constructor(credentialProvider: CredentialProvider, env: PlaidEnv = 'sandbox') {
    this.credentialProvider = credentialProvider;
    this.env = env;
  }

  // ── Internal POST helper ─────────────────────────────────────────────────

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    // Fetch fresh user credentials on every request — never cache.
    // access_token is long-lived but can be revoked; always go through the provider.
    const credentials = await this.credentialProvider();
    const appCreds = getPlaidAppCredentials();

    const baseUrl = getPlaidBaseUrl(this.env);
    const url = `${baseUrl}${endpoint}`;

    // Plaid body-auth: client_id + secret in the POST body.
    // access_token (the user's bank connection token) also goes in the body.
    const requestBody = {
      client_id: appCreds.clientId,
      secret: appCreds.secret,
      access_token: credentials.accessToken,
      ...body,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorMessage = `Plaid API error: HTTP ${response.status}`;
      try {
        const apiError = await response.json() as PlaidApiError;
        errorMessage = `Plaid API error [${apiError.error_code}]: ${apiError.error_message}`;
        logger.error('Plaid API error', {
          endpoint,
          errorCode: apiError.error_code,
          errorType: apiError.error_type,
          errorMessage: apiError.error_message,
          requestId: apiError.request_id,
        });
      } catch {
        logger.error('Plaid API error (non-JSON response)', {
          endpoint,
          status: response.status,
        });
      }
      throw new Error(errorMessage);
    }

    return response.json() as Promise<T>;
  }

  // ── Public data methods ──────────────────────────────────────────────────

  /**
   * Get all accounts for the connected Item (bank connection).
   * Returns cached balance data. For real-time balances use getBalance().
   */
  async getAccounts(options?: { account_ids?: string[] }): Promise<ExternalRecord> {
    logger.info('Plaid getAccounts');

    const body: Record<string, unknown> = {};
    if (options?.account_ids && options.account_ids.length > 0) {
      body.options = { account_ids: options.account_ids };
    }

    const data = await this.post<Record<string, unknown>>('/accounts/get', body);

    return {
      id: 'accounts',
      data,
      lastModified: new Date(),
    };
  }

  /**
   * Get transaction history for a date range.
   * start_date and end_date must be in YYYY-MM-DD format.
   */
  async getTransactions(
    startDate: string,
    endDate: string,
    options?: { account_ids?: string[]; count?: number; offset?: number }
  ): Promise<ExternalRecord> {
    logger.info('Plaid getTransactions', { startDate, endDate });

    const plaidOptions: Record<string, unknown> = {};
    if (options?.account_ids && options.account_ids.length > 0) {
      plaidOptions.account_ids = options.account_ids;
    }
    if (options?.count !== undefined) {
      plaidOptions.count = options.count;
    }
    if (options?.offset !== undefined) {
      plaidOptions.offset = options.offset;
    }

    const body: Record<string, unknown> = {
      start_date: startDate,
      end_date: endDate,
    };
    if (Object.keys(plaidOptions).length > 0) {
      body.options = plaidOptions;
    }

    const data = await this.post<Record<string, unknown>>('/transactions/get', body);

    return {
      id: `transactions:${startDate}:${endDate}`,
      data,
      lastModified: new Date(),
    };
  }

  /**
   * Get real-time balance for accounts. Forces a refresh — not cached.
   */
  async getBalance(options?: { account_ids?: string[] }): Promise<ExternalRecord> {
    logger.info('Plaid getBalance');

    const body: Record<string, unknown> = {};
    if (options?.account_ids && options.account_ids.length > 0) {
      body.options = { account_ids: options.account_ids };
    }

    const data = await this.post<Record<string, unknown>>('/accounts/balance/get', body);

    return {
      id: 'balance',
      data,
      lastModified: new Date(),
    };
  }

  /**
   * Get identity information for account holders (name, address, email, phone).
   */
  async getIdentity(): Promise<ExternalRecord> {
    logger.info('Plaid getIdentity');

    const data = await this.post<Record<string, unknown>>('/identity/get', {});

    return {
      id: 'identity',
      data,
      lastModified: new Date(),
    };
  }

  /**
   * Get liability data (student loans, credit cards, mortgages).
   * Requires the Liabilities product to have been enabled during Plaid Link.
   */
  async getLiabilities(options?: { account_ids?: string[] }): Promise<ExternalRecord> {
    logger.info('Plaid getLiabilities');

    const body: Record<string, unknown> = {};
    if (options?.account_ids && options.account_ids.length > 0) {
      body.options = { account_ids: options.account_ids };
    }

    const data = await this.post<Record<string, unknown>>('/liabilities/get', body);

    return {
      id: 'liabilities',
      data,
      lastModified: new Date(),
    };
  }

  // ── ConnectorClient interface ─────────────────────────────────────────────

  async read(entityType: string, _entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    switch (entityType) {
      case 'accounts':
        return this.getAccounts(payload as { account_ids?: string[] });

      case 'transactions': {
        const startDate = payload?.start_date as string;
        const endDate = payload?.end_date as string;
        if (!startDate || !endDate) {
          throw new Error('Plaid transactions require start_date and end_date');
        }
        return this.getTransactions(startDate, endDate, payload as { account_ids?: string[]; count?: number; offset?: number });
      }

      case 'balance':
        return this.getBalance(payload as { account_ids?: string[] });

      case 'identity':
        return this.getIdentity();

      case 'liabilities':
        return this.getLiabilities(payload as { account_ids?: string[] });

      default:
        throw new Error(`Plaid: unsupported entity type: ${entityType}`);
    }
  }

  // ── Write operations — Plaid is read-only ────────────────────────────────

  private readOnlyError(operation: string): never {
    throw new Error(`Plaid is read-only: ${operation} is not supported`);
  }

  /** Enumerate accounts, transactions or liabilities.
   *
   *  Transactions need a date range; `filters.since` supplies the lower bound
   *  and defaults to 30 days back, matching how the other date-ranged clients
   *  here behave. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const rows = (data: unknown[], idKey: string) =>
      data.map(row => {
        const r = row as Record<string, any>;
        return { id: String(r[idKey] ?? ''), data: r };
      });

    switch (entityType) {
      case 'account':
      case 'accounts': {
        const result = await this.getAccounts() as Record<string, any>;
        return { records: rows(result.accounts ?? [], 'account_id'), hasMore: false };
      }

      case 'transaction':
      case 'transactions': {
        const end = new Date();
        const start = filters?.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        const result = await this.getTransactions(iso(start), iso(end)) as Record<string, any>;
        return {
          records: rows(result.transactions ?? [], 'transaction_id'),
          hasMore: false,
        };
      }

      case 'liability':
      case 'liabilities': {
        const result = await this.getLiabilities() as Record<string, any>;
        return { records: rows(result.accounts ?? [], 'account_id'), hasMore: false };
      }

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }

  async create(_entityType: string, _data: Record<string, any>): Promise<CreateResult> {
    this.readOnlyError('create');
  }

  async update(_entityType: string, _entityId: string | undefined, _data: Record<string, any>): Promise<UpdateResult> {
    this.readOnlyError('update');
  }

  async delete(_entityType: string, _entityId: string | undefined, _payload?: Record<string, any>): Promise<DeleteResult> {
    this.readOnlyError('delete');
  }

  async restore(_entityType: string, _entityId: string | undefined, _snapshot: Record<string, any>): Promise<UpdateResult> {
    this.readOnlyError('restore');
  }

  async semanticInverse(
    _entityType: string,
    _originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    this.readOnlyError('semanticInverse');
  }
}
