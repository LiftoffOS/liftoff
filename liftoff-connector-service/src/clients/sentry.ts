// Sentry Connector Client (reactive polling)
//
// Sentry's hosted MCP (mcp.sentry.dev) is OAuth-gated and its issue search is
// LLM-backed, so it can't serve the deterministic enumeration the polling
// scheduler needs. Instead we poll Sentry's documented REST Issues API
// (https://sentry.io/api/0/organizations/{org}/issues/) with the connector's
// stored api_key (Bearer). The org slug is resolved at runtime from
// GET /api/0/organizations/ (first org), mirroring how the Asana client
// resolves its default workspace. Incremental sync uses the `lastSeen:>=`
// search filter; pagination follows Sentry's cursor in the Link header.
//
// Only list() is implemented — agent tool calls on Sentry go through the
// self-describing tool-gateway path, not this structured client.

import {
  CompensationClient, CredentialProvider, ExternalRecord, CreateResult,
  UpdateResult, DeleteResult, ListFilters, ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';

export class SentryClient implements CompensationClient {
  readonly connector = 'sentry';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://sentry.io/api/0';
  private orgSlug?: string;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async token(): Promise<string> {
    const creds = await this.credentialProvider();
    return creds.accessToken ?? '';
  }

  private async resolveOrgSlug(token: string): Promise<string | undefined> {
    if (this.orgSlug) return this.orgSlug;
    const res = await fetch(`${this.baseUrl}/organizations/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Sentry organizations API ${res.status}: ${await res.text()}`);
    const orgs = (await res.json()) as Array<{ slug?: string }>;
    this.orgSlug = orgs?.[0]?.slug;
    return this.orgSlug;
  }

  // Sentry paginates via the Link header: `<url>; rel="next"; results="true"; cursor="..."`.
  private nextCursor(linkHeader: string | null): string | undefined {
    if (!linkHeader) return undefined;
    for (const part of linkHeader.split(',')) {
      if (/rel="next"/.test(part) && /results="true"/.test(part)) {
        const m = part.match(/cursor="([^"]+)"/);
        if (m) return m[1];
      }
    }
    return undefined;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Issue') return { records: [], hasMore: false, unsupported: true };
    const token = await this.token();
    const org = await this.resolveOrgSlug(token);
    if (!org) {
      logger.warn('Sentry list: no organization resolved for token');
      return { records: [], hasMore: false };
    }

    // `lastSeen:>=` gives incremental "recently active" detection; sort by date
    // (last seen) so newest activity comes first.
    const query = filters?.since instanceof Date ? `lastSeen:>=${filters.since.toISOString()}` : '';
    const params = new URLSearchParams({ sort: 'date', limit: String(filters?.limit ?? 100) });
    if (query) params.set('query', query);
    if (filters?.pageToken) params.set('cursor', filters.pageToken);

    const res = await fetch(`${this.baseUrl}/organizations/${org}/issues/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Sentry issues API ${res.status}: ${await res.text()}`);
    const issues = (await res.json()) as Array<Record<string, unknown>>;
    const records = (issues ?? []).map(i => ({ id: String(i.id ?? ''), data: i }));
    const nextPageToken = this.nextCursor(res.headers.get('link'));
    return { records, nextPageToken, hasMore: !!nextPageToken };
  }

  // Reactive uses list() only; structured write/compensation isn't routed here.
  async read(): Promise<ExternalRecord> {
    throw new Error('SentryClient supports list() only (reactive polling)');
  }
  async create(): Promise<CreateResult> {
    return { success: false, id: '', error: 'sentry read-only via polling' };
  }
  async update(): Promise<UpdateResult> {
    return { success: false, error: 'sentry read-only via polling' };
  }
  async delete(): Promise<DeleteResult> {
    return { success: false, error: 'sentry read-only via polling' };
  }
  async restore(): Promise<UpdateResult> {
    return { success: false, error: 'not supported' };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
