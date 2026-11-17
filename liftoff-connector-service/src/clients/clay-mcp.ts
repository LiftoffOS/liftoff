// Clay.com (api.clay.com/v3/mcp) — GTM data enrichment / prospecting MCP.
//
// Clay.com's MCP is tool/action-based (find/enrich ICP contacts, account research, run Clay
// Functions), NOT the entity-CRUD model. Its tools/list is OAuth-gated, so the concrete tool
// surface can only be enumerated AFTER a Clay.com account is connected. Until those tools are
// enumerated (via listTools) and a CLAY_FUNCTIONS registry entry is authored, this client
// supports connect + listTools only; entity CRUD is intentionally unsupported.
//
// NOTE: the personal-relationship-manager formerly wired here (mcp.clay.earth, now Mesh/me.sh)
// lives in mesh-mcp.ts. Do not reintroduce contact/note/interaction CRUD on this client.
import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult,
} from './types.js';
import { listViaMcpTool } from './mcp-entity-list.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

const NOT_WIRED =
  'Clay.com record operations are not registered — author a CLAY_FUNCTIONS registry entry from the live tool ' +
  'list (enumerate via listTools after connecting a Clay.com account).';

export interface ClayMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class ClayMCPClient implements CompensationClient {
  readonly connector = 'clay';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: ClayMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'clay',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore,
    );

    this.mcpClient = new MCPClient({
      url: 'https://api.clay.com/v3/mcp',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  async read(): Promise<ExternalRecord> {
    throw new Error(NOT_WIRED);
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
      'Clay.com',
      entityType,
      parent ? { id: parent, parent_id: parent } : {},
    );
  }

  async create(): Promise<CreateResult> {
    return { success: false, id: '', error: NOT_WIRED };
  }

  async update(): Promise<UpdateResult> {
    return { success: false, error: NOT_WIRED };
  }

  async delete(): Promise<DeleteResult> {
    return { success: false, error: NOT_WIRED };
  }

  async restore(): Promise<UpdateResult> {
    return { success: false, error: NOT_WIRED };
  }

  async semanticInverse(): Promise<DeleteResult | UpdateResult> {
    return { success: false, error: NOT_WIRED };
  }

  // Available pre-CLAY_FUNCTIONS: enumerate the live Clay.com tool surface after connect.
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Clay.com MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });
    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
