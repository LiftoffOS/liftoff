// HiBob Connector Client (native, first-party).
//
// Base URL: https://api.hibob.com/v1
// Auth: HTTP Basic with a HiBob Service User — base64(serviceUserId:token).
// The customer creates the Service User in HiBob (Settings → Integrations →
// Service users) and pastes its id + token during connect — no Liftoff-side app
// and no HiBob partner review. Fully native, customer-tenant-authorized.
//
// Credential convention (api_key flow, direct-vault → connectorConfig):
//   credentials.connectorConfig.serviceUserId  → the Service User ID
//   credentials.connectorConfig.token          → the Service User token
//
// Native first-party HRIS client. Curated + generated tools
// carry templated entityTypes ("METHOD /path") routed through templated-
// dispatch. `native` is the raw passthrough.

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

const BASE_URL = 'https://api.hibob.com/v1';

export class HiBobClient implements CompensationClient {
  readonly connector = 'hibob';
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
    const cfg = (c.connectorConfig ?? {}) as Record<string, unknown>;
    const serviceUserId = String(cfg.serviceUserId ?? '');
    const token = String(cfg.token ?? c.accessToken ?? '');
    if (!serviceUserId || !token) {
      throw new Error('HiBob credential missing serviceUserId/token (connectorConfig.serviceUserId/token)');
    }
    const basic = Buffer.from(`${serviceUserId}:${token}`).toString('base64');
    const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    const res = await fetch(`${BASE_URL}${path}${q}`, {
      method,
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('HiBob API error', { status: res.status, path, method });
      throw new Error(`HiBob API ${res.status}: ${text}`);
    }
    return res.status === 204 ? ({} as T) : (res.json() as Promise<T>);
  }

  private genExec(): LowLevelRequest {
    return (m, p, b, q) => this.request(m, p, b, q);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    if (isTemplatedEntity(entityType)) return templatedRead(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      const method = String(payload?.method ?? 'GET').toUpperCase();
      const path = String(payload?.path ?? '');
      if (!path.startsWith('/')) throw new Error('HiBob native_request: path must start with "/"');
      const data = await this.request<unknown>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
      return { id: 'native', data: data as Record<string, unknown> };
    }
    throw new Error(`HiBob: unsupported read entityType "${entityType}"`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const path = isTemplatedEntity(entityType) ? entityType.replace(/^GET\s+/i, '') : `/${entityType}`;
    const query: Record<string, string> = {};
    if (filters?.limit) query['limit'] = String(filters.limit);
    const body = await this.request<Record<string, any>>('GET', path, undefined, query);
    const rows: unknown[] = Array.isArray(body?.employees)
      ? body.employees
      : Array.isArray(body?.values)
        ? body.values
        : Array.isArray(body?.data)
          ? body.data
          : [];
    const records = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => r?.id != null)
      .map((r) => ({ id: String(r.id), data: r }));
    return { records, hasMore: false };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (isTemplatedEntity(entityType)) return templatedCreate(this.genExec(), {}, entityType, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'POST').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, id: '', error: 'HiBob native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, id: String(result?.id ?? 'native'), data: result };
      } catch (error) {
        return { success: false, id: '', error: (error as Error).message };
      }
    }
    return { success: false, id: '', error: `HiBob: unsupported create entityType "${entityType}"` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (isTemplatedEntity(entityType)) return templatedUpdate(this.genExec(), {}, entityType, entityId, data);
    if (entityType === 'native') {
      try {
        const method = String(data.method ?? 'PUT').toUpperCase();
        const path = String(data.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'HiBob native_request: path must start with "/"' };
        const result = await this.request<Record<string, unknown>>(method, path, data.body as Record<string, unknown> | undefined, data.query as Record<string, string> | undefined);
        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `HiBob: unsupported update entityType "${entityType}"` };
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    if (isTemplatedEntity(entityType)) return templatedDelete(this.genExec(), {}, entityType, entityId, payload);
    if (entityType === 'native') {
      try {
        const method = String(payload?.method ?? 'DELETE').toUpperCase();
        const path = String(payload?.path ?? '');
        if (!path.startsWith('/')) return { success: false, error: 'HiBob native_request: path must start with "/"' };
        await this.request<void>(method, path, payload?.body as Record<string, unknown> | undefined, payload?.query as Record<string, string> | undefined);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `HiBob: unsupported delete entityType "${entityType}"` };
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create') {
      return this.delete(entityType, entityId ?? String(originalResponse.id ?? ''));
    }
    return { success: false, error: `HiBob: cannot invert ${originalAction} on ${entityType} without a snapshot` };
  }
}
