// Gusto HR/Payroll Connector Client (native, first-party).
//
// Base URL: https://api.gusto.com/v1 (demo: https://api.gusto-demo.com/v1)
// Auth: OAuth2 Bearer via CredentialProvider closure (refresh handled upstream;
//   Gusto's refresh token is single-use + rotates, so the connect/refresh layer
//   must persist the rotated refresh_token — this client only reads accessToken).
//
// Company scope: the connected Gusto company_id is stored in credential.instanceUrl
// (the established api_key/instanceUrl convention in this repo) and is required in
// most paths. Paths use a literal {company_id} token, replaced by request().
//
// Docs-verified corrections (docs.gusto.com):
//   - Time-off requests live at /companies/{id}/time_off/requests (slash) and the
//     single record at /time_off/requests/{id} (NOT company-scoped, NOT the
//     underscore form). Gusto exposes no generic "approve" REST endpoint — status
//     changes go through /time_off/requests write flows; not faked here.
//   - PUT /employees/{id} requires the current `version` (409 Conflict otherwise);
//     update() fetches the current version and merges it in when absent.
//   - Collections paginate with `page` + `per` (default 25); list()/lists follow
//     pages to completion.
//   - DELETE /employees/{id} terminates an employee (implemented).

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

const GUSTO_BASE_PROD = 'https://api.gusto.com/v1';
const GUSTO_BASE_SANDBOX = 'https://api.gusto-demo.com/v1';

function getBaseUrl(): string {
  return process.env.GUSTO_SANDBOX === 'true' ? GUSTO_BASE_SANDBOX : GUSTO_BASE_PROD;
}

export class GustoClient implements CompensationClient {
  readonly connector = 'gusto';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  /** The connected company_id (stored in credential.instanceUrl). */
  private async companyId(): Promise<string> {
    const credentials = await this.credentialProvider();
    const companyId = credentials.instanceUrl;
    if (!companyId) throw new Error('Gusto credential missing companyId (instanceUrl)');
    return companyId;
  }

