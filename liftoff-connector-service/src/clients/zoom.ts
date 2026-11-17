// Zoom REST Connector Client
// Auth: OAuth2 Bearer token via CredentialProvider closure.
// Base URL: https://api.zoom.us/v2

import type {
  CompensationClient,
  CredentialProvider,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';

const ZOOM_API_BASE = 'https://api.zoom.us/v2';

export class ZoomClient implements CompensationClient {
  readonly connector = 'zoom';

  constructor(private readonly credentialProvider: CredentialProvider) {}

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const { accessToken } = await this.credentialProvider();
    const resp = await fetch(`${ZOOM_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) throw new Error(`Zoom REST ${method} ${path} failed: ${resp.status}`);
    if (resp.status === 204) return {} as T;
    return resp.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string): Promise<ExternalRecord> {
    if (entityType === 'Meeting') {
      const data = await this.request<Record<string, unknown>>('GET', `/meetings/${entityId}`);
      return { id: entityId, data };
    }
    throw new Error(`ZoomClient: unsupported read for ${entityType}`);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'Meeting') {
      const params = new URLSearchParams({
        type: 'scheduled',
        page_size: String(filters?.limit ?? 100),
      });
      if (filters?.pageToken) params.set('next_page_token', filters.pageToken);
      const data = await this.request<{
        meetings?: Record<string, unknown>[];
        next_page_token?: string;
      }>('GET', `/users/me/meetings?${params}`);
      return {
        records: (data.meetings ?? []).map(m => ({ id: String(m['id']), data: m })),
        nextPageToken: data.next_page_token || undefined,
        hasMore: !!data.next_page_token,
      };
    }
    return { records: [], hasMore: false, unsupported: true };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    if (entityType === 'Meeting') {
      const result = await this.request<{ id: string | number }>('POST', '/users/me/meetings', data);
      return { success: true, id: String(result.id), data: result as Record<string, unknown> };
    }
    return { success: false, id: '', error: `ZoomClient: unsupported create for ${entityType}` };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (entityType === 'Meeting' && entityId) {
      await this.request('PATCH', `/meetings/${entityId}`, data);
      return { success: true };
    }
    return { success: false, error: `ZoomClient: unsupported update for ${entityType}` };
  }

  async delete(entityType: string, entityId: string | undefined): Promise<DeleteResult> {
    if (entityType === 'Meeting' && entityId) {
      await this.request('DELETE', `/meetings/${entityId}`);
      return { success: true };
    }
    return { success: false, error: `ZoomClient: unsupported delete for ${entityType}` };
  }

  async restore(_entityType: string, _entityId: string | undefined, _snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return { success: false, error: 'ZoomClient does not support restore' };
  }

  async semanticInverse(entityType: string, _originalAction: string, entityId: string | undefined, _originalResponse?: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    return this.delete(entityType, entityId);
  }
}
