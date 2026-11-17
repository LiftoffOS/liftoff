// Box Connector Client
// Per Section 11 & 12: Real Box API implementation

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
import { tryComposioProxy } from './composio-transport.js';

export class BoxClient implements CompensationClient {
  readonly connector = 'box';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://api.box.com/2.0';
  private uploadUrl = 'https://upload.box.com/api/2.0';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { useUploadUrl?: boolean; query?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // composio_managed routing — see clients/composio-transport.ts.
    // Pass the ABSOLUTE vendor URL (same as the direct fetch below). Composio's
    // box toolkit base_url is https://api.box.com/2.0 (already includes /2.0 —
    // verified via GET /api/v3/toolkits/box), so a `/2.0${path}` prefix doubles
    // the segment → 404. The absolute URL is base-inconsistency-proof.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `${options.useUploadUrl ? this.uploadUrl : this.baseUrl}${path}`,
      body,
      query: options.query,
    });
    if (composio.handled) return composio.data;

    const baseUrl = options.useUploadUrl ? this.uploadUrl : this.baseUrl;
    let url = `${baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Box API error', { status: response.status, error, path });
      throw new Error(`Box API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Box read', { entityType, entityId });

    switch (entityType) {
      case 'files': {
        const p = payload ?? {};
        const searchQuery = p.query as string | undefined;
        if (searchQuery) {
          const q: Record<string, string> = {
            query: searchQuery,
            limit: String(p.pageSize ?? 100),
            offset: String(p.offset ?? 0),
            fields: 'id,name,type,parent,modified_at,size',
          };
          if (p.folderId) q.ancestor_folder_ids = String(p.folderId);
          const result = await this.request<{ entries: Array<Record<string, any>>; total_count: number }>(
            'GET',
            '/search',
            undefined,
            { query: q }
          );
          const offset = (p.offset as number ?? 0) + result.entries.length;
          return {
            id: 'files',
            data: { files: result.entries, hasMore: offset < result.total_count, nextPageToken: offset < result.total_count ? String(offset) : undefined },
          };
        }
        const offset = p.offset as number ?? 0;
        const limit = p.pageSize as number ?? 100;
        const result = await this.listFolder({
          folderId: p.folderId as string | undefined,
          limit,
          offset,
        });
        const nextOffset = offset + result.entries.length;
        return {
          id: 'files',
          data: { files: result.entries, hasMore: nextOffset < result.total_count, nextPageToken: nextOffset < result.total_count ? String(nextOffset) : undefined },
        };
      }

      case 'file': {
        if (!entityId) throw new Error('entityId required for file read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/files/${entityId}`,
          undefined,
          { query: { fields: 'id,name,type,parent,modified_at,version_number,size,sha1' } }
        );
        return {
          id: entityId,
          data,
          versionToken: data.version_number?.toString(),
          lastModified: data.modified_at ? new Date(data.modified_at) : undefined,
        };
      }

      case 'folder': {
        if (!entityId) throw new Error('entityId required for folder read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/folders/${entityId}`,
          undefined,
          { query: { fields: 'id,name,type,parent,modified_at,item_collection' } }
        );
        return {
          id: entityId,
          data,
          lastModified: data.modified_at ? new Date(data.modified_at) : undefined,
        };
      }

      case 'folders': {
        const p = payload ?? {};
        const folderId = p.folderId as string ?? '0';
        const limit = p.pageSize as number ?? 100;
        const offset = p.offset as number ?? 0;
        const result = await this.listFolder({ folderId, limit, offset });
        const folderItems = result.entries.filter((e: Record<string, any>) => e.type === 'folder');
        const nextOffset = offset + result.entries.length;
        return {
          id: 'folders',
          data: {
            folders: folderItems,
            hasMore: nextOffset < result.total_count,
            nextPageToken: nextOffset < result.total_count ? String(nextOffset) : undefined,
          },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'file' || entityType === 'folder') {
      const f = filters as Record<string, unknown> | undefined;
      const offset = f?.offset as number ?? 0;
      const limit = f?.pageSize as number ?? 100;

      const result = await this.listFolder({
        folderId: f?.folderId as string | undefined,
        limit,
        offset,
      });

      // 'file' means BOTH — see the same note in dropbox.ts. A tree that gets
      // only files has nothing to open.
      const entries = entityType === 'folder'
        ? result.entries.filter(e => e.type === 'folder')
        : result.entries;

      const nextOffset = offset + entries.length;

      return {
        records: entries.map(entry => ({
          id: entry.id as string,
          data: entry,
          lastModified: entry.modified_at ? new Date(entry.modified_at as string) : undefined,
        })),
        hasMore: nextOffset < result.total_count,
        nextPageToken: nextOffset < result.total_count ? String(nextOffset) : undefined,
      };
    }

    return { records: [], hasMore: false, unsupported: true };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Box create', { entityType });

    try {
      switch (entityType) {
        case 'folder': {
          const result = await this.request<{ id: string; name: string }>(
            'POST',
            '/folders',
            {
              name: data.name,
              parent: { id: data.parentId || '0' },
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  async update(
    entityType: string,
    entityId: string,
    data: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Box update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file': {
          const updateData: Record<string, any> = {};

          if (data.name) updateData.name = data.name;
          if (data.description) updateData.description = data.description;
          if (data.parentId) updateData.parent = { id: data.parentId };

          const result = await this.request<{ version_number: number }>(
            'PUT',
            `/files/${entityId}`,
            updateData
          );

          return {
            success: true,
            versionToken: result.version_number?.toString(),
            data: result,
          };
        }

        case 'folder': {
          const updateData: Record<string, any> = {};

          if (data.name) updateData.name = data.name;
          if (data.description) updateData.description = data.description;
          if (data.parentId) updateData.parent = { id: data.parentId };

          const result = await this.request<Record<string, any>>(
            'PUT',
            `/folders/${entityId}`,
            updateData
          );

          return {
            success: true,
            data: result,
          };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Box delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file': {
          await this.request<void>(
            'DELETE',
            `/files/${entityId}`
          );
          return { success: true };
        }

        case 'folder': {
          await this.request<void>(
            'DELETE',
            `/folders/${entityId}`,
            undefined,
            { query: { recursive: 'true' } }
          );
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type: ${entityType}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  async restore(
    entityType: string,
    entityId: string,
    snapshot: Record<string, any>
  ): Promise<UpdateResult> {
    logger.info('Box restore from snapshot', { entityType, entityId });

    // Box has trash - restore from trash if possible
    if (entityType === 'file' || entityType === 'folder') {
      try {
        const endpoint = entityType === 'file' ? '/files' : '/folders';
        const result = await this.request<Record<string, any>>(
          'POST',
          `${endpoint}/${entityId}`,
          {
            name: snapshot.name,
            parent: snapshot.parent,
          }
        );

        return {
          success: true,
          data: result,
        };
      } catch {
        // If restore from trash failed, try regular update
        return this.update(entityType, entityId, snapshot);
      }
    }

    return {
      success: false,
      error: `Cannot restore Box ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Box semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['file', 'folder'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        // Box items go to trash - try to restore
        try {
          const endpoint = entityType === 'file' ? '/files' : '/folders';
          const result = await this.request<Record<string, any>>(
            'POST',
            `${endpoint}/${entityId}`
          );
          return {
            success: true,
            data: result,
          };
        } catch {
          return {
            success: false,
            error: 'Cannot restore deleted Box items from trash',
          };
        }

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Box action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listFolder(options: {
    folderId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ entries: Array<Record<string, any>>; total_count: number }> {
    const folderId = options.folderId || '0';
    const query: Record<string, string> = {
      limit: (options.limit || 100).toString(),
      offset: (options.offset || 0).toString(),
      fields: 'id,name,type,parent,modified_at,size',
    };

    return this.request<{ entries: Array<Record<string, any>>; total_count: number }>(
      'GET',
      `/folders/${folderId}/items`,
      undefined,
      { query }
    );
  }

  async copyFile(fileId: string, options: {
    name?: string;
    parentId: string;
  }): Promise<CreateResult> {
    try {
      const body: Record<string, any> = {
        parent: { id: options.parentId },
      };
      if (options.name) body.name = options.name;

      const result = await this.request<{ id: string; name: string }>(
        'POST',
        `/files/${fileId}/copy`,
        body
      );

      return {
        success: true,
        id: result.id,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        id: '',
        error: (error as Error).message,
      };
    }
  }

  async registerWebhook(
    folderId: string,
    notificationUrl: string,
  ): Promise<{ subscriptionId: string; expiresAt: string | null }> {
    const result = await this.request<{ id: string }>(
      'POST',
      '/webhooks',
      {
        target: { id: folderId, type: 'folder' },
        address: notificationUrl,
        triggers: ['FILE.CREATED', 'FILE.DELETED', 'FOLDER.CREATED', 'FOLDER.DELETED', 'FILE.UPLOADED'],
      },
    );
    return { subscriptionId: result.id, expiresAt: null };
  }

  async deregisterWebhook(webhookId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/webhooks/${encodeURIComponent(webhookId)}`);
  }

  async getWebhookSigningKeys(): Promise<{ primaryKey: string | null; secondaryKey: string | null }> {
    const credentials = await this.credentialProvider();
    const config = credentials.connectorConfig ?? {};
    return {
      primaryKey: (config.webhookSigningKeyPrimary as string | undefined) ?? null,
      secondaryKey: (config.webhookSigningKeySecondary as string | undefined) ?? null,
    };
  }
}
