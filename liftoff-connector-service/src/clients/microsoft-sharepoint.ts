// Microsoft SharePoint Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for SharePoint

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

export class MicrosoftSharePointClient implements CompensationClient {
  readonly connector = 'microsoft_sharepoint';
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
      logger.error('Microsoft SharePoint API error', { status: response.status, error, path });
      throw new Error(`Microsoft SharePoint API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft SharePoint read', { entityType, entityId });

    switch (entityType) {
      case 'sites': {
        const p = payload ?? {};
        const result = await this.listSites({
          search: p.search as string | undefined,
          pageSize: p.pageSize as number | undefined,
        });
        return { id: 'sites', data: { sites: result.value } };
      }

      case 'lists': {
        const p = payload ?? {};
        const siteId = p.siteId as string | undefined;
        if (!siteId) throw new Error('siteId is required for list_lists');
        const result = await this.listLists(siteId);
        return { id: 'lists', data: { lists: result.value } };
      }

      case 'drive_items': {
        const p = payload ?? {};
        const siteId = p.siteId as string | undefined;
        if (!siteId) throw new Error('siteId is required for list_drive_items');
        const result = await this.listDriveItems(
          siteId,
          p.folderId as string | undefined,
          { pageSize: p.pageSize as number | undefined }
        );
        return {
          id: 'drive_items',
          data: { items: result.value, nextPageToken: result['@odata.nextLink'] },
        };
      }

      case 'site': {
        if (!entityId) throw new Error('entityId required for site read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/sites/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'list': {
        if (!entityId) throw new Error('entityId required for list read');
        const [siteId, listId] = entityId.split(':');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/sites/${siteId}/lists/${listId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'listItem': {
        if (!entityId) throw new Error('entityId required for listItem read');
        const [siteId, listId, itemId] = entityId.split(':');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/sites/${siteId}/lists/${listId}/items/${itemId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.eTag,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'driveItem': {
        if (!entityId) throw new Error('entityId required for driveItem read');
        const [siteId, itemId] = entityId.split(':');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/sites/${siteId}/drive/items/${itemId}`
        );
        return {
          id: entityId,
          data,
          versionToken: data.eTag,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const f = filters as Record<string, unknown> | undefined;

    // ── Polling path ──────────────────────────────────────────────────────────
    // The scheduler calls list('Document', { since, pageToken, limit }) with no
    // folderId. SharePoint documents are driveItems; enumerate the user's drive
    // via the driveItem search function (q='' → every item the user can see).
    //
    // Endpoint: GET /me/drive/root/search(q='')
    //   - Scope: works under the granted Sites.ReadWrite.All (listed as a valid
    //     higher-privileged permission for driveItem-search).
    //   - Single call, no per-site fan-out.
    //   - Response: { value: driveItem[], '@odata.nextLink'? }.
    //   - Supports $orderby + $top + $skipToken paging. Does NOT support $filter,
    //     so incremental sync relies on $orderby=lastModifiedDateTime desc plus
    //     the scheduler's per-record version dedup (lastModifiedDateTime as the
    //     version token). Folders are skipped so we only emit Documents (files).
    if (entityType === 'Document') {
      const result = await this.searchDriveItems({
        pageSize: (filters?.limit as number | undefined) ?? 100,
        skipToken: filters?.pageToken,
      });
      const files = (result.value ?? []).filter(item => !item.folder);
      return {
        records: files.map(item => ({ id: String(item.id), data: item })),
        nextPageToken: this.extractSkipToken(result['@odata.nextLink']),
        hasMore: !!result['@odata.nextLink'],
      };
    }

    const folderId = f?.folderId as string | undefined;

    // No folderId or entityType=site → list sites with "site:" prefix
    if (!folderId || entityType === 'site') {
      const result = await this.listSites({
        pageSize: f?.pageSize as number | undefined,
        search: f?.search as string | undefined,
      });
      return {
        records: result.value.map(s => ({
          id: `site:${s.id as string}`,
          data: {
            title: s.displayName ?? s.name ?? s.id,
            url: s.webUrl ?? null,
            contentType: 'folder',
            metadata: { type: 'site', siteId: s.id },
          },
        })),
        hasMore: !!result['@odata.nextLink'],
      };
    }

    // folderId starts with "site:" → list root drive items for that site
    if (folderId.startsWith('site:')) {
      const siteId = folderId.slice('site:'.length);
      const result = await this.listDriveItems(siteId, 'root', {
        pageSize: f?.pageSize as number | undefined,
      });
      return this.mapDriveItemsToListResult(result, siteId);
    }

    // folderId starts with "item:" → list children: item:{siteId}:{driveItemId}
    if (folderId.startsWith('item:')) {
      const parts = folderId.split(':');  // ['item', siteId, driveItemId]
      const siteId = parts[1];
      const driveItemId = parts[2];
      if (!siteId || !driveItemId) return { records: [], hasMore: false };
      const result = await this.listDriveItems(siteId, driveItemId, {
        pageSize: f?.pageSize as number | undefined,
      });
      return this.mapDriveItemsToListResult(result, siteId);
    }

    return { records: [], hasMore: false, unsupported: true };
  }

