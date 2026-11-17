// UKG Pro Connector Client (native, first-party).
//
// Base URL: https://{serviceUrl}   (the customer's UKG Pro service host, e.g.
//   service5.ultipro.com — copied from their UKG Pro web-services config).
// Auth: HTTP Basic base64(username:userApiKey) PLUS a `US-API-Key` header set to
// the customer API key. No token mint. The customer creates a web-services user
// + customer/user API keys in UKG Pro and pastes them during connect — no
// Liftoff-side app and no UKG partner review. Fully native, customer-tenant-
// authorized.
//
// NOTE: UKG Pro's full OpenAPI is portal-gated, so this ships with the curated
// tools + passthrough; exhaustive codegen lands once we have an account.
//
// Credential convention (api_key flow, direct-vault → connectorConfig):
//   credentials.connectorConfig.{ serviceUrl, customerApiKey, username, userApiKey }
//
// Native first-party HRIS client. Curated + generated tools
// carry templated entityTypes ("METHOD /path") routed through templated-dispatch.

import {
  CompensationClient,
  CredentialProvider,
  ConnectorCredentials,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { logger } from '../infra/logging.js';
import { isTemplatedEntity, templatedRead, templatedCreate, templatedUpdate, templatedDelete, type LowLevelRequest } from './templated-dispatch.js';

interface UkgProConfig { serviceUrl: string; customerApiKey: string; username: string; userApiKey: string; }

export class UkgProClient implements CompensationClient {
  readonly connector = 'ukg_pro';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): UkgProConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const serviceUrl = String(cfg.serviceUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const customerApiKey = String(cfg.customerApiKey ?? '');
    const username = String(cfg.username ?? '');
    const userApiKey = String(cfg.userApiKey ?? '');
    if (!serviceUrl || !customerApiKey || !username || !userApiKey) {
      throw new Error('UKG Pro credential missing serviceUrl/customerApiKey/username/userApiKey in connectorConfig');
    }
    return { serviceUrl, customerApiKey, username, userApiKey };
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>, cfg?: UkgProConfig): Promise<T> {
    const resolved = cfg ?? this.resolveConfig(await this.credentialProvider());
    const basic = Buffer.from(`${resolved.username}:${resolved.userApiKey}`).toString('base64');
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`https://${resolved.serviceUrl}${path}${q}`, {
      method,
      headers: {
        Authorization: `Basic ${basic}`,
        'US-API-Key': resolved.customerApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('UKG Pro API error', { status: res.status, path, method });
      throw new Error(`UKG Pro API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  private async genExec(): Promise<LowLevelRequest> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    return (m, p, b, q) => this.request(m, p, b, q, cfg);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(await this.genExec(), {}, entityType, entityId, payload);
    // Per-employee pay statements. UKG Pro exposes these only as a POST to
    // /payroll/v1/employees/pay-statements with an employee identifier + date range
    // (verified against UKG's Employee Pay Statement service). Response fields are
    // PascalCase (PayDate/PeriodStartDate/PeriodEndDate/GrossWagesCurrent/NetPayCurrent)
    // with no currency and no document id, so we synthesize a stable per-statement id
    // (employee:payDate) and return the rows under `payStatements` for the mapper.
    if (entityType === 'employee_pay_statements') {
      const empId = entityId ?? String(payload?.id ?? '');
      if (!empId) throw new Error('UKG Pro pay statements: employee id required');
      const end = new Date();
      const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
      const iso = (d: Date): string => d.toISOString().slice(0, 10);
      // employeeIdentifier is an object (per UKG's Pay Statement service). The parent
      // externalId is the connector's employeeId, so key it there. Exact sub-key shape
      // to be confirmed against a sandbox response.
      const body = await this.request<unknown>('POST', '/payroll/v1/employees/pay-statements', { employeeIdentifier: { employeeId: empId }, startDate: iso(start), endDate: iso(end) });
      const b = body as Record<string, unknown>;
      const rows = Array.isArray(body) ? body as Array<Record<string, unknown>>
        : Array.isArray(b?.['payStatements']) ? b['payStatements'] as Array<Record<string, unknown>>
        : Array.isArray(b?.['data']) ? b['data'] as Array<Record<string, unknown>> : [];
      // The pay statement carries NO payroll-run id — the run is keyed by paygroup+paydate
      // (verified vs UKG's Employee Pay Statement + paygroup-payperiods schemas). Stamp a
      // `payrollRunKey = paygroup:paydate` that matches the PayrollRun's synth id (listPayrolls),
      // so landPayStatement can link the per-employee burden to its run. Field casing differs
      // across UKG's docs (lowercase OpenAPI vs PascalCase samples) → read both.
      const stamped = rows.map((r) => {
        const payDate = String(r['PayDate'] ?? r['paydate'] ?? r['payDate'] ?? '').slice(0, 10);
        const payGroup = String(r['PayGroup'] ?? r['paygroup'] ?? r['payGroup'] ?? '');
        return { ...r, _stmtId: `${empId}:${payDate}`, payrollRunKey: payGroup && payDate ? `${payGroup}:${payDate}` : undefined };
      });
      return { id: empId, data: { payStatements: stamped } };
    }
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('UKG Pro native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`UKG Pro: unsupported read entityType "${entityType}"`);
  }

  // Payroll runs = pay-group pay periods (GET /payroll/v1/paygroup-payperiods). The
  // per-employee pay statement has no run id, so runs are keyed by payGroup:payDate — the
  // same key stamped on each statement as payrollRunKey — so the run lands first and the
  // burden links to it (verified vs UKG's paygroup-payperiods schema: payPeriodId, payGroup,
  // payDate, periodStartDate/EndDate, isPeriodClosed). Casing read defensively.
  async listPayrolls(): Promise<ExternalRecord[]> {
    const body = await this.request<any>('GET', '/payroll/v1/paygroup-payperiods');
    const rows: Array<Record<string, unknown>> = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    return rows.map((r) => {
      const payGroup = String(r['payGroup'] ?? r['paygroup'] ?? '');
      const payDate = String(r['payDate'] ?? r['paydate'] ?? '').slice(0, 10);
      return { id: `${payGroup}:${payDate}`, data: {
        runKey: `${payGroup}:${payDate}`, payDate,
        periodStart: (r['periodStartDate'] ?? r['periodstartdate'] ?? '') as unknown,
        periodEnd: (r['periodEndDate'] ?? r['periodenddate'] ?? '') as unknown,
        status: (r['isPeriodClosed'] ? 'processed' : 'open'),
      } };
    }).filter((r) => r.data.runKey !== ':');
  }

  // Per-employee benefit deductions (GET /personnel/v1/emp-deductions). Each row carries the
  // employer-paid contribution (employerAmount) + employee deduction (employeeAmount) for a
  // deduction code, verified against UKG's EmpDeductions response schema (employeeId,
  // deductionCode, deductionType, benefitStatus, employeeAmount, employerAmount,
  // employerYearToDateAmount). Keyed by employeeId:deductionCode. Casing read defensively for
  // the id fields (UKG OpenAPI is lowercase; some samples PascalCase).
  async listEmployeeDeductions(): Promise<ExternalRecord[]> {
    const out: ExternalRecord[] = [];
    const pageSize = 100;
    // Page through the whole company (UKG paginates with page/per_Page). Cap at 50 pages
    // (5000 deductions) as a runaway guard; a short page ends the loop.
    for (let page = 1; page <= 50; page++) {
      const body = await this.request<any>('GET', '/personnel/v1/emp-deductions', undefined, { per_Page: String(pageSize), page: String(page) });
      const rows: Array<Record<string, unknown>> = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      for (const r of rows) {
        if (r == null) continue;
        const employeeId = String(r['employeeId'] ?? r['EmployeeId'] ?? '');
        const deductionCode = String(r['deductionCode'] ?? r['DeductionCode'] ?? '');
        out.push({ id: `${employeeId}:${deductionCode}`, data: { ...r, employeeId, deductionCode } });
      }
      if (rows.length < pageSize) break;
    }
    return out;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'ukg_pro_payrolls') return { records: filters?.pageToken ? [] : await this.listPayrolls(), hasMore: false };
    if (entityType === 'ukg_pro_emp_deductions') return { records: filters?.pageToken ? [] : await this.listEmployeeDeductions(), hasMore: false };
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['per_Page'] = String(filters.limit);
    if (filters?.pageToken) query['page'] = filters.pageToken;
    const body = await this.request<any>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r != null)
      .map((r) => ({ id: String(r.id ?? r.employeeId ?? ''), data: r }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(await this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'UKG Pro native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `UKG Pro: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(await this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PUT').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'UKG Pro native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `UKG Pro: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(await this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'UKG Pro native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `UKG Pro: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `UKG Pro: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
