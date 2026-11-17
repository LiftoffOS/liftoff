// ADP Connector Client (native, first-party) — shared by ADP RUN and ADP
// Workforce Now (product chosen by `this.connector`).
//
// Base URL: https://api.adp.com
// Auth: OAuth2 client_credentials mint against https://accounts.adp.com over
// MUTUAL TLS. ADP API Central issues the customer a client id/secret AND a
// client certificate + private key (PEM); every call — token mint and API —
// must present that client cert. The customer pastes clientId + clientSecret +
// certificatePem + privateKeyPem during connect. No Liftoff-side app and no ADP
// partner review beyond the customer's own API Central enrollment. Fully native.
//
// mTLS note: Node's global fetch (undici) ignores the `agent` option and undici
// is not a direct dependency here, so we issue requests through node:https with
// an https.Agent carrying the client cert/key — the plan's `https.request`
// fallback. This is the new per-connection mTLS capability this client adds.
//
// Credential convention (api_key flow, direct-vault → connectorConfig):
//   credentials.connectorConfig.{ clientId, clientSecret, certificatePem, privateKeyPem }
//
// Native first-party HRIS client. Curated + generated tools
// carry templated entityTypes ("METHOD /path") routed through templated-dispatch.

import https from 'node:https';
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

const API_BASE = 'https://api.adp.com';
const TOKEN_URL = 'https://accounts.adp.com/auth/oauth/v2/token';

interface AdpConfig { clientId: string; clientSecret: string; certificatePem: string; privateKeyPem: string; }
interface CachedToken { accessToken: string; expiresAt: number; }

const tokenCache = new Map<string, CachedToken>();

interface RawResponse { status: number; text: string; }

export class AdpClient implements CompensationClient {
  readonly connector: string;
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider, connector: string = 'adp_workforce_now') {
    this.credentialProvider = credentialProvider;
    this.connector = connector;
  }

  private resolveConfig(credentials: ConnectorCredentials): AdpConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    const certificatePem = String(cfg.certificatePem ?? '');
    const privateKeyPem = String(cfg.privateKeyPem ?? '');
    if (!clientId || !clientSecret || !certificatePem || !privateKeyPem) {
      throw new Error('ADP credential missing clientId/clientSecret/certificatePem/privateKeyPem in connectorConfig');
    }
    return { clientId, clientSecret, certificatePem, privateKeyPem };
  }

  /** Per-connection mTLS agent presenting the customer's ADP client cert. */
  private agent(cfg: AdpConfig): https.Agent {
    return new https.Agent({ cert: cfg.certificatePem, key: cfg.privateKeyPem });
  }

  /** Promise wrapper over https.request so the client cert (agent) is honoured
   *  — Node's global fetch drops the `agent` option. */
  private httpsRequest(url: string, opts: { method: string; headers: Record<string, string>; body?: string; agent: https.Agent }): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        { hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method: opts.method, headers: opts.headers, agent: opts.agent },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
        },
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  private async mintToken(cfg: AdpConfig): Promise<string> {
    const cacheKey = cfg.clientId;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const { status, text } = await this.httpsRequest(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'grant_type=client_credentials',
      agent: this.agent(cfg),
    });
    if (status >= 400) throw new Error(`ADP token error: ${status} - ${text}`);
    const json = JSON.parse(text) as { access_token: string; expires_in?: number };
    const entry: CachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    tokenCache.set(cacheKey, entry);
    return entry.accessToken;
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>, cfg?: AdpConfig): Promise<T> {
    const resolved = cfg ?? this.resolveConfig(await this.credentialProvider());
    const token = await this.mintToken(resolved);
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const { status, text } = await this.httpsRequest(`${API_BASE}${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      agent: this.agent(resolved),
    });
    if (status >= 400) {
      logger.error('ADP API error', { status, path, method, connector: this.connector });
      throw new Error(`ADP API ${status}: ${text}`);
    }
    if (status === 204 || !text) return {} as T;
    return JSON.parse(text) as T;
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
      if (!path.startsWith('/')) throw new Error('ADP native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`ADP: unsupported read entityType "${entityType}"`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'payroll_output') return { records: filters?.pageToken ? [] : await this.listPayrollOutput(), hasMore: false };
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['$top'] = String(filters.limit);
    if (filters?.pageToken) query['$skip'] = filters.pageToken;
    const body = await this.request<Record<string, any>>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(body?.workers) ? body.workers : Array.isArray(body?.data) ? body.data : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r != null)
      .map((r) => ({ id: String(r.associateOID ?? r.aoid ?? r.id ?? ''), data: r }));
    return { records, hasMore: false };
  }

  /**
   * Per-associate EMPLOYER burden from the ADP Payroll Output (Turbo) API (→ hris
   * company_payroll_run_items). GATED: the Payroll Output API is a SEPARATE product
   * with its own OAuth scope/entitlement beyond the HR/pay-statement scopes this
   * client normally holds — INERT (403 → empty) without it.
   *
   * The output is per payroll run at the associate-payment level. We flatten each
   * output's associatePayments[] into per-associate rows keyed by associateOID,
   * stamped with a best-effort payroll-output (run) id, and carrying the raw
   * statutoryDeductions[] / reportableEarningsAndBenefits[] / thirdPartyPayments[]
   * arrays for the mapper to sum. (ADP suppresses $0.00 amounts, so absent employer
   * amounts read as 0.) Verified vs ADP's Payroll Output API guide.
   */
  async listPayrollOutput(): Promise<ExternalRecord[]> {
    let body: Record<string, unknown>;
    try {
      body = await this.request<Record<string, unknown>>('GET', '/payroll/v1/payroll-output');
    } catch (e) {
      // Missing entitlement/scope → treat as inert (no burden) rather than failing the sync.
      logger.warn('ADP payroll-output unavailable (gated scope?)', { connector: this.connector, error: (e as Error).message });
      return [];
    }
    const outputs = ['payrollOutputs', 'payrollOutput', 'payroll', 'outputs']
      .map((k) => body[k]).find((v) => Array.isArray(v)) as Array<Record<string, unknown>> | undefined ?? [];
    const out: ExternalRecord[] = [];
    for (const o of outputs) {
      const runId = String(
        o['itemID'] ?? o['payrollOutputId'] ?? o['payrollProcessResultID'] ??
        [o['payrollGroupCode'], o['payrollWeekEndingDate'] ?? o['payCycleCode']].filter(Boolean).join(':') ?? '',
      );
      const payments = Array.isArray(o['associatePayments']) ? (o['associatePayments'] as Array<Record<string, unknown>>) : [];
      for (const p of payments) {
        const aoid = String(p['associateOID'] ?? p['aoid'] ?? '');
        if (!aoid) continue;
        out.push({ id: `${runId}:${aoid}`, data: { id: `${runId}:${aoid}`, payrollOutputId: runId, ...p } });
      }
    }
    return out;
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(await this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'ADP native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `ADP: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(await this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'ADP native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `ADP: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(await this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'ADP native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `ADP: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `ADP: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
