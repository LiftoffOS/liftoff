// Workday Connector Client (native, first-party).
//
// Workday exposes THREE read/write surfaces, all per-tenant:
//   - REST (Workday "Common" REST) at the tenant's REST API endpoint
//     e.g. https://{host}/ccx/api/v1/{tenant} — workers, etc.
//   - WQL (Workday Query Language): POST {host}/ccx/api/wql/v1/{tenant}/data
//     with { query } — the richest read surface. Requires the
//     "System - Workday Query Language" scope on the API client.
//   - RaaS (Report-as-a-Service): GET {reportUrl}?format=json — the customer's
//     own custom reports exposed as JSON.
//
// Auth: OAuth 2.0, ALL URLs per-tenant — the customer retrieves REST endpoint,
// Authorization URL and Token URL from "View API Clients" in their own Workday
// (generic Workday URLs do not work). We mint tokens with an ISU refresh_token
// grant (preferred) or client_credentials. Customer-tenant-authorized — no
// central Workday review of Liftoff. Fully native.
//
// Credential convention:
//   credentials.connectorConfig.{ tenantHost, tenant, restEndpoint, tokenUrl,
//                                 clientId, clientSecret, refreshToken? }
//
// DORMANT: not registered as an executor, no WORKDAY_FUNCTIONS wired.
//
// entityType dispatch:
//   workers/worker  REST workers
//   wql             POST WQL data ({ query })  (read via create-dispatch)
//   report          RaaS report ({ reportUrl } or path)
//   native          raw REST passthrough ({ method, path, body, query })

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
import { XMLParser } from 'fast-xml-parser';

// ── Workday SOAP read helpers (Get_Workers compensation, Get_Payroll_Results) ──
// Workday's REST/WQL surface does not expose base pay or payroll results; both come
// from WWS SOAP. Parse with namespace prefixes stripped so wd:* elements read plainly.
const WD_XML = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false });
function wdArray<T>(x: T | T[] | undefined | null): T[] { return x == null ? [] : Array.isArray(x) ? x : [x]; }
/** Pick a Workday *_Reference's ID whose wd:type matches (Employee_ID, Currency_ID, …), else the first. */
function wdRefId(ref: unknown, type: string): string | undefined {
  const ids = wdArray((ref as { ID?: unknown } | undefined)?.ID);
  const match = ids.find((x) => (x as { '@_type'?: string })?.['@_type'] === type) ?? ids[0];
  if (match == null) return undefined;
  const v = typeof match === 'object' ? (match as { '#text'?: unknown })['#text'] : match;
  return v == null || v === '' ? undefined : String(v);
}
function wdText(v: unknown): string | undefined { return v == null || v === '' ? undefined : String(v); }

interface WorkdayConfig {
  tenantHost: string;   // e.g. https://wd2-impl-services1.workday.com
  tenant: string;       // tenant name
  restEndpoint: string; // full REST base from "View API Clients"
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
}

interface CachedToken { accessToken: string; expiresAt: number; }

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Serialize a structured JSON value into a Workday SOAP `wd:` element. This is how
 * the ~900 generated WWS operation tools turn an agent-supplied request object into
 * the operation's `<wd:{Operation}_Request>` body. Conventions:
 *   renderWorkdayElement('Worker_Reference', { ID: { '@type':'Employee_ID', '#text':'21001' } })
 *     → <wd:Worker_Reference><wd:ID wd:type="Employee_ID">21001</wd:ID></wd:Worker_Reference>
 *   arrays repeat the element; keys starting '@' become attributes (wd: unless qualified);
 *   '#text' / '_text' set text content.
 */
export function renderWorkdayElement(tag: string, value: unknown): string {
  const qn = tag.includes(':') ? tag : `wd:${tag}`;
  if (value == null) return `<${qn}/>`;
  if (typeof value !== 'object') return `<${qn}>${xmlEscape(String(value))}</${qn}>`;
  let attrs = '';
  let inner = '';
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '#text' || k === '_text') { inner += xmlEscape(String(v)); continue; }
    if (k.startsWith('@')) {
      const an = k.slice(1);
      attrs += ` ${an.includes(':') ? an : `wd:${an}`}="${xmlEscape(String(v))}"`;
      continue;
    }
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) inner += renderWorkdayElement(k, item);
  }
  return `<${qn}${attrs}>${inner}</${qn}>`;
}

