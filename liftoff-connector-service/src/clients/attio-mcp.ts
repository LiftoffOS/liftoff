// Attio MCP + REST hybrid client.
//
// Primary: Attio's vendor-hosted MCP server (mcp.attio.com/mcp) gives agents
// access to 35+ tools — records, lists, comments, notes, tasks, meetings,
// call recordings, emails, semantic search, workspace, and reporting.
//
// REST supplement: Attio's MCP server has no delete operations for records,
// notes, tasks, or list entries. The existing AttioClient (api.attio.com/v2)
// handles those. Both paths use the same access token from the DCR OAuth flow.
//
// Auth: DCR OAuth via mcp.attio.com — no static client credentials needed.
// Scopes include both 'mcp' (MCP server) and the REST API scopes
// (record_permission:read-write, note:read-write, etc.) so one token covers both.

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
import { AttioClient } from './attio.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

export interface AttioMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class AttioMCPClient implements CompensationClient {
  readonly connector = 'attio';
  private mcpClient: MCPClient;
  private restClient: AttioClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: AttioMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId ?? crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'attio',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore,
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.attio.com/mcp',
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);

    // REST supplement uses the same token — covers delete operations and files.
    const credentialProvider: CredentialProvider = async () => ({
      accessToken: await tokenProvider.getToken(),
    });
    this.restClient = new AttioClient(credentialProvider);
  }

  async read(
    entityType: string,
    entityId: string | undefined,
    payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    logger.info('Attio read', { entityType, entityId, tenantId: this.tenantId });
    return this.restClient.read(entityType, entityId, payload);
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    return this.restClient.list(entityType, filters);
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    return this.restClient.create(entityType, data);
  }

  async update(
    entityType: string,
    entityId: string | undefined,
    data: Record<string, unknown>,
  ): Promise<UpdateResult> {
    return this.restClient.update(entityType, entityId, data);
  }

  async delete(entityType: string, entityId: string | undefined): Promise<DeleteResult> {
    return this.restClient.delete(entityType, entityId);
  }

  async restore(
    entityType: string,
    entityId: string | undefined,
    snapshot: Record<string, unknown>,
  ): Promise<UpdateResult> {
    return this.restClient.restore(entityType, entityId, snapshot);
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string | undefined,
    originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    return this.restClient.semanticInverse(entityType, originalAction, entityId, originalResponse);
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
