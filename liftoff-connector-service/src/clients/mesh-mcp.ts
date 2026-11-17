import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { listViaMcpTool } from './mcp-entity-list.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { MCPError, MCPErrorCode } from '../mcp/mcp-errors.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

type MeshEntityType =
  | 'contact'
  | 'group'
  | 'interaction'
  | 'note'
  | 'event';

const SUPPORTED_ENTITIES = new Set<string>([
  'contact', 'group', 'interaction', 'note', 'event',
]);

const READ_TOOL_MAP: Record<string, string> = {
  contact: 'get_contact_by_id',
  group: 'get_group',
  interaction: 'search_interactions',
  note: 'get_notes',
  event: 'get_events',
};

const WRITE_TOOL_MAP: Record<string, string> = {
  contact: 'add_contact',
  group: 'create_group',
  note: 'add_note',
};

const UPDATE_TOOL_MAP: Record<string, string> = {
  group: 'update_group',
};

export interface MeshMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class MeshMCPClient implements CompensationClient {
  readonly connector = 'mesh';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: MeshMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'mesh',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.clay.earth/mcp',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  private validateEntityType(entityType: string): void {
    if (!SUPPORTED_ENTITIES.has(entityType as MeshEntityType)) {
      throw new MCPError(
        MCPErrorCode.INVALID_ENTITY_TYPE,
        `Unsupported Mesh entity type: ${entityType}. Supported: ${Array.from(SUPPORTED_ENTITIES).join(', ')}`,
        undefined,
        { entityType, supported: Array.from(SUPPORTED_ENTITIES) }
      );
    }
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown Mesh MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      try {
        return JSON.parse(textContent.text) as Record<string, unknown>;
      } catch {
        throw new MCPError(
          MCPErrorCode.INVALID_RESPONSE,
          `Mesh MCP returned non-JSON response: ${textContent.text.slice(0, 200)}`
        );
      }
    }
    return {};
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    this.validateEntityType(entityType);

    logger.info('Mesh MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const tool = READ_TOOL_MAP[entityType];
    if (!tool) throw new MCPError(MCPErrorCode.TOOL_NOT_FOUND, `READ_TOOL_MAP missing entry for Mesh entity type: ${entityType}`);
    const args = entityId ? { id: entityId, ...payload } : { ...payload };
    const result = await this.mcpClient.callTool(tool, args);
    const data = this.parseToolResult(result);

    return {
      id: entityId || entityType,
      data,
      lastModified: data.updated_at
        ? new Date(data.updated_at as string)
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
      'Mesh',
      entityType,
      parent ? { id: parent, parent_id: parent } : {},
    );
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    this.validateEntityType(entityType);

    const tool = WRITE_TOOL_MAP[entityType];
    if (!tool) {
      return {
        success: false,
        id: '',
        error: `Mesh MCP does not support creating entity type: ${entityType}`,
      };
    }

    logger.info('Mesh MCP create', {
      entityType,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const result = await this.mcpClient.callTool(tool, data);
    const parsed = this.parseToolResult(result);

    const recordId = (parsed.id as string) || '';
    if (!recordId) {
      logger.warn('Mesh MCP create returned no id field', { entityType, tenantId: this.tenantId, correlationId: this.correlationId });
    }

    return {
      success: true,
      id: recordId,
      data: parsed,
    };
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    this.validateEntityType(entityType);

    if (!entityId) {
      return { success: false, error: `entityId required for Mesh MCP update of ${entityType}` };
    }

    const tool = UPDATE_TOOL_MAP[entityType];
    if (!tool) {
      return {
        success: false,
        error: `Mesh MCP does not support updating entity type: ${entityType}`,
      };
    }

    logger.info('Mesh MCP update', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const args = { id: entityId, ...data };
    const result = await this.mcpClient.callTool(tool, args);
    this.parseToolResult(result);

    return { success: true };
  }

  async delete(entityType: string, entityId: string | undefined): Promise<DeleteResult> {
    logger.warn('Mesh MCP delete attempted — not supported via MCP', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return {
      success: false,
      error: 'Mesh MCP does not support delete operations. Use the Mesh dashboard.',
    };
  }

  async restore(_entityType: string, _entityId: string | undefined, _snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return {
      success: false,
      error: 'Mesh MCP does not support restore operations.',
    };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    _originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    logger.info('Mesh MCP semantic inverse', { entityType, originalAction, entityId, tenantId: this.tenantId, correlationId: this.correlationId });

    switch (originalAction) {
      case 'create':
        // Mesh MCP does not expose a delete tool — created records must be removed manually.
        return { success: false, error: 'Mesh MCP does not support delete. Remove the created record manually in the Mesh dashboard.' };
      case 'update':
        return { success: false, error: 'Update compensation requires a pre-action snapshot.' };
      case 'delete':
        return { success: false, error: 'Mesh MCP does not support delete, so this client cannot have caused a deletion.' };
      default:
        return { success: false, error: `Unknown action type: ${originalAction}` };
    }
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Mesh MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
