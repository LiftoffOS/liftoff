// Factorial Connector Client (native, first-party).
//
// Base URL: https://api.factorialhr.com/api/2026-07-01  (the dated API version
// is pinned so a server-side default bump can't silently change the surface —
// 2026-07-01 is Factorial's current published version, per api.factorialhr.com/oas).
// Auth: a Factorial API key sent as the `x-api-key` header. The customer
// generates it in Factorial (Settings → API keys) and pastes it during connect
// — no Liftoff-side app and no Factorial partner review. Fully native,
// customer-tenant-authorized.
//
// Credential convention (api_key flow):
//   credentials.connectorConfig.apiKey  → the Factorial API key
//   (falls back to accessToken for connections stored via the key blob path).
//
// Native first-party HRIS client. Every Curated + generated
// tool carries a templated entityType ("METHOD /path"); read/create/update/
// delete route through templated-dispatch. `native` is the raw passthrough.

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

const BASE_URL = 'https://api.factorialhr.com/api/2026-07-01';

export class FactorialClient implements CompensationClient {
  readonly connector = 'factorial';
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
    const c = await this.credentialProvider();
    const key = String(c.connectorConfig?.apiKey ?? c.accessToken ?? '');
    if (!key) throw new Error('Factorial credential missing apiKey (connectorConfig.apiKey)');
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`${BASE_URL}${path}${q}`, {
      method,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Factorial API error', { status: res.status, path, method });
      throw new Error(`Factorial API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  private genExec(): LowLevelRequest {
    return (m, p, b, q) => this.request(m, p, b, q);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Factorial native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`Factorial: unsupported read entityType "${entityType}"`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'recurring_reimbursements') return { records: filters?.pageToken ? [] : await this.listRecurringReimbursements(), hasMore: false };
    if (entityType === 'factorial_company_contributions') return { records: filters?.pageToken ? [] : await this.listCompanyContributions(), hasMore: false };
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    if (filters?.pageToken) query['page'] = filters.pageToken;
    const body = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', path, undefined, query);
    const rows = Array.isArray(body?.data) ? body.data : [];
    const records = rows.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), data: r }));
    return { records, hasMore: false };
  }

  /**
   * Recurring reimbursements from contracts/compensations (Factorial's recurring
   * additional-pay definition: description + amount + recurrence). The employee link is
   * INDIRECT — compensations carry contract_version_id, so bridge via contract_versions
   * (which carry employee_id = Employee.externalId). Only truly recurring rows
   * (recurrence monthly/yearly, not one_time) are emitted; amount is in the smallest
   * currency unit (cents) → decimal. Verified against Factorial's OpenAPI SDK types.
   */
  async listRecurringReimbursements(): Promise<ExternalRecord[]> {
    const cvMap = new Map<string, string>();
    const cvs = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', '/resources/contracts/contract_versions');
    for (const cv of cvs.data ?? []) {
      const id = cv['id'] != null ? String(cv['id']) : '';
      const emp = cv['employee_id'] != null ? String(cv['employee_id']) : '';
      if (id && emp) cvMap.set(id, emp);
    }
    const comps = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', '/resources/contracts/compensations');
    const out: ExternalRecord[] = [];
    for (const cmp of comps.data ?? []) {
      const recurrence = cmp['recurrence'] != null ? String(cmp['recurrence']) : '';
      if (!recurrence || recurrence === 'one_time') continue; // recurring only
      const employeeId = cvMap.get(cmp['contract_version_id'] != null ? String(cmp['contract_version_id']) : '');
      if (!employeeId) continue;
      const id = cmp['id'] != null ? String(cmp['id']) : '';
      const cents = cmp['amount'];
      out.push({ id, data: {
        id, employee_id: employeeId,
        description: cmp['description'], amount: cents != null ? String(Number(cents) / 100) : undefined,
        currency: cmp['currency'], cadence: recurrence, compensation_type: cmp['compensation_type'],
      } });
    }
    return out;
  }

  /**
   * Per-employee employer benefit contributions. Factorial classifies pay concepts with a
   * category taxonomy (/resources/compensations/concepts, `categories[]`); the employer-paid
   * category is `company_contribution` (verified against Factorial's concept category enum:
   * earnings_fixed_salary | earnings_variable | earnings_benefits_in_kind | earnings_others |
   * deductions | company_contribution | summarized_values). Keep only compensations whose
   * concept is in that category (matched by compensation_type, or contracts_taxonomy_id →
   * concept.id), and bridge each to its employee via contract_versions (contract_version_id →
   * employee_id), mirroring listRecurringReimbursements. amount is smallest-unit (cents) → decimal.
   */
  /** Fetch every page of a Factorial list resource. Factorial uses CURSOR pagination (verified
   *  against apidoc.factorialhr.com/docs/pagination): request `limit` (max 100) + `after_id`
   *  = the previous page's meta.end_cursor, looping while meta.has_next_page. Cap at 200 pages. */
  private async getAllPages(path: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let afterId: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const query: Record<string, string> = { limit: '100' };
      if (afterId) query['after_id'] = afterId;
      const body = await this.request<{ data?: Array<Record<string, unknown>>; meta?: Record<string, unknown> }>('GET', path, undefined, query);
      const rows = Array.isArray(body?.data) ? body.data : [];
      out.push(...rows);
      const meta = body?.meta ?? {};
      const endCursor = meta['end_cursor'];
      if (meta['has_next_page'] !== true || rows.length === 0 || endCursor == null) break;
      afterId = String(endCursor);
    }
    return out;
  }

  async listCompanyContributions(): Promise<ExternalRecord[]> {
    const ccTypes = new Set<string>();
    const ccIds = new Set<string>();
    for (const cn of await this.getAllPages('/resources/compensations/concepts')) {
      const cats = Array.isArray(cn['categories']) ? (cn['categories'] as unknown[]).map(String) : [];
      if (!cats.includes('company_contribution')) continue;
      if (cn['compensation_type'] != null) ccTypes.add(String(cn['compensation_type']));
      if (cn['id'] != null) ccIds.add(String(cn['id']));
    }
    if (ccTypes.size === 0 && ccIds.size === 0) return [];
    const cvMap = new Map<string, string>();
    for (const cv of await this.getAllPages('/resources/contracts/contract_versions')) {
      const id = cv['id'] != null ? String(cv['id']) : '';
      const emp = cv['employee_id'] != null ? String(cv['employee_id']) : '';
      if (id && emp) cvMap.set(id, emp);
    }
    const out: ExternalRecord[] = [];
    for (const cmp of await this.getAllPages('/resources/contracts/compensations')) {
      const type = cmp['compensation_type'] != null ? String(cmp['compensation_type']) : '';
      const taxonomyId = cmp['contracts_taxonomy_id'] != null ? String(cmp['contracts_taxonomy_id']) : '';
      if (!(ccTypes.has(type) || ccIds.has(taxonomyId))) continue;
      const employeeId = cvMap.get(cmp['contract_version_id'] != null ? String(cmp['contract_version_id']) : '');
      if (!employeeId) continue;
      const id = cmp['id'] != null ? String(cmp['id']) : '';
      const cents = cmp['amount'];
      out.push({ id, data: {
        id, employee_id: employeeId,
        description: cmp['description'],
        employer_amount: cents != null ? String(Number(cents) / 100) : undefined,
        currency: cmp['currency'], recurrence: cmp['recurrence'], compensation_type: type,
      } });
    }
    return out;
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Factorial native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `Factorial: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PUT').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Factorial native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Factorial: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Factorial native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Factorial: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `Factorial: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
