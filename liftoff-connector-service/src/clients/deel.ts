// Deel Connector Client (native, first-party).
//
// Base URL: https://api.letsdeel.com/rest/v2
// Auth: a Deel organization API token (Bearer). The customer generates it in
// Deel (Organization Settings → Developer → API tokens) and pastes it during
// connect — no Liftoff-side app and no Deel partner review. Fully native,
// customer-tenant-authorized.
//
// Credential convention (api_key flow):
//   credentials.connectorConfig.apiToken  → the Deel API token
//   (falls back to accessToken for connections stored via the key blob path).
//
// Native first-party HRIS client. Every Curated + generated
// tool carries a templated entityType ("METHOD /path"); read/create/update/
// delete route through templated-dispatch. `native` is the raw passthrough
// escape hatch (fail-secure HITL).

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

const BASE_URL = 'https://api.letsdeel.com/rest/v2';

export class DeelClient implements CompensationClient {
  readonly connector = 'deel';
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
    const token = String(c.connectorConfig?.apiToken ?? c.accessToken ?? '');
    if (!token) throw new Error('Deel credential missing apiToken (connectorConfig.apiToken)');
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`${BASE_URL}${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Deel API error', { status: res.status, path, method });
      throw new Error(`Deel API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  /** LowLevelRequest adapter for templated (codegen'd + curated) tools. */
  private genExec(): LowLevelRequest {
    return (m, p, b, q) => this.request(m, p, b, q);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('Deel native_request: path must start with "/"');
      const query = payload?.query as Record<string, string> | undefined;
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, query);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`Deel: unsupported read entityType "${entityType}"`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Company-level payroll runs require a two-level fan-out (legal entities → each
    // entity's payroll cycles) that templated dispatch can't express — the parent
    // is a legal entity, not an employee, so a per-employee fan-out doesn't drive
    // it. Do it internally. A present pageToken means "page 2+" of an offset
    // pagination → return empty so a >100-run result can't loop this single-shot read.
    if (entityType === 'payroll_runs') return { records: filters?.pageToken ? [] : await this.listPayrollRuns(filters), hasMore: false };
    if (entityType === 'contractor_payments') return { records: filters?.pageToken ? [] : await this.listContractorPayments(filters), hasMore: false };
    if (entityType === 'employer_charges') return { records: filters?.pageToken ? [] : await this.listEmployerCharges(filters), hasMore: false };
    // Generic list over a templated GET; the curated tools read via templated
    // dispatch, so this is only reached for useListMethod/polling callers.
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    if (filters?.pageToken) query['offset'] = filters.pageToken;
    const body = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', path, undefined, query);
    const rows = Array.isArray(body?.data) ? body.data : [];
    const records = rows.filter((r) => r?.id != null).map((r) => ({ id: String(r.id), data: r }));
    return { records, hasMore: false };
  }

