// Warp HRIS Connector Client (native, first-party).
//
// Base URL: https://api.joinwarp.com  (each tool's entityType carries its full
//           /v1/... path; see native-hris-functions.ts WARP_FUNCTIONS).
// Auth: company API key sent as the `x-api-key` header. The employer generates it
// in Warp and pastes it during connect — no Liftoff-side app, no partner review.
// Fully native, customer-tenant-authorized (api_key flow).
//
// Credential convention (api_key flow):
//   credentials.connectorConfig.apiKey  → the Warp API key
//   (falls back to credentials.accessToken / apiKey for the identity-fetch path)
//
// Pagination: cursor. List endpoints return { hasMore, count, data[] } and accept
// `limit` (≤100) + `afterId` (the id of the last row seen). listAll() walks the
// cursor to completion; a bulk sync can page one page per call via list().
//
// Dispatch:
//   - Agent tools carry a templated entityType ("METHOD /v1/path") and route
//     through templated-dispatch (read/create/update/delete).
//   - A bulk sync lists via list() using these synthetic entityTypes:
//       warp_employees / warp_contractors  → GET /v1/workers filtered by type
//       warp_workplaces                     → GET /v1/workplaces
//       warp_departments                    → GET /v1/departments
//       warp_time_off_policies|balances|requests → GET /v1/time_off/{sub}
//       warp_custom_field_values            → GET /v1/worker-custom-field-values
//   - `native` is the raw passthrough — { method, path, body }.
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
import { isTemplatedEntity, templatedRead, templatedCreate, templatedUpdate, templatedDelete, type LowLevelRequest } from './templated-dispatch.js';

const BASE_URL = 'https://api.joinwarp.com';
const PAGE_SIZE = 100;

// Synthetic sync entityType → { path, extra query }.
const SYNC_ROUTE: Record<string, { path: string; query?: Record<string, string> }> = {
  warp_employees: { path: '/v1/workers', query: { types: 'employee' } },
  warp_contractors: { path: '/v1/workers', query: { types: 'contractor' } },
  warp_workers: { path: '/v1/workers' },
  warp_departments: { path: '/v1/departments' },
  warp_workplaces: { path: '/v1/workplaces' },
  warp_time_off_policies: { path: '/v1/time_off/policies' },
  warp_time_off_balances: { path: '/v1/time_off/balances' },
  warp_time_off_requests: { path: '/v1/time_off/requests' },
  warp_time_off_assignments: { path: '/v1/time_off/assignments' },
  warp_custom_worker_fields: { path: '/v1/custom-worker-fields' },
  warp_custom_field_values: { path: '/v1/worker-custom-field-values' },
  warp_offers: { path: '/v1/offers' },
};

export class WarpClient implements CompensationClient {
  readonly connector = 'warp';
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
    const apiKey = String(
      (credentials.connectorConfig?.apiKey as string | undefined) ??
      credentials.accessToken ??
      '',
    );
    if (!apiKey) throw new Error('Warp credential missing API key (connectorConfig.apiKey)');

