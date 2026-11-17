import { CompensationClient, CredentialProvider, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { HubSpotWriteClient } from './hubspot-write.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { MCPError, MCPErrorCode } from '../mcp/mcp-errors.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

// HubSpot entity types (read-only via MCP)
type _HubSpotEntityType =
  | 'contact'
  | 'company'
  | 'deal'
  | 'ticket'
  | 'invoice'
  | 'product'
  | 'line_item'
  | 'quote'
  | 'subscription'
  | 'order'
  | 'cart'
  | 'user';

const SUPPORTED_ENTITIES = new Set<string>([
  'contact', 'company', 'deal', 'ticket', 'invoice',
  'product', 'line_item', 'quote', 'subscription', 'order', 'cart', 'user'
]);

export interface HubSpotMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class HubSpotMCPClient implements CompensationClient {
  readonly connector = 'hubspot';
  private mcpClient: MCPClient;
  private writeClient: HubSpotWriteClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: HubSpotMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'hubspot',
        // HubSpot tokens expire in 30 minutes
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.hubspot.com',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);

    // Same token, REST path — the vendor MCP is read-only.
    const credentialProvider: CredentialProvider = async () => ({
      accessToken: await tokenProvider.getToken(),
    });
    this.writeClient = new HubSpotWriteClient(credentialProvider);
  }

  private validateEntityType(entityType: string): void {
    if (!SUPPORTED_ENTITIES.has(entityType)) {
      throw new MCPError(
        MCPErrorCode.INVALID_ENTITY_TYPE,
        `Unsupported HubSpot entity type: ${entityType}`,
        undefined,
        { entityType, supported: Array.from(SUPPORTED_ENTITIES) }
      );
    }
  }

  private parseResult(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
    const textContent = result.content.find(c => c.type === 'text');
    return textContent?.text ? JSON.parse(textContent.text) as Record<string, unknown> : {};
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    logger.info('HubSpot MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const listToolMap: Record<string, string> = {
      contacts: 'list_contacts',
      deals: 'list_deals',
      companies: 'list_companies',
      tickets: 'list_tickets',
    };

    if (listToolMap[entityType]) {
      const p = payload ?? {};
      const params: Record<string, unknown> = { limit: p.limit ?? 100 };
      if (p.cursor) params.cursor = p.cursor;
      const result = await this.mcpClient.callTool(listToolMap[entityType], params);
      const data = this.parseResult(result);
      return {
        id: entityType,
        data: { results: data.results ?? [], hasMore: !!data.has_more, nextPageToken: data.next_cursor },
      };
    }

    this.validateEntityType(entityType);

    // Map to MCP tool - e.g., "get_contact", "get_deal"
    const tool = `get_${entityType}`;
    const result = await this.mcpClient.callTool(tool, { id: entityId });

    const data = this.parseResult(result);

    return {
      id: entityId ?? entityType,
      data,
      lastModified: data.updatedAt ? new Date(data.updatedAt as string) : undefined,
    };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const toolMap: Record<string, string> = {
      contact: 'list_contacts',
      deal: 'list_deals',
      company: 'list_companies',
      ticket: 'list_tickets',
    };
    const toolName = toolMap[entityType.toLowerCase()];
    if (!toolName) return { records: [], hasMore: false, unsupported: true };
    const params: Record<string, unknown> = { limit: filters?.limit ?? 100 };
    if (filters?.since) params.modified_after = filters.since.toISOString();
    if (filters?.pageToken) params.cursor = filters.pageToken;
    try {
      const result = await this.mcpClient.callTool(toolName, params);
      const text = result.content.find((c: { type: string }) => c.type === 'text')?.text ?? '{}';
      const parsed = JSON.parse(text) as { results?: unknown[]; next_cursor?: string; has_more?: boolean };
      return {
        records: (parsed.results ?? []).map((r: unknown) => {
          const rec = r as Record<string, unknown>;
          return { id: String(rec['id'] ?? crypto.randomUUID()), data: rec };
        }),
        nextPageToken: parsed.next_cursor,
        hasMore: !!parsed.has_more,
      };
    } catch (err) {
      // A failed call is not an empty CRM. Reporting "no contacts" for an
      // expired token or a HubSpot outage hides every one of those behind a
      // plausible-looking answer, so let it propagate and be surfaced as the
      // error it is.
      logger.warn('HubSpot MCP list failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
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

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
