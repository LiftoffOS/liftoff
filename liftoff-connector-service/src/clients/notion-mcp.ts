import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

// Notion entity types supported via MCP
type NotionEntityType =
  | 'page'
  | 'database'
  | 'block'
  | 'user'
  | 'comment';

const SUPPORTED_ENTITIES = new Set<string>([
  'page', 'database', 'block', 'user', 'comment',
]);

// Notion MCP tool names use REST-style hyphens per mcp.notion.com/mcp spec
const READ_TOOL_MAP: Record<string, string> = {
  page: 'retrieve-a-page',
  database: 'retrieve-a-database',
  block: 'retrieve-a-block',
  user: 'retrieve-a-user',
  comment: 'retrieve-a-comment',
};

// Parameter names expected by each Notion MCP read tool
const READ_PARAM_MAP: Record<string, string> = {
  page: 'page_id',
  database: 'database_id',
  block: 'block_id',
  user: 'user_id',
  comment: 'comment_id',
};

export interface NotionMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class NotionMCPClient implements CompensationClient {
  readonly connector = 'notion';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: NotionMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'notion',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.notion.com/mcp',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  private validateEntityType(entityType: string): void {
    if (!SUPPORTED_ENTITIES.has(entityType as NotionEntityType)) {
      throw new Error(
        `Unsupported Notion entity type: ${entityType}. Supported: ${Array.from(SUPPORTED_ENTITIES).join(', ')}`
      );
    }
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown Notion MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    }
    return {};
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('Notion MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    if (entityType === 'pages') {
      const p = payload ?? {};
      const searchParams: Record<string, unknown> = {
        filter: { value: 'page', property: 'object' },
      };
      if (p.cursor) searchParams.start_cursor = p.cursor;
      const result = await this.mcpClient.callTool('search', searchParams);
      const data = this.parseToolResult(result);
      const results = data.results as Array<Record<string, unknown>> ?? [];
      return {
        id: 'pages',
        data: { pages: results, hasMore: Boolean(data.has_more), nextPageToken: data.next_cursor },
      };
    }

    if (entityType === 'databases') {
      const p = payload ?? {};
      const searchParams: Record<string, unknown> = {
        filter: { value: 'database', property: 'object' },
      };
      if (p.cursor) searchParams.start_cursor = p.cursor;
      const result = await this.mcpClient.callTool('search', searchParams);
      const data = this.parseToolResult(result);
      const results = data.results as Array<Record<string, unknown>> ?? [];
      return {
        id: 'databases',
        data: { databases: results, hasMore: Boolean(data.has_more), nextPageToken: data.next_cursor },
      };
    }

    if (entityType === 'page_search') {
      const p = payload ?? {};
      const searchParams: Record<string, unknown> = {};
      if (p.query) searchParams.query = p.query;
      if (p.cursor) searchParams.start_cursor = p.cursor;
      const result = await this.mcpClient.callTool('search', searchParams);
      const data = this.parseToolResult(result);
      const results = data.results as Array<Record<string, unknown>> ?? [];
      return {
        id: 'page_search',
        data: { results, hasMore: Boolean(data.has_more), nextPageToken: data.next_cursor },
      };
    }

    this.validateEntityType(entityType);

    const tool = READ_TOOL_MAP[entityType] || `retrieve-a-${entityType}`;
    const paramName = READ_PARAM_MAP[entityType] || `${entityType}_id`;
    const result = await this.mcpClient.callTool(tool, { [paramName]: entityId });
    const data = this.parseToolResult(result);

    return {
      id: entityId ?? entityType,
      data,
      lastModified: data.last_edited_time
        ? new Date(data.last_edited_time as string)
        : undefined,
    };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // The polling scheduler passes capitalized entity types ('Page'), while
    // the tool-gateway path historically called list('page'). Normalize so both
    // callers route to the same Notion `search` branch.
    const et = entityType.toLowerCase();
    const query = (filters as Record<string, unknown>)?.query as string | undefined;
    // Accept the scheduler's opaque cursor (pageToken) as well as the legacy
    // `cursor` filter key.
    const cursor =
      ((filters as Record<string, unknown>)?.cursor as string | undefined) ??
      filters?.pageToken;

    logger.info('Notion MCP list', { entityType, tenantId: this.tenantId });

    if (et === 'page' || et === 'database') {
      // Notion `search` has no server-side `since` filter; instead sort by
      // last_edited_time descending so a single page surfaces the most
      // recently edited objects. The polling scheduler dedups by version
      // (last_edited_time / extractVersion), so re-seeing unchanged rows is a
      // no-op there.
      const searchParams: Record<string, unknown> = {
        filter: { value: et, property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
      };
      if (query) searchParams.query = query;
      if (cursor) searchParams.start_cursor = cursor;

      const result = await this.mcpClient.callTool('search', searchParams);
      const data = this.parseToolResult(result);
      const results = data.results as Array<Record<string, unknown>> ?? [];

      return {
        records: results.map(r => ({
          id: String(r.id),
          data: r,
          lastModified: r.last_edited_time ? new Date(r.last_edited_time as string) : undefined,
        })),
        hasMore: Boolean(data.has_more),
        nextPageToken: data.next_cursor as string | undefined,
      };
    }

    if (et === 'block') {
      const databaseId = (filters as Record<string, unknown>)?.databaseId as string;
      if (!databaseId) return { records: [], hasMore: false };

      const queryParams: Record<string, unknown> = { id: databaseId };
      if (cursor) queryParams.start_cursor = cursor;

      const result = await this.mcpClient.callTool('query-data-source', queryParams);
      const data = this.parseToolResult(result);
      const results = data.results as Array<Record<string, unknown>> ?? [];

      return {
        records: results.map(r => ({
          id: String(r.id),
          data: r,
          lastModified: r.last_edited_time ? new Date(r.last_edited_time as string) : undefined,
        })),
        hasMore: Boolean(data.has_more),
        nextPageToken: data.next_cursor as string | undefined,
      };
    }

    return { records: [], hasMore: false, unsupported: true };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Notion MCP create', { entityType, tenantId: this.tenantId });

    try {
      if (entityType === 'page') {
        const params: Record<string, unknown> = {
          parent: data.parent,
          properties: data.properties ?? {},
        };
        if (data.children) params.children = data.children;

        const result = await this.mcpClient.callTool('create-a-page', params);
        const created = this.parseToolResult(result);
        return { success: true, id: String(created.id), data: created };
      }

      if (entityType === 'database') {
        const result = await this.mcpClient.callTool('create-a-data-source', data);
        const created = this.parseToolResult(result);
        return { success: true, id: String(created.id), data: created };
      }

      if (entityType === 'page_move') {
        const result = await this.mcpClient.callTool('move-page', { id: data.id, parent: data.parent });
        const parsed = this.parseToolResult(result);
        return { success: true, id: data.id as string, data: parsed };
      }

      return {
        success: false,
        id: '',
        error: `Unsupported entity type for create: ${entityType}`,
      };
    } catch (error) {
      return { success: false, id: '', error: (error as Error).message };
    }
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    logger.info('Notion MCP update', { entityType, entityId, tenantId: this.tenantId });

    try {
      if (entityType === 'page') {
        const result = await this.mcpClient.callTool('update-a-page', {
          page_id: entityId,
          ...data,
        });
        const updated = this.parseToolResult(result);
        return { success: true, data: updated };
      }

      if (entityType === 'database') {
        const result = await this.mcpClient.callTool('update-a-data-source', {
          database_id: entityId,
          ...data,
        });
        const updated = this.parseToolResult(result);
        return { success: true, data: updated };
      }

      return {
        success: false,
        error: `Unsupported entity type for update: ${entityType}`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.warn('Notion MCP delete attempted — not supported via MCP', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return {
      success: false,
      error: 'Notion does not support deleting pages or databases via API. Archive via update instead.',
    };
  }

  async restore(_entityType: string, _entityId: string, _snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return {
      success: false,
      error: 'Notion MCP: No compensation available for restore.',
    };
  }

  async semanticInverse(
    _entityType: string,
    _originalAction: string,
    _entityId: string,
    _originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    return {
      success: false,
      error: 'Notion MCP: No semantic inverse available.',
    };
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Notion MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
