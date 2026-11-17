// Zoom MCP Connector Client
// Reads via Zoom's vendor MCP server; writes delegate to ZoomClient REST.

import crypto from 'crypto';
import { logger } from '../infra/logging.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import type { CredentialStore } from '../mcp/credential-store.js';
import type {
  CompensationClient,
  CredentialProvider,
  ExternalRecord,
  CreateResult,
  UpdateResult,
  DeleteResult,
  ListFilters,
  ListResult,
} from './types.js';
import { ZoomClient } from './zoom.js';

export interface ZoomMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class ZoomMCPClient implements CompensationClient {
  readonly connector = 'zoom';
  private mcpClient: MCPClient;
  private writeClient: ZoomClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: ZoomMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId ?? crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: 'zoom',
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore,
    );

    this.mcpClient = new MCPClient({
      url: 'https://mcp.zoom.us/mcp',
      tokenProvider,
      timeout: 30000,
    });
    this.mcpClient.setCorrelationId(this.correlationId);

    const credentialProvider: CredentialProvider = async () => ({
      accessToken: await tokenProvider.getToken(),
    });
    this.writeClient = new ZoomClient(credentialProvider);
  }

  async read(entityType: string, entityId: string): Promise<ExternalRecord> {
    const toolMap: Record<string, string> = {
      MeetingNotes: 'get_meeting_summary',
    };
    const tool = toolMap[entityType];
    if (!tool) throw new Error(`ZoomMCPClient: unsupported entity type ${entityType}`);
    const result = await this.mcpClient.callTool(tool, { meetingId: entityId });
    const text = result.content.find((c: { type: string }) => c.type === 'text')?.text ?? '{}';
    return { id: entityId, data: JSON.parse(text) as Record<string, unknown> };
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    if (entityType === 'MeetingNotes') {
      const params: Record<string, unknown> = {
        type: 'past',
        page_size: filters?.limit ?? 100,
      };
      if (filters?.since) params['from'] = filters.since.toISOString().split('T')[0];
      if (filters?.pageToken) params['next_page_token'] = filters.pageToken;
      try {
        const result = await this.mcpClient.callTool('list_recordings', params);
        const text = result.content.find((c: { type: string }) => c.type === 'text')?.text ?? '{}';
        const parsed = JSON.parse(text) as {
          meetings?: Record<string, unknown>[];
          next_page_token?: string;
        };
        return {
          records: (parsed.meetings ?? []).map(m => ({
            id: String(m['uuid'] ?? m['id']),
            data: m,
          })),
          nextPageToken: parsed.next_page_token || undefined,
          hasMore: !!parsed.next_page_token,
        };
      } catch (err) {
        // A failed call is not an empty account. Swallowing it here reported
        // "no recordings" for an expired token, a Zoom outage, or a malformed
        // response alike, and the caller had no way to tell. Let it propagate:
        // the route turns a throw into an error the person can act on.
        logger.warn('Zoom MCP list_recordings failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
    return { records: [], hasMore: false, unsupported: true };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    return this.writeClient.create(entityType, data);
  }

  async update(entityType: string, entityId: string | undefined, data: Record<string, unknown>): Promise<UpdateResult> {
    return this.writeClient.update(entityType, entityId, data);
  }

  async delete(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<DeleteResult> {
    void payload;
    return this.writeClient.delete(entityType, entityId);
  }

  async restore(entityType: string, entityId: string | undefined, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.writeClient.restore(entityType, entityId, snapshot);
  }

  async semanticInverse(entityType: string, originalAction: string, entityId: string | undefined, originalResponse: Record<string, unknown>): Promise<DeleteResult | UpdateResult> {
    return this.writeClient.semanticInverse(entityType, originalAction, entityId, originalResponse);
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
