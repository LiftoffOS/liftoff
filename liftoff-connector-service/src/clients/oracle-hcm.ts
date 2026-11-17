// Oracle Fusion Cloud HCM Connector Client (native, first-party).
//
// REST base: https://{podHost}/hcmRestApi/resources/11.13.18.05
//   (docs.oracle.com/en/cloud/saas/human-resources/farws — "All REST Endpoints")
// Auth: OAuth 2.0 client-credentials via the customer's IDCS / IAM identity domain.
//   POST {idcsTokenUrl}/oauth2/v1/token
//     Authorization: Basic base64(client_id:client_secret)
//     grant_type=client_credentials&scope={scope}
//   → { access_token, expires_in }. Then Authorization: Bearer on REST calls.
//
// Customer-tenant-authorized: the customer creates a confidential OAuth app in
// their own IDCS and grants it the Fusion HCM scope — no central Oracle review
// of Liftoff. Fully native.
//
// Credential convention:
//   credentials.connectorConfig.{ podHost, idcsTokenUrl, clientId, clientSecret, scope }
//
// DORMANT: not registered as an executor, no ORACLE_HCM_FUNCTIONS wired.
//
// entityType dispatch (free-form Fusion resource names supported):
//   workers/worker, emps/emp, departments, locations (locationsV2), positions,
//   jobs, grades, salaries, native (raw passthrough { method, path, body, query }).

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
import { isTemplatedEntity, templatedRead, templatedCreate, templatedUpdate, templatedDelete } from './templated-dispatch.js';

const REST_VERSION = '11.13.18.05';

interface OracleConfig {
  podHost: string;
  idcsTokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

interface CachedToken { accessToken: string; expiresAt: number; }

// Shared token cache keyed by OAuth client id. The executor constructs a NEW
// client per tool call, so an instance-level cache would re-mint every request.
const tokenCache = new Map<string, CachedToken>();

export class OracleHcmClient implements CompensationClient {
  readonly connector = 'oracle_hcm';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): OracleConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const podHost = String(cfg.podHost ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const idcsTokenUrl = String(cfg.idcsTokenUrl ?? '').replace(/\/$/, '');
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    const scope = String(cfg.scope ?? 'urn:opc:resource:consumer::all');
    if (!podHost || !idcsTokenUrl || !clientId || !clientSecret) {
      throw new Error('Oracle HCM credential missing podHost/idcsTokenUrl/clientId/clientSecret in connectorConfig');
    }
    return { podHost, idcsTokenUrl, clientId, clientSecret, scope };
  }

