// Dayforce (Ceridian) Connector Client (native, first-party).
//
// Base URL: https://{companyId}.dayforcehcm.com/Api/{companyId}/V1
// Auth: OAuth2 token mint against Dayforce Identity (dfid.dayforcehcm.com). The
// customer provides companyId + a Dayforce web-services username/password; we
// mint a bearer (~1h) with the fixed Dayforce client_id. No Liftoff-side app and
// no Ceridian partner review. Fully native, customer-tenant-authorized.
//
// NOTE: Dayforce's full OpenAPI is login-gated (help.dayforce.com), so this
// ships with the curated first-class tools + passthrough; exhaustive codegen
// lands once we have an account. The token mint is verified against Dayforce's
// RESTful Web Services Developer Guide ("Request an Access Token"): password
// grant with companyId + username/password + the fixed HCMAnywhere client_id.
//
// Credential convention (api_key flow, direct-vault → connectorConfig):
//   credentials.connectorConfig.{ companyId, username, password }
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

const TOKEN_URL = 'https://dfid.dayforcehcm.com/connect/token';
const DAYFORCE_CLIENT_ID = 'Dayforce.HCMAnywhere.Client';

interface DayforceConfig { companyId: string; username: string; password: string; }
interface CachedToken { accessToken: string; expiresAt: number; }

const tokenCache = new Map<string, CachedToken>();