    let url = `${BASE_URL}${path}`;
    if (queryParams && Object.keys(queryParams).length > 0) {
      url = `${url}?${new URLSearchParams(queryParams).toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      logger.error('Warp API error', { status: response.status, path, method, error: errorText });
      if (response.status === 401 || response.status === 403) throw new Error(`Warp authentication failed (${response.status}): ${errorText}`);
      if (response.status === 404) throw new Error(`Warp resource not found (404): ${path}`);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? '60';
        throw new Error(`Warp rate limit exceeded (429) — retry after ${retryAfter}s`);
      }
      throw new Error(`Warp API error: ${response.status} - ${errorText}`);
    }
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  /** LowLevelRequest adapter for templated (agent-tool) dispatch. */
  private genExec(): LowLevelRequest {
    return (m, p, b, q) => this.request(m, p, b, q);
  }

  // A Warp list response is EITHER the { hasMore, count, data[] } envelope (most
  // endpoints) OR a bare array [...] (custom-worker-fields, worker-custom-field-values,
  // which are not paginated). Normalise both into a row array.
  private static rowsOf(body: unknown): Record<string, unknown>[] {
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    const data = (body as { data?: unknown } | null)?.data;
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  // Bare-array (non-paginated) list endpoints.
  private static readonly BARE_ARRAY = new Set(['warp_custom_worker_fields', 'warp_custom_field_values']);

  // Custom-field DEFINITIONS (GET /v1/custom-worker-fields — a bare array, no params).
  // Map fieldId → {name, category, type}. Warp keeps PII/comp/banking as category-tagged
  // custom fields; value rows carry only fieldId, so we join the defs to make each value
  // self-describing, so compensation and banking can be routed into structured fields.
  private async customFieldDefs(): Promise<Map<string, { name?: unknown; category?: unknown; fieldType?: unknown }>> {
    const map = new Map<string, { name?: unknown; category?: unknown; fieldType?: unknown }>();
    for (const r of WarpClient.rowsOf(await this.request<unknown>('GET', '/v1/custom-worker-fields'))) {
      map.set(String(r['id']), { name: r['name'], category: r['category'], fieldType: r['type'] });
    }
    return map;
  }

  // Walk a { data[] } cursor list to completion, returning every raw row.
  private async listAllPaged(path: string, baseQuery?: Record<string, string>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let i = 0; i < 5000; i++) {
      const q: Record<string, string> = { ...(baseQuery ?? {}), limit: String(PAGE_SIZE) };
      if (after) q['afterId'] = after;
      const body = await this.request<{ hasMore?: boolean }>('GET', path, undefined, q);
      const rows = WarpClient.rowsOf(body);
      out.push(...rows);
      if (!body?.hasMore || !rows.length) break;
      after = String(rows[rows.length - 1]['id']);
    }
    return out;
  }

  // Time-off balances carry `legacyWorkerId` (NOT the public wrk_ id) and Warp exposes
  // no way to map it back — but the balances endpoint accepts a `workerIds` FILTER. So we
  // fan out one worker at a time, stamping the wrk_ id we queried by (so the caller
  // can resolve the employee) plus the policy's unit (balances carry no unit; it lives on
  // the policy). Single-shot on the first sync page (later pages terminate).
  private async listBalances(filters?: ListFilters): Promise<ListResult> {
    if (filters?.pageToken) return { records: [], hasMore: false };
    const [workers, policies] = await Promise.all([
      this.listAllPaged('/v1/workers'),
      this.listAllPaged('/v1/time_off/policies'),
    ]);
    const unitByPolicy = new Map(policies.map((p) => [String(p['id']), p['unit']]));
    const out: ExternalRecord[] = [];
    for (const w of workers) {
      const wid = String(w['id']);
      const rows = WarpClient.rowsOf(await this.request<unknown>('GET', '/v1/time_off/balances', undefined, { workerIds: wid }));
      for (const r of rows) {
        out.push({ id: String(r['id']), data: { ...r, workerId: wid, policyUnit: unitByPolicy.get(String(r['policyId'])) } });
      }
    }
    return { records: out, hasMore: false };
  }

  // ── list (bulk sync) ───────────────────────────────────────────────────────
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Balances need the per-worker fan-out (legacyWorkerId → wrk_ id recovery).
    if (entityType === 'warp_time_off_balances') return this.listBalances(filters);

    const route = SYNC_ROUTE[entityType]
      ?? (isTemplatedEntity(entityType) ? { path: entityType.replace(/^GET\s+/i, '') } : { path: `/${entityType}` });
    const bare = WarpClient.BARE_ARRAY.has(entityType);
    // Bare-array endpoints aren't paginated — single shot, terminate on any later page.
    if (bare && filters?.pageToken) return { records: [], hasMore: false };
    const query: Record<string, string> = { ...(route.query ?? {}) };
    if (!bare) {
      query['limit'] = String(filters?.limit ?? PAGE_SIZE);
      if (filters?.pageToken) query['afterId'] = filters.pageToken;
    }

    const body = await this.request<unknown>('GET', route.path, undefined, query);
    let rows = WarpClient.rowsOf(body);
    // Custom-field values: stamp each with its definition's name/category/type.
    if (entityType === 'warp_custom_field_values' && rows.length) {
      const defs = await this.customFieldDefs();
      rows = rows.map((r) => {
        const def = defs.get(String(r['fieldId']));
        return def ? { ...r, fieldName: def.name, fieldCategory: def.category, fieldType: def.fieldType } : r;
      });
    }
    const records = rows.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), data: r }));
    const hasMore = !bare && !!(body as { hasMore?: boolean } | null)?.hasMore;
    const lastId = records.length ? records[records.length - 1].id : undefined;
    return { records, hasMore, nextPageToken: hasMore ? lastId : undefined };
  }

  // ── read / create / update / delete (agent tools via templated dispatch) ───
  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Warp native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    // Fall back to a single-page list (returns the raw envelope) for a bare sync entityType.
    const res = await this.list(entityType, {});
    return { id: entityId ?? entityType, data: { data: res.records.map((r) => r.data) } };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Warp native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `Warp: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PATCH').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Warp native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Warp: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Warp native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Warp: unsupported delete entityType "${entityType}"` };
  }

  // ── CompensationClient — snapshot / inverse (HITL rollback) ────────────────
  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
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
    return { success: false, error: `Warp: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
