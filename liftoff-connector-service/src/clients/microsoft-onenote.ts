// Microsoft OneNote Connector Client
// Per Section 11 & 12: Microsoft Graph API implementation for OneNote

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

export class MicrosoftOneNoteClient implements CompensationClient {
  readonly connector = 'microsoft_onenote';
  private credentialProvider: CredentialProvider;
  private baseUrl = 'https://graph.microsoft.com/v1.0';

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any> | string,
    options: { query?: Record<string, string>; contentType?: string } = {}
  ): Promise<T> {
    // Always fetch fresh credentials per request — never cache. The provider
    // delegates to credentialService.getCredentials, which handles refresh.
    const credentials = await this.credentialProvider();
    let url = `${this.baseUrl}${path}`;

    if (options.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
    };

    if (options.contentType) {
      headers['Content-Type'] = options.contentType;
    } else if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft OneNote API error', { status: response.status, error, path });
      throw new Error(`Microsoft OneNote API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Microsoft OneNote read', { entityType, entityId });

    switch (entityType) {
      case 'notebooks': {
        const result = await this.listNotebooks();
        return { id: 'notebooks', data: { notebooks: result.value } };
      }

      case 'sections': {
        const p = payload ?? {};
        const notebookId = p.notebookId as string | undefined;
        if (!notebookId) throw new Error('notebookId is required for list_sections');
        const result = await this.listSections(notebookId);
        return { id: 'sections', data: { sections: result.value } };
      }

      case 'pages': {
        const p = payload ?? {};
        const sectionId = p.sectionId as string | undefined;
        if (!sectionId) throw new Error('sectionId is required for list_pages');
        const result = await this.listPages(sectionId, { pageSize: p.pageSize as number | undefined });
        return {
          id: 'pages',
          data: { pages: result.value, nextPageToken: result['@odata.nextLink'] },
        };
      }

      case 'notebook': {
        if (!entityId) throw new Error('entityId required for notebook read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/onenote/notebooks/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'section': {
        if (!entityId) throw new Error('entityId required for section read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/onenote/sections/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      case 'page': {
        if (!entityId) throw new Error('entityId required for page read');
        const data = await this.request<Record<string, any>>(
          'GET',
          `/me/onenote/pages/${entityId}`
        );
        return {
          id: entityId,
          data,
          lastModified: data.lastModifiedDateTime ? new Date(data.lastModifiedDateTime) : undefined,
        };
      }

      default:
        throw new Error(`Unsupported entity type: ${entityType}`);
    }
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const f = filters as Record<string, unknown> | undefined;
    const folderId = f?.folderId as string | undefined;

    // Reactive polling — the scheduler passes the capitalized polling entity
    // type 'Page'. Microsoft Graph exposes a FLAT pages endpoint
    // (GET /me/onenote/pages) returning every OneNote page for the user,
    // ordered by lastModifiedDateTime desc by default. Page deltas via
    // $filter on lastModifiedDateTime + @odata.nextLink ($skiptoken) paging,
    // mirroring microsoft-contacts. This branch is distinct from the
    // folderId-scoped notebook/section/page browsing used by other callers.
    if (entityType === 'Page') {
      const since = filters?.since;
      const limit = filters?.limit;
      const pageToken = filters?.pageToken;

      const query: Record<string, string> = {
        $top: String(limit ?? 100),
        $orderby: 'lastModifiedDateTime desc',
      };
      if (since) {
        query.$filter = `lastModifiedDateTime ge ${since.toISOString()}`;
      }
      if (pageToken) {
        // pageToken is the opaque $skiptoken carried over from a prior
        // @odata.nextLink — forward it to fetch the next page.
        query.$skiptoken = pageToken;
      }

      const result = await this.request<{
        value: Array<Record<string, any>>;
        '@odata.nextLink'?: string;
      }>('GET', '/me/onenote/pages', undefined, { query });

      const nextLink = result['@odata.nextLink'];
      const nextSkipToken = nextLink ? this.extractSkipToken(nextLink) : undefined;

      return {
        records: (result.value ?? []).map(p => ({ id: String(p.id), data: p })),
        nextPageToken: nextSkipToken,
        hasMore: !!nextSkipToken,
      };
    }

    // No folderId → list notebooks with "notebook:" prefix
    if (!folderId || entityType === 'notebook') {
      const result = await this.listNotebooks();
      return {
        records: result.value.map(nb => ({
          id: `notebook:${nb.id as string}`,
          data: {
            title: nb.displayName ?? nb.name ?? nb.id,
            url: (nb as Record<string, unknown>).links && ((nb as Record<string, unknown>).links as Record<string, unknown>).oneNoteWebUrl
              ? ((((nb as Record<string, unknown>).links as Record<string, unknown>).oneNoteWebUrl) as Record<string, unknown>).href as string
              : null,
            contentType: 'folder',
            metadata: { type: 'notebook', notebookId: nb.id },
          },
        })),
        hasMore: false,
      };
    }

    // folderId starts with "notebook:" → list sections
    if (folderId.startsWith('notebook:')) {
      const notebookId = folderId.slice('notebook:'.length);
      const result = await this.listSections(notebookId);
      return {
        records: result.value.map(s => ({
          id: `section:${s.id as string}`,
          data: {
            title: s.displayName ?? s.name ?? s.id,
            url: (s as Record<string, unknown>).links && ((s as Record<string, unknown>).links as Record<string, unknown>).oneNoteWebUrl
              ? ((((s as Record<string, unknown>).links as Record<string, unknown>).oneNoteWebUrl) as Record<string, unknown>).href as string
              : null,
            contentType: 'folder',
            metadata: { type: 'section', notebookId, sectionId: s.id },
          },
        })),
        hasMore: false,
      };
    }

    // folderId starts with "section:" → list pages
    if (folderId.startsWith('section:')) {
      const sectionId = folderId.slice('section:'.length);
      const result = await this.listPages(sectionId, { pageSize: f?.pageSize as number | undefined });
      return {
        records: result.value.map(p => ({
          id: `page:${p.id as string}`,
          data: {
            title: p.title ?? p.id,
            url: (p as Record<string, unknown>).links && ((p as Record<string, unknown>).links as Record<string, unknown>).oneNoteWebUrl
              ? ((((p as Record<string, unknown>).links as Record<string, unknown>).oneNoteWebUrl) as Record<string, unknown>).href as string
              : null,
            contentType: 'document',
            metadata: { type: 'page', sectionId },
          },
        })),
        hasMore: !!result['@odata.nextLink'],
      };
    }

    return { records: [], hasMore: false, unsupported: true };
  }

  // Microsoft Graph returns the next page as a full @odata.nextLink URL with an
  // opaque $skiptoken. We persist only the token (not the full URL) as the
  // ListResult cursor, then re-attach it as $skiptoken on the next request.
  private extractSkipToken(nextLink: string): string | undefined {
    try {
      const url = new URL(nextLink);
      return url.searchParams.get('$skiptoken') ?? undefined;
    } catch {
      const match = nextLink.match(/[?&]\$skiptoken=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : undefined;
    }
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Microsoft OneNote create', { entityType });

    try {
      switch (entityType) {
        case 'notebook': {
          const result = await this.request<{ id: string }>(
            'POST',
            '/me/onenote/notebooks',
            {
              displayName: data.displayName,
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'section': {
          const result = await this.request<{ id: string }>(
            'POST',
            `/me/onenote/notebooks/${data.notebookId}/sections`,
            {
              displayName: data.displayName,
            }
          );

          return {
            success: true,
            id: result.id,
            data: result,
          };
        }

        case 'page': {
          // OneNote pages are created with HTML content
          const htmlContent = `
            <!DOCTYPE html>
            <html>
              <head>
                <title>${data.title || 'New Page'}</title>
              </head>
              <body>
                ${data.content || ''}
              </body>
            </html>
          `;

          const result = await this.request<{ id: string }>(
            'POST',
            `/me/onenote/sections/${data.sectionId}/pages`,
            htmlContent,
            { contentType: 'text/html' }
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
    logger.info('Microsoft OneNote update', { entityType, entityId });

    try {
      switch (entityType) {
        case 'page': {
          // OneNote page updates use PATCH with specific commands
          const result = await this.request<Record<string, any>>(
            'PATCH',
            `/me/onenote/pages/${entityId}/content`,
            data.commands || [
              {
                target: 'body',
                action: 'append',
                content: data.content,
              },
            ]
          );

          return {
            success: true,
            data: result,
          };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type for update: ${entityType}`,
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
    logger.info('Microsoft OneNote delete', { entityType, entityId });

    try {
      switch (entityType) {
        case 'page': {
          await this.request<void>('DELETE', `/me/onenote/pages/${entityId}`);
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported entity type for delete: ${entityType}. Notebooks and sections cannot be deleted via API.`,
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
    logger.info('Microsoft OneNote restore from snapshot', { entityType, entityId });

    if (entityType === 'page') {
      return this.update(entityType, entityId, snapshot);
    }

    return {
      success: false,
      error: `Cannot restore Microsoft OneNote ${entityType}`,
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    originalResponse: Record<string, any>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Microsoft OneNote semantic inverse', { entityType, originalAction, entityId });

    switch (originalAction) {
      case 'create':
        if (entityType === 'page') {
          const id = originalResponse.id || entityId;
          return this.delete(entityType, id);
        }
        return {
          success: false,
          error: 'Only pages can be deleted in OneNote',
        };

      case 'delete':
        return {
          success: false,
          error: 'Cannot restore deleted OneNote items without backup',
        };

      case 'update':
        return {
          success: false,
          error: 'Update reversal requires pre-action snapshot',
        };

      default:
        return {
          success: false,
          error: `Cannot reverse Microsoft OneNote action: ${originalAction}`,
        };
    }
  }

  // Fetches the HTML content of a OneNote page.
  // GET /me/onenote/pages/{id}/content returns text/html, not JSON —
  // cannot use the standard request() helper which always calls .json().
  async readPageHtml(pageId: string): Promise<string> {
    const credentials = await this.credentialProvider();
    const url = `${this.baseUrl}/me/onenote/pages/${encodeURIComponent(pageId)}/content`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (!response.ok) {
      const error = await response.text();
      logger.error('Microsoft OneNote page content error', { status: response.status, error, pageId });
      throw new Error(`Microsoft OneNote page content error: ${response.status} - ${error}`);
    }
    return response.text();
  }

  // Utility methods
  async listNotebooks(): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      '/me/onenote/notebooks'
    );
  }

  async listSections(notebookId: string): Promise<{ value: Array<Record<string, any>> }> {
    return this.request<{ value: Array<Record<string, any>> }>(
      'GET',
      `/me/onenote/notebooks/${notebookId}/sections`
    );
  }

  async listPages(sectionId: string, options: {
    pageSize?: number;
  } = {}): Promise<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }> {
    const query: Record<string, string> = {
      $top: (options.pageSize || 50).toString(),
    };

    return this.request<{ value: Array<Record<string, any>>; '@odata.nextLink'?: string }>(
      'GET',
      `/me/onenote/sections/${sectionId}/pages`,
      undefined,
      { query }
    );
  }
}
