// Generic MCP Connector Client
// Works with any MCP server — routes tool calls directly to MCPClient.callTool()
// No connector-specific logic; the tool name and args are passed through as-is.

import { CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult, ListFilters, ListResult } from './types.js';
import { listViaMcpTool } from './mcp-entity-list.js';
import { MCPClient } from '../mcp/mcp-client.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

export interface GenericMCPClientConfig {
  tenantId: string;
  connectorType: string;
  mcpUrl: string;
  credentialStore: CredentialStore;
  correlationId?: string;
}

export class GenericMCPClient implements CompensationClient {
  readonly connector: string;
  private mcpClient: MCPClient;
  private readonly tenantId: string;
  private readonly correlationId: string;

  constructor(config: GenericMCPClientConfig) {
    this.connector = config.connectorType;
    this.tenantId = config.tenantId;
    this.correlationId = config.correlationId || crypto.randomUUID();

    const tokenProvider = new OAuthTokenProvider(
      {
        tenantId: config.tenantId,
        connectorType: config.connectorType,
        refreshBufferMs: 5 * 60 * 1000,
      },
      config.credentialStore
    );

    this.mcpClient = new MCPClient({
      url: config.mcpUrl,
      tokenProvider,
      timeout: 30000,
    });

    this.mcpClient.setCorrelationId(this.correlationId);
  }

