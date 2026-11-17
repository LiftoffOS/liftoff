// Dropbox Connector Client
// Per Section 11 & 12: Real Dropbox API implementation

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
import { tryComposioProxy, bearerFor } from './composio-transport.js';

export class DropboxClient implements CompensationClient {
  readonly connector = 'dropbox';
  private credentialProvider: CredentialProvider;
  private apiUrl = 'https://api.dropboxapi.com/2';
  private contentUrl = 'https://content.dropboxapi.com/2';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { useContentUrl?: boolean } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // composio_managed routing — see clients/composio-transport.ts.
    // Pass the ABSOLUTE vendor URL (same as the direct fetch below). Composio's
    // dropbox toolkit base_url is bare https://api.dropboxapi.com, so a base
    // path is api-only — content-URL calls (content.dropboxapi.com) would hit
    // the wrong host. The absolute URL targets the correct host for both.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `${options.useContentUrl ? this.contentUrl : this.apiUrl}${path}`,
      body,
    });
    if (composio.handled) return composio.data;

    const baseUrl = options.useContentUrl ? this.contentUrl : this.apiUrl;
    const url = `${baseUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'dropbox')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Dropbox API error', { status: response.status, error, path });
      throw new Error(`Dropbox API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Dropbox read', { entityType, entityId });

    switch (entityType) {
      case 'files': {
        const p = payload ?? {};
        const searchQuery = p.query as string | undefined;
        if (searchQuery) {
          const searchResult = await this.request<{
            matches: Array<{ metadata: { metadata: Record<string, any> } }>;
            has_more: boolean;
            cursor?: string;
          }>(
            'POST',
            '/files/search_v2',
            {
              query: searchQuery,
              options: { path: p.path ?? '', max_results: p.pageSize ?? 100 },
            }
          );
          return {
            id: 'files',
            data: {
              files: searchResult.matches.map(m => m.metadata.metadata),
              hasMore: searchResult.has_more,
              nextPageToken: searchResult.has_more ? searchResult.cursor : undefined,
            },
          };
        }
        const result = await this.listFolder({
          path: p.path as string | undefined,
          limit: p.pageSize as number | undefined,
          cursor: p.cursor as string | undefined,
        });
        return {
          id: 'files',
          data: { files: result.entries, hasMore: result.has_more, nextPageToken: result.has_more ? result.cursor : undefined },
        };
      }

      case 'file':
      case 'folder': {
        if (!entityId) throw new Error('entityId required for file/folder read');
        const data = await this.request<Record<string, any>>(
          'POST',
          '/files/get_metadata',
          { path: entityId }
        );
        return {
          id: entityId,
          data,
          versionToken: data.rev,
          lastModified: data.server_modified ? new Date(data.server_modified) : undefined,
        };
      }

      case 'folders': {
        const p = payload ?? {};
        const result = await this.listFolder({
          path: p.path as string | undefined,
          limit: p.pageSize as number | undefined,
          cursor: p.cursor as string | undefined,
        });
        return {
          id: 'folders',
          data: {
            folders: result.entries.filter((e: Record<string, any>) => e['.tag'] === 'folder'),
            hasMore: result.has_more,
            nextPageToken: result.has_more ? result.cursor : undefined,
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
      const result = await this.listFolder({
        path: f?.path as string | undefined,
        limit: f?.pageSize as number | undefined,
        cursor: f?.pageToken as string | undefined,
      });

      // 'file' means BOTH: the caller is a tree, and it splits the response
      // into folders to open and files to tick. Filtering to files alone left
      // it nothing to expand, so only whatever sat at the current level was
      // ever reachable. 'folder' still narrows, for a destination pick.
      const entries = entityType === 'folder'
        ? result.entries.filter(e => e['.tag'] === 'folder')
        : result.entries;

      return {
        records: entries.map(entry => ({
          id: entry.id as string ?? entry.path_lower as string,
          data: entry,
          lastModified: entry.client_modified
            ? new Date(entry.client_modified as string)
            : undefined,
        })),
        hasMore: result.has_more,
        nextPageToken: result.has_more ? result.cursor : undefined,
        pollCursor: result.cursor,
      };
    }

    return { records: [], hasMore: false, unsupported: true };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Dropbox create', { entityType });

    try {
      switch (entityType) {
        case 'folder': {
          const result = await this.request<{ metadata: { id: string; path_display: string } }>(
            'POST',
            '/files/create_folder_v2',
            {
              path: data.path,
              autorename: data.autorename ?? true,
            }
          );

          return {
            success: true,
            id: result.metadata.id,
            data: result.metadata,
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
    logger.info('Dropbox update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file':
        case 'folder': {
          if (data.newPath) {
            // Move/rename operation
            const result = await this.request<{ metadata: { rev: string } }>(
              'POST',
              '/files/move_v2',
              {
                from_path: entityId,
                to_path: data.newPath,
                autorename: data.autorename ?? false,
              }
            );

            return {
              success: true,
              versionToken: result.metadata.rev,
              data: result.metadata,
            };
          }

          return {
            success: false,
            error: 'No update operation specified',
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
    logger.info('Dropbox delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file':
        case 'folder': {
          await this.request<void>(
            'POST',
            '/files/delete_v2',
            { path: entityId }
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
    logger.info('Dropbox restore from snapshot', { entityType, entityId });

    // Dropbox has version history - attempt to restore to previous revision
    if (entityType === 'file' && snapshot.rev) {
      try {
        const result = await this.request<{ rev: string }>(
          'POST',
          '/files/restore',
          {
            path: entityId,
            rev: snapshot.rev,
          }
        );

        return {
          success: true,
          versionToken: result.rev,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    }

    return {
      success: false,
      error: `Cannot restore Dropbox ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Dropbox semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['file', 'folder'].includes(entityType)) {
          const id = originalResponse.id || originalResponse.path_display || entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Dropbox items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Dropbox action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listFolder(options: {
    path?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ entries: Array<Record<string, any>>; cursor: string; has_more: boolean }> {
    if (options.cursor) {
      return this.request<{ entries: Array<Record<string, any>>; cursor: string; has_more: boolean }>(
        'POST',
        '/files/list_folder/continue',
        { cursor: options.cursor }
      );
    }

    return this.request<{ entries: Array<Record<string, any>>; cursor: string; has_more: boolean }>(
      'POST',
      '/files/list_folder',
      {
        path: options.path || '',
        limit: options.limit || 100,
        include_deleted: false,
      }
    );
  }
}
