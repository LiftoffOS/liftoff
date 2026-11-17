// Personio Connector Client (native, first-party).
//
// Base URL: https://api.personio.de/v1
// Auth: OAuth-style client-credentials mint. The customer creates an API
// credential in Personio (Settings → Integrations → API credentials) and pastes
// clientId + clientSecret during connect. We POST them to /auth to mint a bearer
// token (valid ~24h), cached per clientId. No Liftoff-side app and no Personio
// partner review. Fully native, customer-tenant-authorized.
//
// Credential convention (api_key flow, direct-vault → connectorConfig):
//   credentials.connectorConfig.clientId      → the Personio client id
//   credentials.connectorConfig.clientSecret  → the Personio client secret
//
// Native first-party HRIS client. Curated + generated tools
// carry templated entityTypes ("METHOD /path") routed through templated-
// dispatch. `native` is the raw passthrough.

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

// Personio's personnel-data + auth APIs both live under /v1 (per the published
// OpenAPI server url https://api.personio.de/v1). Curated + generated entityTypes
// are the bare paths (/company/employees, /auth), so /v1 belongs on the base.
const BASE_URL = 'https://api.personio.de/v1';

interface PersonioConfig { clientId: string; clientSecret: string; }
interface CachedToken { accessToken: string; expiresAt: number; }

// Shared token cache keyed by clientId — the executor builds a NEW client per
// tool call, so an instance-level cache would re-mint every request.
const tokenCache = new Map<string, CachedToken>();

export class PersonioClient implements CompensationClient {
  readonly connector = 'personio';
  private credentialProvider: CredentialProvider;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private resolveConfig(credentials: ConnectorCredentials): PersonioConfig {
    const cfg = (credentials.connectorConfig ?? {}) as Record<string, unknown>;
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    if (!clientId || !clientSecret) {
      throw new Error('Personio credential missing clientId/clientSecret in connectorConfig');
    }
    return { clientId, clientSecret };
  }

  private async mintToken(cfg: PersonioConfig): Promise<string> {
    const cacheKey = cfg.clientId;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;
    const res = await fetch(`${BASE_URL}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`Personio token error: ${res.status} - ${text}`);
    }
    const json = (await res.json()) as { success?: boolean; data?: { token?: string; expires_in?: number } };
    const token = json.data?.token;
    if (!token) throw new Error('Personio token error: response missing data.token');
    // Personio /auth tokens are valid ~24h; cache conservatively.
    const entry: CachedToken = { accessToken: token, expiresAt: Date.now() + (json.data?.expires_in ?? 86_400) * 1000 };
    tokenCache.set(cacheKey, entry);
    return token;
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, query?: Record<string, string>, cfg?: PersonioConfig): Promise<T> {
    const resolved = cfg ?? this.resolveConfig(await this.credentialProvider());
    const token = await this.mintToken(resolved);
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`${BASE_URL}${path}${q}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('Personio API error', { status: res.status, path, method });
      throw new Error(`Personio API ${res.status}: ${text}`);
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
      if (!path.startsWith('/')) throw new Error('Personio native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`Personio: unsupported read entityType "${entityType}"`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    if (filters?.pageToken) query['offset'] = filters.pageToken;
    const body = await this.request<Record<string, any>>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(body?.data) ? body.data : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r?.id != null)
      .map((r) => ({ id: String(r.id), data: r }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(await this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'Personio native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `Personio: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(await this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PATCH').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Personio native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Personio: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(await this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'Personio native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `Personio: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `Personio: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
