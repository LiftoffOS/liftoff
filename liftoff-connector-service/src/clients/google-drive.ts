// Google Drive Connector Client
// Per Section 11 & 12: Real Google Drive API implementation

import crypto from 'crypto';
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

/** Drive models a folder as a file with this mimeType, which is why folders and
 *  files come from one listing and why a mimeType filter can erase them. */
const FOLDER_MIME = 'application/vnd.google-apps.folder';
import { logger } from '../infra/logging.js';
import { tryComposioProxy, bearerFor } from './composio-transport.js';

export class GoogleDriveClient implements CompensationClient {
  readonly connector = 'google_drive';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://www.googleapis.com/drive/v3';
  private uploadUrl = 'https://www.googleapis.com/upload/drive/v3';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    options: { upload?: boolean; query?: Record<string, string> } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();

    // composio_managed routing — see clients/composio-transport.ts.
    // Pass the ABSOLUTE vendor URL (the same URL our direct fetch uses below).
    // Composio's googledrive proxy base already includes `/drive/v3`, so a
    // `/drive/v3${path}` prefix doubles the segment → Google 404. Absolute URL
    // is base-inconsistency-proof (verified against Composio).
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `${options.upload ? this.uploadUrl : this.baseUrl}${path}`,
      body,
      query: options.query,
    });
    if (composio.handled) return composio.data;

    const baseUrl = options.upload ? this.uploadUrl : this.baseUrl;
    let url = `${baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'google_drive')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Google Drive API error', { status: response.status, error, path });
      throw new Error(`Google Drive API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Google Drive read', { entityType, entityId });

    switch (entityType) {
      case 'files': {
        const p = payload ?? {};
        const mimeTypes = p.mimeTypes as string[] | undefined;
        const searchQuery = p.query as string | undefined;
        let q = searchQuery;
        if (!q && mimeTypes?.length) {
          q = `(${mimeTypes.map((m: string) => `mimeType = '${m}'`).join(' or ')})`;
        }
        const result = await this.listFiles({
          folderId: p.folderId as string | undefined,
          query: q,
          pageSize: p.pageSize as number | undefined,
          pageToken: p.pageToken as string | undefined,
        });
        return {
          id: 'files',
          data: { files: result.files, nextPageToken: result.nextPageToken },
        };
      }

      case 'file': {
        if (!entityId) throw new Error('entityId required for file read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/files/${entityId}`,
          undefined,
          { query: { fields: 'id,name,mimeType,parents,modifiedTime,version,trashed,size,webViewLink' } }
        );
        return {
          id: entityId,
          data,
          versionToken: data.version,
          lastModified: data.modifiedTime ? new Date(data.modifiedTime) : undefined,
        };
      }

      case 'folder': {
        if (!entityId) throw new Error('entityId required for folder read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/files/${entityId}`,
          undefined,
          { query: { fields: 'id,name,mimeType,parents,modifiedTime,trashed' } }
        );
        return {
          id: entityId,
          data,
          versionToken: data.version,
          lastModified: data.modifiedTime ? new Date(data.modifiedTime) : undefined,
        };
      }

      case 'permissions': {
        if (!entityId) throw new Error('entityId required for permissions read');
        const data = await this.request<{ permissions: Array<Record<string, any>> }>(
          'GET',
          `/files/${entityId}/permissions`,
          undefined,
          { query: { fields: 'permissions(id,type,role,emailAddress,displayName)' } }
        );
        return {
          id: entityId,
          data,
        };
      }

      case 'folders': {
        const p = payload ?? {};
        const q = p.folderId
          ? `'${p.folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed=false`
          : `mimeType = 'application/vnd.google-apps.folder' and trashed=false`;
        const result = await this.listFiles({
          query: q,
          pageSize: p.pageSize as number | undefined,
          pageToken: p.pageToken as string | undefined,
        });
        return {
          id: 'folders',
          data: { folders: result.files, nextPageToken: result.nextPageToken },
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'file' || entityType === 'folder') {
      const f = filters as Record<string, unknown> | undefined;
      const mimeTypes = f?.mimeTypes as string[] | undefined;
      let query: string | undefined;

      if (entityType === 'folder') {
        query = `mimeType = '${FOLDER_MIME}'`;
      } else if (mimeTypes?.length) {
        // Folders ride along with the requested file types, always.
        //
        // The caller is a tree: it splits this response into folders to expand
        // and files to tick. A mimeType filter listing only document types
        // silently removes every folder from that response, so the tree has
        // nothing to expand and the customer can reach only what happens to sit
        // at the level they are looking at. Asking for documents is a statement
        // about which FILES are useful, not a request to flatten the drive.
        const wanted = [...mimeTypes, FOLDER_MIME];
        const mimeFilter = wanted.map(m => `mimeType = '${m}'`).join(' or ');
        query = `(${mimeFilter})`;
      }

      const result = await this.listFiles({
        folderId: f?.folderId as string | undefined,
        query,
        pageSize: f?.pageSize as number | undefined,
        pageToken: f?.pageToken as string | undefined,
      });

      return {
        records: result.files.map(file => ({
          id: file.id as string,
          data: file,
          lastModified: file.modifiedTime ? new Date(file.modifiedTime as string) : undefined,
        })),
        hasMore: !!result.nextPageToken,
        nextPageToken: result.nextPageToken,
      };
    }

    return { records: [], hasMore: false, unsupported: true };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Google Drive create', { entityType });

    try {
      switch (entityType) {
        case 'folder': {
          const result = await this.request<{ id: string; name: string }>(
            'POST',
            '/files',
            {
              name: data.name,
              mimeType: 'application/vnd.google-apps.folder',
              parents: data.parents || ['root'],
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'file': {
          // Create empty file with metadata (use uploadUrl for content)
          const metadata: Record<string, any> = {
            name: data.name,
            mimeType: data.mimeType || 'application/octet-stream',
          };

          if (data.parents) {
            metadata.parents = data.parents;
          }

          const result = await this.request<{ id: string; name: string }>(
            'POST',
            '/files',
            metadata
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'permission': {
          // Add permission to a file
          const fileId = data.fileId;
          const result = await this.request<{ id: string }>(
            'POST',
            `/files/${fileId}/permissions`,
            {
              type: data.type, // user, group, domain, anyone
              role: data.role, // owner, organizer, fileOrganizer, writer, commenter, reader
              emailAddress: data.emailAddress,
            },
            { query: { sendNotificationEmail: data.sendNotification ? 'true' : 'false' } }
          );

          return {
            success: true,
            id: `${fileId}/${result.id}`,
            data: result,
          };
        }

        case 'shortcut': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/files',
            {
              name: data.name,
              mimeType: 'application/vnd.google-apps.shortcut',
              shortcutDetails: {
                targetId: data.targetId,
              },
              parents: data.parents || ['root'],
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
    logger.info('Google Drive update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file':
        case 'folder': {
          const updateData: Record<string, any> = {};

          if (data.name) updateData.name = data.name;
          if (data.description) updateData.description = data.description;
          if (data.starred !== undefined) updateData.starred = data.starred;
          if (data.trashed !== undefined) updateData.trashed = data.trashed;

          const query: Record<string, string> = {};
          if (data.addParents) query.addParents = data.addParents.join(',');
          if (data.removeParents) query.removeParents = data.removeParents.join(',');

          const result = await this.request<{ version: string }>(
            'PATCH',
            `/files/${entityId}`,
            updateData,
            { query }
          );

          return {
            success: true,
            versionToken: result.version,
            data: result,
          };
        }

        case 'permission': {
          // entityId format: "fileId/permissionId"
          const [fileId, permissionId] = this.parsePermissionId(entityId);
          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/files/${fileId}/permissions/${permissionId}`,
            { role: data.role }
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
    logger.info('Google Drive delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'file':
        case 'folder':
        case 'shortcut': {
          await this.request<void>(
            'DELETE',
            `/files/${entityId}`
          );
          return { success: true };
        }

        case 'permission': {
          const [fileId, permissionId] = this.parsePermissionId(entityId);
          await this.request<void>(
            'DELETE',
            `/files/${fileId}/permissions/${permissionId}`
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
    logger.info('Google Drive restore from snapshot', { entityType, entityId });

    if (entityType === 'file' || entityType === 'folder') {
      const restoreData: Record<string, any> = {};

      if (snapshot.name) restoreData.name = snapshot.name;
      if (snapshot.description) restoreData.description = snapshot.description;
      if (snapshot.starred !== undefined) restoreData.starred = snapshot.starred;

      // Restore from trash
      if (snapshot.trashed === false) {
        restoreData.trashed = false;
      }

      // Restore parent folders
      if (snapshot.parents) {
        const current = await this.read(entityType, entityId);
        const currentParents = current.data.parents || [];
        const snapshotParents = snapshot.parents;

        restoreData.addParents = snapshotParents.filter((p: string) => !currentParents.includes(p));
        restoreData.removeParents = currentParents.filter((p: string) => !snapshotParents.includes(p));
      }

      return this.update(entityType, entityId, restoreData);
    }

    if (entityType === 'permission') {
      // Restore permission role
      return this.update(entityType, entityId, { role: snapshot.role });
    }

    return {
      success: false,
      error: `Cannot restore Google Drive ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Google Drive semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (['file', 'folder', 'shortcut'].includes(entityType)) {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        if (entityType === 'permission') {
          return this.delete('permission', entityId);
        }
        break;

      case 'delete':
        // Try to restore from trash
        if (['file', 'folder'].includes(entityType)) {
          return this.update(entityType, entityId, { trashed: false });
        }
        return {
          success: false,
          error: 'Cannot restore permanently deleted Google Drive items',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Google Drive action: ${originalAction}`,
        };
    }

    return { success: false, error: 'Unknown entity type' };
  }

  // Utility methods for common operations
  async listFiles(options: {
    folderId?: string;
    query?: string;
    pageSize?: number;
    pageToken?: string;
  } = {}): Promise<{ files: Array<Record<string, any>>; nextPageToken?: string }> {
    const q: string[] = [];

    if (options.folderId) {
      q.push(`'${options.folderId}' in parents`);
    }
    if (options.query) {
      q.push(options.query);
    }
    q.push('trashed = false');

    const query: Record<string, string> = {
      q: q.join(' and '),
      fields: 'files(id,name,mimeType,parents,modifiedTime,size,webViewLink),nextPageToken',
      pageSize: (options.pageSize || 100).toString(),
    };

    if (options.pageToken) {
      query.pageToken = options.pageToken;
    }

    return this.request<{ files: Array<Record<string, any>>; nextPageToken?: string }>(
      'GET',
      '/files',
      undefined,
      { query }
    );
  }

  async copyFile(fileId: string, options: {
    name?: string;
    parents?: string[];
  } = {}): Promise<CreateResult> {
    try {
      const body: Record<string, any> = {};
      if (options.name) body.name = options.name;
      if (options.parents) body.parents = options.parents;

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

  async moveFile(fileId: string, newParentId: string, currentParentId?: string): Promise<UpdateResult> {
    const updateData: Record<string, any> = {
      addParents: [newParentId],
    };

    if (currentParentId) {
      updateData.removeParents = [currentParentId];
    }

    return this.update('file', fileId, updateData);
  }

  private parsePermissionId(entityId: string): [string, string] {
    if (entityId.includes('/')) {
      const parts = entityId.split('/');
      return [parts[0], parts[1]];
    }
    return [entityId, ''];
  }

  async registerWebhook(
    folderId: string,
    channelToken: string,
    notificationUrl: string,
  ): Promise<{ subscriptionId: string; resourceId: string; expiresAt: string | null }> {
    const channelId = crypto.randomUUID();
    const expirationMs = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
    const result = await this.request<{
      id: string;
      resourceId: string;
      expiration?: string;
    }>('POST', `/files/${encodeURIComponent(folderId)}/watch`, {
      id: channelId,
      type: 'web_hook',
      address: notificationUrl,
      token: channelToken,
      payload: true,
      expiration: String(expirationMs),
    });
    return {
      subscriptionId: result.id,
      resourceId: result.resourceId,
      expiresAt: result.expiration ? new Date(parseInt(result.expiration, 10)).toISOString() : null,
    };
  }

  async deregisterWebhook(channelId: string, resourceId: string): Promise<void> {
    await this.request<unknown>('POST', '/channels/stop', { id: channelId, resourceId });
  }
}
