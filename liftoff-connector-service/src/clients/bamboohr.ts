// BambooHR Connector Client (native, first-party).
//
// Base URL: https://{subdomain}.bamboohr.com  (host only — each tool's entityType carries
//           its full versioned path, e.g. /api/v1, /api/v1_2, /api/v2).
// Auth: the customer connects via our BambooHR developer-portal OAuth app → the vaulted
//       OAuth access token is sent as `Authorization: Bearer`.
//
// The subdomain is resolved from whichever field the connect flow persisted:
//   connectorConfig.subdomain (native connect) · connectorConfig.externalAccountId
//   (api-key identity fetcher) · instanceUrl (OAuth callback / legacy).
//
// Every curated + generated tool carries a templated entityType ("METHOD /path");
// read/create/update/delete route through templated-dispatch. `native` is the raw
// passthrough escape hatch (fail-secure HITL) — the bamboohr_native_request tool.

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

/** Resolve the BambooHR company subdomain from whichever field the connect flow
 *  persisted, tolerating a bare subdomain, a "{sub}.bamboohr.com" host, or a full URL. */
function resolveSubdomain(c: ConnectorCredentials): string {
  const cfg = c.connectorConfig ?? {};
  const raw = String(
    (cfg.subdomain as string | undefined) ??
    (cfg.externalAccountId as string | undefined) ??
    c.instanceUrl ??
    '',
  ).trim();
  if (!raw) return '';
  // Strip scheme + path if a URL was stored, then take the first host label.
  const host = raw.replace(/^https?:\/\//i, '').split('/')[0];
  return host.replace(/\.bamboohr\.com$/i, '').split('.')[0];
}

/** Native passthrough paths default to the /api/v1 prefix; a caller can pass a full
 *  versioned path (/api/v1_2/…, /api/v2/…) to reach a non-v1 endpoint directly. */
function withApiVersion(path: string): string {
  return path.startsWith('/api/') ? path : `/api/v1${path}`;
}

/** The current compensation row = the one with the latest startDate (BambooHR appends a
 *  new row each time pay changes), tie-broken by the higher numeric row id. */
function pickLatestComp(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return rows.reduce((a, b) => {
    const sa = String(a['startDate'] ?? ''), sb = String(b['startDate'] ?? '');
    if (sb !== sa) return sb > sa ? b : a;
    return (Number(b['id'] ?? 0) > Number(a['id'] ?? 0)) ? b : a;
  });
}

export class BambooHRClient implements CompensationClient {
  readonly connector = 'bamboohr';
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
    const subdomain = resolveSubdomain(c);
    if (!subdomain) throw new Error('BambooHR credential missing company subdomain (connectorConfig.subdomain / externalAccountId / instanceUrl)');
    const token = String(c.accessToken ?? (c.connectorConfig?.apiKey as string | undefined) ?? '');
    if (!token) throw new Error('BambooHR credential missing token (OAuth accessToken or API key)');

    // OAuth Bearer (BambooHR developer-portal app).
    const authHeader = `Bearer ${token}`;

    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    // Base is the bare company host; every entityType carries its full versioned path
    // (/api/v1, /api/v1_2, /api/v2 — BambooHR spreads endpoints across API versions).
    const res = await fetch(`https://${subdomain}.bamboohr.com${path}${q}`, {
      method,
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('BambooHR API error', { status: res.status, path, method });
      throw new Error(`BambooHR API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  /** LowLevelRequest adapter for templated (codegen'd + curated) tools. */
  private genExec(): LowLevelRequest {
    return (m, p, b, q) => this.request(m, p, b, q);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.genExec(), {}, entityType, entityId, payload);
    // Current base pay for one employee. BambooHR's compensation table returns the
    // FULL history; callers want the single current compensation, so we return
    // ONLY the latest row (max startDate) as a
    // one-element list under `compensation`, read as a per-parent list.
    if (entityType === 'employee_compensation_current') {
      const empId = entityId ?? String(payload?.id ?? '');
      if (!empId) throw new Error('BambooHR compensation: employee id required');
      const rows = await this.request<unknown>('GET', withApiVersion(`/api/v1/employees/${empId}/tables/compensation`));
      const arr = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
      const latest = arr.length ? pickLatestComp(arr) : undefined;
      return { id: empId, data: { compensation: latest ? [latest] : [] } };
    }
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('BambooHR native_request: path must start with "/"');
      const query = payload?.query as Record<string, string> | undefined;
      const data = await this.request<unknown>(method, withApiVersion(path), payload?.body as Record<string, unknown> | undefined, query);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`BambooHR: unsupported read entityType "${entityType}"`);
  }

  /** list('Employee') — reactive polling source (feeds the bamboohr normalizer).
   *  BambooHR's directory endpoint returns the full company roster with no
   *  incremental `since` filter and no pagination, so we return every employee in
   *  one page; the polling scheduler dedups by version hash. */
  async list(entityType: string, _filters?: ListFilters): Promise<ListResult> {
    // Full per-employee profile for every employee in ONE call. The directory returns a thin
    // subset; the custom-report API (POST /api/v1/reports/custom?format=JSON with a `fields` list)
    // returns every requested field for all employees. We request the full canonical-relevant set.
    if (entityType === 'employees_full') {
      // Standard BambooHR custom-report field aliases (the response echoes each requested alias as
      // the key). The report always includes `id`. Keep to well-known stable aliases so a bad alias
      // can't 400 the whole report.
      const fields = [
        'firstName', 'lastName', 'middleName', 'preferredName', 'employeeNumber', 'displayName', 'status',
        'workEmail', 'homeEmail', 'mobilePhone', 'workPhone', 'homePhone',
        'dateOfBirth', 'hireDate', 'terminationDate',
        'address1', 'address2', 'city', 'stateCode', 'zipcode', 'country',
        'gender', 'maritalStatus', 'ssn',
        'jobTitle', 'department', 'division', 'location', 'supervisor',
      ];
      const resp = await this.request<{ employees?: Array<Record<string, unknown>> }>(
        'POST', '/api/v1/reports/custom', { fields }, { format: 'JSON' });
      const emps = Array.isArray(resp?.employees) ? resp.employees : [];
      const records = emps.filter((e) => e?.id != null).map((e) => ({ id: String(e.id), data: e }));
      return { records, hasMore: false };
    }
    // Per-employee benefit enrollments carrying the employer-paid contribution
    // (companyAmount) alongside the employee deduction (employeeAmount). POST
    // /api/v1/benefit/employee_benefit REQUIRES a `filters` object with at least one of
    // employeeId | companyBenefitId | enrollmentStatusEffectiveDate; filtering by
    // enrollmentStatusEffectiveDate returns every accessible employee's enrollments as of
    // that date, so we pull the whole company as of today and FLATTEN
    // employeeBenefits[].employeeBenefit[] into per-(employee, plan) rows. Each row is
    // stamped with employeeId + companyBenefitId and a synthetic id "<employeeId>:<planId>".
    if (entityType === 'employee_benefits') {
      const asOf = new Date().toISOString().slice(0, 10);
      const resp = await this.request<{ employeeBenefits?: Array<Record<string, unknown>> }>(
        'POST', '/api/v1/benefit/employee_benefit', { filters: { enrollmentStatusEffectiveDate: asOf } });
      const groups = Array.isArray(resp?.employeeBenefits) ? resp.employeeBenefits : [];
      const records: Array<{ id: string; data: Record<string, unknown> }> = [];
      for (const g of groups) {
        const employeeId = String(g['employeeId'] ?? '');
        // The employee's pay frequency lives on the group (per pay schedule), not the per-plan
        // record. A '$' contribution is per deduction occurrence, so carry payFrequency onto each
        // row so callers can normalize the amount to a monthly basis.
        const payFrequency = g['payFrequency'];
        const plans = Array.isArray(g['employeeBenefit']) ? (g['employeeBenefit'] as Array<Record<string, unknown>>) : [];
        for (const p of plans) {
          const companyBenefitId = String(p['companyBenefitId'] ?? '');
          records.push({ id: `${employeeId}:${companyBenefitId}`, data: { ...p, employeeId, companyBenefitId, payFrequency } });
        }
      }
      return { records, hasMore: false };
    }
    // Company benefit plan summaries (GET /api/v1/benefit/company_benefit) — the BenefitPlan
    // parent an enrollment links to via companyBenefitId.
    if (entityType === 'company_benefits') {
      const resp = await this.request<{ companyBenefits?: Array<Record<string, unknown>> }>('GET', '/api/v1/benefit/company_benefit');
      const plans = Array.isArray(resp?.companyBenefits) ? resp.companyBenefits : [];
      const records = plans.filter((p) => p?.id != null).map((p) => ({ id: String(p.id), data: p }));
      return { records, hasMore: false };
    }
    if (entityType !== 'Employee') return { records: [], hasMore: false, unsupported: true };
    const directory = await this.request<{ employees?: Array<Record<string, unknown>> }>('GET', '/api/v1/employees/directory');
    const employees = Array.isArray(directory?.employees) ? directory.employees : [];
    const records = employees
      .filter((emp) => emp?.id != null)
      .map((emp) => ({ id: String(emp.id), data: emp }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'BambooHR native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, withApiVersion(path), data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `BambooHR: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'BambooHR native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, withApiVersion(path), data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `BambooHR: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'BambooHR native_request: path must start with "/"' };
        await this.request<void>(method, withApiVersion(path), payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `BambooHR: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `BambooHR: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