  private mapDriveItemsToListResult(
    result: { value: Array<Record<string, unknown>>; '@odata.nextLink'?: string },
    siteId: string,
  ): ListResult {
    return {
      records: result.value.map(item => ({
        id: `item:${siteId}:${item.id as string}`,
        data: {
          title: item.name ?? item.id,
          url: item.webUrl ?? null,
          contentType: item.folder ? 'folder' : 'document',
          metadata: {
            type: item.folder ? 'folder' : 'file',
            siteId,
            driveItemId: item.id,
            mimeType: item.file ? (item.file as Record<string, unknown>).mimeType ?? null : null,
          },
        },
      })),
      hasMore: !!result['@odata.nextLink'],
    };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft SharePoint create', { entityType });

    try {
      switch (entityType) {
        case 'list': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/sites/${data.siteId}/lists`,
            {
              displayName: data.displayName,
              list: {
                template: data.template || 'genericList',
              },
            }
          );

          return {
            success: true,
            id: `${data.siteId}:${result.id}`,
            data: result,
          };
        }

        case 'listItem': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/sites/${data.siteId}/lists/${data.listId}/items`,
            {
              fields: data.fields,
            }
          );

          return {
            success: true,
            id: `${data.siteId}:${data.listId}:${result.id}`,
            data: result,
          };
        }

        case 'folder': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/sites/${data.siteId}/drive/items/${data.parentId || 'root'}/children`,
            {
              name: data.name,
              folder: {},
              '@microsoft.graph.conflictBehavior': data.conflictBehavior || 'rename',
            }
          );

          return {
            success: true,
            id: `${data.siteId}:${result.id}`,
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
    logger.info('Microsoft SharePoint update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'listItem': {
          const [siteId, listId, itemId] = entityId.split(':');
          const result = await this.request<{ eTag: string }>(
            'PATCH',
            `/sites/${siteId}/lists/${listId}/items/${itemId}/fields`,
            data.fields
          );

          return {
            success: true,
            versionToken: result.eTag,
            data: result,
          };
        }

        case 'driveItem': {
          const [siteId, itemId] = entityId.split(':');
          const updateData: Record<string, any> = {};
          if (data.name) updateData.name = data.name;
          if (data.description) updateData.description = data.description;

          const result = await this.request<{ eTag: string }>(
            'PATCH',
            `/sites/${siteId}/drive/items/${itemId}`,
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

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<DeleteResult> {
    logger.info('Microsoft SharePoint delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'list': {
          // Accepts entityId="siteId:listId" OR payload.siteId + payload.listId
          const siteId = payload?.siteId || entityId?.split(':')[0];
          const listId = payload?.listId || entityId?.split(':')[1];
          if (!siteId || !listId) throw new Error('delete_list: siteId and listId required');
          await this.request<void>('DELETE', `/sites/${siteId}/lists/${listId}`);
          return { success: true };
        }

        case 'listItem': {
          if (!entityId) throw new Error('entityId required for listItem delete');
          const [siteId, listId, itemId] = entityId.split(':');
          await this.request<void>('DELETE', `/sites/${siteId}/lists/${listId}/items/${itemId}`);
          return { success: true };
        }

        case 'driveItem': {
          // Accepts entityId="siteId:itemId" OR payload.siteId + extracted from id
          const compoundId = entityId || payload?.id as string;
          if (!compoundId) throw new Error('delete_drive_item: id required (format: siteId:itemId)');
          const [siteId, itemId] = compoundId.split(':');
          await this.request<void>('DELETE', `/sites/${siteId}/drive/items/${itemId}`);
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
    logger.info('Microsoft SharePoint restore from snapshot', { entityType, entityId });

    if (['listItem', 'driveItem'].includes(entityType)) {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft SharePoint ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft SharePoint semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['list', 'listItem', 'folder', 'driveItem'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType === 'folder' ? 'driveItem' : entityType, id);
        }
        break;

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted SharePoint items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft SharePoint action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods
  async listSites(options: {
    pageSize?: number;
    search?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    if (options.search) {
      query.search = options.search;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      '/sites',
      undefined,
      { query }
    );
  }

  // Enumerate the user's drive items via the driveItem search function. q=''
  // returns every item; $orderby surfaces the most-recently-modified first so
  // newly changed documents are seen first when paging is truncated.
  async searchDriveItems(options: {
    pageSize?: number;
    skipToken?: string;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 100).toString(),
      $orderby: 'lastModifiedDateTime desc',
    };

    if (options.skipToken) {
      query.$skiptoken = options.skipToken;
    }

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      "/me/drive/root/search(q='')",
      undefined,
      { query }
    );
  }

  // Graph returns @odata.nextLink as a full URL with an opaque $skiptoken; the
  // scheduler persists nextPageToken and feeds it back as filters.pageToken, so
  // surface just the skip token rather than the whole URL.
  private extractSkipToken(nextLink?: string): string | undefined {
    if (!nextLink) return undefined;
    const match = nextLink.match(/[?&]\$skiptoken=([^&]+)/i);
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  async listLists(siteId: string): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      `/sites/${siteId}/lists`
    );
  }

  async listDriveItems(siteId: string, folderId: string = 'root', options: {
    pageSize?: number;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 100).toString(),
    };

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      `/sites/${siteId}/drive/items/${folderId}/children`,
      undefined,
      { query }
    );
  }

  async registerWebhook(
    siteId: string,
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
        resource: `/sites/${siteId}/drive/items/${itemId}/children`,
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
