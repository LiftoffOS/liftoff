// Namely HRIS Connector Client (native, first-party).
//
// Base URL: https://{subdomain}.namely.com/api/v1  (paths take a .json suffix)
// Auth: Personal Access Token (Bearer). The employer generates the token in
// Namely (Account → API) and pastes it during connect — no Liftoff-side app and
// no Namely partner review. Fully native, customer-tenant-authorized.
//
// Credential convention (api_key flow, matches BambooHRClient):
//   - credentials.instanceUrl  → the Namely subdomain (e.g. "acme")
//   - credentials.accessToken  → the Personal Access Token
//
// This client is DORMANT: it is not registered as an executor and no
// NAMELY_FUNCTIONS are wired. It exists as a complete implementation ready to be
// activated at cutover (operator decision), exactly like the other native HRIS
// clients.
//
// entityType dispatch (read/list/create/update/delete):
//   profiles / profile      GET/POST /profiles(.json|/{id}.json), PUT /profiles/{id}.json
//   job_titles / job_title  GET /job_titles(.json|/{id}.json)
//   job_tiers               GET /job_tiers.json
//   groups / group          GET/POST /groups(.json|/{id}.json)
//   group_types             GET /group_types.json
//   events                  GET /events.json          (company FEED events — NOT
//                                                       time-off; Namely v1 has no
//                                                       public time-off-request API)
//   reports / report        GET /reports(.json|/{id}.json)
//   fields                  GET /profiles/fields.json (custom field definitions)
//   countries / currencies  GET /countries.json, /currencies.json
//   native                  raw passthrough — { method, path, body }

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

// entityType → REST collection (plural, used to build /{collection}.json paths)
const COLLECTION: Record<string, string> = {
  profiles: 'profiles',
  profile: 'profiles',
  job_titles: 'job_titles',
  job_title: 'job_titles',
  job_tiers: 'job_tiers',
  groups: 'groups',
  group: 'groups',
  group_types: 'group_types',
  events: 'events',
  event: 'events',
  reports: 'reports',
  report: 'reports',
  // Custom-field DEFINITIONS live under profiles/fields (not a top-level /fields).
  fields: 'profiles/fields',
  countries: 'countries',
  currencies: 'currencies',
};

function collectionFor(entityType: string): string {
  return COLLECTION[entityType] ?? entityType;
}

export class NamelyClient implements CompensationClient {
  readonly connector = 'namely';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    // Direct-vault connect persists `subdomain` to connector.config; fall back to
    // instanceUrl for connections established via an identity-fetch path.
    const subdomain = (credentials.connectorConfig?.subdomain as string | undefined) ?? credentials.instanceUrl;
    if (!subdomain) {
      throw new Error('Namely credential missing subdomain (connectorConfig.subdomain / instanceUrl)');
    }

    const baseUrl = `https://${subdomain}.namely.com/api/v1`;
    let url = `${baseUrl}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
      url = `${url}?${new URLSearchParams(queryParams).toString()}`;
    }

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
      logger.error('Namely API error', { status: response.status, path, method, error: errorText });
      if (response.status === 401) throw new Error(`Namely authentication failed (401): ${errorText}`);
      if (response.status === 403) throw new Error(`Namely access forbidden (403): ${errorText}`);
      if (response.status === 404) throw new Error(`Namely resource not found (404): ${path}`);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? '60';
        throw new Error(`Namely rate limit exceeded (429) — retry after ${retryAfter}s`);
      }
      throw new Error(`Namely API error: ${response.status} - ${errorText}`);
    }
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  // ── read / list ────────────────────────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    logger.info('Namely read', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedRead(this.request.bind(this), {}, entityType, entityId, payload);

    // Raw native passthrough — payload carries { method, path, body }.
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Namely native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }

    const collection = collectionFor(entityType);
    const params = this.buildQueryParams(payload);

    // Single-record fetch when an id is present and the entityType is singular.
    if (entityId && !entityType.endsWith('s')) {
      const data = await this.request<Record<string, unknown>>('GET', `/${collection}/${entityId}.json`);
      return { id: entityId, data };
    }

    const data = await this.request<Record<string, unknown>>('GET', `/${collection}.json`, undefined, params);
    return { id: entityId ?? collection, data };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const collection = collectionFor(entityType);
    const params: Record<string, string> = {};
    if (filters?.limit) params['per_page'] = String(filters.limit);
    if (filters?.pageToken) params['page'] = filters.pageToken;

    const body = await this.request<Record<string, any>>('GET', `/${collection}.json`, undefined, params);
    // Namely wraps collections under a key named after the resource.
    const rows: unknown[] = Array.isArray(body?.[collection])
      ? body[collection]
      : Array.isArray(body?.results)
        ? body.results
        : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r?.id !== undefined && r?.id !== null)
      .map((r) => ({ id: String(r.id), data: r }));

    const meta = body?.meta as { total_pages?: number; current_page?: number } | undefined;
    const hasMore = !!meta && !!meta.total_pages && !!meta.current_page && meta.current_page < meta.total_pages;
    return {
      records,
      hasMore,
      nextPageToken: hasMore ? String((meta!.current_page ?? 1) + 1) : undefined,
    };
  }

  // ── create / update / delete ─────────────────────────────────────────────

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Namely create', { entityType });
    if (isTemplatedEntity(entityType)) return templatedCreate(this.request.bind(this), {}, entityType, data);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Namely native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, id: 'native', data: result };
      }

      const collection = collectionFor(entityType);
      // Namely wraps the create payload under the singular-ish resource key.
      const result = await this.request<Record<string, any>>('POST', `/${collection}.json`, { [collection]: [data] });
      const created = Array.isArray(result?.[collection]) ? result[collection][0] : result;
      return { success: true, id: String(created?.id ?? ''), data: created };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('Namely update', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.request.bind(this), {}, entityType, entityId, data);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'PUT').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Namely native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, data: result };
      }
      if (!entityId) return { success: false, error: `Namely: update ${entityType} requires entityId` };
      const collection = collectionFor(entityType);
      const result = await this.request<Record<string, any>>('PUT', `/${collection}/${entityId}.json`, { [collection]: [data] });
      const updated = Array.isArray(result?.[collection]) ? result[collection][0] : result;
      return { success: true, data: updated };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    logger.info('Namely delete', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedDelete(this.request.bind(this), {}, entityType, entityId, _payload);
    try {
      if (!entityId) return { success: false, error: `Namely: delete ${entityType} requires entityId` };
      // Namely does NOT hard-delete profiles — deactivate by setting user_status.
      if (entityType === 'profile' || entityType === 'profiles') {
        await this.request<void>('PUT', `/profiles/${entityId}.json`, { profiles: [{ user_status: 'inactive' }] });
        return { success: true };
      }
      // Groups are deletable via the API.
      if (entityType === 'group' || entityType === 'groups') {
        await this.request<void>('DELETE', `/groups/${entityId}.json`);
        return { success: true };
      }
      return { success: false, error: `Namely: delete not supported for "${entityType}" (profiles are deactivated, not deleted; only groups are hard-deletable)` };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse (HITL rollback) ────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `Namely: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private buildQueryParams(payload?: Record<string, unknown>): Record<string, string> {
    if (!payload) return {};
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (['id', 'entityType', 'method', 'path', 'body'].includes(key)) continue;
      if (value !== undefined && value !== null) params[key] = String(value);
    }
    return params;
  }
}