  /** Auto-derived path params for generated (templated) endpoints. */
  private async genCtx(): Promise<Record<string, unknown>> {
    const c = await this.credentialProvider();
    return { company_id: c.instanceUrl, company_uuid: c.instanceUrl };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const companyId = credentials.instanceUrl;
    if (!companyId && path.includes('{company_id}')) {
      throw new Error('Gusto credential missing companyId (instanceUrl)');
    }

    const resolvedPath = path.replace('{company_id}', companyId ?? '');
    let url = `${getBaseUrl()}${resolvedPath}`;
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
      logger.error('Gusto API error', { status: response.status, path: resolvedPath, method, error: errorText });
      if (response.status === 401) throw new Error(`Gusto authentication failed (401): ${errorText}`);
      if (response.status === 403) throw new Error(`Gusto access forbidden (403): ${errorText}`);
      if (response.status === 404) throw new Error(`Gusto resource not found (404): ${resolvedPath}`);
      if (response.status === 409) throw new Error(`Gusto version conflict (409) — record changed since read: ${errorText}`);
      if (response.status === 422) throw new Error(`Gusto validation error (422): ${errorText}`);
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') ?? '60';
        throw new Error(`Gusto rate limit exceeded (429) — retry after ${retryAfter}s`);
      }
      throw new Error(`Gusto API error: ${response.status} - ${errorText}`);
    }
    if (response.status === 204) return {} as T;
    return response.json() as Promise<T>;
  }

  /**
   * Fetch every page of a collection endpoint. Gusto paginates with `page`
   * (1-based) + `per` (default 25, max 100); `X-Total-Count` / short pages
   * signal the end.
   */
  private async requestAllPages<T = Record<string, unknown>>(
    path: string,
    baseParams: Record<string, string> = {},
    per = 100,
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    // Hard cap to avoid unbounded loops on a misbehaving endpoint.
    for (let guard = 0; guard < 1000; guard++) {
      const pageRows = await this.request<T[]>('GET', path, undefined, {
        ...baseParams,
        page: String(page),
        per: String(per),
      });
      const rows = Array.isArray(pageRows) ? pageRows : [];
      out.push(...rows);
      if (rows.length < per) break;
      page += 1;
    }
    return out;
  }

  // ── Employee operations ─────────────────────────────────────────────────────

  async listEmployees(params: Record<string, string> = {}): Promise<unknown[]> {
    return this.requestAllPages('/companies/{company_id}/employees', params);
  }

  async getEmployee(employeeId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/employees/${employeeId}`);
  }

  /**
   * Update an employee. Gusto requires the current `version`; when the caller
   * doesn't supply one we read the record first and merge it in.
   */
  async updateEmployee(employeeId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    let body = data;
    if (data.version == null) {
      const current = await this.getEmployee(employeeId);
      body = { ...data, version: current.version };
    }
    return this.request<Record<string, unknown>>('PUT', `/employees/${employeeId}`, body);
  }

  async createEmployee(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('POST', '/companies/{company_id}/employees', data);
  }

  async terminateEmployee(employeeId: string): Promise<void> {
    await this.request<void>('DELETE', `/employees/${employeeId}`);
  }

  // ── Payroll operations ──────────────────────────────────────────────────────

  async listPayrolls(params: Record<string, string> = {}): Promise<unknown[]> {
    // Gusto stopped including run totals by default (API v2023-04-01); request them
    // explicitly so PayrollRun carries gross/net/tax amounts, not just the period.
    return this.requestAllPages('/companies/{company_id}/payrolls', { include: 'totals', ...params });
  }

  async getPayroll(payrollId: string, include = 'taxes,benefits'): Promise<Record<string, unknown>> {
    // `include` enriches each employee_compensations[] entry with per-employee
    // taxes[] (each carries an `employer` boolean + `amount`) and benefits[] (each
    // carries `company_contribution`) — the per-employee employer burden. Valid
    // include tokens are taxes/benefits/deductions (docs.gusto.com); `employee_
    // compensations` is NOT an include token (the array is returned by default), so
    // we request only the valid ones.
    const query = include ? { include } : undefined;
    return this.request<Record<string, unknown>>('GET', `/companies/{company_id}/payrolls/${payrollId}`, undefined, query);
  }

  /**
   * Per-employee pay statements → the per-employee burden that lands in
   * company_payroll_run_items. Gusto has no per-employee pay-statement endpoint,
   * so we list processed payrolls, re-fetch each with ?include=taxes,benefits, and
   * FLATTEN each payroll's employee_compensations[] into per-employee rows stamped
   * with the payroll_uuid (the run link). Each row carries the raw per-employee
   * taxes[]/benefits[] arrays; the mapper sums employer:true taxes + benefit
   * company_contribution. Gusto amounts are decimal STRINGS (dollars), not cents.
   */
  async listPayStatements(params: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const payrolls = await this.listPayrolls(params);
    const out: Record<string, unknown>[] = [];
    for (const p of payrolls) {
      const pr = p as Record<string, unknown>;
      // Skip un-processed payrolls (no calculated employee_compensations yet).
      if (pr['processed'] === false) continue;
      const payrollUuid = String(pr['payroll_uuid'] ?? pr['uuid'] ?? pr['id'] ?? '');
      if (!payrollUuid) continue;
      const full = await this.getPayroll(payrollUuid, 'taxes,benefits');
      const comps = Array.isArray(full['employee_compensations']) ? (full['employee_compensations'] as Record<string, unknown>[]) : [];
      for (const comp of comps) {
        const employeeUuid = String(comp['employee_uuid'] ?? '');
        if (!employeeUuid) continue;
        out.push({
          id: `${payrollUuid}:${employeeUuid}`,
          employee_uuid: employeeUuid,
          payroll_uuid: payrollUuid,
          gross_pay: comp['gross_pay'],
          taxes: comp['taxes'] ?? [],
          benefits: comp['benefits'] ?? [],
        });
      }
    }
    return out;
  }

  /**
   * Per-contractor payments (the contractor half of
   * per-person fully-loaded cost — a 1099's loaded cost = gross paid, no employer burden).
   * GET /companies/{company_id}/contractor_payments?start_date&end_date returns a summary
   * with a contractor_payments[] array (uuid, contractor_uuid, date, payment_method, wage,
   * reimbursement, bonus). Total paid = wage + reimbursement + bonus (decimal-string dollars,
   * summed in the mapper). start_date/end_date are required by Gusto; default to a wide window.
   */
  async listContractorPayments(params: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const end = params['end_date'] ?? new Date().toISOString().slice(0, 10);
    const start = params['start_date'] ?? new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const body = await this.request<Record<string, unknown>>('GET', '/companies/{company_id}/contractor_payments', undefined, { start_date: start, end_date: end });
    const rows = Array.isArray(body?.['contractor_payments']) ? (body['contractor_payments'] as Record<string, unknown>[]) : [];
    return rows.map((cp) => ({
      id: String(cp['uuid'] ?? ''),
      contractor_uuid: cp['contractor_uuid'],
      date: cp['date'],
      payment_method: cp['payment_method'],
      wage: cp['wage'], reimbursement: cp['reimbursement'], bonus: cp['bonus'],
    })).filter((r) => r.id);
  }

  // ── Time-off operations (docs-correct paths) ─────────────────────────────────

  async listTimeOffRequests(params: Record<string, string> = {}): Promise<unknown[]> {
    return this.requestAllPages('/companies/{company_id}/time_off/requests', params);
  }

  async getTimeOffRequest(requestId: string): Promise<Record<string, unknown>> {
    // Single time-off request is NOT company-scoped.
    return this.request<Record<string, unknown>>('GET', `/time_off/requests/${requestId}`);
  }

  // ── Benefits operations ─────────────────────────────────────────────────────

  async listCompanyBenefits(): Promise<unknown[]> {
    return this.requestAllPages('/companies/{company_id}/company_benefits');
  }

  // ── CompensationClient interface ────────────────────────────────────────────

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    logger.info('Gusto read', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedRead(this.request.bind(this), await this.genCtx(), entityType, entityId, payload);
    const params = this.buildQueryParams(payload);

    switch (entityType) {
      case 'employee': {
        if (!entityId) return { id: 'employees', data: { results: await this.listEmployees(params) } };
        const data = await this.getEmployee(entityId);
        return { id: entityId, data, lastModified: data.updated_at ? new Date(data.updated_at as string) : undefined };
      }
      case 'employees':
        return { id: 'employees', data: { results: await this.listEmployees(params) } };

      case 'payroll': {
        if (!entityId) return { id: 'payrolls', data: { results: await this.listPayrolls(params) } };
        return { id: entityId, data: await this.getPayroll(entityId) };
      }
      case 'payrolls':
        return { id: 'payrolls', data: { results: await this.listPayrolls(params) } };

      case 'pay_statements':
        return { id: 'pay_statements', data: { results: await this.listPayStatements(params) } };

      case 'gusto_contractor_payments':
        return { id: 'gusto_contractor_payments', data: { results: await this.listContractorPayments(params) } };

      case 'time_off_request': {
        if (entityId) return { id: entityId, data: await this.getTimeOffRequest(entityId) };
        return { id: 'time_off_requests', data: { results: await this.listTimeOffRequests(params) } };
      }
      case 'time_off_requests':
        return { id: 'time_off_requests', data: { results: await this.listTimeOffRequests(params) } };

      case 'company_benefits':
        return { id: 'company_benefits', data: { results: await this.listCompanyBenefits() } };

      // Raw native passthrough — payload carries { method, path, body, query }.
      case 'native': {
        const method = String(payload?.method ?? 'GET').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) throw new Error('Gusto native_request: path must start with "/"');
        const data = await this.request<Record<string, unknown>>(
          method,
          path,
          payload?.body as Record<string, unknown> | undefined,
          payload?.query as Record<string, string> | undefined,
        );
        return { id: 'native', data };
      }

      default:
        throw new Error(`Gusto: unsupported read entity type "${entityType}"`);
    }
  }

  /** Polling source — every active employee for the connected company. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType !== 'Employee' && entityType !== 'employees' && entityType !== 'employee') {
      return { records: [], hasMore: false, unsupported: true };
    }
    const params: Record<string, string> = {};
    if (filters?.since) params['updated_after'] = filters.since.toISOString();
    const employees = await this.listEmployees(params);
    const records = employees
      .map((e) => e as Record<string, unknown>)
      .filter((e) => e?.uuid != null || e?.id != null)
      .map((e) => ({ id: String(e.uuid ?? e.id), data: e }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Gusto create', { entityType });
    if (isTemplatedEntity(entityType)) return templatedCreate(this.request.bind(this), await this.genCtx(), entityType, data);
    try {
      if (entityType === 'employee') {
        const result = await this.createEmployee(data);
        return { success: true, id: String(result.uuid ?? result.id ?? ''), data: result };
      }
      if (entityType === 'native') {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Gusto native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(
          method,
          path,
          data.body as Record<string, unknown> | undefined,
          data.query as Record<string, string> | undefined,
        );
        return { success: true, id: 'native', data: result };
      }
      return { success: false, id: '', error: `Gusto: unsupported create entity type "${entityType}"` };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    logger.info('Gusto update', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.request.bind(this), await this.genCtx(), entityType, entityId, data);
    try {
      switch (entityType) {
        case 'employee': {
          const employeeId = entityId ?? (data.uuid as string) ?? (data.id as string);
          if (!employeeId) return { success: false, error: 'Gusto: employee update requires entityId' };
          const result = await this.updateEmployee(employeeId, data);
          return { success: true, versionToken: result.version as string | undefined, data: result };
        }
        case 'native': {
          const method = String(data.method ?? 'PUT').toUpperCase();
          const path = String(data.path ?? '');
          if (!path.startsWith('/')) return { success: false, error: 'Gusto native_request: path must start with "/"' };
          const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
          return { success: true, data: result };
        }
        default:
          return { success: false, error: `Gusto: unsupported update entity type "${entityType}"` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(
    entityType: string,
    entityId: string | undefined,
    _payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    logger.info('Gusto delete (terminate)', { entityType, entityId });
    if (isTemplatedEntity(entityType)) return templatedDelete(this.request.bind(this), await this.genCtx(), entityType, entityId, _payload);
    try {
      if (entityType === 'employee') {
        if (!entityId) return { success: false, error: 'Gusto: employee termination requires entityId' };
        await this.terminateEmployee(entityId);
        return { success: true };
      }
      return { success: false, error: `Gusto: unsupported delete entity type "${entityType}"` };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // ── CompensationClient — snapshot / inverse ─────────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    // Drop the stale version so update() re-reads the current one before writing.
    const { version: _drop, ...rest } = snapshot;
    return this.update(entityType, entityId, rest);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create' && entityType === 'employee') {
      return this.delete('employee', entityId ?? String(originalResponse.uuid ?? originalResponse.id ?? ''));
    }
    return { success: false, error: `Gusto: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private buildQueryParams(payload?: Record<string, unknown>): Record<string, string> {
    if (!payload) return {};
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (['id', 'entityType', 'method', 'path', 'body', 'query'].includes(key)) continue;
      if (value !== undefined && value !== null) params[key] = String(value);
    }
    return params;
  }
}
