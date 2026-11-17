import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { listViaMcpTool } from './mcp-entity-list.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

// Map entity types to Xero MCP tool names (official XeroAPI MCP server)
const READ_TOOL_MAP: Record<string, string> = {
  contact: 'get_contact',
  invoice: 'get_invoice',
  credit_note: 'get_credit_note',
  payment: 'get_payment',
  account: 'get_account',
  item: 'get_item',
  employee: 'get_employee',
  organisation: 'get_organisation',
};

const CREATE_TOOL_MAP: Record<string, string> = {
  contact: 'create_contact',
  invoice: 'create_invoice',
  credit_note: 'create_credit_note',
  payment: 'create_payment',
  manual_journal: 'create_manual_journal',
  item: 'create_item',
};

const UPDATE_TOOL_MAP: Record<string, string> = {
  contact: 'update_contact',
  invoice: 'update_invoice',
  credit_note: 'update_credit_note',
  item: 'update_item',
};

export interface XeroMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class XeroMCPClient implements CompensationClient {
  readonly connector = 'xero';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: XeroMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'xero',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.xero.com',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown Xero MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    }
    return {};
  }

  async read(entityType: string, entityId: string): Promise<ExternalRecord> {
    logger.info('Xero MCP read', {
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
      lastModified: data.UpdatedDateUTC
        ? new Date(data.UpdatedDateUTC as string)
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
      'Xero',
      entityType,
      parent ? { id: parent, parent_id: parent } : {},
    );
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    const tool = CREATE_TOOL_MAP[entityType];
    if (!tool) {
      return { success: false, id: '', error: `Create not supported for Xero entity type: ${entityType}` };
    }

    logger.info('Xero MCP create', { entityType, tenantId: this.tenantId, correlationId: this.correlationId });

    const result = await this.mcpClient.callTool(tool, data);
    const parsed = this.parseToolResult(result);
    const id = (parsed.InvoiceID as string) || (parsed.ContactID as string) || (parsed.ItemID as string) || (parsed.id as string) || '';
    return { success: true, id, data: parsed };
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    const tool = UPDATE_TOOL_MAP[entityType];
    if (!tool) {
      return { success: false, error: `Update not supported for Xero entity type: ${entityType}` };
    }

    logger.info('Xero MCP update', { entityType, entityId, tenantId: this.tenantId, correlationId: this.correlationId });

    const result = await this.mcpClient.callTool(tool, { id: entityId, ...data });
    const parsed = this.parseToolResult(result);
    return { success: true, data: parsed };
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    // Xero does not expose a delete tool — void invoices instead
    logger.info('Xero MCP delete (void)', { entityType, entityId, tenantId: this.tenantId, correlationId: this.correlationId });

    if (entityType === 'invoice') {
      const result = await this.mcpClient.callTool('update_invoice', { id: entityId, Status: 'VOIDED' });
      this.parseToolResult(result);
      return { success: true };
    }

    return { success: false, error: `Delete not supported for Xero entity type: ${entityType}` };
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
    return { success: false, error: 'No semantic inverse available for this Xero operation' };
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Xero MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