  /**
   * Company-level payroll runs = legal entities → per-entity payroll cycles.
   * GET /legal-entities → GET /legal-entities/{id}/payroll-events (Deel's "payroll
   * cycles"). Each cycle carries date_start/date_end but NO gross/net totals (those
   * live behind the separate gp/reports/{id}/gross_to_net chain), so runs land with
   * period + payday only. date_end is the standard payday proxy. Verified against
   * Deel's published OpenAPI (legal-entities + payroll-events).
   */
  async listPayrollRuns(filters?: ListFilters): Promise<ExternalRecord[]> {
    const le = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', '/legal-entities', undefined, { limit: '100' });
    const entities = Array.isArray(le?.data) ? le.data : [];
    const end = new Date();
    const start = filters?.since ?? new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const out: ExternalRecord[] = [];
    for (const ent of entities) {
      const entId = String(ent['id'] ?? '');
      if (!entId) continue;
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) { // safety cap on per-entity cycle pages
        const q: Record<string, string> = { date_start: iso(start), date_end: iso(end), limit: '100' };
        if (cursor) q['cursor'] = cursor;
        const ev = await this.request<{ data?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string }>(
          'GET', `/legal-entities/${entId}/payroll-events`, undefined, q);
        const events = Array.isArray(ev?.data) ? ev.data : [];
        for (const e of events) {
          const runId = String(e['id'] ?? '');
          if (!runId) continue;
          out.push({ id: runId, data: {
            run_id: runId, legal_entity_id: entId, legal_entity_name: ent['name'], type: e['type'],
            period_start: e['date_start'], period_end: e['date_end'], pay_date: e['date_end'],
          } });
        }
        if (!ev?.has_more || !ev?.next_cursor) break;
        cursor = ev.next_cursor;
      }
    }
    return out;
  }

  /** Cycle ids across all legal entities (legal-entities → payroll-events). */
  private async collectCycleIds(filters?: ListFilters): Promise<string[]> {
    const le = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', '/legal-entities', undefined, { limit: '100' });
    const entities = Array.isArray(le?.data) ? le.data : [];
    const end = new Date();
    const start = filters?.since ?? new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const ids: string[] = [];
    for (const ent of entities) {
      const entId = String(ent['id'] ?? '');
      if (!entId) continue;
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const q: Record<string, string> = { date_start: iso(start), date_end: iso(end), limit: '100' };
        if (cursor) q['cursor'] = cursor;
        const ev = await this.request<{ data?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string }>(
          'GET', `/legal-entities/${entId}/payroll-events`, undefined, q);
        for (const e of ev?.data ?? []) { const id = String((e as Record<string, unknown>)['id'] ?? ''); if (id) ids.push(id); }
        if (!ev?.has_more || !ev?.next_cursor) break;
        cursor = ev.next_cursor;
      }
    }
    return ids;
  }

  /**
   * Per-employee EMPLOYER burden for Global-Payroll workers (closes Deel W-2 from take-home
   * to full fully-loaded cost). Deel's committed gross-to-net report
   * GET /reports/payroll/cycles/{cycle_id}/gross-to-net returns one row per `contract_oid`
   * with an `items[]` breakdown; each item's `category_group` is a TYPED enum
   * (ADDITIONS/DEDUCTIONS/BENEFITS/CONTRIBUTIONS/INFOS/TOTALS) — no label-matching needed. Per
   * contract: employerTaxes = Σ CONTRIBUTIONS (employer social contributions/taxes),
   * employerBenefits = Σ BENEFITS, grossPay = Σ ADDITIONS; DEDUCTIONS (employee-side) excluded.
   * Keyed to its run by cycle_id (= the PayrollRun run_id from listPayrollRuns), so the burden
   * lands against its run. GP workers only (EOR/IC have no employer payroll run). Cents-
   * accumulated to avoid float drift. Verified vs Deel OpenAPI (cycle G2N v2026-01-01). Cycles
   * without a G2N report (non-GP) are skipped → inert for EOR/IC-only connections.
   */
  async listEmployerCharges(filters?: ListFilters): Promise<ExternalRecord[]> {
    const cycleIds = await this.collectCycleIds(filters);
    const cents = (v: unknown): number => Math.round(Number(v ?? 0) * 100);
    const out: ExternalRecord[] = [];
    for (const cycleId of cycleIds) {
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const q: Record<string, string> = { limit: '100' };
        if (cursor) q['cursor'] = cursor;
        let body: { data?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string };
        try {
          body = await this.request('GET', `/reports/payroll/cycles/${encodeURIComponent(cycleId)}/gross-to-net`, undefined, q);
        } catch { break; } // cycle without a G2N report (non-GP) → skip
        for (const row of body?.data ?? []) {
          const r = row as Record<string, unknown>;
          const contractId = String(r['contract_oid'] ?? '');
          if (!contractId) continue;
          const items = Array.isArray(r['items']) ? (r['items'] as Array<Record<string, unknown>>) : [];
          let erTax = 0, erBen = 0, gross = 0;
          for (const it of items) {
            const g = String(it['category_group'] ?? ''); const c = cents(it['value']);
            if (g === 'CONTRIBUTIONS') erTax += c;
            else if (g === 'BENEFITS') erBen += c;
            else if (g === 'ADDITIONS') gross += c;
          }
          out.push({ id: `${cycleId}:${contractId}`, data: {
            id: `${cycleId}:${contractId}`, employeeExternalId: contractId, payrollRunExternalId: cycleId,
            grossPay: (gross / 100).toFixed(2), employerTaxes: (erTax / 100).toFixed(2), employerBenefits: (erBen / 100).toFixed(2),
          } });
        }
        if (!body?.has_more || !body?.next_cursor) break;
        cursor = body.next_cursor;
      }
    }
    return out;
  }

  /**
   * Per-contractor payments. GET /payments
   * lists the company's payments to Deel including worker details, amount, currency,
   * status and payment method (Deel developer docs — "Retrieve payment receipts").
   * A payment receipt can cover several contractors, so when it carries an inline
   * per-contractor breakdown array we FLATTEN it into per-contractor rows stamped
   * with the parent payment id; otherwise the payment is emitted as a single row.
   * Deel IC payments have NO payroll run, so no payrollRunExternalId is emitted.
   * Field names are extracted defensively by the mapper (Deel's payments schema is
   * portal-gated) — the toCanonical is lossless, so unmapped fields survive in metadata.
   */
  async listContractorPayments(filters?: ListFilters): Promise<ExternalRecord[]> {
    const limit = 100;
    const out: ExternalRecord[] = [];
    for (let offset = 0, page = 0; page < 200; page++) { // safety cap
      const query: Record<string, string> = { limit: String(limit), offset: String(offset) };
      if (filters?.since) query['date_from'] = filters.since.toISOString().slice(0, 10);
      const body = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', '/payments', undefined, query);
      const payments = Array.isArray(body?.data) ? body.data : [];
      for (const p of payments) {
        const paymentId = String(p['id'] ?? '');
        // Inline per-contractor breakdown (if the receipt exposes one) → per-contractor rows.
        const breakdown = ['breakdown', 'payments', 'contractors', 'items', 'payment_breakdown']
          .map((k) => p[k]).find((v) => Array.isArray(v)) as Array<Record<string, unknown>> | undefined;
        if (breakdown && breakdown.length) {
          breakdown.forEach((line, i) => {
            out.push({
              id: `${paymentId}:${String(line['id'] ?? line['worker_id'] ?? line['contractor_id'] ?? i)}`,
              data: { payment_id: paymentId, payment_method: p['payment_method'] ?? p['method'], paid_at: p['paid_at'] ?? p['created_at'], currency: p['currency'], ...line },
            });
          });
        } else if (paymentId) {
          out.push({ id: paymentId, data: p });
        }
      }
      if (payments.length < limit) break;
      offset += payments.length;
    }
    return out;
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Deel native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `Deel: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PATCH').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Deel native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Deel: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Deel native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Deel: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `Deel: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