  private async mintToken(cfg: OracleConfig): Promise<string> {
    const cached = tokenCache.get(cfg.clientId);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    // idcsTokenUrl may be given as the IDCS base or the full token endpoint; only
    // append the standard path when it isn't already present (avoid …/token/oauth2/v1/token).
    const tokenEndpoint = /\/oauth2\/v1\/token\/?$|\/token\/?$/.test(cfg.idcsTokenUrl)
      ? cfg.idcsTokenUrl
      : `${cfg.idcsTokenUrl}/oauth2/v1/token`;
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: cfg.scope }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`Oracle HCM IDCS token error: ${res.status} - ${text}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const entry: CachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    tokenCache.set(cfg.clientId, entry);
    return entry.accessToken;
  }

  private async rest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
    // Oracle splits HCM (`hcmRestApi`) and Financials (`fscmRestApi`) onto separate
    // API bases on the same pod. Bank accounts (externalBankAccounts) live on
    // Financials; everything else on HCM. Same OAuth token/pod host for both.
    apiBase: 'hcmRestApi' | 'fscmRestApi' = 'hcmRestApi',
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const cfg = this.resolveConfig(credentials);
    const token = await this.mintToken(cfg);

    let url = `https://${cfg.podHost}/${apiBase}/resources/${REST_VERSION}${path}`;
    if (query && Object.keys(query).length > 0) url = `${url}?${new URLSearchParams(query).toString()}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/vnd.oracle.adf.resourceitem+json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      logger.error('Oracle HCM REST error', { status: res.status, path, method });
      throw new Error(`Oracle HCM REST error: ${res.status} - ${text}`);
    }
    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  private resource(entityType: string): string {
    const map: Record<string, string> = {
      worker: 'workers', workers: 'workers',
      emp: 'emps', emps: 'emps',
      department: 'departments', departments: 'departments',
      location: 'locationsV2', locations: 'locationsV2',
      position: 'positions', positions: 'positions',
      job: 'jobs', jobs: 'jobs',
      grade: 'grades', grades: 'grades',
      // NOTE: salaries are a NESTED child resource
      // (/workers/{id}/child/assignments/{aid}/child/salaries), not a top-level
      // resource — reach them via native_request with the full child path.
    };
    return map[entityType] ?? entityType;
  }

  /**
   * Oracle Fusion primary key. Every REST item carries a self link whose last
   * path segment is the record key; fall back to well-known PascalCase id fields.
   * (The previous `${resource}Id` heuristic produced lowercase keys that never
   * matched Oracle's PascalCase, so non-worker lists came back empty.)
   */
  private extractId(row: Record<string, unknown>): string | undefined {
    const links = row.links as Array<{ rel?: string; href?: string }> | undefined;
    const self = links?.find((l) => l.rel === 'self')?.href;
    if (self) {
      const seg = self.split('?')[0].split('/').filter(Boolean).pop();
      if (seg) return decodeURIComponent(seg);
    }
    for (const k of ['PersonId', 'PersonNumber', 'DepartmentId', 'PositionId', 'LocationId', 'JobId', 'GradeId', 'AssignmentId', 'id']) {
      if (row[k] != null) return String(row[k]);
    }
    return undefined;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.rest.bind(this), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Oracle native_request: path must start with "/"');
      const data = await this.rest<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    const resource = this.resource(entityType);
    if (entityId) {
      const data = await this.rest<Record<string, unknown>>('GET', `/${resource}/${entityId}`);
      return { id: entityId, data };
    }
    const query = this.buildQuery(payload);
    const data = await this.rest<{ items?: unknown[] }>('GET', `/${resource}`, undefined, query);
    return { id: resource, data: { items: data.items ?? [] } };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Net-pay splits + employee bank accounts are multi-request derivations (worker
    // PersonNumber→PersonId bridge; cross-base-path Financials call). Client paginates
    // internally → a present pageToken means "page 2+" of an offset-paginated caller.
    if (entityType === 'net_pay_splits') return { records: filters?.pageToken ? [] : await this.listNetPaySplits(), hasMore: false };
    if (entityType === 'employee_bank_accounts') return { records: filters?.pageToken ? [] : await this.listEmployeeBankAccounts(), hasMore: false };
    if (entityType === 'oracle_deductions') return { records: filters?.pageToken ? [] : await this.listDeductions(), hasMore: false };
    if (entityType === 'employer_charges') return { records: filters?.pageToken ? [] : await this.listEmployerCharges(), hasMore: false };
    const resource = this.resource(entityType);
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    if (filters?.pageToken) query['offset'] = filters.pageToken;
    const data = await this.rest<{ items?: Array<Record<string, unknown>>; hasMore?: boolean; offset?: number; limit?: number }>('GET', `/${resource}`, undefined, query);
    const rows = data.items ?? [];
    const records = rows
      .map((r) => ({ id: this.extractId(r), data: r }))
      .filter((r): r is { id: string; data: Record<string, unknown> } => r.id != null);
    const nextOffset = (data.offset ?? 0) + (data.limit ?? rows.length);
    return { records, hasMore: !!data.hasMore, nextPageToken: data.hasMore ? String(nextOffset) : undefined };
  }

  /** Page a top-level resource fully (Oracle offset pagination), applying `map` per row. */
  private async pageAll(path: string, apiBase: 'hcmRestApi' | 'fscmRestApi', extraQuery: Record<string, string>, onRow: (r: Record<string, unknown>) => void): Promise<void> {
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.rest<{ items?: Array<Record<string, unknown>>; hasMore?: boolean }>(
        'GET', path, undefined, { onlyData: 'true', limit: '500', offset: String(offset), ...extraQuery }, apiBase);
      const rows = data.items ?? [];
      for (const r of rows) onRow(r);
      if (!data.hasMore || rows.length === 0) break;
      offset += rows.length;
    }
  }

  /** PersonNumber → PersonId map from /workers (both non-nullable → total + deterministic).
   *  personalPaymentMethods only returns PersonNumber, but employees are keyed by PersonId. */
  private async personNumberToId(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    await this.pageAll('/workers', 'hcmRestApi', { fields: 'PersonId,PersonNumber' }, (r) => {
      const pn = r['PersonNumber'] != null ? String(r['PersonNumber']) : '';
      const pid = r['PersonId'] != null ? String(r['PersonId']) : '';
      if (pn && pid) map.set(pn, pid);
    });
    return map;
  }

  /** Net-pay splits: personalPaymentMethods grouped per employee. PersonNumber→PersonId
   *  via the workers bridge so the split-set links to the Employee (externalId=PersonId).
   *  Split type is derived from Amount/Percentage presence (PaymentAmountType semantics
   *  aren't doc-guaranteed); neither present → remainder. */
  async listNetPaySplits(): Promise<ExternalRecord[]> {
    const pn = await this.personNumberToId();
    const byPerson = new Map<string, Array<Record<string, unknown>>>();
    await this.pageAll('/personalPaymentMethods', 'hcmRestApi', {}, (r) => {
      const personId = pn.get(String(r['PersonNumber'] ?? ''));
      if (!personId) return;
      const split = {
        bankAccountExternalId: r['BankAccountId'] != null ? String(r['BankAccountId']) : undefined,
        amount: r['Amount'] != null ? String(r['Amount']) : undefined,
        percentage: r['Percentage'] != null ? Number(r['Percentage']) : undefined,
        priority: r['Priority'] != null ? Number(r['Priority']) : undefined,
      };
      const list = byPerson.get(personId); if (list) list.push(split); else byPerson.set(personId, [split]);
    });
    return [...byPerson].map(([employeeId, splits]) => ({ id: employeeId, data: { employee_id: employeeId, splits } }));
  }

  /** Employee bank accounts from Financials externalBankAccounts (top-level PersonId
   *  = Employee.externalId). Account number is typically masked by Oracle; routing =
   *  BankBranchNumber. Only employee-owned accounts (PersonId present) are emitted. */
  async listEmployeeBankAccounts(): Promise<ExternalRecord[]> {
    const out: ExternalRecord[] = [];
    await this.pageAll('/externalBankAccounts', 'fscmRestApi', {}, (r) => {
      const bankId = r['BankAccountId'] != null ? String(r['BankAccountId']) : '';
      const personId = r['PersonId'] != null ? String(r['PersonId']) : '';
      if (!bankId || !personId) return;
      out.push({ id: bankId, data: {
        bank_account_id: bankId, person_id: personId,
        institution: r['BankName'], routing: r['BankBranchNumber'], account: r['BankAccountNumber'], type: r['AccountType'],
      } });
    });
    return out;
  }

  /**
   * Post-tax deductions from elementEntries. Verified against the Oracle HCM REST
   * schema (op-elemententries-get): PersonId links directly (= Employee.externalId),
   * the amount lives in the CHILD elementEntryValues array (InputValueName='Amount' →
   * ScreenEntryValue), and there is no deduction flag — a deduction is any entry whose
   * PrimaryClassification contains "Deduction" (Voluntary/Involuntary/Pretax/Employee
   * Tax Deductions). Earnings classifications are excluded.
   */
  async listDeductions(): Promise<ExternalRecord[]> {
    const out: ExternalRecord[] = [];
    await this.pageAll('/elementEntries', 'hcmRestApi', { expand: 'elementEntryValues' }, (r) => {
      const cls = String(r['PrimaryClassification'] ?? '');
      if (!/deduction/i.test(cls)) return;
      const personId = r['PersonId'] != null ? String(r['PersonId']) : '';
      const id = r['ElementEntryId'] != null ? String(r['ElementEntryId']) : '';
      if (!personId || !id) return;
      const values = Array.isArray(r['elementEntryValues']) ? r['elementEntryValues'] as Array<Record<string, unknown>> : [];
      const amt = values.find((v) => /amount/i.test(String(v['InputValueName'] ?? '')));
      out.push({ id, data: {
        element_entry_id: id, person_id: personId,
        description: r['ElementName'], classification: cls,
        amount: amt ? amt['ScreenEntryValue'] : undefined,
        effective_start: r['EffectiveStartDate'],
      } });
    });
    return out;
  }

  /**
   * Per-employee EMPLOYER burden from the Statement of Earnings (→ hris
   * company_payroll_run_items). GATED: requires the payroll-admin data role
   * (PAY_ACCESS_PAYROLL_FLOWS + PAY_VERIFY_STATEMENT_OF_EARNING) — without it the
   * personProcessResults resource returns nothing, so this is INERT by default.
   *
   * personProcessResults is a per-person payroll process result whose ObjectActionId
   * IS the payroll (run) id — the natural run link. Its SOEBalanceView child is the
   * Statement of Earnings balance view; we filter to the employer-charges balance
   * group (GLB_SOE_EMPLOYER_CHARGES_BALANCE_GROUP) and split employer taxes vs
   * employer liabilities/contributions by balance name (SOEBalanceView carries no
   * category field). The run-dimension amount is the first populated Value slice —
   * the exact Value index + tax/liability split need calibration against a live
   * payroll-admin response. Verified vs Oracle Fusion HCM REST (personProcessResults
   * / SOEBalanceView).
   */
  async listEmployerCharges(): Promise<ExternalRecord[]> {
    const out: ExternalRecord[] = [];
    await this.pageAll('/personProcessResults', 'hcmRestApi', { expand: 'SOEBalanceView' }, (r) => {
      const personId = r['PersonId'] != null ? String(r['PersonId']) : '';
      const runId = r['ObjectActionId'] != null ? String(r['ObjectActionId']) : '';
      if (!personId || !runId) return;
      const balances = Array.isArray(r['SOEBalanceView']) ? (r['SOEBalanceView'] as Array<Record<string, unknown>>) : [];
      const charges: Array<Record<string, unknown>> = [];
      for (const b of balances) {
        if (String(b['BalanceGroupName'] ?? '') !== 'GLB_SOE_EMPLOYER_CHARGES_BALANCE_GROUP') continue;
        const name = String(b['BalanceName'] ?? b['ReportingName'] ?? '');
        // Run-dimension amount: first populated Value slice (Value1..Value10 / TotalValue1).
        let amount: number | undefined;
        for (const k of ['Value1', 'Value2', 'Value3', 'Value4', 'Value5', 'TotalValue1']) {
          const v = b[k];
          if (v != null && v !== '' && !Number.isNaN(Number(v))) { amount = Number(v); break; }
        }
        if (amount == null) continue;
        // No category field on SOEBalanceView → classify by statutory-tax vocab.
        const isTax = /tax|social security|medicare|futa|suta|unemployment|fica|withhold/i.test(name);
        charges.push({ balanceName: name, amount, isTax });
      }
      if (!charges.length) return;
      out.push({ id: `${runId}:${personId}`, data: {
        id: `${runId}:${personId}`, person_id: personId, object_action_id: runId,
        pay_date: r['DateEarned'] ?? r['ProcessDate'] ?? r['PayrollActionDate'],
        currency: r['CurrencyCode'] ?? r['BaseCurrencyCode'],
        employer_charges: charges,
      } });
    });
    return out;
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.rest.bind(this), {}, entityType, data);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Oracle native_request: path must start with "/"' };
        const result = await this.rest<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, id: 'native', data: result };
      }
      const resource = this.resource(entityType);
      const result = await this.rest<Record<string, unknown>>('POST', `/${resource}`, data);
      return { success: true, id: this.extractId(result) ?? '', data: result };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.rest.bind(this), {}, entityType, entityId, data);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'PATCH').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Oracle native_request: path must start with "/"' };
        const result = await this.rest<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined);
        return { success: true, data: result };
      }
      if (!entityId) return { success: false, error: `Oracle: update ${entityType} requires entityId` };
      const resource = this.resource(entityType);
      const result = await this.rest<Record<string, unknown>>('PATCH', `/${resource}/${entityId}`, data);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string | undefined, _payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.rest.bind(this), {}, entityType, entityId, _payload);
    try {
      if (!entityId) return { success: false, error: `Oracle: delete ${entityType} requires entityId` };
      const resource = this.resource(entityType);
      await this.rest<void>('DELETE', `/${resource}/${entityId}`);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create' && entityId) return this.delete(entityType, entityId);
    return { success: false, error: `Oracle: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }

  private buildQuery(payload?: Record<string, unknown>): Record<string, string> {
    if (!payload) return {};
    const q: Record<string, string> = {};
    // Oracle Fusion REST query params: q (filter), fields, expand, limit, offset, orderBy
    for (const key of ['q', 'fields', 'expand', 'limit', 'offset', 'orderBy', 'onlyData']) {
      if (payload[key] != null) q[key] = String(payload[key]);
    }
    return q;
  }
}
