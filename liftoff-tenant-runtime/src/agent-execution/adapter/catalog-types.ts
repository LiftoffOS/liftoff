// Unified MCP-shaped tool catalog produced by the platform layer and
// consumed by VendorSdkAdapter implementations.
//
// Distinct from the upstream tool-catalog/catalog-service.ts which models
// per-connector aliases for distill (CatalogTool / ToolCatalogResult).
// Those are per-connector and use snake_case input_schema; this is the
// runtime aggregated catalog adapters consume directly.

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

/** Remote MCP server reachable over HTTP/SSE — vendor-hosted MCPs like
 *  GitHub, Stripe, Notion are passed as these to the vendor SDKs. */
export interface RemoteMcpServerConfig {
  kind: 'remote';
  id: string;
  url: string;
  transport: 'http' | 'streamable-http' | 'sse' | 'stdio';
  headers?: Record<string, string>;
}

/** In-process MCP server holding the Liftoff platform tool surface
 *  (connector tools, sandbox primitives, code_session, delegate_to_agent,
 *  memory tools, agent_slack, etc.). Built per invocation by
 *  createToolGatewayMcpServer; the Anthropic SDK consumes the config
 *  object directly; the OpenAI adapter converts the parallel modelTools
 *  list (via McpToolCatalog.tools) into native OpenAI function tools. */
export interface InProcessMcpServerConfig {
  kind: 'in-process';
  id: string;
  /** Live SDK config object — `{type:'sdk', name, instance: McpServer}`. */
  config: McpSdkServerConfigWithInstance;
}

export type McpServerConfig = RemoteMcpServerConfig | InProcessMcpServerConfig;

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;  // JSON Schema (camelCase to match MCP wire format)
  serverId: string;                       // links to McpServerConfig.id
  /** Tool categories from the connector_functions_registry — needed at
   *  adapter gate-check time so the registered hitlGate can run
   *  `hitlEnforcementService.checkHitlGate` and signal a hitl_approval
   *  pause for outbound / destructive / sensitive_work tools. Optional
   *  because non-connector tools (standard, search, sandbox) may not
   *  carry categories. */
  categories?: string[];
  /** Tool's draft variant name from the registry — same purpose as
   *  `categories`. */
  draftVariant?: string;
  /** Where this tool came from, tagged at the gateway's push site. Absent
   *  for vendor-hosted MCP tools (classified by server id instead) and for
   *  platform built-ins, which are the default bucket. */
  source?: 'connector' | 'sandbox' | 'external_agent' | 'internal_agent' | 'platform';
  /** Side-effect class for the external-content write gate. Platform tools carry
   *  a concrete value; vendor tools are derived by verb-token classification at
   *  catalog-build time. A missing value gates (fail closed) at the runtime check. */
  effect?: 'read' | 'write' | 'spawn';
  /** 'inbox' lists work items; 'ack' is the operation that marks one handled.
   *  Declared per connector in connector-functions-registry.ts — Gmail's
   *  update_message, Jira's transition_issue, Zendesk's update_ticket, and so
   *  on. Carried here so the HITL gate can recognise an acknowledgement of the
   *  very record that woke the run, which is the one write that adds no blast
   *  radius. Dropped on the way into the catalog, every connector's ack raised
   *  an approval card. */
  workRole?: 'inbox' | 'ack';
  /** 'stage' prepares a change a paired apply commits; 'apply' commits a
   *  staged batch under one approval. See tool-gateway/staged-batches.ts. */
  writeRole?: 'stage' | 'apply' | 'direct';
  /** For tools that live on a REMOTE vendor MCP server (serverId points to a
   *  `kind:'remote'` entry), the BARE tool name the vendor server actually
   *  dispatches on. `name` is namespaced (`<serverAlias>__<tool>`) for
   *  model-facing collision safety, but the remote `tools/call` must use the
   *  bare name — so `dispatchFunctionCall` sends `remoteToolName ?? name` on
   *  the wire. Undefined for in-process gateway tools (name == wire name). */
  remoteToolName?: string;
  /** Meta-tool servers (omnisend) expose one tool whose argument names the
   *  operation — `execute` with `tool_name` — so the tool's own name says nothing
   *  about what a call does. The seeds for such a server are keyed
   *  `<tool>:<operation>`; the enumerator folds them here so the HITL gate can
   *  resolve a call to its operation's categories. A call naming an operation
   *  with no entry falls to the write class. */
  operationClassifications?: { arg: string; byOperation: Record<string, string[]> };
}

/** A tool a collapsed vendor server no longer exposes to the model directly.
 *
 *  It carries the SAME classification fields the visible tools carry, because
 *  everything downstream of the model reaches it exactly as it reaches them:
 *  the bridge dispatches it, the adapter gate resolves it out of this list to
 *  ask what class of action it is, and the Communication setting reads its
 *  message. Reduced to name + schema, those questions all answered "unknown"
 *  for every tool on an oversized server — a GitHub comment on a collapsed
 *  server matched no Sensitive Work category and was never read, while the
 *  same tool on a small server was. Collapsing is a CATALOG-SIZE decision and
 *  must not be a governance one. */
export type DeferredVendorTool = Pick<
  McpToolDefinition,
  'name' | 'remoteToolName' | 'description' | 'inputSchema' | 'serverId'
  | 'categories' | 'draftVariant' | 'effect' | 'workRole' | 'writeRole' | 'operationClassifications'
>;

export interface McpToolCatalog {
  servers: McpServerConfig[];
  tools: McpToolDefinition[];
  /** Bound connector tools the Communication setting withheld from the model
   *  (Draft-first substitutes a draft form for each outbound send). Never
   *  offered to the model; carried so an APPROVED call naming one resolves as
   *  bound rather than as a connector the hire no longer has. On the catalog
   *  for the same reason `deferredVendorTools` is. */
  withheldByOversight?: McpToolDefinition[];
  /** Tools a collapsed vendor server no longer exposes directly,
   *  keyed by server id. Lives on the CATALOG rather than the bridge context
   *  because the catalog is the thing that already reaches every dispatch site;
   *  putting it on the context would mean every adapter had to remember to set
   *  it, which is exactly how the oversized-result spill ended up unreachable. */
  deferredVendorTools?: Map<string, DeferredVendorTool[]>;
  /** Read one file from the run's own workspace, for the subdirectory
   *  context hints. Set by the gateway exactly when the agent has the `file`
   *  capability; absent for a connector-only agent, which has no directories to
   *  be given hints about.
   *
   *  On the catalog for the same reason `deferredVendorTools` is: it is the one
   *  object every engine already receives. The Anthropic adapter in particular
   *  cannot reach the in-process MCP server itself — the Claude Agent SDK holds
   *  that instance and the protocol refuses a second transport on it. */
  readWorkspaceFile?: ((path: string) => Promise<string | null>) | null;
  /** Write one file into the run's own workspace, for offloading an oversized
   *  intermediate value. Set by the gateway under exactly the same `file`
   *  capability condition as `readWorkspaceFile`, and null otherwise — an
   *  offload the agent cannot read back would replace data with a dead path.
   *  Resolves false on a failed write so the caller keeps its in-context
   *  summary. */
  writeWorkspaceFile?: ((path: string, content: string) => Promise<boolean>) | null;
  /** This run's place in a delegation tree, decided at assembly.
   *
   *  On the catalog for the same reason the two fields above are: it is the one
   *  object every engine receives. Setting it on the bridge context instead
   *  would mean six adapter construction sites each had to remember it, and the
   *  one that forgot would silently let a leaf delegate. */
  delegationRole?: import('../delegation-roles').DelegationRole;
}
