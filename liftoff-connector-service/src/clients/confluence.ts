// Confluence Connector Client
// Auth: OAuth2 Bearer token (Atlassian shared OAuth — same provider as Jira)
// Cloud ID: fetched from accessible-resources endpoint, cached on the credential object
// Base URL: https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/

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

const ACCESSIBLE_RESOURCES_URL =
  'https://api.atlassian.com/oauth/token/accessible-resources';

// ─── Confluence domain types ──────────────────────────────────────────────────

interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  parentId?: string;
  status: string;
  version: { number: number; message?: string; createdAt: string };
  body?: { storage?: { value: string }; atlas_doc_format?: { value: string } };
  _links: { webui?: string; editui?: string };
}

interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
  homepageId?: string;
}

interface ConfluenceSearchResult {
  results: Array<{
    content: Record<string, any>;
    title: string;
    excerpt: string;
    url: string;
  }>;
  totalSize: number;
  _links?: { next?: string };
}

interface AtlassianResource {
  id: string;
  name: string;
  url: string;
  scopes: string[];
  avatarUrl: string;
}

// Confluence _links.next is a full URL containing the next page cursor as a query param.
// e.g. "https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/pages?cursor=XYZ&limit=25"
function extractUrlCursor(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ConfluenceClient implements CompensationClient {
  readonly connector = 'atlassian_confluence';
  private credentialProvider: CredentialProvider;

  // Per-instance cloud ID cache. Same pattern as JiraClient.
  private cloudIdCache: string | null = null;
  // Atlassian site URL (e.g. "https://acme.atlassian.net") — needed to build
  // user-facing absolute URLs from the relative `_links.webui` Confluence returns.
  private siteUrlCache: string | null = null;

  constructor(credentialProvider: CredentialProvider) {
    this.credentialProvider = credentialProvider;
  }

  // ── Cloud ID resolution ───────────────────────────────────────────────────

  private async getCloudId(accessToken: string, credentials: { instanceUrl?: string }): Promise<string> {
    if (this.cloudIdCache) return this.cloudIdCache;

    if (credentials.instanceUrl) {
      const cloudId = credentials.instanceUrl.split(':')[0].trim();
      if (cloudId && cloudId.length > 0) {
        this.cloudIdCache = cloudId;
        return cloudId;
      }
    }

    const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      logger.error('Confluence: failed to fetch accessible resources', { status: response.status, err });
      throw new Error(`Confluence: failed to resolve cloud ID: ${response.status} - ${err}`);
    }

    const resources = (await response.json()) as AtlassianResource[];
    if (!resources || resources.length === 0) {
      throw new Error('Confluence: no Atlassian sites found for this credential');
    }

    const cloudId = resources[0].id;
    this.cloudIdCache = cloudId;
    this.siteUrlCache = resources[0].url ?? null;
    logger.info('Confluence: resolved cloud ID', { cloudId, siteName: resources[0].name });
    return cloudId;
  }

  // Returns the Atlassian site URL (e.g. "https://acme.atlassian.net") used to
  // build absolute user-facing URLs. Forces an accessible-resources fetch when
  // we previously short-circuited via credentials.instanceUrl (which only
  // contains the cloudId, not the site URL).
  private async getSiteUrl(accessToken: string): Promise<string | null> {
    if (this.siteUrlCache) return this.siteUrlCache;

    try {
      const response = await fetch(ACCESSIBLE_RESOURCES_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) return null;
      const resources = (await response.json()) as AtlassianResource[];
      this.siteUrlCache = resources?.[0]?.url ?? null;
      return this.siteUrlCache;
    } catch (err) {
      logger.warn('Confluence: failed to resolve site URL', { err: (err as Error).message });
      return null;
    }
  }

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const credentials = await this.credentialProvider();

    // composio_managed routing — Composio knows the connected account's
    // cloudId internally so we don't need to pre-fetch
    // accessible-resources. Pass `/wiki/api/v2${path}` as the endpoint.
    const composio = await tryComposioProxy<T>(credentials, {
      method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path: `/wiki/api/v2${path}`,
      body,
      query: queryParams,
    });
    if (composio.handled) return composio.data;

    const cloudId = await this.getCloudId(credentials.accessToken, credentials);
    const baseUrl = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2`;
    let url = `${baseUrl}${path}`;

    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(queryParams).toString();
      url = `${url}?${qs}`;
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearerFor(credentials, 'atlassian_confluence')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error('Confluence API error', { status: response.status, error, path, method });
      throw new Error(`Confluence API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // ── Page operations ───────────────────────────────────────────────────────

  async getPage(pageId: string): Promise<ConfluencePage> {
    return this.request<ConfluencePage>('GET', `/pages/${pageId}`, undefined, {
      'body-format': 'storage',
    });
  }

  async listPages(params: {
    spaceId?: string;
    parentId?: string;
    title?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ results: ConfluencePage[]; _links?: { next?: string } }> {
    const q: Record<string, string> = {};
    if (params.spaceId) q['spaceId'] = params.spaceId;
    if (params.parentId) q['parentId'] = params.parentId;
    if (params.title) q['title'] = params.title;
    if (params.limit !== undefined) q['limit'] = String(params.limit);
    if (params.cursor) q['cursor'] = params.cursor;
    return this.request<{ results: ConfluencePage[]; _links?: { next?: string } }>(
      'GET',
      '/pages',
      undefined,
      q,
    );
  }

  async createPage(data: {
    spaceId: string;
    title: string;
    content: string;
    parentId?: string;
    status?: string;
  }): Promise<ConfluencePage> {
    const body: Record<string, any> = {
      spaceId: data.spaceId,
      status: data.status ?? 'current',
      title: data.title,
      body: {
        representation: 'storage',
        value: data.content,
      },
    };
    if (data.parentId) body['parentId'] = data.parentId;
    return this.request<ConfluencePage>('POST', '/pages', body);
  }

  async updatePage(
    pageId: string,
    data: {
      title: string;
      content: string;
      versionNumber: number;
      versionMessage?: string;
    },
  ): Promise<ConfluencePage> {
    return this.request<ConfluencePage>('PUT', `/pages/${pageId}`, {
      id: pageId,
      status: 'current',
      title: data.title,
      body: {
        representation: 'storage',
        value: data.content,
      },
      version: {
        number: data.versionNumber,
        ...(data.versionMessage ? { message: data.versionMessage } : {}),
      },
    });
  }

  // ── Space operations ───────────────────────────────────────────────────────

  async listSpaces(params: { type?: string; limit?: number } = {}): Promise<{
    results: ConfluenceSpace[];
    _links?: { next?: string };
  }> {
    const q: Record<string, string> = {};
    if (params.type) q['type'] = params.type;
    if (params.limit !== undefined) q['limit'] = String(params.limit);
    return this.request<{ results: ConfluenceSpace[]; _links?: { next?: string } }>(
      'GET',
      '/spaces',
      undefined,
      q,
    );
  }

  async getSpace(spaceId: string): Promise<ConfluenceSpace> {
    return this.request<ConfluenceSpace>('GET', `/spaces/${spaceId}`);
  }

  // ── Search (CQL) ───────────────────────────────────────────────────────────

  async search(cql: string, limit: number = 25): Promise<ConfluenceSearchResult> {
    return this.request<ConfluenceSearchResult>('GET', '/search/content', undefined, {
      cql,
      limit: String(limit),
    });
  }

  // ── CompensationClient interface ──────────────────────────────────────────

  /**
   * read() — maps entity type to the correct Confluence API call.
   *
   * Supported entityTypes:
   *   - 'page'   → getPage(entityId)
   *   - 'pages'  → listPages(payload)
   *   - 'space'  → getSpace(entityId)
   *   - 'spaces' → listSpaces(payload)
   *   - 'search' → search(payload.cql)
   */
  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, any>,
  ): Promise<ExternalRecord> {
    logger.info('Confluence read', { entityType, entityId });

    switch (entityType) {
      case 'page': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Confluence: page read requires entityId or payload.id');
        const data = await this.getPage(id);
        return {
          id: data.id,
          data: data as unknown as Record<string, any>,
          lastModified: data.version?.createdAt ? new Date(data.version.createdAt) : undefined,
        };
      }

      case 'pages': {
        const data = await this.listPages({
          spaceId: payload?.spaceId as string | undefined,
          title: payload?.title as string | undefined,
          limit: payload?.limit as number | undefined,
        });
        return {
          id: 'pages',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'space': {
        const id = entityId ?? (payload?.id as string);
        if (!id) throw new Error('Confluence: space read requires entityId or payload.id');
        const data = await this.getSpace(id);
        return { id: data.id, data: data as unknown as Record<string, any> };
      }

      case 'spaces': {
        const data = await this.listSpaces({
          type: payload?.type as string | undefined,
          limit: payload?.limit as number | undefined,
        });
        return {
          id: 'spaces',
          data: data as unknown as Record<string, any>,
        };
      }

      case 'search': {
        const cql = (payload?.cql as string);
        if (!cql) throw new Error('Confluence: search requires payload.cql');
        const data = await this.search(cql, payload?.limit as number | undefined);
        return {
          id: 'search',
          data: data as unknown as Record<string, any>,
        };
      }

      default:
        throw new Error(`Confluence: unsupported read entity type "${entityType}"`);
    }
  }

  /**
   * create() — maps entity type to the correct write operation.
   *
   * Supported entityTypes:
   *   - 'page' → createPage(data)
   */
  // Build a user-facing absolute URL for a Confluence page's raw data
  // (whose `_links.webui` is a relative path). Used by both list() and the
  // single-item refresh path. Returns null if the site URL can't be resolved.
  async absoluteWebUrl(pageData: Record<string, unknown> | undefined): Promise<string | null> {
    const links = pageData?._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    if (!webui) return null;
    if (/^https?:\/\//i.test(webui)) return webui;
    const credentials = await this.credentialProvider();
    const siteUrl = await this.getSiteUrl(credentials.accessToken);
    if (!siteUrl) return null;
    return `${siteUrl}/wiki${webui.startsWith('/') ? '' : '/'}${webui}`;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const f = filters as Record<string, unknown> | undefined;
    const folderId = f?.folderId as string | undefined;
    const cursor = f?.pageToken as string | undefined;

    const credentials = await this.credentialProvider();
    const siteUrl = await this.getSiteUrl(credentials.accessToken);
    const toAbsolute = (webui: string | undefined): string | null => {
      if (!webui) return null;
      if (/^https?:\/\//i.test(webui)) return webui;
      if (!siteUrl) return null;
      return `${siteUrl}/wiki${webui.startsWith('/') ? '' : '/'}${webui}`;
    };

    if (!folderId || entityType === 'space') {
      const spaces = await this.listSpaces();
      return {
        records: spaces.results.map(s => ({
          id: s.key,
          data: { title: s.name, url: null, contentType: 'collection', metadata: { spaceKey: s.key, spaceId: s.id } },
        })),
        hasMore: !!spaces._links?.next,
      };
    }

    // folderId is a space key when coming from space level; a page ID when drilling into pages
    // Space keys are typically short uppercase identifiers; page IDs are numeric strings
    const isNumericId = /^\d+$/.test(folderId);

    if (!isNumericId) {
      // folderId is a space key — list top-level pages in that space (no parent)
      const pages = await this.listPages({ spaceId: folderId, cursor });
      return {
        records: pages.results.map(p => ({
          id: p.id,
          data: {
            title: p.title,
            url: toAbsolute(p._links?.webui),
            contentType: 'folder',
            metadata: { spaceKey: folderId, parentId: p.parentId ?? null },
          },
        })),
        hasMore: !!pages._links?.next,
        nextPageToken: extractUrlCursor(pages._links?.next),
      };
    }

    // folderId is a page ID — list child pages
    const pages = await this.listPages({ parentId: folderId, cursor });
    return {
      records: pages.results.map(p => ({
        id: p.id,
        data: {
          title: p.title,
          url: toAbsolute(p._links?.webui),
          contentType: 'folder',
          metadata: { parentId: p.parentId ?? null },
        },
      })),
      hasMore: !!pages._links?.next,
      nextPageToken: extractUrlCursor(pages._links?.next),
    };
  }


  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    logger.info('Confluence create', { entityType });

    try {
      switch (entityType) {
        case 'page': {
          const { spaceId, title, content, parentId, status } = data;
          if (!spaceId || !title || !content) {
            return {
              success: false,
              id: '',
              error: 'Confluence: createPage requires spaceId, title, and content',
            };
          }
          const page = await this.createPage({
            spaceId: spaceId as string,
            title: title as string,
            content: content as string,
            parentId: parentId as string | undefined,
            status: status as string | undefined,
          });
          return { success: true, id: page.id, data: page as unknown as Record<string, any> };
        }

        default:
          return {
            success: false,
            id: '',
            error: `Confluence: unsupported create entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  /**
   * update() — maps entity type to the correct update operation.
   *
   * Supported entityTypes:
   *   - 'page' → updatePage(entityId, data)
   */
  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Confluence update', { entityType, entityId });

    try {
      const id = entityId ?? (data.id as string);
      if (!id) {
        return { success: false, error: `Confluence: ${entityType} update requires entityId` };
      }

      switch (entityType) {
        case 'page': {
          const { title, content, versionNumber, versionMessage } = data;
          if (!title || !content || !versionNumber) {
            return {
              success: false,
              error: 'Confluence: updatePage requires title, content, and versionNumber',
            };
          }
          const updated = await this.updatePage(id, {
            title: title as string,
            content: content as string,
            versionNumber: versionNumber as number,
            versionMessage: versionMessage as string | undefined,
          });
          return {
            success: true,
            versionToken: String(updated.version.number),
            data: updated as unknown as Record<string, any>,
          };
        }

        default:
          return {
            success: false,
            error: `Confluence: unsupported update entity type "${entityType}"`,
          };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * delete() — Confluence pages can be archived but not hard-deleted via API v2.
   */
  async delete(
    entityType: string,
    _entityId: string | undefined,
    _payload?: Record<string, any>,
  ): Promise<DeleteResult> {
    logger.info('Confluence delete (unsupported)', { entityType });
    return {
      success: false,
      error: 'Confluence: page deletion is not supported via API v2. Archive the page instead.',
    };
  }

  // ── CompensationClient — snapshot / inverse ───────────────────────────────

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, any>,
  ): Promise<UpdateResult> {
    logger.info('Confluence restore from snapshot', { entityType, entityId });
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, any>,
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Confluence semantic inverse', { entityType, originalAction });

    return {
      success: false,
      error: `Confluence: cannot reverse ${originalAction} on ${entityType} — restore from snapshot if available`,
    };
  }
}
