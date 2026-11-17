import { createSign } from 'crypto';
import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { TokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

// Snowflake uses RS256 JWT authentication against its per-account MCP endpoint.
// The private key PEM is stored as accessToken in Secret Manager.
// accountIdentifier and username come from connectors.config (DB JSONB column).
class SnowflakeJwtTokenProvider implements TokenProvider {
  private cachedToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private readonly refreshBufferMs = 5 * 60 * 1000;

  constructor(
    private readonly tenantId: string,
    private readonly accountIdentifier: string,
    private readonly username: string,
    private readonly credentialStore: CredentialStore,
  ) {}

  async getToken(): Promise<string> {
    if (this.cachedToken && !this.isTokenExpired()) {
      return this.cachedToken;
    }
    return this.refreshToken();
  }

  async refreshToken(): Promise<string> {
    const credentials = await this.credentialStore.getCredentials(this.tenantId, 'snowflake');
    const privateKeyPem = credentials.accessToken;

    const account = this.accountIdentifier.toUpperCase();
    const user = this.username.toUpperCase();
    const iss = `${account}.${user}`;
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iss, sub: iss, iat: now, exp }));
    const signingInput = `${header}.${payload}`;

    const sign = createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = base64url(sign.sign(privateKeyPem));

    this.cachedToken = `${signingInput}.${signature}`;
    this.tokenExpiry = new Date(exp * 1000);
    return this.cachedToken;
  }

  isTokenExpired(): boolean {
    if (!this.tokenExpiry) return true;
    return Date.now() >= this.tokenExpiry.getTime() - this.refreshBufferMs;
  }
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export interface SnowflakeMCPClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
  connectorConfig: Record<string, unknown>;
  correlationId?: string;
}

