import { CompensationClient, CredentialProvider, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { IntercomWriteClient } from './intercom-write.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

const INTERCOM_API_BASE = 'https://api.intercom.io';
const INTERCOM_API_VERSION = '2.11';

// Intercom entity types supported via MCP
type IntercomEntityType =
  | 'contact'
  | 'conversation'
  | 'message'
  | 'company'
  | 'admin'
  | 'article'
  | 'tag';

const SUPPORTED_ENTITIES = new Set<string>([
  'contact', 'conversation', 'message', 'company', 'admin', 'article', 'tag',
]);

// Map entity types to Intercom MCP read tool names
const READ_TOOL_MAP: Record<string, string> = {
  contact: 'get_contact',
  conversation: 'get_conversation',
  message: 'get_message',
  company: 'get_company',
  admin: 'get_admin',
  article: 'get_article',
  tag: 'get_tag',
};

export interface IntercomMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class IntercomMCPClient implements CompensationClient {
  readonly connector = 'intercom';
  private mcpClient: MCPClient;
  private writeClient: IntercomWriteClient;
  private tokenProvider: OAuthTokenProvider;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: IntercomMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    this.tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'intercom',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.intercom.com',
      tokenProvider: this.tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);

    // Same token, REST path — the vendor MCP is read-only.
    const credentialProvider: CredentialProvider = async () => ({
      accessToken: await this.tokenProvider.getToken(),
    });
    this.writeClient = new IntercomWriteClient(credentialProvider);
  }

  private validateEntityType(entityType: string): void {
    if (!SUPPORTED_ENTITIES.has(entityType as IntercomEntityType)) {
      throw new Error(
        `Unsupported Intercom entity type: ${entityType}. Supported: ${Array.from(SUPPORTED_ENTITIES).join(', ')}`
      );
    }
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown Intercom MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    }
    return {};
  }

  private async fetchIntercomRest<T>(path: string): Promise<T> {
    const token = await this.tokenProvider.getToken();
    const response = await fetch(`${INTERCOM_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Intercom-Version': INTERCOM_API_VERSION,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Intercom API error: ${response.status} - ${errorText}`);
    }
    return response.json() as Promise<T>;
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Intercom MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    if (entityType === 'articles') {
      const p = payload ?? {};
      const page = p.page as number ?? 1;
      const perPage = p.perPage as number ?? 50;
      const data = await this.fetchIntercomRest<{
        data: Array<Record<string, unknown>>;
        pages: { total_pages: number; current_page: number };
      }>(`/articles?page=${page}&per_page=${perPage}`);
      return {
        id: 'articles',
        data: {
          articles: data.data ?? [],
          hasMore: (data.pages?.total_pages ?? 0) > (data.pages?.current_page ?? page),
        },
      };
    }

    if (entityType === 'conversations') {
      const p = payload ?? {};
      const state = p.state as string | undefined;
      const qs = state ? `?state=${encodeURIComponent(state)}` : '';
      const data = await this.fetchIntercomRest<{
        conversations: Array<Record<string, unknown>>;
        pages?: { next?: string };
      }>(`/conversations${qs}`);
      return {
        id: 'conversations',
        data: { conversations: data.conversations ?? [], hasMore: !!data.pages?.next },
      };
    }

    if (entityType === 'contacts') {
      const p = payload ?? {};
      const email = p.email as string | undefined;
      const qs = email ? `?email=${encodeURIComponent(email)}` : '';
      const data = await this.fetchIntercomRest<{
        data: Array<Record<string, unknown>>;
        pages?: { next?: string };
      }>(`/contacts${qs}`);
      return {
        id: 'contacts',
        data: { contacts: data.data ?? [], hasMore: !!data.pages?.next },
      };
    }

    this.validateEntityType(entityType);

    const tool = READ_TOOL_MAP[entityType] || `get_${entityType}`;
    const result = await this.mcpClient.callTool(tool, { id: entityId });
    const data = this.parseToolResult(result);

    return {
      id: entityId ?? entityType,
      data,
      lastModified: data.updated_at
        ? new Date((data.updated_at as number) * 1000)
        : undefined,
    };
  }

  private async intercomFetch<T>(path: string): Promise<T> {
    const token = await this.tokenProvider.getToken();
    const response = await fetch(`${INTERCOM_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Intercom-Version': INTERCOM_API_VERSION,
      },
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Intercom API error ${response.status}: ${errorText}`);
    }
    return response.json() as Promise<T>;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const limit = filters?.limit ?? 50;
    const cursor = filters?.pageToken;

    switch (entityType) {
      case 'Article': {
        const page = cursor ? parseInt(cursor, 10) : 1;
        const data = await this.intercomFetch<{
          data: Array<Record<string, unknown>>;
          pages: { total_pages: number; current_page: number };
        }>(`/articles?page=${page}&per_page=${limit}`);
        const hasMore = (data.pages?.total_pages ?? 0) > (data.pages?.current_page ?? page);
        return {
          records: (data.data ?? []).map(a => ({
            id: String(a.id),
            data: a,
            lastModified: a.updated_at ? new Date((a.updated_at as number) * 1000) : undefined,
          })),
          hasMore,
          nextPageToken: hasMore ? String((data.pages?.current_page ?? page) + 1) : undefined,
        };
      }

      case 'Conversation': {
        const qs = new URLSearchParams({ per_page: String(limit) });
        if (cursor) qs.set('starting_after', cursor);
        const data = await this.intercomFetch<{
          conversations: Array<Record<string, unknown>>;
          pages: { next?: { starting_after: string } };
        }>(`/conversations?${qs}`);
        const nextCursor = data.pages?.next?.starting_after;
        return {
          records: (data.conversations ?? []).map(c => ({
            id: String(c.id),
            data: c,
            lastModified: c.updated_at ? new Date((c.updated_at as number) * 1000) : undefined,
          })),
          hasMore: !!nextCursor,
          nextPageToken: nextCursor,
        };
      }

      case 'Contact': {
        const qs = new URLSearchParams({ per_page: String(limit) });
        if (cursor) qs.set('starting_after', cursor);
        const data = await this.intercomFetch<{
          data: Array<Record<string, unknown>>;
          pages: { next?: { starting_after: string } };
        }>(`/contacts?${qs}`);
        const nextCursor = data.pages?.next?.starting_after;
        return {
          records: (data.data ?? []).map(c => ({
            id: String(c.id),
            data: c,
            lastModified: c.updated_at ? new Date((c.updated_at as number) * 1000) : undefined,
          })),
          hasMore: !!nextCursor,
          nextPageToken: nextCursor,
        };
      }

      // Browse hierarchy: root → collections → (sections →) articles
      case 'collection': {
        const f = filters as Record<string, unknown> | undefined;
        const folderId = f?.folderId as string | undefined;
        if (!folderId) {
          // Top-level collections
          const data = await this.intercomFetch<{
            data: Array<Record<string, unknown>>;
          }>('/help_center/collections');
          return {
            records: (data.data ?? []).map(c => ({
              id: String(c.id),
              data: { title: c.name, contentType: 'collection', url: c.url ?? null, metadata: { collectionId: c.id, expandEntityType: 'article' } },
            })),
            hasMore: false,
          };
        }
        // Sections within a collection — sections also expand to articles
        const data = await this.intercomFetch<{
          data: Array<Record<string, unknown>>;
        }>(`/help_center/collections/${folderId}/sections`);
        return {
          records: (data.data ?? []).map(s => ({
            id: String(s.id),
            data: { title: s.name, contentType: 'collection', url: null, metadata: { sectionId: s.id, collectionId: folderId, expandEntityType: 'article' } },
          })),
          hasMore: false,
        };
      }
      case 'article': {
        const f = filters as Record<string, unknown> | undefined;
        const folderId = f?.folderId as string | undefined;
        const page = f?.pageToken ? parseInt(f.pageToken as string, 10) : 1;
        const qs = new URLSearchParams({ per_page: String(limit), page: String(page) });
        if (folderId) qs.set('collection_id', folderId);
        const data = await this.intercomFetch<{
          data: Array<Record<string, unknown>>;
          pages: { total_pages: number; current_page: number };
        }>(`/articles?${qs}`);
        const hasMore = (data.pages?.total_pages ?? 0) > (data.pages?.current_page ?? page);
        return {
          records: (data.data ?? []).map(a => ({
            id: String(a.id),
            data: { title: a.title, contentType: 'article', url: a.url ?? null, body: a.body, metadata: { authorId: a.author_id, collectionId: folderId } },
          })),
          hasMore,
          nextPageToken: hasMore ? String((data.pages?.current_page ?? page) + 1) : undefined,
        };
      }

      default:
        return { records: [], hasMore: false, unsupported: true };
    }
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    return this.writeClient.create(entityType, data);
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    return this.writeClient.update(entityType, entityId, data);
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    return this.writeClient.delete(entityType, entityId, payload);
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.writeClient.restore(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    return this.writeClient.semanticInverse(entityType, originalAction, entityId, originalResponse);
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Intercom MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
