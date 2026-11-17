// Microsoft OneDrive Connector Client
// Per Section 11 & 12: Real Microsoft OneDrive API implementation

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

export class MicrosoftOneDriveClient implements CompensationClient {
  readonly connector = 'microsoft_onedrive';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { query?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();
    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    // microsoft_onedrive is composio_managed, so getCredentials returns
    // accessToken: '' — Composio holds the grant and the only way to spend it
    // is the signed proxy. This client is still reached on the POLLING path
    // (the scheduler calls list('File')), so without this it would send
    // `Bearer ` on every poll and Graph would answer 401 while the Connections
    // page showed the connector healthy — the Gmail failure that
    // composio-no-raw-bearer.test.ts exists to prevent, which is what caught
    // this flip.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: url,
      body,
    });
    if (composio.handled) return composio.data as T;

    const response = await fetch(url, {
      method,
      headers: {
        // bearerFor throws a named error instead of interpolating an empty
        // token, so a mis-wired credential fails loudly rather than as a 401
        // indistinguishable from a revoked grant.
        Authorization: `Bearer ${bearerFor(credentials, 'microsoft_onedrive')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft OneDrive API error', { status: response.status, error, path });
      throw new Error(`Microsoft OneDrive API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft OneDrive read', { entityType, entityId });

    switch (entityType) {
      case 'files': {
        const p = payload ?? {};
        const searchQuery = p.query as string | undefined;
        if (searchQuery) {
          const searchResult = await this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
            'GET',
            `/me/drive/root/search(q='${encodeURIComponent(searchQuery)}')`,
            undefined,
            { query: { $top: String(p.pageSize ?? 100) } }
          );
          const nextLink = searchResult['@odata.nextLink'];
          const nextSkipToken = nextLink ? new URL(nextLink).searchParams.get('$skiptoken') ?? undefined : undefined;
          return {
            id: 'files',
            data: { files: searchResult.value, nextPageToken: nextSkipToken },
          };
        }
        const result = await this.listFiles({
          folderId: p.folderId as string | undefined,
          pageSize: p.pageSize as number | undefined,
          skipToken: p.skipToken as string | undefined,
        });
        const nextLink = result['@odata.nextLink'];
        const nextSkipToken = nextLink ? new URL(nextLink).searchParams.get('$skiptoken') ?? undefined : undefined;
        return {
          id: 'files',
          data: { files: result.value, nextPageToken: nextSkipToken },
        };
      }

      case 'file':
      case 'folder': {
        if (!entityId) throw new Error('entityId required for file/folder read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/drive/items/${entityId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.eTag,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'folders': {
        const p = payload ?? {};
        const folderPath = p.folderId ? `/me/drive/items/${p.folderId}/children` : '/me/drive/root/children';
        const query: Record<string, string> = {
          $filter: 'file eq null',
          $top: String(p.pageSize ?? 100),
        };
        if (p.skipToken) query['$skiptoken'] = p.skipToken as string;
        const result = await this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
          'GET',
          folderPath,
          undefined,
          { query }
        );
        const nextLink = result['@odata.nextLink'];
        const nextSkipToken = nextLink ? new URL(nextLink).searchParams.get('$skiptoken') ?? undefined : undefined;
        return {
          id: 'folders',
          data: { folders: result.value, nextPageToken: nextSkipToken },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'file' || entityType === 'folder') {
      const f = filters as Record<string, unknown> | undefined;
      const result = await this.listFiles({
        folderId: f?.folderId as string | undefined,
        pageSize: f?.pageSize as number | undefined,
        skipToken: f?.skipToken as string | undefined,
      });

      const nextLink = result['@odata.nextLink'];
      const nextSkipToken = nextLink
        ? new URL(nextLink).searchParams.get('$skiptoken') ?? undefined
        : undefined;

      return {
        records: result.value.map(item => ({
          id: item.id as string,
          data: item,
          lastModified: item.lastModifiedDateTime
            ? new Date(item.lastModifiedDateTime as string)
            : undefined,
        })),
        hasMore: !!nextLink,
        nextPageToken: nextSkipToken,
      };
    }

    return { records: [], hasMore: false, unsupported: true };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft OneDrive create', { entityType });

    try {
      switch (entityType) {
        case 'folder': {
          const parentId = data.parentId || 'root';
          const result = await this.request<{ id: string; name: string }>(
            'POST',
            `/me/drive/items/${parentId}/children`,
            {
              name: data.name,
              folder: {},
              '@microsoft.graph.conflictBehavior': data.conflictBehavior || 'rename',
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
    logger.info('Microsoft OneDrive update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file':
        case 'folder': {
          const updateData: Record<string, any> = {};

          if (data.name) updateData.name = data.name;
          if (data.description) updateData.description = data.description;

          const result = await this.request<{ eTag: string }>(
            'PATCH',
            `/me/drive/items/${entityId}`,
            updateData
          );

          return {
            success: true,
            versionToken: result.eTag,
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
    logger.info('Microsoft OneDrive delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file':
        case 'folder': {
          await this.request<void>(
            'DELETE',
            `/me/drive/items/${entityId}`
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
    logger.info('Microsoft OneDrive restore from snapshot', { entityType, entityId });

    if (entityType === 'file' || entityType === 'folder') {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft OneDrive ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft OneDrive semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['file', 'folder'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted Microsoft OneDrive items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft OneDrive action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listFiles(options: {
    folderId?: string;
    pageSize?: number;
    skipToken?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const folderId = options.folderId || 'root';
    const query: Record<string, string> = {
      $top: (options.pageSize || 100).toString(),
    };

    if (options.skipToken) {
      query.$skiptoken = options.skipToken;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      `/me/drive/items/${folderId}/children`,
      undefined,
      { query }
    );
  }

  async registerWebhook(
    itemId: string,
    channelToken: string,
    notificationUrl: string,
  ): Promise<{ subscriptionId: string; expiresAt: string | null }> {
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.request<{ id: string; expirationDateTime?: string }>(
      'POST',
      '/subscriptions',
      {
        changeType: 'updated',
        notificationUrl,
        resource: `/me/drive/items/${itemId}/children`,
        expirationDateTime: expiresAt,
        clientState: channelToken,
      },
    );
    return { subscriptionId: result.id, expiresAt: result.expirationDateTime ?? null };
  }

  async renewWebhook(subscriptionId: string): Promise<{ expiresAt: string | null }> {
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.request<{ id: string; expirationDateTime?: string }>(
      'PATCH',
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { expirationDateTime: expiresAt },
    );
    return { expiresAt: result.expirationDateTime ?? null };
  }

  async deregisterWebhook(subscriptionId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
}
