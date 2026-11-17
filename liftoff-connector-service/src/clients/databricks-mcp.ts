import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { TokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

// Databricks (plan §3B). Two surfaces:
//   • raw read via the SQL MCP server (`{workspaceUrl}/api/2.0/mcp/sql`) — the
//     pinned functions run_query / list_tables / get_table_schema resolve the
//     workspace-specific SQL tool at call time (tool sets are per-workspace).
//   • Genie semantic (`{workspaceUrl}/api/2.0/mcp/genie/{space}`) — NL→SQL,
//     Unity-Catalog RLS enforced. Genie generally requires OAuth (M2M/DCR), so
//     a DCR/OAuth token provider sits alongside the PAT provider.
// The PAT / client secret are stored in Secret Manager; workspaceUrl,
// genieSpaceId, oauthClientId come from connectors.config (DB JSONB).

/** PAT bearer — the raw SQL MCP surface. */
class DatabricksPatTokenProvider implements TokenProvider {
  constructor(
    private readonly tenantId: string,
    private readonly credentialStore: CredentialStore,
  ) {}

  async getToken(): Promise<string> {
    const credentials = await this.credentialStore.getCredentials(this.tenantId, 'databricks');
    return credentials.accessToken;
  }

  async refreshToken(): Promise<string> {
    return this.getToken();
  }

  isTokenExpired(): boolean {
    return false;
  }
}

/**
 * OAuth M2M (service-principal / DCR) token provider — used for the Genie
 * endpoint where PAT is insufficient (plan §3B). Client-credentials against the
 * workspace OIDC token endpoint; self-serve per-workspace (the customer creates
 * a service principal + secret — no Databricks review of Liftoff). The client
 * secret is resolved from Secret Manager (stored as the credential refreshToken
 * slot when the connector is onboarded in OAuth mode).
 */
class DatabricksDcrTokenProvider implements TokenProvider {
  private cachedToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private readonly refreshBufferMs = 5 * 60 * 1000;

  constructor(
    private readonly tenantId: string,
    private readonly workspaceUrl: string,
    private readonly clientId: string,
    private readonly credentialStore: CredentialStore,
  ) {}

  async getToken(): Promise<string> {
    if (this.cachedToken && !this.isTokenExpired()) return this.cachedToken;
    return this.refreshToken();
  }

  async refreshToken(): Promise<string> {
    const credentials = await this.credentialStore.getCredentials(this.tenantId, 'databricks');
    const clientSecret = credentials.refreshToken || credentials.accessToken;
    const res = await fetch(`${this.workspaceUrl.replace(/\/$/, '')}/oidc/v1/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials&scope=all-apis',
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`databricks_oauth_failed ${res.status}: ${body.error_description ?? res.statusText}`);
    }
    this.cachedToken = body.access_token;
    this.tokenExpiry = new Date(Date.now() + (body.expires_in ?? 3600) * 1000);
    return this.cachedToken;
  }

  isTokenExpired(): boolean {
    if (!this.tokenExpiry) return true;
    return Date.now() >= this.tokenExpiry.getTime() - this.refreshBufferMs;
  }
}

export interface DatabricksMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  connectorConfig: Record<string, unknown>;
  correlationId?: string;
}

/** Reject anything that isn't a plain dotted SQL identifier — list_tables /
 *  get_table_schema build SQL from these, so they must not be injectable. */
function sanitizeIdentifier(raw: string, label: string): string {
  if (!raw || !/^[A-Za-z0-9_.`]+$/.test(raw)) {
    throw new Error(`invalid ${label}: expected a catalog.schema[.table] identifier`);
  }
  return raw;
}

export class DatabricksMCPClient implements CompensationClient {
  readonly connector = 'databricks';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;
  private readonly workspaceUrl: string;
  private readonly genieSpaceId?: string;
  private readonly oauthClientId?: string;
  private readonly credentialStore: CredentialStore;
  private sqlToolName: string | null = null;

  constructor(config: DatabricksMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();
    this.credentialStore = config.credentialStore;

    const workspaceUrl = config.connectorConfig.workspaceUrl as string;
    if (!workspaceUrl) {
      throw new Error('Databricks connector requires workspaceUrl in connectorConfig');
    }
    this.workspaceUrl = workspaceUrl.replace(/\/$/, '');
    this.genieSpaceId = config.connectorConfig.genieSpaceId as string | undefined;
    this.oauthClientId = config.connectorConfig.oauthClientId as string | undefined;

    const tokenProvider = new DatabricksPatTokenProvider(config.tenantId, config.credentialStore);

    this.mcpClient = new MCPClient({
      url: `${this.workspaceUrl}/api/2.0/mcp/sql`,
      tokenProvider,
      timeout: 20000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown Databricks MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    }
    return {};
  }

  /** Resolve the workspace's SQL-execution tool once (names are per-workspace). */
  private async resolveSqlTool(): Promise<string> {
    if (this.sqlToolName) return this.sqlToolName;
    const tools = await this.mcpClient.listTools();
    const match = tools.find((t) => /execute|statement|^sql$|run_?query|query/i.test(t.name));
    if (!match) {
      throw new Error('Databricks SQL MCP exposes no SQL-execution tool for this workspace');
    }
    this.sqlToolName = match.name;
    return match.name;
  }

  /** Run a statement through the SQL MCP tool. Callers pass either agent-gated
   *  SELECTs (run_query) or internally-built SHOW/DESCRIBE (sanitized). */
  private async runSql(statement: string): Promise<Record<string, unknown>> {
    const tool = await this.resolveSqlTool();
    // Pass both arg spellings — workspace tools name the SQL param differently.
    const result = await this.mcpClient.callTool(tool, { statement, query: statement, sql: statement });
    return this.parseToolResult(result);
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    logger.info('Databricks MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    switch (entityType) {
      case 'sql_result': {
        // run_query — already validated read-only + row-capped by sqlGuard (§2).
        const statement = (payload?.statement as string) ?? '';
        if (!statement) throw new Error('run_query requires a statement');
        return { id: '', data: await this.runSql(statement) };
      }
      case 'tables': {
        const schema = sanitizeIdentifier((payload?.schema_name as string) ?? '', 'schema_name');
        return { id: schema, data: await this.runSql(`SHOW TABLES IN ${schema}`) };
      }
      case 'table_schema': {
        const table = sanitizeIdentifier((payload?.table_name as string) ?? '', 'table_name');
        return { id: table, data: await this.runSql(`DESCRIBE TABLE ${table}`) };
      }
      case 'semantic': {
        return { id: '', data: await this.genieQuery((payload?.question as string) ?? '') };
      }
      default: {
        // Back-compat: route unknown entityTypes straight to a like-named tool.
        const result = await this.mcpClient.callTool(entityType, { id: entityId });
        return { id: entityId ?? '', data: this.parseToolResult(result) };
      }
    }
  }

  /**
   * Genie semantic query (plan §3B/§6). Degrades gracefully: no Genie space
   * configured → honest {success:false,error} (never a fabricated success), and
   * the agent falls back to run_query.
   */
  private async genieQuery(question: string): Promise<Record<string, unknown>> {
    if (!question) throw new Error('semantic_query requires a question');
    if (!this.genieSpaceId) {
      return { success: false, error: 'no Genie space configured for this Databricks workspace; use run_query instead' };
    }
    const tokenProvider: TokenProvider = this.oauthClientId
      ? new DatabricksDcrTokenProvider(this.tenantId, this.workspaceUrl, this.oauthClientId, this.credentialStore)
      : new DatabricksPatTokenProvider(this.tenantId, this.credentialStore);
    const genie = new MCPClient({
      url: `${this.workspaceUrl}/api/2.0/mcp/genie/${this.genieSpaceId}`,
      tokenProvider,
      timeout: 30000,
    });
    genie.setCorrelationId(this.correlationId);
    try {
      const tools = await genie.listTools();
      const ask = tools.find((t) => /ask|query|question|genie|converse|message/i.test(t.name));
      if (!ask) {
        return { success: false, error: 'Genie space is configured but exposes no query tool' };
      }
      const result = await genie.callTool(ask.name, { question, query: question, content: question });
      return this.parseToolResult(result);
    } finally {
      genie.disconnect();
    }
  }

  /** Walk the Unity Catalog namespace: catalogs → schemas → tables.
   *
   *  Databricks has no list tool over MCP, so each level is a SHOW statement
   *  through the same SQL path `read` uses. Identifiers are run through
   *  sanitizeIdentifier for the same reason they are there: `filters.folderId`
   *  reaches this from an HTTP query string, and it is interpolated into SQL.
   *
   *  Schemas and tables are scoped to a parent. Missing it means the request did
   *  not say where to look, not that this client cannot look, so it returns
   *  empty without the unsupported marker. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const rawParent = (filters as Record<string, unknown> | undefined)?.folderId as string | undefined;

    let statement: string;
    switch (entityType) {
      case 'catalog':
      case 'catalogs':
        statement = 'SHOW CATALOGS';
        break;
      case 'schema':
      case 'schemas':
        if (!rawParent) return { records: [], hasMore: false };
        statement = `SHOW SCHEMAS IN ${sanitizeIdentifier(rawParent, 'catalog_name')}`;
        break;
      case 'table':
      case 'tables':
        if (!rawParent) return { records: [], hasMore: false };
        statement = `SHOW TABLES IN ${sanitizeIdentifier(rawParent, 'schema_name')}`;
        break;
      default:
        return { records: [], hasMore: false, unsupported: true };
    }

    const data = await this.runSql(statement);

    // SHOW returns a result set whose row shape varies by workspace and by
    // level (catalog / database / schemaName / tableName). Take the first array
    // in the response and the first name-ish column, rather than pinning to one
    // spelling that only some workspaces use.
    const rows: unknown[] = Array.isArray(data)
      ? data
      : (Object.values(data).find(Array.isArray) as unknown[]) ?? [];

    return {
      records: rows.map(row => {
        if (typeof row === 'string') return { id: row, data: { name: row } };
        const r = row as Record<string, any>;
        const name = String(
          r.tableName ?? r.table_name ?? r.databaseName ?? r.database_name
          ?? r.schemaName ?? r.schema_name ?? r.catalog ?? r.name ?? '',
        );
        return { id: name, data: r };
      }),
      hasMore: false,
    };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Databricks MCP create', {
      entityType,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    // Write surface (run_write_sql, follow-on §14): a data-modifying statement.
    if (entityType === 'sql_result') {
      const statement = (data.statement as string) ?? '';
      if (!statement) return { success: false, id: '', error: 'run_write_sql requires a statement' };
      return { success: true, id: '', data: await this.runSql(statement) };
    }

    const result = await this.mcpClient.callTool(entityType, data);
    const parsed = this.parseToolResult(result);
    const id = (parsed.id as string) || '';
    return { success: true, id, data: parsed };
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    logger.info('Databricks MCP update', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const result = await this.mcpClient.callTool(entityType, { id: entityId, ...data });
    const parsed = this.parseToolResult(result);
    return { success: true, data: parsed };
  }

  async delete(entityType: string, entityId: string): Promise<DeleteResult> {
    logger.info('Databricks MCP delete', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const result = await this.mcpClient.callTool(entityType, { id: entityId });
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
    _originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    if (originalAction === 'create' && entityId) {
      return this.delete(entityType, entityId);
    }
    return { success: false, error: 'No semantic inverse available for this Databricks operation' };
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Databricks MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