  // For MCP servers, tool calls go directly through callTool()
  // The action name IS the MCP tool name (e.g., get_bitcoin_price)
  private async callMCPTool(toolName: string, args: Record<string, unknown> = {}): Promise<any> {
    logger.info('Generic MCP tool call', {
      connector: this.connector,
      tool: toolName,
      tenantId: this.tenantId,
      correlationId: this.correlationId,
    });

    const result = await this.mcpClient.callTool(toolName, args);

    const textContent = result.content?.find((c: any) => c.type === 'text');

    // isError is checked BEFORE parsing, which is the ordering every sibling
    // client here already uses (stripe-mcp, intercom-mcp, notion-mcp, …).
    //
    // Reversed, as it was, an error result whose text is PROSE — which is what
    // most servers send — threw a JSON syntax error out of the parse on the
    // line above, and the real message was destroyed before anyone could read
    // it. The caller saw `Unexpected token …` for every such failure and had no
    // way to learn what the server actually objected to.
    if (result.isError) {
      throw new Error(textContent?.text || 'MCP tool call returned an error');
    }

    // MCP `text` content is a STRING by specification, not a JSON document.
    // Plenty of tools return exactly that: GitHub's `pull_request_read` with
    // `method: get_diff` returns a unified diff beginning `diff --git a/…`, and
    // parsing it threw where the diff was the whole point of the call.
    //
    // So a body that does not parse is returned AS TEXT rather than swallowed.
    // This is not a rescue for malformed JSON — a server that promised JSON and
    // broke it now surfaces through the isError path above, or reaches the
    // caller as the string it really sent, which is inspectable. Turning a
    // legitimate text result into an exception was the defect.
    //
    // Otherwise a reviewing agent can read a pull request successfully and then
    // die on the next step fetching that PR's diff, one call short of the
    // review it exists to write.
    const raw = textContent?.text;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      logger.info('MCP tool returned non-JSON text; passing through verbatim', {
        connector: this.connector,
        tool: toolName,
        tenantId: this.tenantId,
        correlationId: this.correlationId,
        bytes: raw.length,
      });
      return raw;
    }
  }

  /**
   * A READ FORWARDS ITS ARGUMENTS. It did not, and could not say so.
   *
   * The executor has always called this with three arguments —
   * `client.read(entityType, entityId, payload)` in adapter.ts — while this
   * method was declared with two. Passing an extra argument to a shorter
   * function is legal JavaScript and satisfies the structural interface check,
   * so `payload` was dropped in silence: no error, no log, no type complaint.
   * Every read reached the vendor with `{ id }`, or with `{}` when the payload
   * carried no id to extract.
   *
   * WHICH TOOLS. `inferCrudOp` routes by NAME, so every `get|read|list|fetch|
   * search|find|query` prefix lands here. On a generic-MCP connector — github,
   * datadog, sentry, granola — that is most of the read surface, and none of it
   * could be addressed. The write verbs were unaffected, because `create` and
   * `update` do forward. One connector that can post a comment and cannot read
   * a file looks like a scopes problem and is not one, which is why this
   * survived: the failure never named its own cause.
   *
   * THE TRACE, which is the proof; the failure counts are only its shadow.
   *
   *   1. types.ts:85 declares `read(entityType, entityId, payload?)`. Line 93
   *      declares `delete` the same way.
   *   2. adapter.ts:236 and :367 — BOTH executors, REST and MCP — call
   *      `client.read(entityType, entityId, payload)`. Three arguments.
   *   3. This method declared two, and its body never named a third.
   *   4. A function with fewer parameters is assignable to a signature with
   *      more. That is the language rule, so no error was ever possible.
   *   5. adapter.ts:142 `extractEntityId` reads only `id` / `targetRef` /
   *      `entityId`. `get_commit` carries owner, repo, sha, detail — so it
   *      returns undefined and the ternary yielded `{}`.
   *   6. The vendor therefore received `callTool('get_commit', {})`. Every
   *      required argument was absent; `owner` is merely the first one the
   *      server checks, which is why the message named it.
   *
   * The same trace explains why its neighbour worked, and that asymmetry is
   * what made this look like a permissions problem: `inferCrudOp` (adapter.ts:85,
   * prefix rules at :105) sends `get_commit` to `read`, while
   * `pull_request_read` matches no prefix, falls to `return 'create'`, and
   * reaches `create(entityType, payload)` below — which forwards the object
   * whole. Same server, same credential, same second, two different methods.
   *
   * The id is merged ON TOP of the payload rather than instead of it, so this
   * is strictly wider than the old behaviour: a vendor tool keyed on `id` still
   * receives exactly what it did before.
   */
  async read(
    entityType: string,
    entityId?: string,
    payload?: Record<string, unknown>,
  ): Promise<ExternalRecord> {
    // For generic MCP, entityType is the action name (e.g., get_bitcoin_price)
    const data = await this.callMCPTool(entityType, this.withEntityId(entityId, payload));
    return {
      id: entityId || entityType,
      data,
    };
  }

  /** The vendor arguments: everything the caller passed, with the extracted id
   *  laid over it when there is one.
   *
   *  Separate so `read` and `delete` cannot drift on the merge order — they are
   *  the two methods that took an id and nothing else. */
  private withEntityId(
    entityId: string | undefined,
    payload: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    return { ...(payload ?? {}), ...(entityId ? { id: entityId } : {}) };
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
      'generic MCP',
      entityType,
      parent ? { id: parent, parent_id: parent } : {},
    );
  }

  async create(entityType: string, data: Record<string, unknown>): Promise<CreateResult> {
    // For generic MCP, entityType is the action name (e.g., append_row)
    const result = await this.callMCPTool(entityType, data);
    return {
      success: true,
      id: result.id || '',
      data: result,
    };
  }

  async update(entityType: string, entityId: string, data: Record<string, unknown>): Promise<UpdateResult> {
    const result = await this.callMCPTool(entityType, { id: entityId, ...data });
    return {
      success: true,
      data: result,
    };
  }

  /** Same signature defect as `read`, same call shape from the executor.
   *  GitHub's `delete_file` needs owner, repo, path and branch, and could never
   *  be addressed with any of them. */
  async delete(
    entityType: string,
    entityId?: string,
    payload?: Record<string, unknown>,
  ): Promise<DeleteResult> {
    await this.callMCPTool(entityType, this.withEntityId(entityId, payload));
    return { success: true };
  }

  async restore(entityType: string, entityId: string, snapshot: Record<string, unknown>): Promise<UpdateResult> {
    const result = await this.callMCPTool(`restore_${entityType}`, { id: entityId, ...snapshot });
    return { success: true, data: result };
  }

  async semanticInverse(
    entityType: string,
    originalAction: string,
    entityId: string,
    _originalResponse: Record<string, unknown>
  ): Promise<DeleteResult | UpdateResult> {
    // Attempt to undo by calling delete if original was create, or restore if delete
    if (originalAction.startsWith('create') || originalAction.startsWith('append') || originalAction.startsWith('insert')) {
      return this.delete(entityType, entityId);
    }
    return { success: false, data: { error: `Cannot semantically inverse action: ${originalAction}` } } as UpdateResult;
  }
}
