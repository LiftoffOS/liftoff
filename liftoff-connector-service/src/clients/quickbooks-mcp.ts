import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { listViaMcpTool } from './mcp-entity-list.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

// Map entity types to QuickBooks MCP tool names (official Intuit MCP server)
const READ_TOOL_MAP: Record<string, string> = {
  customer: 'get_customer',
  vendor: 'get_vendor',
  invoice: 'get_invoice',
  payment: 'get_payment',
  estimate: 'get_estimate',
  bill: 'get_bill',
  account: 'get_account',
  item: 'get_item',
  employee: 'get_employee',
};

const CREATE_TOOL_MAP: Record<string, string> = {
  customer: 'create_customer',
  vendor: 'create_vendor',
  invoice: 'create_invoice',
  bill: 'create_bill',
  payment: 'create_payment',
  item: 'create_item',
  employee: 'create_employee',
  journal_entry: 'create_journal_entry',
  purchase_order: 'create_purchase_order',
};

const UPDATE_TOOL_MAP: Record<string, string> = {
  customer: 'update_customer',
  vendor: 'update_vendor',
  invoice: 'update_invoice',
  bill: 'update_bill',
  item: 'update_item',
  payment: 'update_payment',
};

const DELETE_TOOL_MAP: Record<string, string> = {
  invoice: 'delete_invoice',
  bill: 'delete_bill',
};

export interface QuickBooksMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class QuickBooksMCPClient implements CompensationClient {
  readonly connector = 'quickbooks';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: QuickBooksMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'quickbooks',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.intuit.com',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown QuickBooks MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    }
    return {};
  }

  async read(entityType: string, entityId: string): Promise<ExternalRecord> {
    logger.info('QuickBooks MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const tool = READ_TOOL_MAP[entityType] || `get_${entityType}`;
    const result = await this.mcpClient.callTool(tool, { id: entityId });
    const data = this.parseToolResult(result);

    return {
      id: entityId,
      data,
      lastModified: data.MetaData
        ? new Date((data.MetaData as Record<string, string>).LastUpdatedTime)
        : undefined,
    };
  }

  /** Enumerate an entity by discovering the tool that lists it.
   *
   *  See mcp-entity-list.ts: MCP exposes tools rather than tables, so there is
   *  no generic list verb. This used to return an empty array unconditionally,
   *  which a picker renders as "your account has none" — a claim about the
   *  customer's data that we were in no position to make. When the server
   *  exposes no enumerating tool the result now says so explicitly. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const parent = (filters as Record<string, unknown> | undefined)?.folderId;
    return listViaMcpTool(
      this.mcpClient,
      'QuickBooks',
      entityType,
      parent ? { id: parent, parent_id: parent } : {},
    );
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    const tool = CREATE_TOOL_MAP[entityType];
    if (!tool) {
      return { success: false, id: '', error: `Create not supported for QuickBooks entity type: ${entityType}` };
    }

    logger.info('QuickBooks MCP create', { entityType, tenantId: this.tenantId, correlationId: this.correlationId });

    const result = await this.mcpClient.callTool(tool, data);
    const parsed = this.parseToolResult(result);
    const id = (parsed.Id as string) || (parsed.id as string) || '';
    return { success: true, id, data: parsed };
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    const tool = UPDATE_TOOL_MAP[entityType];
    if (!tool) {
      return { success: false, error: `Update not supported for QuickBooks entity type: ${entityType}` };
    }

    logger.info('QuickBooks MCP update', { entityType, entityId, tenantId: this.tenantId, correlationId: this.correlationId });

    const result = await this.mcpClient.callTool(tool, { id: entityId, ...data });
    const parsed = this.parseToolResult(result);
    return { success: true, data: parsed };
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    const tool = DELETE_TOOL_MAP[entityType];
    if (!tool) {
      return { success: false, error: `Delete not supported for QuickBooks entity type: ${entityType}` };
    }

    logger.info('QuickBooks MCP delete', { entityType, entityId, tenantId: this.tenantId, correlationId: this.correlationId });

    const result = await this.mcpClient.callTool(tool, { id: entityId });
    this.parseToolResult(result);
    return { success: true };
  }

  async restore(entityType: string, entityId: string, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create' && entityId) {
      return this.delete(entityType, entityId);
    }
    return { success: false, error: 'No semantic inverse available for this QuickBooks operation' };
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('QuickBooks MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
