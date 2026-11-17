// Rippling HRIS Connector Client (native, first-party).
//
// Base URL: https://rest.ripplingapis.com  (the current Rippling REST API — the
// legacy https://api.rippling.com/platform/api this client used to target is on a
// deprecation path and is NOT what the implementation plan / current docs specify).
// Auth: OAuth2 Bearer, token scoped to a single company tenant.
//
// Docs (developer.rippling.com/documentation/rest-api):
//   GET /workers[?expand=user,manager,legal_entity,employment_type,compensation,department]
//   GET /workers/{id}
//   GET /companies
//   GET /departments  ·  GET /departments/{id}
//   GET /users        ·  GET /users/{id}
//   GET /leave-requests
//   Query params: filter, expand (≤2 levels, ≤10 fields), limit, offset.
//   Writes are read-dominant on the REST API; create/update are attempted against
//   the resource and otherwise reachable via native_request.
//
// DORMANT: not registered as an executor, no RIPPLING_FUNCTIONS wired.
//
// entityType dispatch:
//   workers/worker, companies/company, departments/department, users/user,
//   leave_requests/leave_request, native (raw passthrough { method, path, body }).

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
import { isTemplatedEntity, templatedRead, templatedCreate, templatedUpdate, templatedDelete } from './templated-dispatch.js';

const RIPPLING_API_BASE = 'https://rest.ripplingapis.com';

// entityType → REST collection path segment.
const COLLECTION: Record<string, string> = {
  worker: 'workers', workers: 'workers',
  company: 'companies', companies: 'companies',
  department: 'departments', departments: 'departments',
  user: 'users', users: 'users',
  leave_request: 'leave-requests', leave_requests: 'leave-requests',
  employment: 'employments', employments: 'employments',
};

function collectionFor(entityType: string): string {
  return COLLECTION[entityType] ?? entityType;
}

export class RipplingClient implements CompensationClient {
  readonly connector = 'rippling';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    let url = `${RIPPLING_API_BASE}${path}`;
    if (query && Object.keys(query).length > 0) url = `${url}?${new URLSearchParams(query).toString()}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      logger.error('Rippling API error', { status: response.status, path, method, error: errorText });
      if (response.status === 401) throw new Error(`Rippling authentication failed (401): ${errorText}`);
      if (response.status === 403) throw new Error(`Rippling access forbidden (403): ${errorText}`);
      if (response.status === 404) throw new Error(`Rippling resource not found (404): ${path}`);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? '60';
        throw new Error(`Rippling rate limit exceeded (429) — retry after ${retryAfter}s`);
      }
      throw new Error(`Rippling API error: ${response.status} - ${errorText}`);
    }
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  // Rippling REST returns either a bare array or { results: [...], next_link? }.
  private rowsOf(body: unknown): { rows: Array<Record<string, unknown>>; next?: string } {
    if (Array.isArray(body)) return { rows: body as Array<Record<string, unknown>> };
    const b = (body ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(b.results) ? (b.results as Array<Record<string, unknown>>) : [];
    const next = typeof b.next_link === 'string' ? b.next_link : undefined;
    return { rows, next };
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    logger.info('Rippling read', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedRead(this.request.bind(this), {}, entityType, entityId, payload);

    // Raw native passthrough — payload carries { method, path, body }.
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Rippling native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }

    const collection = collectionFor(entityType);
    if (entityId && !entityType.endsWith('s')) {
      const data = await this.request<Record<string, unknown>>('GET', `/${collection}/${entityId}`, undefined, this.readQuery(payload));
      return { id: entityId, data };
    }
    const body = await this.request<unknown>('GET', `/${collection}`, undefined, this.readQuery(payload));
    const { rows } = this.rowsOf(body);
    return { id: entityId ?? collection, data: { results: rows } };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const collection = collectionFor(entityType);
    const query: Record<string, string> = {};
    if (filters?.limit) query.limit = String(filters.limit);
    if (filters?.pageToken) query.offset = filters.pageToken;
    if (collection === 'workers') query.expand = 'user,manager,employment_type,compensation,department';
    const body = await this.request<unknown>('GET', `/${collection}`, undefined, query);
    const { rows, next } = this.rowsOf(body);
    const records = rows.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), data: r }));
    const offset = filters?.pageToken ? Number(filters.pageToken) : 0;
    const nextOffset = offset + rows.length;
    return {
      records,
      hasMore: !!next || rows.length === (filters?.limit ?? -1),
      nextPageToken: next ?? (rows.length && filters?.limit ? String(nextOffset) : undefined),
    };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Rippling create', { entityType });
    if (isTemplatedEntity(entityType)) return templatedCreate(this.request.bind(this), {}, entityType, data);
    if (entityType === 'native') {
      const method = String(data.method ?? 'POST').toUpperCase();
      const path = String(data.path ?? '');
      if (!path.startsWith('/')) return { success: false, id: '', error: 'Rippling native_request: path must start with "/"' };
      try {
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, id: 'native', data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    try {
      const collection = collectionFor(entityType);
      const result = await this.request<Record<string, unknown>>('POST', `/${collection}`, data);
      return { success: true, id: String((result.id ?? '') as string), data: result };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    logger.info('Rippling update', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.request.bind(this), {}, entityType, entityId, data);
    if (entityType === 'native') {
      const method = String(data.method ?? 'PATCH').toUpperCase();
      const path = String(data.path ?? '');
      if (!path.startsWith('/')) return { success: false, error: 'Rippling native_request: path must start with "/"' };
      try {
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    if (!entityId) return { success: false, error: 'Rippling update requires entityId' };
    try {
      const collection = collectionFor(entityType);
      const result = await this.request<Record<string, unknown>>('PATCH', `/${collection}/${entityId}`, data);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string | undefined, _payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.request.bind(this), {}, entityType, entityId, _payload);
    if (!entityId) return { success: false, error: 'Rippling delete requires entityId' };
    try {
      const collection = collectionFor(entityType);
      await this.request<void>('DELETE', `/${collection}/${entityId}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    return { success: false, error: `Rippling: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }

  private readQuery(payload?: Record<string, unknown>): Record<string, string> {
    if (!payload) return {};
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (['id', 'entityType', 'method', 'path', 'body', 'query'].includes(k)) continue;
      if (v != null) q[k] = String(v);
    }
    return q;
  }
}
