// GitHub MCP Connector Client (reactive polling)
//
// GitHub is a vendor-hosted MCP (https://api.githubcopilot.com/mcp/). For
// reactive polling the scheduler calls list('Issue' | 'PullRequest') with an
// incremental `since` watermark. The GitHub MCP exposes `search_issues` and
// `search_pull_requests`, which take a literal GitHub search query (NOT an
// LLM/NL query) — so we build a deterministic `involves:@me updated:>=<since>`
// query to surface the authenticated user's recently-changed issues/PRs across
// all repos without per-repo fan-out. Search returns { items: [...], total_count }.
//
// Only list() is implemented here — agent CRUD on GitHub goes through the
// self-describing tool-gateway path, not this structured client.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

export interface GitHubMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class GitHubMCPClient implements CompensationClient {
  readonly connector = 'github';
  private mcpClient: MCPClient;
  private readonly tenantId: string;

  constructor(config: GitHubMCPClientConfig) {
    this.tenantId = config.tenantId;
    const tokenProvider = new OAuthTokenProvider(
      { tenantId: config.tenantId, connectorType: 'github' },
      config.credentialStore,
    );
    this.mcpClient = new MCPClient({
      url: 'https://api.githubcopilot.com/mcp/',
      tokenProvider,
      timeout: 30000,
    });
    this.mcpClient.setCorrelationId(config.correlationId || crypto.randomUUID());
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const tool =
      entityType === 'Issue' ? 'search_issues'
      : entityType === 'PullRequest' ? 'search_pull_requests'
      : undefined;
    if (!tool) return { records: [], hasMore: false, unsupported: true };

    // GitHub search query syntax (literal). `involves:@me` scopes to the
    // authenticated user; `updated:>=` gives incremental change detection.
    const qualifier = entityType === 'Issue' ? 'is:issue' : 'is:pr';
    let query = `${qualifier} involves:@me`;
    if (filters?.since instanceof Date) {
      query += ` updated:>=${filters.since.toISOString()}`;
    }
    const perPage = filters?.limit ?? 100;
    const page = filters?.pageToken ? Number(filters.pageToken) : 1;

    try {
      const result = await this.mcpClient.callTool(tool, {
        query, sort: 'updated', order: 'desc', perPage, page,
      });
      const textContent = result.content?.find((c: { type: string }) => c.type === 'text');
      if (result.isError) throw new Error(textContent?.text || 'GitHub MCP search error');
      const parsed = (textContent?.text ? JSON.parse(textContent.text) : {}) as {
        items?: Array<Record<string, unknown>>;
        total_count?: number;
      };
      const items = parsed.items ?? [];
      const records = items.map(it => ({ id: String(it.id ?? it.number ?? ''), data: it }));
      const hasMore = items.length === perPage;
      return { records, nextPageToken: hasMore ? String(page + 1) : undefined, hasMore };
    } catch (err) {
      logger.warn('GitHub MCP list failed — verify search tool via tools/list', {
        entityType, tool, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }
  }

  // GitHub reactive uses list() only; structured write/compensation is not
  // routed through this client. The CompensationClient surface is satisfied
  // with explicit not-supported responses.
  async read(): Promise<ExternalRecord> {
    throw new Error('GitHubMCPClient supports list() only (reactive polling)');
  }
  async create(): Promise<CreateResult> {
    return { success: false, id: '', error: 'github write-only via tool-gateway' };
  }
  async update(): Promise<UpdateResult> {
    return { success: false, error: 'github write-only via tool-gateway' };
  }
  async delete(): Promise<DeleteResult> {
    return { success: false, error: 'github write-only via tool-gateway' };
  }
  async restore(): Promise<UpdateResult> {
    return { success: false, error: 'not supported' };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