export class SnowflakeMCPClient implements CompensationClient {
  readonly connector = 'snowflake';
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: SnowflakeMCPClientConfig) {
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const accountIdentifier = config.connectorConfig.accountIdentifier as string;
    const username = config.connectorConfig.username as string;

    if (!accountIdentifier || !username) {
      throw new Error('Snowflake connector requires accountIdentifier and username in connectorConfig');
    }

    const tokenProvider = new SnowflakeJwtTokenProvider(
      config.tenantId,
      accountIdentifier,
      username,
      config.credentialStore,
    );

    this.mcpClient = new MCPClient({
      url: `https://${accountIdentifier}.snowflakecomputing.com/api/2.0/mcp`,
      tokenProvider,
      timeout: 15000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  private parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, unknown> {
    if (result.isError) {
      const errorText = result.content.find(c => c.type === 'text')?.text;
      throw new Error(errorText || 'Unknown Snowflake MCP error');
    }
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text) as Record<string, unknown>;
    }
    return {};
  }

  async read(entityType: string, entityId: string | undefined, payload?: Record<string, unknown>): Promise<ExternalRecord> {
    logger.info('Snowflake MCP read', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    // run_query (plan §3A): the statement has already been validated read-only
    // and row-capped by the central sqlGuard in execute-dispatcher (plan §2),
    // so we run it verbatim through the MCP execute_sql tool.
    if (entityType === 'sql_result') {
      const statement = (payload?.statement as string) ?? '';
      if (!statement) throw new Error('run_query requires a statement');
      const result = await this.mcpClient.callTool('execute_sql', { statement });
      return { id: '', data: this.parseToolResult(result) };
    }

    // semantic_query (plan §3A/§6): degrade gracefully when no Cortex Analyst
    // semantic model is configured for the account.
    if (entityType === 'semantic') {
      const question = (payload?.question as string) ?? '';
      return { id: '', data: await this.semanticQuery(question) };
    }

    let tool: string;
    let args: Record<string, unknown>;

    switch (entityType) {
      case 'table_schema':
        tool = 'get_table_schema';
        args = { table_name: entityId };
        break;
      case 'tables':
        tool = 'list_tables';
        args = { schema_name: entityId };
        break;
      case 'schemas':
        tool = 'list_schemas';
        args = { database_name: entityId };
        break;
      case 'databases':
        tool = 'list_databases';
        args = {};
        break;
      default:
        tool = 'execute_sql';
        args = { statement: `SELECT * FROM ${entityId} LIMIT 100` };
    }

    const result = await this.mcpClient.callTool(tool, args);
    const data = this.parseToolResult(result);

    return { id: entityId ?? '', data };
  }

  /**
   * Cortex Analyst natural-language query (plan §3A/§6). The managed Cortex MCP
   * exposes a Cortex Analyst tool only when a semantic model is configured, so
   * we discover it at call time and degrade gracefully when it is absent rather
   * than hard-failing accounts that never set one up.
   */
  private async semanticQuery(question: string): Promise<Record<string, unknown>> {
    if (!question) throw new Error('semantic_query requires a question');
    const tools = await this.mcpClient.listTools();
    const analyst = tools.find((t) => /cortex|analyst|semantic/i.test(t.name));
    if (!analyst) {
      // §6 / INV-4: honest failure, never a fabricated success. The agent falls
      // back to run_query.
      return {
        success: false,
        error:
          'no Cortex Analyst semantic model configured for this Snowflake account; use run_query with an explicit SELECT instead',
      };
    }
    const result = await this.mcpClient.callTool(analyst.name, { query: question, question });
    return this.parseToolResult(result);
  }

  /** Walk the Snowflake namespace: databases → schemas → tables.
   *
   *  The managed MCP exposes a list tool at each level, so this is a real
   *  enumeration rather than a query dressed up as one. Schemas and tables are
   *  scoped to their parent, carried in `filters.folderId`; without it there is
   *  nothing to enumerate under, which is a gap in the request rather than in
   *  this client, and so is not marked unsupported.
   *
   *  Rows come back as whatever shape the tool returns; a name field is the
   *  identity here because Snowflake objects are addressed by name, not id. */
  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const parent = (filters as Record<string, unknown> | undefined)?.folderId as string | undefined;

    let tool: string;
    let args: Record<string, unknown>;
    switch (entityType) {
      case 'database':
      case 'databases':
        tool = 'list_databases';
        args = {};
        break;
      case 'schema':
      case 'schemas':
        if (!parent) return { records: [], hasMore: false };
        tool = 'list_schemas';
        args = { database_name: parent };
        break;
      case 'table':
      case 'tables':
        if (!parent) return { records: [], hasMore: false };
        tool = 'list_tables';
        args = { schema_name: parent };
        break;
      default:
        return { records: [], hasMore: false, unsupported: true };
    }

    const data = this.parseToolResult(await this.mcpClient.callTool(tool, args));

    // The list tools return either a bare array or a single-key envelope around
    // one; accept both rather than depending on which the account's MCP build
    // happens to emit.
    const rows: unknown[] = Array.isArray(data)
      ? data
      : (Object.values(data as Record<string, unknown>).find(Array.isArray) as unknown[]) ?? [];

    return {
      records: rows.map(row => {
        if (typeof row === 'string') return { id: row, data: { name: row } };
        const r = row as Record<string, any>;
        const name = String(r.name ?? r.NAME ?? r.table_name ?? r.TABLE_NAME ?? '');
        return { id: name, data: r };
      }),
      hasMore: false,
    };
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    logger.info('Snowflake MCP create', {
      entityType,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const statement = data.statement as string;
    if (!statement) {
      return { success: false, id: '', error: 'Snowflake create requires a statement in data.statement' };
    }

    const result = await this.mcpClient.callTool('execute_sql', { statement });
    const parsed = this.parseToolResult(result);
    return { success: true, id: '', data: parsed };
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    logger.info('Snowflake MCP update', {
      entityType,
      entityId,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const statement = data.statement as string;
    if (!statement) {
      return { success: false, error: 'Snowflake update requires a statement in data.statement' };
    }

    const result = await this.mcpClient.callTool('execute_sql', { statement });
    const parsed = this.parseToolResult(result);
    return { success: true, data: parsed };
  }

  async delete(_entityType: string, _entityId: string): Promise<DeleteResult> {
    return { success: false, error: 'Snowflake delete must be performed via execute_sql with an explicit statement' };
  }

  async restore(entityType: string, entityId: string, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    return this.update(entityType, entityId, snapshot);
  }

  async semanticInverse(
    _entityType: string,
    _originalAction: string,
    _entityId: string | undefined,
    _originalResponse: Record<string, unknown>,
  ): Promise<DeleteResult | UpdateResult> {
    return { success: false, error: 'No semantic inverse available for Snowflake SQL operations' };
  }

  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    logger.info('Snowflake MCP listTools', {
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    return this.mcpClient.listTools();
  }

  dispose(): void {
    this.mcpClient.disconnect();
  }
}