// Shared token cache keyed by tokenUrl+clientId. The executor builds a NEW client
// per tool call, so an instance-level cache would re-mint every request.
const tokenCache = new Map<string, CachedToken>();

export class WorkdayClient implements CompensationClient {
  readonly connector = 'workday';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): WorkdayConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const tenantHost = String(cfg.tenantHost ?? '').replace(/\/$/, '');
    const tenant = String(cfg.tenant ?? '');
    const restEndpoint = String(cfg.restEndpoint ?? '').replace(/\/$/, '');
    const tokenUrl = String(cfg.tokenUrl ?? '');
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    const refreshToken = cfg.refreshToken ? String(cfg.refreshToken) : undefined;
    if (!tokenUrl || !clientId || !clientSecret || (!restEndpoint && !tenantHost)) {
      throw new Error('Workday credential missing tokenUrl/clientId/clientSecret/restEndpoint in connectorConfig');
    }
    return { tenantHost, tenant, restEndpoint, tokenUrl, clientId, clientSecret, refreshToken };
  }

  private async mintToken(cfg: WorkdayConfig): Promise<string> {
    const cacheKey = `${cfg.tokenUrl}::${cfg.clientId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const body = cfg.refreshToken
      ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken })
      : new URLSearchParams({ grant_type: 'client_credentials' });
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`Workday token error: ${res.status} - ${text}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const entry: CachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    tokenCache.set(cacheKey, entry);
    return entry.accessToken;
  }

  private async request<T>(url: string, method: string, body?: Record<string, unknown>, cfg?: WorkdayConfig): Promise<T> {
    const credentials = await this.credentialProvider();
    const resolved = cfg ?? this.resolveConfig(credentials);
    const token = await this.mintToken(resolved);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      logger.error('Workday API error', { status: res.status, url, method });
      throw new Error(`Workday API error: ${res.status} - ${text}`);
    }
    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  /** LowLevelRequest adapter for templated dispatch. Generated tools carry the
   *  full module base (/ccx/api/{module}/v1/{tenant}/…) → rooted at tenantHost;
   *  any other path is relative to the configured restEndpoint. */
  private async genExec(): Promise<LowLevelRequest> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    return (method, path, body, query) => {
      const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
      const base = path.startsWith('/ccx/') ? cfg.tenantHost : cfg.restEndpoint;
      return this.request(`${base}${path}${q}`, method, body, cfg);
    };
  }

  /** Path-param context for generated tools ({tenant} in the module base). */
  private async genCtx(): Promise<Record<string, unknown>> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    return { tenant: cfg.tenant };
  }

  /**
   * Invoke a Workday Web Services (SOAP/WWS) operation — the write path for
   * business processes that Common REST does not expose (Change_Job, Hire,
   * Terminate, etc.). Auth: WS-Security UsernameToken with the ISU credentials
   * (connectorConfig.isuUsername/isuPassword). `operationXml` is the inner
   * <wd:*_Request> element; `service` is the WWS service (e.g. 'Staffing',
   * 'Human_Resources'). Returns the raw SOAP response XML.
   */
  async soapRequest(service: string, operationXml: string, version?: string): Promise<string> {
    const creds = await this.credentialProvider();
    const cfg = this.resolveConfig(creds);
    const rc = (creds.connectorConfig ?? {}) as Record<string, unknown>;
    const user = String(rc.isuUsername ?? '');
    const pass = String(rc.isuPassword ?? '');
    if (!user || !pass) {
      throw new Error('Workday SOAP: connectorConfig.isuUsername/isuPassword required for WWS business-process writes');
    }
    const v = version ?? String(rc.wwsVersion ?? 'v43.0');
    const endpoint = `${cfg.tenantHost}/ccx/service/${cfg.tenant}/${service}/${v}`;
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wd="urn:com.workday/bsvc">` +
      `<soapenv:Header>` +
      `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" soapenv:mustUnderstand="1">` +
      `<wsse:UsernameToken>` +
      `<wsse:Username>${user}@${cfg.tenant}</wsse:Username>` +
      `<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${pass}</wsse:Password>` +
      `</wsse:UsernameToken>` +
      `</wsse:Security>` +
      `</soapenv:Header>` +
      `<soapenv:Body>${operationXml}</soapenv:Body>` +
      `</soapenv:Envelope>`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: envelope,
    });
    const text = await res.text();
    if (!res.ok) {
      logger.error('Workday SOAP error', { status: res.status, service });
      throw new Error(`Workday SOAP error: ${res.status} - ${text.slice(0, 500)}`);
    }
    return text;
  }

  /**
   * Invoke a named WWS operation from a structured request object — the executor
   * behind the generated `SOAP {Service} {Operation}` tools. Wraps `request` in the
   * operation's `<wd:{Operation}_Request>` element (see renderWorkdayElement) and
   * dispatches through soapRequest(). `request` may carry a top-level `@version`
   * attribute; otherwise the connectorConfig / v43.0 default applies.
   */
  async soapOperation(service: string, operation: string, request: Record<string, unknown>, version?: string): Promise<string> {
    const inner = renderWorkdayElement(`${operation}_Request`, request ?? {});
    return this.soapRequest(service, inner, version);
  }

  /**
   * Get_Workers with Include_Compensation → one normalized record per worker with
   * current base pay (Compensation_Data / Salary_and_Hourly_Data). Verified against
   * the Human_Resources WWS XSD. Element paths are namespace-stripped by WD_XML.
   */
  async listWorkerCompensation(): Promise<ExternalRecord[]> {
    const xml = await this.soapOperation('Human_Resources', 'Get_Workers', {
      Response_Group: { Include_Reference: 'true', Include_Compensation: 'true' },
    });
    const parsed = WD_XML.parse(xml) as Record<string, unknown>;
    const body = ((parsed?.['Envelope'] as Record<string, unknown>)?.['Body'] ?? {}) as Record<string, unknown>;
    const workers = wdArray((((body['Get_Workers_Response'] as Record<string, unknown>)?.['Response_Data']) as Record<string, unknown>)?.['Worker']);
    const out: ExternalRecord[] = [];
    for (const w of workers) {
      const worker = w as Record<string, unknown>;
      const wd = (worker['Worker_Data'] ?? {}) as Record<string, unknown>;
      // Link to the Employee synced via Common REST, whose externalId is the WID.
      // Prefer the WID; fall back to Employee_ID / Worker_ID only if absent.
      const workerId = wdRefId(worker['Worker_Reference'], 'WID') ?? wdRefId(worker['Worker_Reference'], 'Employee_ID') ?? wdText(wd['Worker_ID']);
      if (!workerId) continue;
      const comp = (wd['Compensation_Data'] ?? {}) as Record<string, unknown>;
      const base = (wdArray(comp['Salary_and_Hourly_Data'])[0] ?? {}) as Record<string, unknown>;
      if (base['Amount'] == null) continue; // worker with no visible base pay → no comp row
      out.push({ id: workerId, data: {
        worker_id: workerId,
        employee_business_id: wdRefId(worker['Worker_Reference'], 'Employee_ID'),
        comp_amount: wdText(base['Amount']),
        comp_currency: wdRefId(base['Currency_Reference'], 'Currency_ID'),
        comp_frequency: wdRefId(base['Frequency_Reference'], 'Frequency_ID'),
        comp_effective_date: wdText(base['Assignment_Effective_Date'] ?? comp['Compensation_Effective_Date']),
      } });
    }
    return out;
  }

  /**
   * Get_Payroll_Results over a date window → one record per worker × pay period
   * (Period dates, Gross/Net Amount, Payment_Date). Verified against the Payroll
   * WWS XSD. Each Payroll_Result is per-worker (no company rollup).
   */
  // Pay-component EMPLOYER classification for employer-burden sums. Get_Payroll_Results result
  // lines carry NO employer/employee flag (Earning vs Deduction only) — employer taxes AND
  // employer contributions are both Deductions. The tenant-portable classifier is Pay Component
  // GROUP membership (delivered "Employer-Paid Benefits" + Employer Taxes groups). We read a RaaS
  // custom report (customreport2, Enable-As-Web-Service) exposing per pay component
  // {referenceId, class}. GATE (inert unless configured): the delivered-group report must be
  // deployed + web-service-enabled in the customer's Workday tenant, its URL stored as
  // connectorConfig.payComponentClassReportUrl. Empty map ⇒ employer fields left unset (identical
  // to prior behavior). Verified vs Workday RaaS + Pay Component Group docs.
  private async payComponentClassification(): Promise<Map<string, 'employer_tax' | 'employer_benefit'>> {
    const map = new Map<string, 'employer_tax' | 'employer_benefit'>();
    const raw = ((await this.credentialProvider()).connectorConfig ?? {}) as Record<string, unknown>;
    const url = String(raw['payComponentClassReportUrl'] ?? '');
    if (!url) return map; // inert
    try {
      const token = await this.mintToken(this.resolveConfig(await this.credentialProvider()));
      const full = url.includes('format=') ? url : `${url}${url.includes('?') ? '&' : '?'}format=json`;
      const res = await fetch(full, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!res.ok) return map;
      const json = (await res.json()) as Record<string, unknown>;
      for (const row of wdArray(json['Report_Entry'] ?? json['data'] ?? [])) {
        const r = row as Record<string, unknown>;
        const code = String(r['payComponentReferenceId'] ?? r['Pay_Component_Reference_ID'] ?? r['referenceId'] ?? r['code'] ?? '');
        if (!code) continue;
        const cls = String(r['class'] ?? r['classification'] ?? r['group'] ?? r['isEmployerPaid'] ?? '').toLowerCase();
        if (/tax/.test(cls)) map.set(code, 'employer_tax');
        else if (/benefit|contribution|employer|^true$/.test(cls)) map.set(code, 'employer_benefit');
      }
    } catch { /* inert on error */ }
    return map;
  }

  async listPayrollResults(filters?: ListFilters): Promise<ExternalRecord[]> {
    const end = new Date();
    const start = filters?.since ?? new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const xml = await this.soapOperation('Payroll', 'Get_Payroll_Results', {
      Request_Criteria: { Period_Start_Date: iso(start), Period_End_Date: iso(end) },
    });
    const classification = await this.payComponentClassification(); // empty ⇒ no employer sums
    const parsed = WD_XML.parse(xml) as Record<string, unknown>;
    const body = ((parsed?.['Envelope'] as Record<string, unknown>)?.['Body'] ?? {}) as Record<string, unknown>;
    const results = wdArray((((body['Get_Payroll_Results_Response'] as Record<string, unknown>)?.['Response_Data']) as Record<string, unknown>)?.['Payroll_Result']);
    const out: ExternalRecord[] = [];
    for (const r of results) {
      const pr = r as Record<string, unknown>;
      // Link to the Employee synced via Common REST (externalId = WID); prefer WID.
      const workerId = wdRefId(pr['Employee_Reference'], 'WID') ?? wdRefId(pr['Employee_Reference'], 'Employee_ID');
      const resultId = wdRefId(pr['Payroll_Result_Reference'], 'WID') ?? `${workerId ?? ''}:${wdText(pr['Payment_Date']) ?? ''}`;
      if (!workerId) continue;
      // Per-line employer burden (only when a classification report is configured).
      let erTaxCents = 0, erBenCents = 0;
      if (classification.size) {
        for (const line of wdArray(pr['Payroll_Result_Data'])) {
          const l = line as Record<string, unknown>;
          const pcRef = (l['Pay_Component_Reference'] ?? {}) as Record<string, unknown>;
          const code = wdRefId(pcRef['Earning_Reference'] ?? pcRef['Deduction_Reference'] ?? pcRef, 'Pay_Component_ID') ?? wdRefId(pcRef, 'WID') ?? '';
          const cls = code ? classification.get(code) : undefined;
          if (!cls) continue;
          const amt = Math.round(Number(wdText(l['Result_Line_Amount']) ?? 0) * 100);
          if (cls === 'employer_tax') erTaxCents += amt; else erBenCents += amt;
        }
      }
      out.push({ id: resultId, data: {
        result_id: resultId, worker_id: workerId,
        employee_business_id: wdRefId(pr['Employee_Reference'], 'Employee_ID'),
        period_start: wdText(pr['Period_Start_Date']), period_end: wdText(pr['Period_End_Date']), pay_date: wdText(pr['Payment_Date']),
        gross: wdText(pr['Gross_Amount']), net: wdText(pr['Net_Amount']), currency: wdRefId(pr['Currency_Reference'], 'Currency_ID'),
        ...(classification.size ? { employer_taxes: (erTaxCents / 100).toFixed(2), employer_benefits: (erBenCents / 100).toFixed(2) } : {}),
      } });
    }
    return out;
  }

  /**
   * Get_Payroll_Federal_W-4_Tax_Election (Payroll WWS) → one record per employee's
   * current federal W-4. Verified against the v33.2 XSD (the 2020+ Form W-4 fields
   * Multiple_Jobs_or_Spouse_Works / Total_Dependent_Amount / Other_Income /
   * Deductions require WWS ≥ v33.2; the client's default v43.0 satisfies this).
   * Marital_Status_Reference + Worker_Reference are object refs (ID[] by type).
   */
  async listFederalW4(): Promise<ExternalRecord[]> {
    const xml = await this.soapOperation('Payroll', 'Get_Payroll_Federal_W-4_Tax_Election', {});
    const parsed = WD_XML.parse(xml) as Record<string, unknown>;
    const body = ((parsed?.['Envelope'] as Record<string, unknown>)?.['Body'] ?? {}) as Record<string, unknown>;
    // Root token's plural-vs-singular varies by version; accept either.
    const resp = ((body['Get_Payroll_Federal_W-4_Tax_Elections_Response']
      ?? body['Get_Payroll_Federal_W-4_Tax_Election_Response']) ?? {}) as Record<string, unknown>;
    const elections = wdArray((resp['Response_Data'] as Record<string, unknown>)?.['Payroll_Federal_W-4_Tax_Election']);
    const out: ExternalRecord[] = [];
    for (const e of elections) {
      const el = e as Record<string, unknown>;
      const d = (el['Payroll_Federal_W-4_Tax_Election_Data'] ?? {}) as Record<string, unknown>;
      const workerId = wdRefId(d['Worker_Reference'], 'WID') ?? wdRefId(d['Worker_Reference'], 'Employee_ID');
      if (!workerId) continue;
      out.push({ id: workerId, data: {
        worker_id: workerId,
        filing_status: wdRefId(d['Marital_Status_Reference'], 'Payroll_Withholding_Status_ID'),
        two_jobs: wdText(d['Multiple_Jobs_or_Spouse_Works']),
        dependents_amount: wdText(d['Total_Dependent_Amount']),
        other_income: wdText(d['Other_Income']),
        deductions: wdText(d['Deductions']),
        extra_withholding: wdText(d['Additional_Amount']),
        exempt: wdText(d['Exempt']),
        allowances: wdText(d['Number_of_Allowances']),
        effective: wdText(d['Effective_as_of']),
      } });
    }
    return out;
  }

  /**
   * Federal W-4 elections expanded into per-field tax-param rows for the Employee-Detail
   * "Tax Parameters" widget (employee_tax_param_settings), which is a generic
   * jurisdiction/label/value key-value view. Reuses the same Get_Payroll_Federal_W-4
   * parse; each present W-4 field becomes one Federal param row.
   */
  async listFederalTaxParams(): Promise<ExternalRecord[]> {
    const w4s = await this.listFederalW4();
    const params: Array<{ key: string; label: string }> = [
      { key: 'filing_status', label: 'Filing Status' },
      { key: 'two_jobs', label: 'Multiple Jobs / Spouse Works' },
      { key: 'dependents_amount', label: 'Dependents Amount' },
      { key: 'other_income', label: 'Other Income' },
      { key: 'deductions', label: 'Deductions' },
      { key: 'extra_withholding', label: 'Extra Withholding' },
      { key: 'exempt', label: 'Exempt' },
    ];
    const out: ExternalRecord[] = [];
    for (const rec of w4s) {
      const workerId = String((rec.data as Record<string, unknown>)['worker_id'] ?? rec.id);
      for (const p of params) {
        const val = (rec.data as Record<string, unknown>)[p.key];
        if (val == null || val === '') continue;
        const paramId = `${workerId}:federal:${p.key}`;
        out.push({ id: paramId, data: {
          param_id: paramId, worker_id: workerId,
          jurisdiction_id: 'federal', jurisdiction_label: 'Federal',
          param_name: p.key, param_label: p.label, param_type: 'string', value: String(val),
        } });
      }
    }
    return out;
  }

  /**
   * Post-tax deductions = involuntary withholding orders (garnishments, tax levies,
   * child support) via Get_Payroll_Involuntary_Withholding_Orders (Payroll WWS SOAP).
   * Verified against the WWS op reference: Employee_Reference, Withholding_Order_Type_
   * Reference, Withholding_Order_Amount(+_as_Percent), Case_Number, Begin/End_Date under
   * Payroll_Involuntary_Withholding_Order_Data. No scalar id → synthetic worker:case.
   */
  async listWithholdingOrders(): Promise<ExternalRecord[]> {
    const xml = await this.soapOperation('Payroll', 'Get_Payroll_Involuntary_Withholding_Orders', {});
    const parsed = WD_XML.parse(xml) as Record<string, unknown>;
    const body = ((parsed?.['Envelope'] as Record<string, unknown>)?.['Body'] ?? {}) as Record<string, unknown>;
    const resp = (body['Get_Payroll_Involuntary_Withholding_Orders_Response'] ?? {}) as Record<string, unknown>;
    const orders = wdArray((resp['Response_Data'] as Record<string, unknown>)?.['Payroll_Involuntary_Withholding_Order']);
    const out: ExternalRecord[] = [];
    for (const o of orders) {
      const inst = o as Record<string, unknown>;
      const d = (inst['Payroll_Involuntary_Withholding_Order_Data'] ?? inst) as Record<string, unknown>;
      const workerId = wdRefId(d['Employee_Reference'], 'WID') ?? wdRefId(d['Employee_Reference'], 'Employee_ID');
      if (!workerId) continue;
      const orderType = wdRefId(d['Withholding_Order_Type_Reference'], 'Withholding_Order_Type_ID') ?? wdText((d['Withholding_Order_Type_Reference'] as Record<string, unknown>)?.['Descriptor']);
      const caseNumber = wdText(d['Case_Number']);
      const orderId = `${workerId}:${caseNumber ?? orderType ?? wdText(d['Begin_Date']) ?? ''}`;
      out.push({ id: orderId, data: {
        order_id: orderId, worker_id: workerId, order_type: orderType, case_number: caseNumber,
        amount: wdText(d['Withholding_Order_Amount']), percent: wdText(d['Withholding_Order_Amount_as_Percent']),
        begin_date: wdText(d['Begin_Date']),
      } });
    }
    return out;
  }

  /** Parse a generated `SOAP {Service} {Operation}` entityType. */
  private parseSoapEntity(entityType: string): { service: string; operation: string } | null {
    if (!entityType.startsWith('SOAP ')) return null;
    const [, service, operation] = entityType.split(' ');
    return service && operation ? { service, operation } : null;
  }

  /** The request body for a SOAP tool: an explicit `request` wrapper, else the
   *  whole input minus dispatch control keys. */
  private soapBody(input?: Record<string, unknown>): Record<string, unknown> {
    if (!input) return {};
    if (input.request && typeof input.request === 'object') return input.request as Record<string, unknown>;
    const { id: _id, entityType: _e, version: _v, ...rest } = input;
    return rest;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(await this.genExec(), await this.genCtx(), entityType, entityId, payload);
    const soap = this.parseSoapEntity(entityType);
    if (soap) {
      const xml = await this.soapOperation(soap.service, soap.operation, this.soapBody(payload), payload?.version ? String(payload.version) : undefined);
      return { id: soap.operation, data: { response: xml } };
    }
    const credentials = await this.credentialProvider();
    const cfg = this.resolveConfig(credentials);

    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Workday native_request: path must start with "/"');
      const q = payload?.query ? `?${new URLSearchParams(payload.query as Record<string, string>).toString()}` : '';
      const data = await this.request<unknown>(`${cfg.restEndpoint}${path}${q}`, method, payload?.body as Record<string, unknown> | undefined, cfg);
      return { id: 'native', data: data as Record<string, unknown> };
    }

    if (entityType === 'report') {
      // RaaS — payload.reportUrl is the full custom-report URL from the customer.
      const reportUrl = String(payload?.reportUrl ?? payload?.path ?? '');
      if (!reportUrl) throw new Error('Workday report: reportUrl is required');
      const url = reportUrl.includes('format=') ? reportUrl : `${reportUrl}${reportUrl.includes('?') ? '&' : '?'}format=json`;
      const data = await this.request<unknown>(url, 'GET', undefined, cfg);
      return { id: 'report', data: data as Record<string, unknown> };
    }

    if (entityType === 'wql') {
      // WQL is a read executed via POST; supported on both read() and create()
      // dispatch so a read-categorized run_wql tool routes correctly.
      const query = String(payload?.query ?? '');
      if (!query) throw new Error('Workday WQL: query is required');
      const host = cfg.tenantHost || cfg.restEndpoint.replace(/\/ccx\/.*/, '');
      const data = await this.request<Record<string, unknown>>(`${host}/ccx/api/wql/v1/${cfg.tenant}/data`, 'POST', { query }, cfg);
      return { id: 'wql', data };
    }

    // Default: REST workers.
    const resource = entityType === 'worker' || entityType === 'workers' ? 'workers' : entityType;
    if (entityId) {
      const data = await this.request<Record<string, unknown>>(`${cfg.restEndpoint}/${resource}/${entityId}`, 'GET', undefined, cfg);
      return { id: entityId, data };
    }
    const q = payload ? `?${new URLSearchParams(this.buildQuery(payload)).toString()}` : '';
    const data = await this.request<{ data?: unknown[] }>(`${cfg.restEndpoint}/${resource}${q}`, 'GET', undefined, cfg);
    return { id: resource, data: { data: data.data ?? [] } };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Base pay + payroll results are SOAP-only (Get_Workers/Include_Compensation,
    // Get_Payroll_Results). The client parses the XML into normalized records in a
    // single shot (WWS returns the full set). The RPC layer derives a next-page
    // token from offset pagination + row count, so a >100-row result
    // would otherwise re-request forever; a present pageToken means "page 2+" →
    // return empty to terminate the loop after the first (complete) page.
    if (entityType === 'worker_compensation') return { records: filters?.pageToken ? [] : await this.listWorkerCompensation(), hasMore: false };
    if (entityType === 'payroll_results') return { records: filters?.pageToken ? [] : await this.listPayrollResults(filters), hasMore: false };
    if (entityType === 'federal_w4') return { records: filters?.pageToken ? [] : await this.listFederalW4(), hasMore: false };
    if (entityType === 'federal_tax_params') return { records: filters?.pageToken ? [] : await this.listFederalTaxParams(), hasMore: false };
    if (entityType === 'withholding_orders') return { records: filters?.pageToken ? [] : await this.listWithholdingOrders(), hasMore: false };
    const credentials = await this.credentialProvider();
    const cfg = this.resolveConfig(credentials);
    const resource = entityType === 'worker' || entityType === 'workers' ? 'workers' : entityType;
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    if (filters?.pageToken) query['offset'] = filters.pageToken;
    const q = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const body = await this.request<{ data?: Array<Record<string, unknown>>; total?: number }>(`${cfg.restEndpoint}/${resource}${q}`, 'GET', undefined, cfg);
    const rows = body.data ?? [];
    const records = rows.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), data: r }));
    const offset = filters?.pageToken ? Number(filters.pageToken) : 0;
    const nextOffset = offset + rows.length;
    return { records, hasMore: !!body.total && nextOffset < body.total, nextPageToken: String(nextOffset) };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(await this.genExec(), await this.genCtx(), entityType, data);
    const soapEntity = this.parseSoapEntity(entityType);
    if (soapEntity) {
      try {
        const xml = await this.soapOperation(soapEntity.service, soapEntity.operation, this.soapBody(data), data?.version ? String(data.version) : undefined);
        return { success: true, id: soapEntity.operation, data: { response: xml } };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    const credentials = await this.credentialProvider();
    const cfg = this.resolveConfig(credentials);
    try {
      // SOAP/WWS business-process write (Change_Job, Hire, Terminate, …) — raw XML form.
      if (entityType === 'soap') {
        const service = String(data.service ?? 'Staffing');
        const operationXml = String(data.operationXml ?? '');
        if (!operationXml) return { success: false, id: '', error: 'Workday SOAP: operationXml is required' };
        const xml = await this.soapRequest(service, operationXml, data.version ? String(data.version) : undefined);
        return { success: true, id: 'soap', data: { response: xml } };
      }
      // WQL query — a read executed via POST. Dispatched here because run_wql
      // doesn't prefix-match an update verb.
      if (entityType === 'wql') {
        const query = String(data.query ?? '');
        if (!query) return { success: false, id: '', error: 'Workday WQL: query is required' };
        const host = cfg.tenantHost || cfg.restEndpoint.replace(/\/ccx\/.*/, '');
        const url = `${host}/ccx/api/wql/v1/${cfg.tenant}/data`;
        const result = await this.request<Record<string, unknown>>(url, 'POST', { query }, cfg);
        return { success: true, id: 'wql', data: result };
      }
      if (entityType === 'native') {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Workday native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(`${cfg.restEndpoint}${path}`, method, data.body as Record<string, unknown> | undefined, cfg);
        return { success: true, id: 'native', data: result };
      }
      const resource = entityType === 'worker' ? 'workers' : entityType;
      const result = await this.request<Record<string, unknown>>(`${cfg.restEndpoint}/${resource}`, 'POST', data, cfg);
      return { success: true, id: String((result.id ?? '') as string), data: result };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(await this.genExec(), await this.genCtx(), entityType, entityId, data);
    const soapEntity = this.parseSoapEntity(entityType);
    if (soapEntity) {
      try {
        const xml = await this.soapOperation(soapEntity.service, soapEntity.operation, this.soapBody(data), data?.version ? String(data.version) : undefined);
        return { success: true, data: { response: xml } };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    const credentials = await this.credentialProvider();
    const cfg = this.resolveConfig(credentials);
    try {
      if (entityType === 'native') {
        const method = String(data.method ?? 'PATCH').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Workday native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(`${cfg.restEndpoint}${path}`, method, data.body as Record<string, unknown> | undefined, cfg);
        return { success: true, data: result };
      }
      if (!entityId) return { success: false, error: `Workday: update ${entityType} requires entityId` };
      const resource = entityType === 'worker' ? 'workers' : entityType;
      const result = await this.request<Record<string, unknown>>(`${cfg.restEndpoint}/${resource}/${entityId}`, 'PATCH', data, cfg);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string | undefined, _payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(await this.genExec(), await this.genCtx(), entityType, entityId, _payload);
    const soapEntity = this.parseSoapEntity(entityType);
    if (soapEntity) {
      try {
        await this.soapOperation(soapEntity.service, soapEntity.operation, this.soapBody(_payload), _payload?.version ? String(_payload.version) : undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    // Workday Common REST has no generic hard-delete; lifecycle changes go through
    // business processes (use a Change_/End_ WWS operation or workday_native_request).
    return { success: false, error: 'Workday: delete not supported via Common REST — use a business-process (SOAP WWS) operation or workday_native_request' };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, _originalAction: string, _entityId: string | undefined): Promise<DeleteResult | UpdateResult> {
    return { success: false, error: `Workday: semantic inverse not supported for ${entityType} without a snapshot` };
  }

  private buildQuery(payload?: Record<string, unknown>): Record<string, string> {
    if (!payload) return {};
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (['id', 'entityType', 'method', 'path', 'body', 'reportUrl', 'query'].includes(k)) continue;
      if (v != null) q[k] = String(v);
    }
    return q;
  }
}