export class DayforceClient implements CompensationClient {
  readonly connector = 'dayforce';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): DayforceConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const companyId = String(cfg.companyId ?? '');
    const username = String(cfg.username ?? '');
    const password = String(cfg.password ?? '');
    if (!companyId || !username || !password) {
      throw new Error('Dayforce credential missing companyId/username/password in connectorConfig');
    }
    return { companyId, username, password };
  }

  private baseUrl(cfg: DayforceConfig): string {
    return `https://${cfg.companyId}.dayforcehcm.com/Api/${cfg.companyId}/V1`;
  }

  private async mintToken(cfg: DayforceConfig): Promise<string> {
    const cacheKey = `${cfg.companyId}::${cfg.username}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    // Dayforce Identity password grant (RESTful Web Services Developer Guide →
    // "Request an Access Token"): grant_type=password + companyId (client
    // namespace) + username/password + the fixed HCMAnywhere client_id.
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: DAYFORCE_CLIENT_ID,
      companyId: cfg.companyId,
      username: cfg.username,
      password: cfg.password,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`Dayforce token error: ${res.status} - ${text}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const entry: CachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    tokenCache.set(cacheKey, entry);
    return entry.accessToken;
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>, cfg?: DayforceConfig): Promise<T> {
    const resolved = cfg ?? this.resolveConfig(await this.credentialProvider());
    const token = await this.mintToken(resolved);
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`${this.baseUrl(resolved)}${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Dayforce API error', { status: res.status, path, method });
      throw new Error(`Dayforce API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  private async genExec(): Promise<LowLevelRequest> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    return (m, p, b, q) => this.request(m, p, b, q, cfg);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(await this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Dayforce native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`Dayforce: unsupported read entityType "${entityType}"`);
  }

  // Earning rate: Dayforce compensation is a per-employee history endpoint
  // (GET /Employees/{xrefCode}/CompensationSummary), not a global list. Fan out
  // over the employee list, take the latest change per employee (by EffectiveStart),
  // and emit one earning-rate row. BaseSalary is the annualized figure; BaseRate the
  // hourly. Employees with no visible comp are skipped (→ no $0 pollution).
  async listEarningRates(): Promise<ExternalRecord[]> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    const emps = await this.request<{ Data?: Array<Record<string, unknown>> }>('GET', '/Employees', undefined, undefined, cfg);
    const xrefs = (emps.Data ?? []).map((e) => String((e as Record<string, unknown>)['XRefCode'] ?? '')).filter(Boolean);
    const out: ExternalRecord[] = [];
    for (const xref of xrefs) {
      let rows: Array<Record<string, unknown>> = [];
      try {
        const cs = await this.request<{ Data?: Array<Record<string, unknown>> }>('GET', `/Employees/${encodeURIComponent(xref)}/CompensationSummary`, undefined, undefined, cfg);
        rows = cs.Data ?? [];
      } catch {
        continue; // employee with no comp visibility → skip
      }
      if (!rows.length) continue;
      const latest = rows.reduce((a, b) => (String(b['EffectiveStart'] ?? '') > String(a['EffectiveStart'] ?? '') ? b : a));
      const salary = latest['BaseSalary'];
      const isSalaried = salary != null && Number(salary) > 0;
      const amount = isSalaried ? salary : latest['BaseRate'];
      if (amount == null) continue;
      out.push({ id: xref, data: {
        rate_id: xref,
        employee_id: xref,
        amount: String(amount),
        rate_type: isSalaried ? 'salaried' : 'hourly',
        effective_start: latest['EffectiveStart'],
      } });
    }
    return out;
  }

  // Full employee HR details. Dayforce's bulk `GET /Employees` returns ONLY XRefCodes
  // (no HR fields), and nested collections (Addresses, MaritalStatuses) require `?expand=`.
  // So the Employee sync fans out: list XRefCodes, then GET /Employees/{xref}?expand=... per
  // employee, returning the full object (base fields + nested Items[]). Field names verified
  // vs Dayforce's official OpenAPI (PersonAddress: Address1/Address2/City/PostalCode/State/
  // Country; EmployeeMaritalStatus: MaritalStatus.{XRefCode,ShortName}; base Gender/HomePhone).
  // Same fan-out shape as listEarningRates; a per-employee fetch failure skips that employee.
  async listEmployeesFull(): Promise<ExternalRecord[]> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    const emps = await this.request<{ Data?: Array<Record<string, unknown>> }>('GET', '/Employees', undefined, undefined, cfg);
    const xrefs = (emps.Data ?? []).map((e) => String((e as Record<string, unknown>)['XRefCode'] ?? '')).filter(Boolean);
    const out: ExternalRecord[] = [];
    for (const xref of xrefs) {
      try {
        const resp = await this.request<{ Data?: Record<string, unknown> }>(
          'GET', `/Employees/${encodeURIComponent(xref)}`, undefined, { expand: 'Addresses,MaritalStatuses,Contacts' }, cfg);
        const emp = resp.Data;
        if (emp && typeof emp === 'object') out.push({ id: String(emp['XRefCode'] ?? xref), data: emp });
      } catch {
        continue; // employee not readable with current scope → skip
      }
    }
    return out;
  }

  // Per-employee per-pay-period PAYMENT amount. `EmployeePaySummaries` is a WFM/timesheet
  // endpoint: one row per pay-code / labor line, and its ONLY money field is `PayAmount`
  // (there is NO `NetPay`/`GrossPay` scalar — mapping `NetPay` yielded $0). So the payment
  // amount = Σ PayAmount grouped by (EmployeeXRefCode, PayDate). Required filters are
  // `filterTransactionTimeStartUtc`/`filterTransactionTimeEndUtc` (verified vs Dayforce's
  // "REST Services for Retrieving WFM Data" guide). CAVEAT: this is worked-time GROSS, not
  // committed net pay — true net + employer-side actuals come from the Reporting API on a
  // Committed Pay Run Results report (see listCommittedPayRun). Cents-accumulated to avoid drift.
  async listPaySummaries(filters?: ListFilters): Promise<ExternalRecord[]> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    const end = new Date();
    const start = filters?.since ?? new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const body = await this.request<{ Data?: Array<Record<string, unknown>> }>(
      'GET', '/EmployeePaySummaries', undefined,
      { filterTransactionTimeStartUtc: start.toISOString(), filterTransactionTimeEndUtc: end.toISOString() }, cfg);
    const agg = new Map<string, { emp: string; payDate: string; cents: number }>();
    for (const ln of body.Data ?? []) {
      const emp = String(ln['EmployeeXRefCode'] ?? '');
      const payDate = String(ln['PayDate'] ?? '');
      if (!emp || !payDate) continue;
      const key = `${emp}:${payDate}`;
      const cur = agg.get(key) ?? { emp, payDate, cents: 0 };
      cur.cents += Math.round(Number(ln['PayAmount'] ?? 0) * 100);
      agg.set(key, cur);
    }
    return [...agg.values()].map((r) => ({
      id: `${r.emp}:${r.payDate}`,
      data: { id: `${r.emp}:${r.payDate}`, EmployeeXRefCode: r.emp, PayDate: r.payDate, amount: (r.cents / 100).toFixed(2) },
    }));
  }

  // Per-employee EMPLOYER taxes + EMPLOYER contributions for a COMMITTED pay run.
  // Dayforce exposes committed-run actuals only via the Reporting API on a "Committed Pay
  // Run Results" report (typed endpoints carry none). We read the report the customer has
  // exposed (its xRefCode in connectorConfig.committedPayRunReportXRefCode), resolve its
  // column CodeNames via GET /ReportMetadata/{xRefCode} (columns are per-instance), and sum:
  //   employerTaxes    = Σ columns whose CodeName starts `PRPayRunTaxPermanent_` AND is an
  //                      employer tax (CodeName/DisplayName contains "Employer")
  //   employerBenefits = Σ columns starting `PRPayRunDeductionPermanent_` marked employer
  //   key/run          = PRPayRunResultPermanent_EmployeeNumber + PayDate
  // GATE (per-customer config, NOT code): inert unless the customer creates a Committed Pay
  // Run Results report with a **Report Integration Name (xRefCode)** set + NO totals, and that
  // xRefCode is stored on the connection. Verified vs Dayforce Web Services "RESTful Get
  // Reports"/"Get ReportMetadata" + Ad Hoc Reporting Guide (Payroll - Pay Run Summary).
  async listCommittedPayRun(): Promise<ExternalRecord[]> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    const reportRef = String(((await this.credentialProvider()).connectorConfig as Record<string, unknown> | undefined)?.['committedPayRunReportXRefCode'] ?? '');
    if (!reportRef) return []; // no report configured → inert (see GATE above)
    // Resolve per-instance column CodeNames so we don't hard-code aliased columns.
    let taxCols: string[] = [], dedCols: string[] = [], empCol = 'PRPayRunResultPermanent_EmployeeNumber', dateCol = 'PRPayRunResultPermanent_PayDate';
    try {
      const meta = await this.request<{ ColumnMetadata?: Array<Record<string, unknown>> }>('GET', `/ReportMetadata/${encodeURIComponent(reportRef)}`, undefined, undefined, cfg);
      const cols = (meta.ColumnMetadata ?? []).map((c) => ({ code: String(c['CodeName'] ?? ''), disp: String(c['DisplayName'] ?? '') }));
      const isEmployer = (c: { code: string; disp: string }) => /employer/i.test(c.code) || /employer/i.test(c.disp);
      taxCols = cols.filter((c) => c.code.startsWith('PRPayRunTaxPermanent_') && isEmployer(c)).map((c) => c.code);
      dedCols = cols.filter((c) => c.code.startsWith('PRPayRunDeductionPermanent_') && isEmployer(c)).map((c) => c.code);
      empCol = cols.find((c) => /EmployeeNumber$/i.test(c.code))?.code ?? empCol;
      dateCol = cols.find((c) => /PayDate$/i.test(c.code))?.code ?? dateCol;
    } catch { /* metadata unavailable → fall back to convention names below */ }
    const rep = await this.request<{ Data?: { Rows?: Array<Record<string, unknown>> } }>('GET', `/Reports/${encodeURIComponent(reportRef)}`, undefined, undefined, cfg);
    const rows = rep.Data?.Rows ?? [];
    const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
    return rows.map((r) => {
      const emp = String(r[empCol] ?? '');
      const payDate = String(r[dateCol] ?? '').slice(0, 10);
      const erTax = taxCols.reduce((s, c) => s + cents(r[c]), 0) / 100;
      const erBen = dedCols.reduce((s, c) => s + cents(r[c]), 0) / 100;
      return { id: `${emp}:${payDate}`, data: {
        id: `${emp}:${payDate}`, employeeExternalId: emp, payrollRunExternalId: payDate,
        employerTaxes: erTax.toFixed(2), employerBenefits: erBen.toFixed(2),
      } };
    }).filter((r) => r.data.employeeExternalId);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Earning rate is a per-employee history fan-out (see listEarningRates). A
    // present pageToken means "page 2+" → return empty to terminate the RPC loop.
    if (entityType === 'dayforce_earning_rates') return { records: filters?.pageToken ? [] : await this.listEarningRates(), hasMore: false };
    // Full employee HR details via per-employee expand fan-out (see listEmployeesFull).
    if (entityType === 'dayforce_employees_full') return { records: filters?.pageToken ? [] : await this.listEmployeesFull(), hasMore: false };
    // Pay summaries are aggregated per employee+paydate (see listPaySummaries).
    if (entityType === 'pay_summaries') return { records: filters?.pageToken ? [] : await this.listPaySummaries(filters), hasMore: false };
    // Committed-pay-run employer taxes/contributions via the Reporting API (see listCommittedPayRun).
    if (entityType === 'committed_pay_run') return { records: filters?.pageToken ? [] : await this.listCommittedPayRun(), hasMore: false };
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['pageSize'] = String(filters.limit);
    const body = await this.request<Record<string, any>>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(body?.Data) ? body.Data : Array.isArray(body?.data) ? body.data : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r != null)
      .map((r) => ({ id: String(r.XRefCode ?? r.id ?? ''), data: r }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(await this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Dayforce native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `Dayforce: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(await this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PATCH').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Dayforce native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Dayforce: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(await this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Dayforce native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Dayforce: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `Dayforce: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
