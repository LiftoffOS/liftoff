// UKG Ready (SaaShr / Kronos Workforce Ready) Connector Client (native, first-party).
//
// Base URL: https://{apiHost}/ta/rest/v2   (the customer's UKG Ready / SaaShr
//   API host, e.g. secure.saashr.com / secure4.saashr.com).
// Auth: UKG Ready authenticates with an account username + password + an
// `Api-Key` header and, on success, issues a SHORT-LIVED bearer token (~1h TTL)
// used on subsequent calls (per apidocs at secure.saashr.com/ta/docs/rest/public
// and UKG Ready credential guides). We mint that bearer at connect/first-call
// and cache it. No Liftoff-side app and no UKG partner review. Fully native.
//
// NOTE: UKG Ready's REST docs (and thus the exact login endpoint + body shape +
// bearer-header name) are login-gated, so the mint below is implemented to the
// PUBLICLY-DOCUMENTED auth model (username/password + Api-Key → bearer) and must
// be confirmed against a customer's SaaShr instance at cutover — this is the
// login-gated connector the plan ships curated-first-class + passthrough now.
//
// Credential convention (api_key flow, direct-vault → connectorConfig):
//   credentials.connectorConfig.{ apiHost, companyShortName, username, password, apiKey }
//   companyShortName fills the {cid} path param of company-scoped curated tools.
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

interface UkgReadyConfig { apiHost: string; companyShortName: string; username: string; password: string; apiKey: string; }
interface CachedToken { accessToken: string; expiresAt: number; }

const tokenCache = new Map<string, CachedToken>();

export class UkgReadyClient implements CompensationClient {
  readonly connector = 'ukg_ready';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): UkgReadyConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const apiHost = String(cfg.apiHost ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const companyShortName = String(cfg.companyShortName ?? '');
    const username = String(cfg.username ?? '');
    const password = String(cfg.password ?? '');
    const apiKey = String(cfg.apiKey ?? '');
    if (!apiHost || !username || !password || !apiKey) {
      throw new Error('UKG Ready credential missing apiHost/username/password/apiKey in connectorConfig');
    }
    return { apiHost, companyShortName, username, password, apiKey };
  }

  private async mintToken(cfg: UkgReadyConfig): Promise<string> {
    const cacheKey = `${cfg.apiHost}::${cfg.username}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    // Login → bearer. Api-Key in the header; credentials in the body. Response
    // carries the bearer under `token` (fallback `access_token`).
    const res = await fetch(`https://${cfg.apiHost}/ta/rest/v1/login`, {
      method: 'POST',
      headers: { 'Api-Key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ credentials: { username: cfg.username, password: cfg.password, company: cfg.companyShortName } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`UKG Ready token error: ${res.status} - ${text}`);
    }
    const json = (await res.json()) as { token?: string; access_token?: string; expires_in?: number };
    const token = json.token ?? json.access_token;
    if (!token) throw new Error('UKG Ready token error: login response missing token');
    const entry: CachedToken = { accessToken: token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    tokenCache.set(cacheKey, entry);
    return token;
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>, cfg?: UkgReadyConfig): Promise<T> {
    const resolved = cfg ?? this.resolveConfig(await this.credentialProvider());
    const token = await this.mintToken(resolved);
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`https://${resolved.apiHost}/ta/rest/v2${path}${q}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Api-Key': resolved.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('UKG Ready API error', { status: res.status, path, method });
      throw new Error(`UKG Ready API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  private async genExec(): Promise<LowLevelRequest> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    return (m, p, b, q) => this.request(m, p, b, q, cfg);
  }

  /** Path-param context: {cid} for company-scoped curated tools. */
  private async genCtx(): Promise<Record<string, unknown>> {
    const cfg = this.resolveConfig(await this.credentialProvider());
    return { cid: cfg.companyShortName };
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(await this.genExec(), await this.genCtx(), entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('UKG Ready native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`UKG Ready: unsupported read entityType "${entityType}"`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    const body = await this.request<any>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r != null)
      .map((r) => ({ id: String(r.id ?? ''), data: r }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(await this.genExec(), await this.genCtx(), entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'UKG Ready native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `UKG Ready: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(await this.genExec(), await this.genCtx(), entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PUT').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'UKG Ready native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `UKG Ready: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(await this.genExec(), await this.genCtx(), entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'UKG Ready native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `UKG Ready: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `UKG Ready: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
