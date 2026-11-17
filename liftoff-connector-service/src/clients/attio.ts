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

// Attio object slugs for standard objects
const OBJECT_SLUG: Record<string, string> = {
  person: 'people',
  company: 'companies',
  deal: 'deals',
};

export class AttioClient implements CompensationClient {
  readonly connector = 'attio';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://api.attio.com/v2';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const credentials = await this.credentialProvider();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      logger.error('Attio API error', { status: response.status, path, method, error: errorText.slice(0, 500) });
      throw new Error(`Attio API error: ${response.status} - ${path}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    logger.info('Attio read', { entityType, entityId });

    switch (entityType) {
      case 'people':
      case 'companies':
      case 'deals': {
        const p = payload ?? {};
        const data = await this.request<{ data: Array<Record<string, unknown>> }>(
          'POST',
          `/objects/${entityType}/records/query`,
          { filter: p.filter ?? {}, limit: p.limit ?? 20, offset: p.offset ?? 0 }
        );
        return { id: entityType, data: { records: data.data } };
      }

      case 'notes': {
        const data = await this.request<{ data: Array<Record<string, unknown>> }>('GET', '/notes');
        return { id: 'notes', data: { notes: data.data } };
      }

      case 'tasks': {
        const data = await this.request<{ data: Array<Record<string, unknown>> }>('GET', '/tasks');
        return { id: 'tasks', data: { tasks: data.data } };
      }

      case 'person':
      case 'company':
      case 'deal': {
        const slug = OBJECT_SLUG[entityType];
        if (!entityId) throw new Error(`entityId required for Attio ${entityType}`);
        const data = await this.request<{ data: Record<string, unknown> }>(
          'GET',
          `/objects/${slug}/records/${entityId}`
        );
        return {
          id: entityId,
          data: data.data,
          lastModified: data.data.updated_at ? new Date(data.data.updated_at as string) : undefined,
        };
      }

      case 'note': {
        if (!entityId) throw new Error('entityId required for Attio note');
        const data = await this.request<{ data: Record<string, unknown> }>(
          'GET',
          `/notes/${entityId}`
        );
        return { id: entityId, data: data.data };
      }

      case 'task': {
        if (!entityId) throw new Error('entityId required for Attio task');
        const data = await this.request<{ data: Record<string, unknown> }>(
          'GET',
          `/tasks/${entityId}`
        );
        return { id: entityId, data: data.data };
      }

      case 'list': {
        const objectSlug = (payload?.object as string) || 'people';
        const data = await this.request<{ data: unknown[] }>(
          'POST',
          `/objects/${objectSlug}/records/query`,
          { filter: payload?.filter || {}, limit: payload?.limit || 20 }
        );
        return { id: objectSlug, data: { records: data.data } };
      }

      default:
        throw new Error(`Unsupported Attio entity type: ${entityType}`);
    }
  }

  // Polling entityType → Attio object slug. The reactive scheduler calls
  // list('Contact') and list('Deal') separately; each maps to the object whose
  // records/query endpoint we hit.
  private static readonly POLL_OBJECT: Record<string, 'people' | 'deals'> = {
    Contact: 'people',
    Deal: 'deals',
  };

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const object = AttioClient.POLL_OBJECT[entityType];
    if (!object) return { records: [], hasMore: false, unsupported: true };

    const limit = filters?.limit ?? 100;
    const offset = filters?.pageToken ? Number(filters.pageToken) || 0 : 0;

    // Attio records expose `created_at` at the top level; there is no documented
    // top-level updated_at to sort on, so we order newest-first by created_at to
    // surface fresh records each poll. `since` is best-effort filtered client-side
    // below (the query API filters on attribute values, not the system created_at).
    const body: Record<string, unknown> = {
      limit,
      offset,
      sorts: [{ attribute: 'created_at', direction: 'desc' }],
    };

    const result = await this.request<{ data: Array<Record<string, any>> }>(
      'POST',
      `/objects/${object}/records/query`,
      body,
    );

    const rows = result.data ?? [];

    const records: ExternalRecord[] = rows
      .filter(r => {
        if (!(filters?.since instanceof Date)) return true;
        const created = r.created_at ? new Date(r.created_at as string).getTime() : 0;
        return created >= filters.since.getTime();
      })
      .map(r => ({
        id: String(r.id?.record_id ?? r.id ?? ''),
        // Stamp a discriminator so the (entityType-blind) normalizer can tell a
        // people row from a deals row when it receives { results: [...] }.
        data: { ...r, __attioObject: object },
        lastModified: r.created_at ? new Date(r.created_at as string) : undefined,
      }));

    // Offset pagination: a full page implies there may be more.
    const hasMore = rows.length === limit;
    const nextPageToken = hasMore ? String(offset + limit) : undefined;

    return { records, nextPageToken, hasMore };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Attio create', { entityType });

    try {
      switch (entityType) {
        case 'person':
        case 'company':
        case 'deal': {
          const slug = OBJECT_SLUG[entityType];
          const result = await this.request<{ data: { id: { record_id: string } } }>(
            'POST',
            `/objects/${slug}/records`,
            { data }
          );
          return { success: true, id: result.data.id.record_id, data: result.data as Record<string, unknown> };
        }

        case 'note': {
          const result = await this.request<{ data: { id: { note_id: string } } }>(
            'POST',
            '/notes',
            data
          );
          return { success: true, id: result.data.id.note_id, data: result.data as Record<string, unknown> };
        }

        case 'task': {
          const result = await this.request<{ data: { id: { task_id: string } } }>(
            'POST',
            '/tasks',
            data
          );
          return { success: true, id: result.data.id.task_id, data: result.data as Record<string, unknown> };
        }

        default:
          return { success: false, id: '', error: `Unsupported Attio entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    if (!entityId) return { success: false, error: 'entityId required for Attio update' };
    logger.info('Attio update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'person':
        case 'company':
        case 'deal': {
          const slug = OBJECT_SLUG[entityType];
          await this.request('PATCH', `/objects/${slug}/records/${entityId}`, { data });
          return { success: true };
        }

        case 'note': {
          await this.request('PATCH', `/notes/${entityId}`, data);
          return { success: true };
        }

        case 'task': {
          await this.request('PATCH', `/tasks/${entityId}`, data);
          return { success: true };
        }

        default:
          return { success: false, error: `Attio does not support updating entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string | undefined): Promise<DeleteResult> {
    if (!entityId) return { success: false, error: 'entityId required for Attio delete' };
    logger.info('Attio delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'person':
        case 'company':
        case 'deal': {
          const slug = OBJECT_SLUG[entityType];
          await this.request('DELETE', `/objects/${slug}/records/${entityId}`);
          return { success: true };
        }

        case 'note': {
          await this.request('DELETE', `/notes/${entityId}`);
          return { success: true };
        }

        case 'task': {
          await this.request('DELETE', `/tasks/${entityId}`);
          return { success: true };
        }

        default:
          return { success: false, error: `Attio does not support deleting entity type: ${entityType}` };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    // Patches the record back to its snapshot state. Only handles update rollback — deleted
    // records cannot be restored via the Attio API and must be recovered manually.
    if (!entityId) return { success: false, error: 'entityId required for restore' };
    const { id: _id, ...properties } = snapshot;
    return this.update(entityType, entityId, properties);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Attio semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        return this.delete(entityType, entityId);
      case 'delete':
        return { success: false, error: 'Cannot restore deleted Attio records — recover manually via the Attio dashboard' };
      case 'update':
        return { success: false, error: 'Update reversal requires a pre-action snapshot' };
      default:
        return { success: false, error: `Unknown action type: ${originalAction}` };
    }
  }
}
