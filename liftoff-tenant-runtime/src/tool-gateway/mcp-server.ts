// Tool Gateway MCP Server
// Wraps ToolGatewayService as an in-process MCP server for the Claude Agent SDK.
// Every in-process tool call goes through the full governance pipeline.
// Returns:
//   - the MCP server for the Claude SDK (in-process tools routed through
//     ToolGatewayService.execute → connector-service Execute RPC)
//   - a ModelTool[] array for HITL enforcement
//   - vendorMcpServers: a map of vendor-hosted MCP servers (GitHub, Notion,
//     Stripe, …) the SDK should connect to directly, keyed by a unique per-
//     connector-instance name. See the "Vendor MCP wiring" section below.
//
// Phase 2c (connector-service cutover) + Phase 3.1 (GitHub via official MCP)
// ─────────────────────────────────────────────────────────────────────────
// REST connectors are dispatched through ToolGatewayService.execute →
// connector-service Execute RPC. But some vendors ship their own MCP servers
// (GitHub Copilot MCP, Stripe MCP, …) that the Claude SDK connects to
// directly with a Bearer OAuth token. For those, we fetch the MCP URL +
// transport from connector-service via GetMcpServerConfig (which is the
// authoritative copy of the registry) and the OAuth token via GetCredentials.
//
// This file used to hold a copy of the MCP registry. That copy was deleted
// in Phase 2b and never replaced — the result was silently-empty
// vendorMcpServers and agents that couldn't see their GitHub tools. The fix
// (this file) calls the RPC instead of carrying a local copy, so the single
// source of truth lives in connector-service.
//
// Gap fixes addressed:
// - Gap 11: Returns modelTools array for HITL gate checks
// - Gap 12: Filters functions by allowedActionTypes
// - Gap 13: Adds ⚠️ DESTRUCTIVE: prefix for Level 2 HITL
// - Gap 14: Registers standard tools
// - Gap 16: Passes _internalSkipHitl to prevent double HITL check (REVIEW FIX SE-002)
// - Gap 22: Standard tools handled locally (not routed through tool gateway)
// - Gap 23: Search tool registered

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { ResolvedProvider } from '../agent-execution/adapter/types';
import { readBoundedErrorText } from '../infrastructure/bounded-error-body';
import { randomUUID } from 'node:crypto';
import { describeWith } from './tool-description-overrides';
import { z } from 'zod';
import { hasSessionBrowserConnector, platformPaneBrowserOn } from '../browser-sessions/session-vendor-connectors';

// McpTransport now ships in @liftoffos/proto-gen (≥0.5.8). Import directly so
// the wire-level integer values stay in sync with what connector-service
// returns from GetMcpServerConfig.
import { McpTransport } from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb';

import type { ToolGatewayDispatcher } from './dispatcher';
import type { InternalExecuteInput } from './types';
import { SnapshotUnavailableError } from './service';
import { standardToolEffect } from './tool-effect';
import { getToolSchemas, getCustomApiToolSchemas, CUSTOM_API_CONNECTOR_TYPE } from '../connectors/tool-schema-cache';
import { connectorManifestRepository } from '../connectors/manifest-repository';
import { oversightDecisionFor } from './oversight-decision';
import { getConnectorServiceClient } from '../connectors/connector-service-client';
import { STANDARD_TOOLS } from '../tools/standard-tools';
import { executeStandardTool, StandardToolContext } from '../tools/standard-tool-handler';
import { runToolWithTransientRetry } from '../tools/transient-retry';
import { tenantHasBoundKnowledge } from './knowledge-exposure-cache';
import { convertJsonSchemaToZod, extractToolShape } from './schema-converter';
import { sanitizeToolNameSegment } from '../agent-execution/tool-name-sanitizer';
import { isAlwaysLoadedTool } from '../agent-execution/adapter/tool-tiering';
import { STEP_OUTPUT_TOOL } from '../agent-execution/terminal-state';
import { describeIteratedKeys } from '../agent-execution/step-output-keys';
import type { StepOutputRead } from '../agent-execution/step-output-keys';
import type { WorkflowRunRef } from '../agent-execution/types';
// Composio cutover-completion (C5): stable-name routing for in-process
// dispatch of composio_managed tools. The router reads each
// ConnectorFunction's definitionSource marker (set at connector-service
// boot by the @liftoffos/composio-overlays merge) and returns a route
// resolution; composio routes go through composio-dispatcher
// (composio.tools.execute, NOT the SDK's vendorMcpServers transport).
import { resolveStableName } from './stable-name-router';
import { dispatchComposio, dispatchComposioWithPolling } from './composio-dispatcher';
import { applyWarehouseGuard } from './warehouse-query-guardrails';
import { searchIndexedContext } from '../connector-content/indexed-context-source';
import { SEARCH_TOOL_DESCRIPTION } from '../connector-content/search-tool-description';
import { buildRetrievalVector } from '../memory/retrieval-vector';
import { claimSideEffect, resolveSideEffect, failSideEffect, stepKey } from '../agent-execution/sideeffect-idempotency';
import { dedupPostureFor, vendorKeyFromStepKey } from '../agent-execution/dedup-posture';
import { getToolkitSlugForConnectorType } from '@liftoffos/composio-overlays';
import type { ExternalAgentConfig } from './external-agent-handler';
import { getPoolForService } from '../infrastructure/database';
import { messagesCarryUntrustedOrigin } from './collaboration-callbacks';
import { logger } from '../infrastructure/logging';
import { runOutputGuardrails } from './output-guardrails';
import { recordHostDelivered } from './host-delivered';
import type { ExecuteResult } from './types';

/** A gateway result as the MODEL may read it: what the egress guardrail
 *  lifted is re-recorded in THIS process for the surface and taken off the
 *  object, so no serialisation below — `data` alone or the whole result —
 *  can carry a value the guardrail removed from the model's copy. */
function forModel(result: ExecuteResult, invocationId: string | undefined): Omit<ExecuteResult, 'hostDelivered'> {
  const { hostDelivered, ...delivered } = result;
  for (const entry of hostDelivered ?? []) {
    recordHostDelivered({ invocationId, toolName: entry.toolName, fields: entry.fields });
  }
  return delivered;
}
import { nativeWebSearchFor } from '../agent-execution/adapter/native-web-search';
import { scrubLogger } from '../observability/scrub-logger';
import { insertAuditLog } from '../audit';
import { emitStandardToolAudit } from '../audit/standard-tool-emitter';
import { summariseToolResult } from '../audit/result-identity';
import { evaluateCitationWarning, deriveInternalDomains } from '../audit/citation-warning';
import { HitlGateError } from '../hitl-enforcement/types';
import { recordGatewayHitlPause } from '../hitl-enforcement/gateway-pause-signal';
import { registerDocumentTools } from './document-tools-mcp';
import { hostNoteSuffix } from './file-card-note';
import { validatePredicate } from '../reactive-subscriptions/predicate-evaluator';
import type { PredicateExpr } from '../agent-lifecycle/types';
import { extractToolErrorContract } from './tool-error-contract';
import { classifyError, isRetryable, recoveryFor, type ToolErrorCode } from '@liftoffos/connector-types';
import { frameUntrusted } from '../workspace/untrusted-content-wrapper';
import { FRAMED_STRUCTURED_WEB_TOOLS } from '../agent-execution/engine/framed-web-output';
import { datasetOrInlineWithCompleteness } from './result-dataset';
import { withCompleteness } from './result-completeness';
import { observeAndBoundToolResults } from './observe-result-size';
import { replayRecordedStepCalls } from './replay-step-calls';
import { toolInputSchemasFrom } from './tool-input-schemas';
import { getManagedSecret } from '../infrastructure/secret-store';
import { checkMessage } from './message-check';

/**
 * Uniform model-facing tool-error content. Every connector/tool failure that
 * the LLM reads is built through here so it always sees a machine-parseable
 * `TOOL_ERROR {error, code, retryable, retry_after_ms?, recovery}` contract
 * instead of a bare string. `code` defaults to a heuristic classification of
 * the message when the caller has no pre-computed code.
 *
 * Governance gates (snapshot_unavailable, BLOCKED_PRIOR_ATTEMPT, catalog-drift
 * no_handler_registered) keep their bespoke text and deliberately do NOT route
 * through here — they are gates, not tool errors.
 */
function buildToolErrorContent(input: {
  message: string;
  code?: ToolErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  recovery?: string;
  connectorType?: string;
}): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const code = input.code ?? classifyError({ message: input.message });
  const errBody = {
    error: input.message,
    code,
    retryable: input.retryable ?? isRetryable(code),
    ...(input.retryAfterMs ? { retry_after_ms: input.retryAfterMs } : {}),
    recovery: input.recovery ?? recoveryFor(code, { connectorType: input.connectorType }),
  };
  return {
    content: [{ type: 'text' as const, text: `TOOL_ERROR ${JSON.stringify(errBody)}` }],
    isError: true,
  };
}

/** Refusal for a tool whose result must be whole and could not be returned whole.
 *
 *  Not a success with a caveat: the caveat is what failed last time. A preview of
 *  the existing keys makes every unseen record look new, and the note saying so
 *  sat inside the data, addressed to a model that was already out of room.
 *
 *  `retryable: true` because the recovery is real work the agent can do — read
 *  and reduce the parked copy in the workspace, then act on the reduction. The
 *  recovery text points AT the workspace deliberately: materialising the whole
 *  result back into context would trade a wrong answer for an overflowed run. */
function incompleteResultError(
  toolName: string,
  parked: { path: string; bytes: number } | undefined,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const where = parked
    ? `The complete result (${parked.bytes} characters of JSON) is in your workspace at ${parked.path}.`
    : 'There is no saved copy of the complete result — it was too large to return and could not be written to a workspace.';
  const how = parked
    ? `Read and reduce it THERE with file_read or your code-execution tools (jq and python3 are available) — extract just the values this decision needs, and work from those. Do not try to bring the whole result into this conversation.`
    : `Narrow the request — ask for fewer fields, a smaller range, or one page at a time — and try again.`;
  return buildToolErrorContent({
    message: `${toolName} returned more than fits in context, and this agent may only act on its complete result.`,
    code: 'internal_error',
    retryable: true,
    recovery: `${where} ${how}`,
  });
}

// ModelTool: the shape HITL enforcement expects for category/destructive checking.
// Matches the hitl-enforcement ModelTool interface.
/** The origin of a model-facing tool, for catalog-size telemetry.
 *  `vendor_mcp` and `custom_mcp` are NOT set here — those tools are enumerated
 *  from remote servers by the adapter catalog builder, which classifies them by
 *  server id. */
export type ToolSource =
  | 'connector'
  | 'sandbox'
  | 'external_agent'
  | 'internal_agent'
  | 'platform';

export interface ModelTool {
  name: string;
  description: string;
  categories: string[];
  draftVariant?: string;
  /** Side-effect class for the external-content write gate. Mirrors the shared
   *  governance-types ModelTool.effect. */
  effect?: 'read' | 'write' | 'spawn';
  /** Where this tool came from (B4 telemetry). Absent means 'platform' — a
   *  built-in this gateway always offers. Tagged at the push site because
   *  nothing downstream can recover it from the name: a connector tool and a
   *  platform tool are both just strings by the time the catalog is built. */
  source?: ToolSource;
  inputSchema?: z.ZodTypeAny;   // optional — populated only where we want hook validation
  // W1.4 — work_inbox/ack metadata carried from the connector registry.
  workRole?: 'inbox' | 'ack';
  paired_ack?: string;
  acknowledges?: string;
  workItemKind?: string;
  /** 'stage' prepares a change a paired apply commits; 'apply' commits one
   *  staged batch under one approval (ADR-052 rule 5). Carried so the gate
   *  can hold an apply to its one ask and the dispatcher can verify the batch. */
  writeRole?: 'stage' | 'apply' | 'direct';
  paired_apply?: string;
}

// Return type: MCP server + tools array for HITL + any vendor-hosted MCP
// servers the SDK should connect to directly. `vendorMcpServers` is populated
// only for connector instances whose type has a vendor-hosted MCP entry in
// connector-service's registry (GetMcpServerConfig returns isVendorHosted=true
// for them). REST-path connectors don't appear here — they flow through the
// in-process mcpServer's tool dispatch.
export interface ToolGatewayMcpResult {
  mcpServer: ReturnType<typeof createSdkMcpServer>;
  modelTools: ModelTool[];
  /** The bound connector tools the Communication setting withheld from the
   *  model — Draft-first substitutes a draft form for each outbound send. Not
   *  registered, not offered, but still BOUND: an approved call naming one is
   *  a call the hire can make, and the consumption point resolves it here
   *  rather than reading the substitution as a connector that is gone. */
  withheldByOversight: ModelTool[];
  /** Each in-process tool's arguments as JSON Schema, keyed by tool name.
   *
   *  `modelTools` answers what the governance gate needs (name, categories,
   *  effect) and `mcpServer` answers what the Claude Agent SDK needs (the live
   *  Zod shapes). Every other engine builds its own function-tool list from
   *  `McpToolCatalog.tools[].inputSchema` and needs the shapes as JSON Schema —
   *  so the same registration answers both, instead of the wire engines being
   *  handed a tool with no arguments at all. */
  toolInputSchemas: Record<string, Record<string, unknown>>;
  /** Model-facing teammate label -> runtime agent id, exactly the map the
   *  `delegate_to_agent` enum was built from. The tool takes a label, so this
   *  is what turns a `delegate_to_agent` call back into the id the chat
   *  stream attributes the hand-over to. Empty when the agent has no
   *  delegate-able roster and the tool was not registered. */
  delegateIdByLabel: ReadonlyMap<string, string>;
  vendorMcpServers: Record<string, { type: 'http' | 'sse'; url: string; headers: Record<string, string> }>;
  /** The tool-name prefix of each CUSTOM API connection in this catalog.
   *
   *  A connection can serve up to two hundred operations, and the existing
   *  collapse enumerates `kind: 'remote'` servers only — vendor-hosted MCP plus
   *  `custom_mcp_server` — so these in-process connector tools get no collapse
   *  for free. The catalog assembly turns each alias into a tiering group of
   *  its own, which is the only reason this leaves the gateway. */
  customApiAliases: string[];
  /** Read one workspace file, for the subdirectory context hints. Null
   *  when the agent has no `file` capability, which is what scopes the feature
   *  to agents that have directories to be given hints about. */
  readWorkspaceFile: ((path: string) => Promise<string | null>) | null;
  /** Write one workspace file, for offloading an oversized intermediate value
   *  the agent can then read back with `file_read`. Null under the same
   *  condition as the read: no `file` capability means no filesystem to write
   *  to, and an offload the agent cannot read back is worse than none — it
   *  points the model at a path that does not answer. */
  writeWorkspaceFile: ((path: string, content: string) => Promise<boolean>) | null;
  activeBrowserSession: { id: string; vendorSessionId: string } | null;
}

export interface DiscoveredMCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// An agent integration as stored on the compiled instruction. `id` is the
// connector instance UUID — what connector-service's RPCs take as
// connector_id. `type` is the canonical connector type string; if absent,
// the caller can still resolve it via the RPC roundtrip but the metadata
// is cheaper when it's already on the integration row.
export interface AgentIntegration {
  id: string;
  type?: string;
  selectedObjects?: string[];
  config?: Record<string, unknown>;
}

export interface CreateToolGatewayMcpServerInput {
  tenantId: string;
  agentId: string;
  /** The run's shared trust cell. send_agent_message stamps the SENDING run's live
   *  trust onto the message; read_agent_messages upgrades it to 'untrusted_inbound'
   *  when it returns a tainted message. Optional: absent → treated as trusted. */
  trustRef?: import('../agent-lifecycle/types').TrustRef;
  /** Interactive chat's run_routine_now cell. Presence ARMS the tool (the
   *  chat handler creates one only for an agent with a workflow); the tool's
   *  handler flips `requested` and the engine dispatch reads it. Absent on
   *  every autonomous catalog, so the tool never appears there. */
  workflowRunRef?: WorkflowRunRef;
  /** Parent run's HITL level — forwarded to spawn_task_graph children so they
   *  inherit oversight. Optional: existing callers default to 3 (autonomous). */
  hitlLevel?: number;
  /** Parent run's trigger source — gates async delegation (chat = sync only).
   *  Optional: defaults to 'agent'. */
  triggeredBy?: 'human' | 'agent' | 'cron' | 'event';
  /** True when this run's system prompt carries the terminal-outcome contract
   *  (buildSystemPrompt's responseFormatDirective), i.e. autonomous execution.
   *  Gates registration of report_task_outcome so the catalog and the prompt
   *  stay in lockstep: interactive chat builds its own prompt via
   *  systemPromptOverride and never learns the contract, and a stray
   *  report_task_outcome('fail') there would turn a normal reply into an
   *  EXEC_ERROR. Optional: defaults to false (do not register). */
  terminalOutcomeContract?: boolean;
  /** The `outputField` of the workflow step this catalog is being built for.
   *
   *  Gates registration of `record_step_output` on exactly the same principle as
   *  `terminalOutcomeContract` above: the tool exists only where the prompt
   *  carries the matching contract. Set only by invokeStepLLM, and only for a
   *  step that declares an outputField — a conversational turn has no step
   *  contract to satisfy, so it never sees the tool. Optional: absent → do not
   *  register. */
  stepOutputField?: string;
  /** Keys later steps read off this step, derived from the graph. Empty when
   *  nothing reads it. */
  stepOutputReads?: StepOutputRead[];
  /** Tool names THIS run's workflow steps name, which the SDK's own tool
   *  search must not defer. Computed per run from the graph
   *  (`workflowNamedToolNames`) and read here for the same reason
   *  `isAlwaysLoadedTool` is: a step whose tool has to be searched for first is
   *  a step whose contract depends on the model running a search. */
  alwaysLoadedToolNames?: ReadonlySet<string>;
  instructionVersion: number;
  traceId: string;
  /** Connector identifiers the instruction has enabled — types, aliases, or UUIDs. */
  allowedConnectors: string[];
  toolGateway: ToolGatewayDispatcher;
  /** Compiled instruction's integrations array. Required to wire vendor-hosted
   *  MCP servers (GitHub, Stripe, Notion, etc.). Missing = agent gets REST
   *  connectors only, which silently drops vendor-MCP-only connectors. */
  integrations?: AgentIntegration[];
  externalAgents?: ExternalAgentConfig[];
  allowedActionTypes?: string[];
  memoryScope?: { readableLayers?: string[]; writableLayers?: string[]; scopeKeys?: string[] };
  toolCallAccumulator?: Array<{ id: string; name: string; input: Record<string, unknown>; output: unknown; error?: string }>;
  invocationId?: string;
  /** Self-schedule chain depth, forwarded into the tool context so
   *  schedule_followup can bound runaway self-loops. */
  chainDepth?: number;
  threadId?: string;
  /** Stable trigger identity (plan §4.1/§4.7). When set, mutating Composio side
   *  effects are claim-before/replay deduplicated per (triggerKey, tool, args).
   *  Undefined for chat (not redelivered) → no per-side-effect idempotency. */
  triggerKey?: string;
  /** Knowledge item IDs the operator pinned via [[knowledge:...]] markers.
   *  Forwarded to corpus_search as a retrieval bias. */
  pinnedKnowledgeIds?: string[];
  /** Liftoff accounts.id of the user whose message triggered this turn. */
  messageSenderAccountId?: string;
  /** Per-invocation skill-disclosure override, service-auth only, used by the
   *  eval that measures the disclosure trade. Governs whether `read_skill` is
   *  exposed; undefined means the deployment's mode. Must match whatever the
   *  caller rendered into the prompt. */
  skillDisclosureMode?: import('../skills/retrieval').SkillDisclosureMode;
  /** Current chat turn id (plan v13) — required (with
   *  messageSenderAccountId) to register recall_conversations, and passed
   *  as excludeTurnId so recall never returns the executing turn. */
  turnId?: string;
  /** Provider this agent resolved to. Used as the 'auto' default for the
   *  code_session tool's sub-handler selection. */
  resolvedProvider?: ResolvedProvider;
  /** Model id this agent resolved to (invocation-level resolution). Used by
   *  code_session to pick the vendor-matched coding model when the provider is
   *  'openrouter' — GLM/Qwen/DeepSeek/Kimi all share that provider and are
   *  distinguishable only by the model id's vendor prefix. */
  resolvedModelId?: string;
  /** Model id an operator DELIBERATELY pinned on this agent
   *  (`model_config.modelId`), as opposed to `resolvedModelId`, which is always
   *  populated because resolution falls back to the workspace policy default
   *  and then to the tier table.
   *
   *  code_session needs the difference: a vendor coding agent keeps its own
   *  default model unless somebody actually chose one, and `resolvedModelId`
   *  cannot answer "did somebody choose". */
  explicitModelId?: string;
  /** Per-agent sandbox capability set (subset of {shell, file, browser,
   *  vscode}). Empty/absent = no raw sandbox primitives surfaced; only
   *  the higher-level code_session tool is registered. Source of truth is
   *  compiled_instructions.runtime_config.sandboxCapabilities. */
  sandboxCapabilities?: readonly ('shell' | 'file' | 'browser' | 'vscode')[];
  /** Tools whose result this agent may only act on in full.
   *
   *  A result over the context bound is parked in the workspace and only a
   *  preview reaches the model. For most calls that is the right trade. For a
   *  call that decides whether a key already exists, how many records there are,
   *  or what differs between two systems, a preview does not give a partial
   *  answer — it gives a wrong one, confidently, because everything unseen looks
   *  absent.
   *
   *  Listing a tool here means: if its result cannot be returned whole, do not
   *  return it as a success. The call fails with a retryable tool error naming
   *  the workspace copy, so the agent reads and reduces the data THERE rather
   *  than pulling it into the window it just overflowed.
   *
   *  Source of truth is compiled_instructions.runtime_config, written by
   *  distillation for the steps whose correctness depends on seeing everything. */
  completeResultRequiredTools?: readonly string[];
  /** Per-tool rules appended to those tools' descriptions, keyed by the same
   *  aliased tool name this server registers. See
   *  tool-description-overrides.ts for why every path that describes a tool
   *  must apply these. */
  toolDescriptionOverrides?: Record<string, string>;
  /** Tenant oversight settings (autonomy / escalation / sensitive_work /
   *  communication). Drives the structural draft-mode tool filter:
   *    - communication='draft': every outbound tool the LLM would
   *      otherwise see is either swapped to its draft variant (if the
   *      connector publishes one — Gmail/Outlook create_draft) or
   *      replaced with a wrapper that throws HitlGateError at execute
   *      time (Slack and any other outbound tool with no draft API).
   *    - communication='review': same logic, but only for outbound
   *      tools matching an enabled sensitiveWork category.
   *    - communication='auto' (or absent): no filtering.
   *  Loaded by hitlEnforcementService.getOversightSettings, cache-aside
   *  against PB's /api/internal/oversight/:tenantId — the same source
   *  of truth the user-facing /oversight page writes to. Threaded in
   *  from buildPlatformMcpCatalog → state.context.oversight. */
  oversight?: import('../hitl-enforcement/types').OversightSettings;
  /** What the message check judges an outgoing message against
   *  (message-check.ts): the instructions and role on the run's agent record.
   *  Absent, the check runs without a contract. */
  contract?: import('../hitl-enforcement/contract-check').HitlContract;
  /** The ONLY tools this catalog may carry, by registered name.
   *
   *  Applied at registration — to the list the in-process McpServer is built
   *  from, to `modelTools`, to the input schemas, and by emptying the vendor
   *  server map — so every engine sees the same narrowed catalog: the Claude
   *  Agent SDK mounts the server instance, the OpenAI/Gemini bridge reads the
   *  list, and neither can reach a tool that was never registered. A list
   *  filtered for display would leave the tools callable underneath it.
   *  Set only by a workflow step's web-only fallback turn (engine/
   *  capability-step-prompt.ts); absent, every tool the run is entitled to
   *  is registered as before. The HITL gate still governs every tool that
   *  executes. */
  toolAllowlist?: ReadonlySet<string>;
  /** Calls the workflow step this catalog serves has ALREADY completed.
   *
   *  Present only for a step whose earlier attempt completed a mutating call, so
   *  the ordinary catalog never carries one. A call whose normalised tool name and
   *  canonical arguments match an entry is answered with that call's own recorded
   *  result instead of being dispatched a second time.
   *
   *  The case this covers is a RESUME: a pause re-dispatches the step it paused
   *  on, so a step whose model created a document and then hit a gate runs its
   *  turn again in another process. See
   *  `agent-execution/step-replay-ledger.ts`. */
  stepReplay?: import('../agent-execution/step-replay-ledger').StepReplayLookup;
}

// messagesCarryUntrustedOrigin now lives in ./collaboration-callbacks so the
// workflow-step __builtin arm and this interactive handler share one predicate.

export async function createToolGatewayMcpServer(
  input: CreateToolGatewayMcpServerInput,
): Promise<ToolGatewayMcpResult> {
  const {
    tenantId,
    agentId,
    trustRef,
    workflowRunRef,
    hitlLevel = 3,
    triggeredBy = 'agent',
    instructionVersion,
    traceId,
    allowedConnectors,
    toolGateway,
    integrations,
    externalAgents,
    allowedActionTypes,
    memoryScope,
    toolCallAccumulator,
    pinnedKnowledgeIds,
    invocationId,
    chainDepth,
    threadId,
    turnId,
    triggerKey,
    resolvedProvider,
    resolvedModelId,
    explicitModelId,
    sandboxCapabilities,
    completeResultRequiredTools,
    toolDescriptionOverrides,
    oversight,
    contract,
    terminalOutcomeContract = false,
    stepOutputField,
    stepOutputReads,
    alwaysLoadedToolNames,
    toolAllowlist,
    stepReplay,
  } = input;
  /** Never undefined at the registration sites below. */
  const runAlwaysLoadedToolNames: ReadonlySet<string> = alwaysLoadedToolNames ?? new Set<string>();

  // Option-1 policy: the requirement is declared per TOOL for the agent, not per
  // workflow step. The model reaches a tool directly here — there is no step in
  // scope at this seam — so a per-step flag would not have covered the call that
  // actually truncated. Matching is exact on the aliased tool name.
  const completeRequired = new Set(completeResultRequiredTools ?? []);
  const requiresCompleteResult = (toolName: string): boolean => completeRequired.has(toolName);
  // Recorded when the gateway is ARMED, not only when it refuses.
  //
  // A policy that never fires is indistinguishable from a policy that never
  // arrived, and both look like silence. That ambiguity costs a full diagnostic
  // pass: the read parks, no refusal appears, and nothing says whether the
  // gateway holds the rule at all or holds it under a name that cannot match.
  // One line at construction separates "not armed" from "armed and not
  // triggered", which are different bugs with different fixes.
  if (completeRequired.size > 0) {
    logger.info({
      metric: 'tool_result.complete_required_armed',
      tenantId,
      agentId,
      invocationId,
      tools: [...completeRequired],
    }, 'gateway armed with complete-result requirements');
  }
  const logCompletenessRefusal = (
    toolName: string,
    parked: { path: string; bytes: number } | undefined,
  ): void => {
    logger.warn({
      metric: 'tool_result.incomplete_refused',
      tool: toolName,
      tenantId,
      agentId,
      invocationId,
      parkedPath: parked?.path ?? null,
      bytes: parked?.bytes ?? null,
    }, 'result required complete but was parked — refusing rather than returning a view as a success');
  };

  // Prefetch the thread's browser session ONCE — drives both the tool-gating
  // (read_active_browser_session / run_browser_task) and the result tuple the
  // caller uses for the system-prompt preamble. Non-fatal: a lookup blip must
  // never break tool-gateway creation — the browser tools just aren't gated in.
  let activeBrowserSession: import('../browser-sessions/types').BrowserSession | null = null;
  if (threadId || invocationId) {
    try {
      const repo = await import('../browser-sessions/repository');
      // The thread's session, or on a run with no thread the run's own.
      activeBrowserSession = threadId
        ? await repo.getActiveForThread(tenantId, threadId)
        : await repo.getActiveForInvocation(tenantId, invocationId!);
    } catch {
      activeBrowserSession = null;
    }
  }
  const manifests = await connectorManifestRepository.getManifestsForAgent(tenantId, allowedConnectors);
  const pool = getPoolForService('tool-gateway');

  // Per-agent binding resolution map. Keyed by every identifier that may
  // appear in input.connector (alias / canonical type / UUID) so the
  // tool-gateway's resolveBinding always lands on the right connector
  // instance and per-binding config (Gmail q, sendAs) regardless of which
  // form the agent's tool name used.
  const { buildBindingsByType } = await import('./binding-resolver');
  const bindingsByType = buildBindingsByType(integrations, manifests);

  const mcpTools = [];
  const modelTools: ModelTool[] = [];
  const withheldByOversight: ModelTool[] = [];
  let toolIndex = 0;

  // Record tool calls to the shared accumulator (if provided).
  // SDK hooks may not fire for MCP tool calls, so we record directly here.
  /**
   * What the model is told when a platform callback answers with a non-2xx.
   *
   * The control plane's routes explain a refusal in the body (`message`, else
   * `error`), and that text is written for the agent to act on: "nobody to
   * notify" or "sending too fast" leads somewhere, a bare status code does
   * not. The status stays so a log line and the tool result agree.
   */
  function platformFailure(status: number, errorText: string): string {
    let detail = '';
    try {
      const parsed = JSON.parse(errorText) as { message?: unknown; error?: unknown };
      const text = typeof parsed.message === 'string' ? parsed.message
        : typeof parsed.error === 'string' ? parsed.error : '';
      detail = text.trim();
    } catch {
      // Not JSON: nothing the model can act on beyond the status.
    }
    return detail ? `Platform returned ${status}: ${detail}` : `Platform returned ${status}`;
  }

  function recordToolCall(name: string, input: Record<string, unknown>, output: unknown, error?: string) {
    if (toolCallAccumulator) {
      toolCallAccumulator.push({
        id: `mcp-${toolIndex}`,
        name,
        input,
        output,
        error,
      });
    }
  }

  // Track registered tool names for collision detection (TE-002)
  const registeredToolNames = new Set<string>();

  // ── Oversight tool-filter helper ────────────────────────────────────
  // Maps the agent-facing tenant oversight policy onto the connector
  // tool catalog so the LLM physically cannot pick a send-mode tool the
  // policy forbids. Same semantics as the legacy
  // tool-interceptor.ts#maybeConvertToDraft rewrite, but applied
  // STRUCTURALLY at catalog construction time so the protection holds
  // on every dispatch path (adapter conversational, adapter llm_reason,
  // and the legacy executeToolCalls path). Without this, the
  // adapter path bypasses oversight entirely and an agent can send real
  // Gmail replies under communication='draft'.
  //
  // Decision per outbound tool, given the active oversight:
  //   communication='draft'                          → BLOCK (always)
  //   communication='review' + matches sensitiveWork → BLOCK
  //   communication='review' + no sensitive match    → ALLOW
  //   communication='auto' (or no oversight)         → ALLOW
  //
  // BLOCK has two sub-cases:
  //   (a) the connector publishes a draftVariant (Gmail/Outlook
  //       create_draft) → skip registering the outbound tool entirely.
  //       The draft variant is registered when the loop visits it
  //       independently, so the LLM sees only the draft form. Result
  //       lands in the user's Gmail/Outlook Drafts folder, threaded if
  //       a reply, ready for human review-and-send in the native client.
  //   (b) no draftVariant exists (Slack send_message, custom_mcp send_*,
  //       any vendor without a draft API) → register the tool but wrap
  //       its handler to throw HitlGateError at execute time. The outer
  //       hybrid loop converts that to a HITL pause + approval request
  //       on the oversight dashboard. Slack has no draft endpoint in
  //       its Web API (verified against docs.slack.dev/reference/methods
  //       2026-06-16 — chat.scheduleMessage is a delayed send, not a
  //       draft); HITL approval is the structurally correct fallback.
  // `oversightDecisionFor` + `OUTBOUND_CATEGORIES` + `OversightFilterDecision`
  // moved to ./oversight-decision so the sandbox-code dispatch path applies the
  // SAME communication gate. It now takes `oversight` as an explicit argument
  // (was a closure capture) — see the two call sites below.

  const customApiAliases: string[] = [];
  // --- Connector tools: sourced from the tool-schema cache, dispatched through Execute RPC ---
  for (const manifest of manifests) {
    // A custom API connection's operations are PER INSTANCE: `ListTools` is
    // aggregated per connector TYPE from a static registry with no database
    // read, and `custom_api_connector` is ONE type whose operations come from
    // one workspace's own OpenAPI document. Keyed on the manifest's id, which
    // IS the connector id (events/subscriber.ts writes it as the manifest's
    // primary key), never on the type — reading the type here would hand every
    // custom API connection in the process the same empty list.
    //
    // The comparison is against a string because `ConnectorManifest`'s
    // `connectorType` is the union @liftoffos/connector-types publishes, and
    // this type is widened locally in connector-service's catalog until that
    // package ships a release carrying it. The VALUE on the row is what
    // decides.
    const isCustomApi = (manifest.connectorType as string) === CUSTOM_API_CONNECTOR_TYPE;
    const functions = isCustomApi
      ? getCustomApiToolSchemas(manifest.id)
      : getToolSchemas(manifest.connectorType);
    const alias = sanitizeToolNameSegment(manifest.alias);
    // Carried out of this loop so the catalog assembly can give each custom API
    // connection a tiering group of its OWN. A connection can serve two hundred
    // operations, and the existing collapse enumerates `kind: 'remote'` servers
    // only — vendor-hosted MCP plus custom_mcp_server — so a REST connector gets
    // no collapse for free.
    if (isCustomApi) customApiAliases.push(alias);

    for (const fn of functions) {
      if (allowedActionTypes && allowedActionTypes.length > 0 && !allowedActionTypes.includes('*')) {
        const isAllowed = allowedActionTypes.some(
          (at: string) => fn.name.toLowerCase().includes(at.toLowerCase()) ||
            fn.categories?.includes(at as 'read' | 'write' | 'destructive' | 'outbound' | 'sensitive')
        );
        if (!isAllowed) continue;
      }

      // sanitize fn.name defensively — connector-service's listTools now emits
      // clean names but a future registry / vendor MCP schema with `.` would
      // otherwise break the LLM providers' tool-name regex.
      const toolName = `${alias}__${sanitizeToolNameSegment(fn.name)}`;
      if (registeredToolNames.has(toolName)) continue;
      if (STANDARD_TOOLS.some(st => st.name === toolName) || toolName.startsWith('external__')) {
        logger.warn('Connector tool name collision, skipping', { toolName, connectorType: manifest.connectorType });
        continue;
      }

      // Oversight decision before registration.
      const oversightDecision = oversightDecisionFor({
        categories: fn.categories,
        draftVariant: fn.draftVariant,
      }, oversight);
      if (oversightDecision.kind === 'skip_for_draft') {
        logger.info(
          { tenantId, agentId, toolName, draftVariant: fn.draftVariant, communication: oversight?.communication },
          'oversight: skipping outbound tool — draft variant will be registered separately',
        );
        withheldByOversight.push({
          name: toolName, description: fn.description, source: 'connector',
          categories: fn.categories || [], draftVariant: fn.draftVariant, writeRole: fn.writeRole,
        });
        continue;
      }

      registeredToolNames.add(toolName);

      const isDestructive = fn.categories?.includes('destructive');
      // The per-tool rule is appended LAST, after the destructive marker, so the
      // warning stays the first thing read. This path matters more than it
      // looks: the Claude Agent SDK engine mounts this server directly via
      // `mcpServers`, so its tools never come through the adapter catalog —
      // applying overrides only there would leave the DEFAULT engine without
      // them, which is INV-TR-019's failure exactly.
      const description = describeWith(
        isDestructive ? `⚠️ DESTRUCTIVE: ${fn.description}` : fn.description,
        toolDescriptionOverrides?.[toolName],
      );

      modelTools.push({
        name: toolName, description,
        source: 'connector',
        categories: fn.categories || [],
        draftVariant: fn.draftVariant,
        // W1.4 — propagate work_inbox/ack metadata so the runtime
        // (tool-interceptor, future ack-enforcement layer) can see which
        // tools are inbox/ack pairs.
        workRole: fn.workRole,
        paired_ack: fn.paired_ack,
        acknowledges: fn.acknowledges,
        workItemKind: fn.workItemKind,
        writeRole: fn.writeRole,
        paired_apply: fn.paired_apply,
      });

      const rawShape = extractToolShape(convertJsonSchemaToZod(fn.inputSchema));

      // Capture the oversight decision in the closure so the handler can
      // refuse-at-dispatch if the agent (or a future code path) somehow
      // formed a call to this tool despite the catalog filter. Catalog
      // filter is the primary defense; this is belt-and-braces.
      const closureOversightDecision = oversightDecision;

      const mcpTool = tool(toolName, description, rawShape,
        async (args: Record<string, unknown>) => {
          try {
            // The Communication setting reads the message (message-check.ts):
            // under Auto an unsafe message pauses; under Review a matched
            // message that is clear on every ticked category goes out.
            const verdict = await checkMessage({
              toolName, categories: fn.categories ?? [], args, oversight, decision: closureOversightDecision,
              ...(contract ? { contract } : {}), tenantId, agentId, ...(invocationId ? { invocationId } : {}),
            });
            if (verdict.kind === 'pause') {
              logger.info(
                { tenantId, agentId, toolName, reason: verdict.reason, matchedCategory: verdict.matchedCategory, communication: oversight?.communication },
                'oversight: the message check found this message unsafe to send automatically; HITL approval required',
              );
              recordGatewayHitlPause(invocationId, { toolName, reason: verdict.reason, args, matchedCategory: verdict.matchedCategory, context: verdict.context });
              throw new HitlGateError(
                [{ id: '', connector: manifest.connectorType, entityType: '', actionType: fn.name, payload: args } as never],
                verdict.reason,
                verdict.matchedCategory,
              );
            }
            if (closureOversightDecision.kind === 'require_approval' && verdict.kind !== 'send') {
              const reason = closureOversightDecision.reason as 'communication_review' | 'sensitive_work';
              logger.info(
                { tenantId, agentId, toolName, reason, communication: oversight?.communication },
                'oversight: HITL approval required before dispatching outbound tool with no draft variant',
              );
              // Record BEFORE throwing. The SDK turns a handler exception into a tool
              // error, so the throw alone reaches the model as a failure rather than
              // pausing the run. The signal survives that boundary; the throw is kept
              // as defence in depth for callers that do propagate it.
              recordGatewayHitlPause(invocationId, { toolName, reason, args, ...(verdict.context ? { context: verdict.context } : {}) });
              throw new HitlGateError(
                [{ id: '', connector: manifest.connectorType, entityType: '', actionType: fn.name, payload: args } as never],
                reason,
              );
            }
            const effectiveFn = fn;
            const effectiveArgs = args;
            // Composio cutover-completion (C5): branch on the stable-name
            // router's source decision. For definitionSource='composio',
            // dispatch via composio.tools.execute in-process (skipping the
            // native REST executor that has no credentials for
            // composio_managed connectors).
            const route = resolveStableName({
              connectorType: manifest.connectorType,
              toolkitSlug: getToolkitSlugForConnectorType(manifest.connectorType),
              stableName: effectiveFn.name,
              fn: effectiveFn,
            });
            if (route.source === 'composio') {
              // Arg normalization — preserve the agent's original args
              // (post-substitution), then let translateInput overlay
              // non-undefined values on top. The LLM-visible tool schema
              // sometimes carries Composio's vendor field names directly
              // (`recipient_email`, `thread_id`, `is_html`) rather than the
              // stable/Liftoff names (`to`, `threadId`, `isHtml`), so the
              // overlay's translateInput would emit `undefined` for those
              // fields if it only reads stable forms. Spreading
              // effectiveArgs first means the vendor-form fields survive;
              // translateInput's adds/defaults still apply. Universal fix
              // that unblocks every overlay without 31 per-overlay edits.
              let translatedArgs: Record<string, unknown> = { ...effectiveArgs };
              if (route.translateInput) {
                const overlay = route.translateInput(effectiveArgs) as Record<string, unknown>;
                for (const [k, v] of Object.entries(overlay)) {
                  if (v !== undefined) translatedArgs[k] = v;
                }
              }
              // Async pre-dispatch enrichment. Overlay-driven, opt-in per
              // vendor tool. Used today by GMAIL_CREATE_EMAIL_DRAFT and
              // OUTLOOK_CREATE_DRAFT to look up the source thread/message
              // and populate the To recipient when the draft was produced
              // by the reply-tool draft substitution and the LLM never
              // passed a recipient. The vendor-lookup callable reuses the
              // same Composio connection (tenantId / connectedAccountId /
              // connectorInstanceId) so the read hits the same mailbox the
              // outer call writes to. No shape validation on the lookup
              // (synthesized canonicalKey carries no CANONICAL_RESPONSE_SHAPES
              // entry, so validateCanonical passes through).
              if (route.enrichBeforeExecute) {
                const dispatchVendor = async (
                  vendorSlug: string,
                  vendorArgs: Record<string, unknown>,
                ): Promise<unknown> => {
                  return await dispatchComposio({
                    tenantId,
                    agentId,
                    invocationId,
                    connectorInstanceId: manifest.id,
                    connectorType: manifest.connectorType,
                    toolkitSlug: route.toolkitSlug,
                    vendorToolName: vendorSlug,
                    canonicalKey: `${route.toolkitSlug}.__enrichment_lookup__`,
                    composioConnectedAccountId: manifest.externalAccountId ?? '',
                    args: vendorArgs,
                    translateOutput: undefined,
                    translateError: route.translateError,
                    // An enrichment lookup is still a billable Composio attempt
                    // against the org's shared monthly quota, so it carries the
                    // same trigger source as the call it is enriching.
                    triggeredBy,
                  });
                };
                try {
                  translatedArgs = await route.enrichBeforeExecute(translatedArgs, {
                    dispatchVendor,
                  });
                } catch (err) {
                  logger.warn(
                    { err, vendorTool: route.vendorToolName },
                    'mcp-server: enrichBeforeExecute threw — proceeding with un-enriched args',
                  );
                }
              }
              // §3D dual-path read-only gate. Warehouse SQL read functions
              // (e.g. supabase.run_query) dispatched in-process here must pass
              // the SAME fail-closed parser + row-cap as connector-service's
              // native path. Runs on the FINAL args (post-translateInput/enrich),
              // before dispatch. Throws read_only_violation on any write attempt
              // — the statement never reaches Composio. No-op for non-warehouse
              // tools.
              translatedArgs = applyWarehouseGuard(route.canonicalKey, translatedArgs);
              const auditAction = effectiveFn === fn ? toolName : `${alias}__${effectiveFn.name}`;
              const composioOpts = {
                tenantId,
                agentId,
                invocationId,
                connectorInstanceId: manifest.id,
                connectorType: manifest.connectorType,
                toolkitSlug: route.toolkitSlug,
                vendorToolName: route.vendorToolName,
                canonicalKey: route.canonicalKey,
                composioConnectedAccountId: manifest.externalAccountId ?? '',
                args: translatedArgs,
                translateOutput: route.translateOutput,
                translateError: route.translateError,
                // Decides whether this call may spend into the platform's
                // reserved Composio headroom. Ambient work may not.
                triggeredBy,
              };
              // THE SAME GUARDS THE NATIVE ROUTE RUNS, on the route that
              // carries most of the traffic.
              //
              // This branch dispatches to the vendor without calling
              // `toolGateway.execute`, so until now none of them ran here: not
              // the capability tri-state, not repository scope, not write
              // provenance, not the duplicate-outward check. Nothing disabled
              // them — the code that holds them was simply never entered, which
              // is why the only symptom was an absence of telemetry.
              //
              // Built from the same fields the native `executeInput` below
              // uses, so both routes are judged on identical grounds. The
              // connector is the ALIAS for the same reason it is there: the
              // permission validator and the declaration lookup are keyed by
              // alias, and a type here would miss both.
              const guardInput: InternalExecuteInput = {
                tenantId, agentId, instructionVersion, traceId, triggerKey, invocationId, threadId, turnId,
                idempotencyKey: triggerKey
                  ? stepKey({ tenantId, triggerKey, toolName: `${manifest.alias}.${fn.name}`, args })
                  // ONE CALL, ONE KEY. `toolIndex++` is what makes the second
                  // call to a tool a different act from the first, and every
                  // model-issued route in this file carries it: this one, the
                  // native branch below, search, Slack, Teams, sandbox and
                  // external agents.
                  //
                  // `actions.idempotency_key` is UNIQUE and the gateway answers a
                  // completed match with the stored response, so without it a
                  // run that calls one tool N times collapses to a single act:
                  // six `create_document_markdown` calls in one step — a watch
                  // list, a snapshot and four battle cards — leave ONE ledger
                  // row. The other five documents exist in the customer's
                  // Drive and are invisible to the duplicate guard, the undo
                  // path and the acts-this-run block, and a second create could
                  // be answered with the FIRST document's id without dispatching
                  // at all.
                  //
                  // The triggerKey branch above was never affected: `stepKey`
                  // hashes the arguments, so it already separates two calls.
                  : `${traceId}-mcp-composio-${toolName}-${toolIndex++}`,
                connector: manifest.alias,
                entityType: fn.entityType || 'default',
                actionType: fn.name,
                payload: args,
                estimatedCredits: 1,
                _internalSkipHitl: true,
                bindingsByType,
              };
              const composioRefusal = await toolGateway.preDispatchGuards(guardInput);
              // A staged apply already applied answers with its recorded
              // result: a success from the guards, not a refusal, and not a
              // second vendor call.
              const stagedReplay = composioRefusal?.success === true ? composioRefusal.data : undefined;
              if (composioRefusal && !composioRefusal.success) {
                // Surfaced as a tool error, which is what the native route's
                // `{success:false}` becomes by the time the model sees it. The
                // message is the hold's own: it names the read to run first.
                return {
                  content: [{
                    type: 'text' as const,
                    text: composioRefusal.error ?? 'refused before dispatch',
                  }],
                  isError: true,
                };
              }
              // A claimed staged apply dispatches the model's arguments minus
              // the protocol's, and settles its batch with the vendor's answer.
              const stagedPayload = toolGateway.stagedApplyPayload(guardInput);
              if (stagedPayload) {
                const stripped: Record<string, unknown> = { ...stagedPayload };
                if (route.translateInput) {
                  for (const [k, v] of Object.entries(route.translateInput(stagedPayload) as Record<string, unknown>)) {
                    if (v !== undefined) stripped[k] = v;
                  }
                }
                composioOpts.args = stripped;
              }

              const runComposio = async (): Promise<unknown> => {
                if (stagedReplay !== undefined) return stagedReplay;
                try {
                  const out = await (route.polling
                    ? dispatchComposioWithPolling({ ...composioOpts, polling: route.polling })
                    : dispatchComposio(composioOpts));
                  await toolGateway.settleStagedApply(guardInput, { success: true, data: out });
                  return out;
                } catch (err) {
                  await toolGateway.settleStagedApply(guardInput, { success: false, error: (err as Error).message });
                  throw err;
                }
              };

              // Per-side-effect idempotency (§4.4): wrap MUTATING Composio calls so a
              // redelivery / crash-retry of the same (trigger, tool, args) does not
              // re-fire the side effect. Reads are naturally idempotent — skip them.
              // A replay returns the stored result WITHOUT calling the dispatcher, so
              // reportComposioToolCall (cost) is also skipped — no vendor call happened.
              // Posture defaults to at_most_once (safe fallback); §4.6 enriches per-tool.
              const isMutatingComposio = (effectiveFn.categories ?? []).some(
                (c) => c === 'write' || c === 'destructive' || c === 'outbound',
              );
              let composioOutput: unknown;
              if (isMutatingComposio && triggerKey) {
                const posture = dedupPostureFor(route.canonicalKey);
                const claim = await claimSideEffect({
                  tenantId,
                  triggerKey,
                  toolName: route.canonicalKey,
                  args: effectiveArgs as Record<string, unknown>,
                  policy: posture.policy,
                });
                // §4.6: effectively_once + a vendor idempotency field → inject the
                // deterministic step_key so the VENDOR dedups the retry.
                if (claim.outcome === 'run' && posture.vendorKeyField) {
                  composioOpts.args = {
                    ...composioOpts.args,
                    [posture.vendorKeyField]: vendorKeyFromStepKey(claim.stepKey),
                  };
                }
                if (claim.outcome === 'replay') {
                  composioOutput = claim.result;
                } else if (claim.outcome === 'blocked') {
                  return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                      success: false,
                      error:
                        'BLOCKED_PRIOR_ATTEMPT: a previous attempt of this exact action was '
                        + 'interrupted before its result was recorded. Not re-run automatically '
                        + 'to avoid a duplicate side effect. Verify externally before retrying.',
                    }) }],
                    isError: true,
                  };
                } else {
                  try {
                    composioOutput = await runComposio();
                    await resolveSideEffect({ tenantId, stepKey: claim.stepKey, result: composioOutput });
                  } catch (e) {
                    await failSideEffect({ tenantId, stepKey: claim.stepKey, error: (e as Error).message });
                    throw e;
                  }
                }
              } else {
                composioOutput = await runComposio();
              }
              // The SAME output guardrails the gateway's `execute()` runs, on
              // a path that would otherwise skip them. This branch dispatches
              // the tool itself and hands the vendor's response straight to the
              // model, so without this the secret scrubber and the egress lift
              // never run on a Composio result: a credential in a mail body
              // would reach the model verbatim, and a signed download URL
              // declared `egressOnly` would be quoted back to the person in full.
              // Applied here, before the ledger, the audit row and the dataset
              // framing all read it, so every copy is the guarded one; a
              // replayed side effect goes through the same door.
              const guarded = await runOutputGuardrails({
                actionType: fn.name,
                payload: effectiveArgs,
                tenantId,
                invocationId,
                connector: manifest.alias,
                agentId,
              }, composioOutput);
              if (guarded.outcome === 'blocked') {
                logger.warn({ toolName: auditAction, guardrail: guarded.guardrail }, 'composio result blocked by an output guardrail');
                return {
                  content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: guarded.reason }) }],
                  isError: true,
                };
              }
              composioOutput = guarded.data;
              recordToolCall(auditAction, effectiveArgs, composioOutput);
              // THE ACTION LEDGER, which this branch never wrote.
              //
              // It wrote the audit_logs row below and stopped there, and
              // `have_i_acted_on` reads `actions`. So an agent on a
              // Composio-served connector — most of them — had no memory of its
              // own actions: it posts, the same trigger is redelivered, it asks
              // whether it has already handled this, and is told no. Every time.
              //
              // AWAITED, not fire-and-forget, because this is also where a READ
              // becomes provenance for the writes after it. The guard on the
              // next tool call asks the store what this run has read, and a
              // record still in flight is a record the guard does not see — so
              // a read-then-write pair inside one turn would flag itself.
              //
              // Non-throwing all the same: the action already happened, and
              // failing here would turn a completed send into a reported
              // failure and invite a retry that sends twice.
              // What comes back is the host note, when the recorder turned a
              // found file into a card: the one thing the model may be told
              // about the card, and it is told it by the host, not inferred
              // from the vendor's success.
              const selfDispatched = await toolGateway.recordSelfDispatched(guardInput, {
                success: true,
                data: composioOutput,
                traceId,
              }).catch((err) => {
                logger.warn(
                  { err, toolName: auditAction },
                  'Non-fatal: composio ledger/provenance record failed',
                );
                return undefined;
              });
              // Audit log: same shape as the native path below, but no
              // pre/post snapshots (Composio is the source of truth for
              // its own state — no Liftoff-side snapshotting). When a
              // substitution happened, log the effective tool name so the
              // /activity surface shows `create_draft` not `send_email`.
              insertAuditLog(null, tenantId, {
                internalAgentId: agentId,
                invocationId,
                // The conversation this happened in. Absent here, every tool
                // call a MODEL makes — which is nearly all of them — was
                // recorded with no thread, so the audit trail could not answer
                // "what did this team do in this chat".
                threadId,
                action: auditAction,
                inputArgs: effectiveArgs,
                // A success recorded WITH its evidence, the same rule the
                // native path below already follows and this one never did: a
                // green row said a call happened and nothing about what came
                // back, so the created document's own URL — the thing that
                // makes the work findable — was thrown away at the moment it
                // was known.
                // Identity first, so the document's own title and link survive
                // the cap instead of being spent on body structure or a few
                // hundred empty `replies` objects.
                outputSummary: summariseToolResult(composioOutput),
                outcome: 'success',
                triggeredBy: `agent:${agentId}`,
              }).catch((err) => logger.warn({ err, toolName: auditAction }, 'Non-fatal: composio dispatch audit log failed'));
              // Dataset contract: an oversized result is parked in the
              // workspace as clean JSON and only a preview + handle is framed
              // into context. Prevents the SDK's own overflow spill from writing
              // a framed blob no parser can read (see result-dataset.ts for
              // why). Fail-open: without a filesystem the full serialized
              // result flows as before.
              //
              // Completeness rides on the result as structure, so a caller that
              // may only act on the whole result can tell that it has a view.
              const composioParked = await datasetOrInlineWithCompleteness(
                fn.name, JSON.stringify(composioOutput), writeWorkspaceFile, { tenantId, agentId },
              );
              // `toolName`, not `fn.name`: the policy is authored against the
              // name the MODEL sees (`<alias>__<function>`), while fn.name is the
              // function inside the manifest. Matching the wrong one is a Set
              // lookup that never hits — no error, no log, just a rule that
              // silently protects nothing.
              if (!composioParked.complete && requiresCompleteResult(toolName)) {
                logCompletenessRefusal(toolName, composioParked.full);
                return incompleteResultError(toolName, composioParked.full);
              }
              // The host note goes AFTER the frame: it is the host speaking,
              // not the vendor, and a line inside the untrusted region would
              // be read as data.
              return withCompleteness({
                content: [{ type: 'text' as const, text: frameUntrusted(`connector:${manifest.connectorType}/${fn.name}`, composioParked.text, undefined, { tenantId, agentId, invocationId }) + hostNoteSuffix(selfDispatched?.hostNote) }],
                isError: false,
              }, { complete: composioParked.complete, ...(composioParked.full ? { full: composioParked.full } : {}) });
            }

            const executeInput: InternalExecuteInput = {
              // threadId rides along: `ExecuteInput` documents it as populated
              // for chat-turn tool calls, and the gateway's per-turn hooks (a
              // found file becoming a card on the thread that found it) key on
              // it. It was in scope for the audit log and never put on the
              // input, so every chat-turn call through this server read as
              // autonomous to anything downstream that asked. `turnId` rides
              // beside it for the same hook: the card a found file becomes is
              // stamped with the turn that found it.
              tenantId, agentId, instructionVersion, traceId, triggerKey, invocationId, threadId, turnId,
              // §4.3: deterministic key so connector-service's Execute idempotency
              // interceptor dedups across re-runs/redeliveries (not just within a
              // run). Falls back to the per-run key for chat (no triggerKey).
              idempotencyKey: triggerKey
                ? stepKey({ tenantId, triggerKey, toolName: `${manifest.alias}.${fn.name}`, args })
                : `${traceId}-mcp-${toolName}-${toolIndex++}`,
              connector: manifest.alias,  // Use alias not connectorType — permission validator checks aliases
              entityType: fn.entityType || 'default',
              actionType: fn.name,
              payload: args,
              estimatedCredits: 1,
              _internalSkipHitl: true,
              bindingsByType,
            };
            // What the gateway's egress guardrail lifted is re-recorded HERE:
            // the chat turn drains this process's store, and the gateway ran
            // in another one. Taken off the result before anything below can
            // serialise it — these are the values the model must not read.
            const result = forModel(await toolGateway.execute(executeInput), invocationId);
            const output = result.data ?? result;
            recordToolCall(toolName, args, output);

            // Citation-warning guardrail (provenance-agnostic). For a successful
            // outbound-mail tool, flag MISSING_CITATION_URL when the agent has
            // corpus_search (a knowledge base it could cite) and is mailing an
            // external recipient with no source URL. This is the authoritative
            // dispatch path for adapter tool calls (interactive chat + autonomous
            // adapter), so the guardrail lives here rather than in a chat-only
            // SDK hook. Returns {} (no-op) for any non-mail / non-qualifying call.
            const citation = result.success
              ? evaluateCitationWarning({
                  actionType: toolName,
                  toolInput: (args ?? {}) as Record<string, unknown>,
                  hasKnowledgeAccess: modelTools.some(t => t.name === 'corpus_search'),
                  internalDomains: deriveInternalDomains(integrations),
                })
              : {};

            // Write audit log entry for this tool call so it appears on /activity.
            // SDK hooks don't reliably fire for MCP tool calls, so this is the
            // authoritative audit record. Uses the clean tool name (toolName)
            // which includes the connector prefix for grouping in the UI.
            insertAuditLog(null, tenantId, {
              internalAgentId: agentId,
              invocationId,
              threadId,
              action: toolName,
              inputArgs: args,
              // A success is recorded WITH its evidence, not as a bare claim.
              //
              // This used to write `undefined` on success and summarise only
              // failures, so a green row said a call happened and nothing about
              // what came back. That is the row a person reads to decide whether
              // work was done, and it could not be checked against anything.
              //
              // Otherwise a tool can be called with a literal placeholder —
              // `mark_as_read` with `thread_id: "{{input.message.threadId}}"` —
              // and be recorded as `outcome: success`, `output_summary` NULL.
              // Whether Gmail marked something, errored, or silently no-oped is
              // then not answerable from the audit trail, and the only honest
              // reading of that row is "unknown".
              //
              // Bounded to the same 500 chars failures already use, and every
              // string goes through the audit layer's `redactPii` on insert, so
              // this adds evidence without adding exposure.
              outputSummary: citation.outputSummary ?? summariseToolResult(output),
              outcome: result.success ? 'success' : 'error',
              // On an in-band {success:false} the connector-service already
              // classified the failure — record its semantic code so /activity
              // shows the real cause (auth_expired/not_found/…), not the coarse
              // 'connector_error'. On success, keep any citation-warning code.
              errorCode: result.success
                ? citation.errorCode
                : (result.errorCode ?? citation.errorCode ?? 'connector_error'),
              triggeredBy: `agent:${agentId}`,
              preActionSnapshot: result.preActionSnapshot,
              postActionSnapshot: result.postActionSnapshot,
              externalResponse: result.externalResponse,
              snapshotStatus: result.snapshotStatus,
            }).catch(err => logger.warn({ err, toolName }, 'Non-fatal: MCP connector audit log failed'));

            if (!result.success) {
              // The model boundary: surface the structured contract carried
              // from connector-service so recovery is machine-parseable.
              return buildToolErrorContent({
                message: result.error ?? (typeof output === 'string' ? output : 'tool call failed'),
                code: result.errorCode,
                retryable: result.retryable,
                retryAfterMs: result.retryAfterMs,
                recovery: result.recovery,
                connectorType: manifest.connectorType,
              });
            }
            // Same dataset contract as the composio path above — this is the
            // branch an oversized Sheets result comes through.
            const nativeParked = await datasetOrInlineWithCompleteness(
              fn.name, JSON.stringify(output), writeWorkspaceFile, { tenantId, agentId },
            );
            // Aliased name, for the same reason as the composio branch above.
            if (!nativeParked.complete && requiresCompleteResult(toolName)) {
              logCompletenessRefusal(toolName, nativeParked.full);
              return incompleteResultError(toolName, nativeParked.full);
            }
            // The host note after the frame, as on the composio branch: the
            // gateway wrote it onto the result when a found file became a card.
            return withCompleteness({
              content: [{ type: 'text' as const, text: frameUntrusted(`connector:${manifest.connectorType}/${fn.name}`, nativeParked.text, undefined, { tenantId, agentId, invocationId }) + hostNoteSuffix(result.hostNote) }],
              isError: false,
            }, { complete: nativeParked.complete, ...(nativeParked.full ? { full: nativeParked.full } : {}) });
          } catch (error) {
            // HitlGateError is a structured signal the outer hybrid loop
            // converts into a HITL pause + approval request on the
            // oversight dashboard. Re-throw so the adapter's anomaly
            // path escalates it rather than burying it as a tool error
            // returned to the LLM.
            if (error instanceof HitlGateError) throw error;
            const isSnapshotUnavailable = error instanceof SnapshotUnavailableError;
            const message = error instanceof Error ? error.message : String(error);
            logger.error({ err: error, toolName, tenantId }, isSnapshotUnavailable ? 'MCP tool blocked — snapshot unavailable (write blocked for audit integrity)' : 'MCP tool call failed');
            recordToolCall(toolName, args, null, message);

            // Audit the failure too
            insertAuditLog(null, tenantId, {
              internalAgentId: agentId,
              invocationId,
              threadId,
              action: toolName,
              inputArgs: args,
              outputSummary: message.slice(0, 500),
              outcome: isSnapshotUnavailable ? 'gated' : 'error',
              // Upgrade the coarse 'exception' label to the semantic tool-error
              // class so /activity + harvest can filter by real cause. Reads the
              // authoritative code off either contract shape (ToolExecutionError
              // or the composio NormalizedToolError) before the heuristic.
              errorCode: isSnapshotUnavailable
                ? 'snapshot_unavailable'
                : (extractToolErrorContract(error)?.code ?? classifyError({ message })),
              snapshotStatus: isSnapshotUnavailable ? 'unavailable' : undefined,
              triggeredBy: `agent:${agentId}`,
            }).catch(err => logger.warn({ err, toolName }, 'Non-fatal: MCP connector failure audit log failed'));

            // When snapshot unavailable + governance enabled: create HITL approval so human can unblock
            if (isSnapshotUnavailable) {
              const governanceUrl = process.env.GOVERNANCE_SERVICE_URL;
              const governanceToken = getManagedSecret('GOVERNANCE_SERVICE_TOKEN');
              if (governanceUrl && governanceToken) {
                const idempotencyKey = `snapshot-unavailable:${tenantId}:${toolName}:${invocationId || Date.now()}`;
                fetch(`${governanceUrl}/api/governance/approvals`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-tenant-id': tenantId,
                    'x-service-auth': governanceToken,
                  },
                  body: JSON.stringify({
                    tenantId,
                    agentId,
                    hitlLevel: 3,
                    pendingToolCalls: [{ id: invocationId || toolName, name: toolName, input: args }],
                    reason: `Pre-action snapshot could not be captured for ${toolName}. Human approval required to proceed without audit trail. Once approved, re-run the same action — it will automatically retry with skipSnapshotCapture: true.`,
                    idempotencyKey,
                  }),
                }).catch(err => logger.warn({ err, toolName }, 'Non-fatal: Failed to create HITL approval for snapshot unavailable'));
              }
            }

            // snapshot_unavailable is a governance gate (keeps its bespoke text
            // + HITL unblock), not a tool error — do NOT route through errBody.
            if (isSnapshotUnavailable) {
              return {
                content: [{ type: 'text' as const, text: `Action blocked: ${message}` }],
                isError: true,
              };
            }
            // Thrown connector failures carry the structured contract — via
            // ToolExecutionError (native) OR NormalizedToolError (composio
            // overlay). Surface the authoritative code/retryable/retryAfterMs/
            // recovery the origin computed; only raw infra throws fall back to a
            // message-heuristic classification inside buildToolErrorContent.
            const contract = extractToolErrorContract(error);
            if (contract) {
              return buildToolErrorContent({
                message: contract.message || message,
                code: contract.code,
                retryable: contract.retryable,
                retryAfterMs: contract.retryAfterMs,
                recovery: contract.recovery,
                connectorType: manifest.connectorType,
              });
            }
            return buildToolErrorContent({ message, connectorType: manifest.connectorType });
          }
        },
        // The SDK's own tool search defers large MCP catalogs by default, so a
        // tool this run's instructions NAME has to be opted out of that too.
        // One vocabulary, two mechanisms: our collapse reads the same set at
        // catalog assembly (`applyToolTiering`). Unless both call sites read
        // it, the names the prompts depend on are protected on the other
        // engines and unprotected on this one.
        ...(isAlwaysLoadedTool(toolName)
          || runAlwaysLoadedToolNames.has(toolName)
          || runAlwaysLoadedToolNames.has(fn.name)
          ? [{ alwaysLoad: true }] as const
          : []),
      );
      mcpTools.push(mcpTool);
    }
  }

  // --- GAP 14 + 22 FIX: Standard tools ---
  // Standard tools bypass the tool gateway — handled via executeStandardTool()
  // which routes memory_save/memory_retrieve to real MemoryService calls.
  // One id per dispatch: the handlers use it as their usage/cost id and the
  // audit emit below stamps it as the row's idempotency_key, joining an
  // individual tool charge to the audit record of exactly that call.
  const toolCallId = randomUUID();
  const stdToolCtx: StandardToolContext = {
    toolCallId,
    tenantId,
    agentId,
    memoryScope: memoryScope || { readableLayers: ['global', 'role', 'individual'], writableLayers: ['individual', 'conversation'] },
    traceId,
    threadId,
    // Connector bindings forwarded so handlers that need to scope by the
    // agent's bound connectors (e.g. corpus_search → /api/internal/knowledge/search)
    // can do so without re-reading the instruction. Only id + type — config
    // stays out so handlers can't read sensitive per-binding fields.
    integrations: integrations?.map(i => ({ id: i.id, type: i.type })),
    pinnedKnowledgeIds: pinnedKnowledgeIds ?? [],
    // invocationId was previously omitted here, so tools (e.g. schedule_followup
    // recording scheduled_by_invocation_id) always saw undefined. Wire it
    // through, alongside the self-schedule chain depth.
    invocationId,
    chainDepth,
    // The turn, beside the thread, so a file a document tool registers with
    // the platform is stamped with the turn that produced it. Until this was
    // here the id stopped one hop short: on the catalog input, read by the
    // recall tool only, and never on the context a tool handler sees.
    turnId,
    messageSenderAccountId: input.messageSenderAccountId,
    // Live content trust so schedule_followup can propagate taint to the run it schedules.
    trustLevel: trustRef?.current,
    // The provider this run resolved to, for the bridged web_search to pick
    // the backend the provider owns.
    resolvedProvider,
    // The chat run's run_routine_now cell — the same object the engine
    // dispatch reads, so the tool's write is the engine's signal.
    workflowRunRef,
    // The run's contract, for the memory admission check.
    ...(contract ? { contract } : {}),
  };

  // Gate corpus_search exposure on whether the agent's bound connectors have
  // any imported knowledge_items. Avoids burning prompt budget on a tool the
  // agent has no useful data for. Cached in-process for 60s so we don't pay
  // a knowledge-count round-trip on every chat turn; soft-fails to "expose"
  // on any error so the tool is never silently dropped.
  const exposeCorpusSearch = await tenantHasBoundKnowledge({
    tenantId,
    agentId,
    connectorIds: (integrations ?? []).map(i => i.id),
  });

  // Apply the same per-tenant vendor-availability filter the legacy
  // buildToolsSchema path used. Without this the catalog over-exposes web
  // tools whose vendor backends aren't enabled for the tenant — calls
  // would fail at the vendor layer with a confusing error instead of the
  // tool being absent entirely.
  //
  // Soft-fail to the unfiltered list on any failure (e.g. connector-
  // service unavailable, vendor-flag query timeout): better to over-expose
  // web tools (the pre-WS-1.3 behavior) than to lose them entirely. Real
  // failures will surface in the call's dispatch as a vendor-side error,
  // which is observable; silent catalog truncation is not.
  let exposedStandardTools: typeof STANDARD_TOOLS = STANDARD_TOOLS;
  try {
    const { buildExposedStandardTools } = await import('../integrations/web-fetch/expose-tools');
    exposedStandardTools = await buildExposedStandardTools(
      STANDARD_TOOLS,
      tenantId,
      {
        threadId,
        messageSenderAccountId: input.messageSenderAccountId,
        hasActiveBrowserSession: !!activeBrowserSession,
        // Per-agent gate for BYOK-exclusive web tools (web_extract, web_diff,
        // Anchor browser/session). Native-backed web tools stay tenant-level.
        allowedConnectors,
        skillDisclosureMode: input.skillDisclosureMode,
        // This is the MODEL's list: the bridged basic search is offered only
        // where this run's engine attaches no vendor search of its own.
        nativeWebSearch: nativeWebSearchFor(resolvedProvider, resolvedModelId),
        surface: 'model',
        provider: resolvedProvider,
        // A run with no thread may open the team's own browser (see the
        // option); the run catalog decides the same way, so the two agree.
        autonomousRun: !threadId && !!invocationId,
      },
    );
  } catch (err) {
    logger.warn(
      { tenantId, agentId, err: (err as Error).message },
      'mcp-server: buildExposedStandardTools failed — falling back to unfiltered STANDARD_TOOLS',
    );
  }

  // run_routine_now exists only while the interactive turn is still
  // conversational: the cell is created by the chat handler alone, and once
  // the model has invoked it the graph phase's catalogs drop it again.
  // Mirrored in buildToolsSchema — the parity tests hold the two together.
  // Outside the try/catch on purpose: the unfiltered fallback above must not
  // over-expose this tool either.
  exposedStandardTools = exposedStandardTools.filter(
    (t) => t.name !== 'run_routine_now'
      || (workflowRunRef !== undefined && workflowRunRef.requested !== true),
  );

  // Any vendor that can own the pane, not Anchor alone — and the platform's own
  // Browser Use key, which backs one for an agent bound to no browser connector
  // at all. This runs on the NORMAL path as well as the soft-fail one, so a
  // narrower answer here than buildExposedStandardTools gives withholds
  // run_browser_task while the prompt still promises it.
  const BROWSER_CONNECTOR_ON =
    hasSessionBrowserConnector(allowedConnectors) || await platformPaneBrowserOn(tenantId);
  for (const stdTool of exposedStandardTools) {
    if (stdTool.name === 'corpus_search' && !exposeCorpusSearch) continue;

    // Defense-in-depth: when buildExposedStandardTools soft-fails to the
    // unfiltered STANDARD_TOOLS list (e.g. connector-service blip), still
    // hide the thread-scoped browser tools that require an active session or a
    // browser the agent can actually drive. On the normal filtered path these
    // checks match buildExposedStandardTools — both ask the same two-part
    // question, the agent's binding to a session-capable connector OR the
    // platform's own key — so they are redundant there; they only bite on the
    // soft-fail fallback.
    if (stdTool.name === 'read_active_browser_session' && !activeBrowserSession) continue;
    // The SAME predicate buildExposedStandardTools applies to run_browser_task
    // (`sessionVendorAgentOn || hasActiveBrowserSession`), and deliberately not
    // a stricter one. Requiring a message sender here withheld the tool on the
    // normal path whenever the palette had already offered it — an agent asked
    // to drive a browser by anything other than a person's chat message, a
    // scheduled run for instance, lost the tool while its prompt still named it.
    // Ownership of the saved logins is what needs a sender, and spawning is
    // gated on that inside the handler, not here.
    if (
      stdTool.name === 'run_browser_task' &&
      !activeBrowserSession &&
      !BROWSER_CONNECTOR_ON
    ) continue;

    modelTools.push({
      name: stdTool.name,
      description: stdTool.description,
      categories: [],
      // STATED, not guessed, and stated by the one function the workflow
      // catalog also calls — see standardToolEffect for why a tool this
      // catalog classifies as a read must not reach the gate unclassified
      // from the other one.
      effect: standardToolEffect(stdTool.name),
    });

    const rawShape = extractToolShape(convertJsonSchemaToZod(stdTool.input_schema || {}));
    const toolName = stdTool.name;

    const mcpTool = tool(
      stdTool.name,
      stdTool.description,
      rawShape,
      async (args: Record<string, unknown>) => {
        const stepStart = Date.now();
        const handlerResult = await runToolWithTransientRetry(
          () => executeStandardTool(toolName, args, stdToolCtx),
          { toolName },
        );
        if (handlerResult) {
          // Standard tools (memory_*, web_*, browser_*, audit_log, notifications_send, etc.)
          // are first-party platform tools — the audit ledger needs to record them just like
          // connector tool calls do. Without this, ~half the agent's tool surface is invisible
          // to /activity, compliance review, and forensic timelines. Field mapping lives in
          // emitStandardToolAudit so both dispatch paths produce identical row shapes.
          void emitStandardToolAudit({
            tenantId,
            agentId,
            invocationId,
            threadId,
            toolCallId,
            action: toolName,
            inputArgs: args,
            success: handlerResult.success,
            // What came back, not just that something did.
            result: handlerResult.result,
            error: typeof handlerResult.error === 'string'
              ? handlerResult.error
              : (handlerResult.error ? JSON.stringify(handlerResult.error) : undefined),
            durationMs: Date.now() - stepStart,
          });
          // Always include the JSON-stringified result so the model has the
          // textual/structured payload. Append any MCP-native attachments the
          // handler supplied (images, etc.) so vision-capable models can also
          // see the actual artifact. read_active_browser_session uses this to
          // ship the browser screenshot as a base64 PNG alongside the URL JSON.
          // Failure → uniform structured error contract (classified from the
          // message; retry flag from the converged transient/retryable signal).
          // mcpContent is only populated on successful media reads, so nothing
          // is lost by not appending it on the error path.
          if (!handlerResult.success) {
            const stdErrMsg = typeof handlerResult.error === 'string'
              ? handlerResult.error
              : JSON.stringify(handlerResult.error ?? 'standard tool failed');
            // The handler's own classification and recovery travel when it
            // has them; the message heuristic is the fallback, not the rule.
            return buildToolErrorContent({
              message: stdErrMsg,
              code: handlerResult.errorCode,
              retryable: handlerResult.retryable ?? handlerResult.transient,
              retryAfterMs: handlerResult.retryAfterMs,
              recovery: handlerResult.recovery,
            });
          }
          // web_extract and web_task return STRUCTURE, so nothing framed them:
          // framing a nested `data` object is not a thing, and the handler
          // screens the value instead. This is the model-facing serialisation
          // — the string the model actually reads — so the frame goes on it,
          // here and on the autonomous path's prompt rendering. No screenCtx:
          // the value was already screened in the handler, and this string
          // hashes differently from the extracted text, so a second screen
          // would neither deduplicate nor add anything.
          const serialized = JSON.stringify(handlerResult);
          const content: Array<
            | { type: 'text'; text: string }
            | { type: 'image'; data: string; mimeType: string }
          > = [{
            type: 'text',
            text: FRAMED_STRUCTURED_WEB_TOOLS.has(toolName)
              ? frameUntrusted(`web:${toolName}`, serialized)
              : serialized,
          }];
          if (Array.isArray(handlerResult.mcpContent)) {
            for (const block of handlerResult.mcpContent) {
              content.push({
                type: block.type,
                data: block.data,
                mimeType: block.mimeType,
              });
            }
          }
          return {
            content,
            isError: false,
          };
        }
        // Post-WS-2: unhandled standard tool is an error condition, not a stub.
        // Emit the schema-validated `stub_fallback_fired` event so the log-based
        // metric + alert (WS-1.5/1.6) fire on any regression.
        scrubLogger.error({
          event: 'stub_fallback_fired',
          tool_name: toolName,
          dispatch_path: 'mcp_server',
        });
        // Audit the stub-fallback path too. An agent calling a tool that has
        // no handler is itself worth recording — it surfaces tool-name probing
        // and catalog/handler drift in /activity, not just in metrics.
        void emitStandardToolAudit({
          tenantId,
          agentId,
          invocationId,
          threadId,
          action: toolName,
          inputArgs: args,
          success: false,
          error: 'no handler registered for standard tool',
          errorCode: 'no_handler_registered',
          durationMs: Date.now() - stepStart,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error:
              `no handler registered for standard tool: ${toolName}. ` +
              `The platform's tool catalog and handler implementation are out of sync. ` +
              `This tool cannot be invoked.`,
          }) }],
          isError: true,
        };
      },
      // Same rule the sandbox registration applies at its own site: a tool
      // isAlwaysLoadedTool names must not be deferred behind the SDK's tool
      // search, or the prompt contract that names it can be missed.
      ...(isAlwaysLoadedTool(stdTool.name) ? [{ alwaysLoad: true }] as const : []),
    );
    mcpTools.push(mcpTool);
  }

  // --- Search tool: indexed context + memory + connector dispatch ---
  // Searches content already fetched into the workspace index, searches agent
  // memory (always), and optionally dispatches to connector-specific search
  // actions via the tool gateway (when `connectors` is provided). Falls back
  // gracefully — a connector without a 'search' action simply returns no
  // results for that source rather than erroring.
  modelTools.push({ name: 'search', description: SEARCH_TOOL_DESCRIPTION, categories: [], effect: 'read' });

  // The model names connectors by ALIAS ("crm"); connector_content is keyed by
  // connector TYPE ("hubspot"). Resolve through the manifests the agent is
  // actually bound to. An alias that resolves to nothing is dropped rather
  // than passed through as a type — a bogus type filter matches zero rows and
  // would read as "the workspace has nothing indexed", which is the one thing
  // this source must never say by accident.
  const connectorTypeByAlias = new Map<string, string>();
  for (const m of manifests) {
    connectorTypeByAlias.set(m.alias.toLowerCase(), m.connectorType);
    connectorTypeByAlias.set(sanitizeToolNameSegment(m.alias).toLowerCase(), m.connectorType);
    connectorTypeByAlias.set(m.connectorType.toLowerCase(), m.connectorType);
  }
  const connectorTypesForAliases = (aliases: string[] | undefined): string[] => {
    if (!aliases?.length) return [];
    const types = new Set<string>();
    for (const a of aliases) {
      const t = connectorTypeByAlias.get(a.toLowerCase());
      if (t) types.add(t);
    }
    return [...types];
  };

  const searchMcpTool = tool(
    'search',
    SEARCH_TOOL_DESCRIPTION,
    {
      query: z.string().describe('The search query'),
      connectors: z.array(z.string()).optional().describe('Connector aliases to search in addition to memory (e.g. ["github", "slack"])'),
    },
    async (args: { query: string; connectors?: string[] }) => {
      const searchStart = Date.now();
      const results: Array<{ source: string; items: unknown[]; coverage?: unknown; note?: string }> = [];

      // One hypothetical document and one embedding for the whole call. Both
      // semantic sources below want a vector for the same question, and buying
      // two would double the LLM cost of every `search` for no extra recall.
      // A failure here leaves each source to build its own, which is the
      // behaviour that existed before this was shared.
      const retrieval = await buildRetrievalVector({
        query: args.query,
        tenantId,
        ...(agentId ? { agentId } : {}),
        ...(invocationId ? { invocationId } : {}),
      });

      // Already-indexed content first: it is free at the vendor, costs no
      // Composio quota, and answers from data this workspace has already been
      // charged to fetch and embed.
      const indexedStart = Date.now();
      const indexedTypes = connectorTypesForAliases(args.connectors);
      const indexed = await searchIndexedContext({
        tenantId,
        agentId,
        query: args.query,
        ...(indexedTypes.length > 0 ? { connectorTypes: indexedTypes } : {}),
        ...(retrieval.embeddingJson ? { embeddingJson: retrieval.embeddingJson } : {}),
        ...(retrieval.unavailable ? { semanticUnavailable: true } : {}),
        // Invocation id when there is one, trace id otherwise. Both are
        // per-run; a tenant-wide key would cap the tenant permanently on the
        // twentieth search rather than capping one run.
        runKey: invocationId ?? traceId,
      });
      if (indexed.items.length > 0 || indexed.note) {
        results.push({
          source: 'indexed_context',
          items: indexed.items,
          coverage: indexed.coverage,
          ...(indexed.note ? { note: indexed.note } : {}),
        });
      }
      // Audited like the memory sub-call below: the agent asked for `search`
      // and this ran as part of it, so /activity shows the work that happened.
      void emitStandardToolAudit({
        tenantId, agentId, invocationId, threadId,
        action: 'indexed_context_search',
        inputArgs: { query: args.query, connectors: args.connectors },
        // The source never throws, so `success: true` unconditionally would
        // record a search that never ran as one that ran and found nothing.
        success: indexed.ok,
        error: indexed.error,
        errorCode: indexed.ok ? undefined : 'indexed_context_unavailable',
        durationMs: Date.now() - indexedStart,
      });

      // Audit the implicit memory_retrieve sub-call. The agent asked for
      // `search`; we choose to invoke memory_retrieve as part of the
      // implementation. That sub-call IS a tool call that ran and belongs in
      // the ledger so /activity correctly shows the work that happened.
      let memorySubOk = false;
      let memorySubError: string | undefined;
      const memoryStart = Date.now();
      try {
        const memResult = await executeStandardTool(
          'memory_retrieve',
          { query: args.query, top_k: 5 },
          retrieval.embedding
            ? { ...stdToolCtx, precomputedQueryEmbedding: retrieval.embedding }
            : { ...stdToolCtx, semanticRetrievalUnavailable: retrieval.unavailable },
        );
        memorySubOk = memResult?.success ?? false;
        if (!memorySubOk) memorySubError = memResult?.error;
        const memories = (memResult?.result as { memories?: unknown[] })?.memories ?? [];
        if (memories.length > 0) {
          results.push({ source: 'memory', items: memories });
        }
      } catch (err) {
        memorySubError = err instanceof Error ? err.message : String(err);
      }
      void emitStandardToolAudit({
        tenantId, agentId, invocationId, threadId,
        action: 'memory_retrieve',
        inputArgs: { query: args.query, top_k: 5 },
        success: memorySubOk,
        error: memorySubError,
        durationMs: Date.now() - memoryStart,
      });

      // For each requested connector, try to dispatch a 'search' action.
      // Indexed context counts toward the outer outcome: without it, a search
      // whose only hits came from already-fetched content would be recorded as
      // `search_no_results` on /activity while returning results to the model.
      let anySubDispatchSucceeded = memorySubOk || indexed.items.length > 0;
      for (const connectorAlias of args.connectors ?? []) {
        const subStart = Date.now();
        let subOk = false;
        let subError: string | undefined;
        try {
          const executeInput: InternalExecuteInput = {
            tenantId, agentId, instructionVersion, traceId, invocationId,
            idempotencyKey: `${traceId}-search-${connectorAlias}-${toolIndex++}`,
            connector: connectorAlias,
            entityType: 'default',
            actionType: 'search',
            payload: { query: args.query },
            estimatedCredits: 1,
            _internalSkipHitl: true,
            bindingsByType,
          };
          const result = forModel(await toolGateway.execute(executeInput), invocationId);
          subOk = !!result.success;
          if (!result.success) subError = result.error;
          if (result.success && result.data) {
            const items = Array.isArray(result.data) ? result.data : [result.data];
            results.push({ source: connectorAlias, items });
          }
        } catch (err) {
          // connector doesn't support search — recorded below but not surfaced to the model
          subError = err instanceof Error ? err.message : String(err);
        }
        if (subOk) anySubDispatchSucceeded = true;
        // Per-sub-dispatch audit: each connector search IS a real connector call and
        // belongs in the ledger alongside other connector tool calls. The outer
        // `search` audit (below) tracks the agent's intent; these track each
        // executed dispatch.
        void emitStandardToolAudit({
          tenantId, agentId, invocationId, threadId,
          action: `${connectorAlias}__search`,
          inputArgs: { query: args.query },
          success: subOk,
          error: subError,
          errorCode: subOk ? undefined : 'search_sub_dispatch_error',
          durationMs: Date.now() - subStart,
        });
      }

      // Outer-search outcome reflects whether any sub-dispatch (memory or
      // connector) actually succeeded. The umbrella row should match reality —
      // success only when there's at least one real result behind it.
      void emitStandardToolAudit({
        tenantId, agentId, invocationId, threadId,
        action: 'search',
        inputArgs: args,
        success: anySubDispatchSucceeded,
        error: anySubDispatchSucceeded ? undefined : 'all search sub-dispatches failed or returned empty',
        errorCode: anySubDispatchSucceeded ? undefined : 'search_no_results',
        durationMs: Date.now() - searchStart,
      });

      // "Nothing was found" is about ITEMS, not about entries: the indexed
      // source contributes a coverage note even when it matched nothing, and
      // that note is what lets the model say "not in what I have seen" rather
      // than "it does not exist". Both are returned.
      if (!results.some((r) => r.items.length > 0)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, results, message: 'No results found. Try specifying connector aliases in the `connectors` parameter, or use connector-specific tools directly.' }) }],
          isError: false,
        };
      }

      return {
        content: [{ type: 'text' as const, text: frameUntrusted('search:corpus', JSON.stringify({ success: true, results }), undefined, { tenantId, agentId, invocationId }) }],
        isError: false,
      };
    }
  );
  mcpTools.push(searchMcpTool);

  // --- Per-agent Slack tools (slack_send_message, slack_reply_in_thread, …) ---
  // Gated on the presence of at least one installed Slack workspace for
  // this agent (per-agent Slack apps installed from the More pane on
  // /dashboard/agents/chat; bot tokens live in Secret Manager). Without
  // this section, conversational + llm_reason dispatch through the adapter
  // loses Slack entirely.
  //
  // This used to claim that workflow tool_call steps naming slack_* "still
  // route through executeToolStep → toolGateway.execute" and were therefore
  // unaffected. They did not. `buildToolCallRequest` gave any name without a
  // `__` an empty connector, which the dispatcher reads as "standard tool", so
  // those steps went to executeStandardTool — which has no slack_* case — and
  // died with "no handler registered". They reach the gateway now because the
  // family resolver (agent-execution/tool-dispatch-family.ts) routes them, not
  // because they always did.
  try {
    const { listAgentSlackInstalls } = await import('../agent-chat/agent-slack-client');
    const installs = await listAgentSlackInstalls(tenantId, agentId);
    if (installs.some((i) => i.botToken)) {
      const { AGENT_SLACK_TOOLS } = await import('./agent-slack-tool-catalog');
      for (const slackTool of AGENT_SLACK_TOOLS) {
        if (registeredToolNames.has(slackTool.name)) continue;

        // Slack's Web API has NO programmatic draft endpoint. Verified
        // against docs.slack.dev/reference/methods 2026-06-16:
        // chat.scheduleMessage is a delayed send (auto-fires when the
        // timer hits — that's not a draft), not a user-editable draft.
        // Under communication='draft' the structurally correct
        // behaviour is HITL approval — pause the agent, surface the
        // proposed message on the oversight dashboard, send only on
        // explicit user approval. Skip the tool entirely (no draft
        // alternative to register), and wrap the handler defensively
        // in case a future code path forms a call to it anyway.
        const slackOversightDecision = oversightDecisionFor({
          categories: slackTool.categories,
          // AGENT_SLACK_TOOLS never publishes a draftVariant; the API
          // doesn't exist. Passing undefined routes the decision to
          // 'require_approval' for any outbound slack tool under draft
          // (or review + matching sensitive category).
          draftVariant: undefined,
        }, oversight);
        if (slackOversightDecision.kind === 'skip_for_draft') {
          // AGENT_SLACK_TOOLS shouldn't reach this branch (no
          // draftVariant), but log defensively if a future catalog
          // edit introduces one.
          continue;
        }

        registeredToolNames.add(slackTool.name);
        modelTools.push({
          name: slackTool.name,
          description: slackTool.description,
          categories: slackTool.categories ?? [],
        });
        const rawShape = extractToolShape(convertJsonSchemaToZod(slackTool.input_schema ?? {}));
        const slackToolName = slackTool.name;
        const slackClosureOversight = slackOversightDecision;
        const mcpTool = tool(
          slackToolName,
          slackTool.description,
          rawShape,
          async (args: Record<string, unknown>) => {
            try {
              // Same mapping as the connector site: the message check reads
              // an outbound message under Auto or a matched Review.
              const verdict = await checkMessage({
                toolName: slackToolName, categories: slackTool.categories ?? [], args, oversight, decision: slackClosureOversight,
                ...(contract ? { contract } : {}), tenantId, agentId, ...(invocationId ? { invocationId } : {}),
              });
              if (verdict.kind === 'pause') {
                recordGatewayHitlPause(invocationId, { toolName: slackToolName, reason: verdict.reason, args, matchedCategory: verdict.matchedCategory, context: verdict.context });
                throw new HitlGateError(
                  [{ id: '', connector: 'agent_slack', entityType: 'agent_slack', actionType: slackToolName, payload: args } as never],
                  verdict.reason,
                  verdict.matchedCategory,
                );
              }
              if (slackClosureOversight.kind === 'require_approval' && verdict.kind !== 'send') {
                const reason = slackClosureOversight.reason as 'communication_review' | 'sensitive_work';
                logger.info(
                  { tenantId, agentId, toolName: slackToolName, reason, communication: oversight?.communication },
                  'oversight: HITL approval required before dispatching outbound Slack tool (no API draft exists)',
                );
                // See the connector site above: record before throwing so the pause
                // survives the SDK turning handler exceptions into tool errors.
                recordGatewayHitlPause(invocationId, { toolName: slackToolName, reason, args, ...(verdict.context ? { context: verdict.context } : {}) });
                throw new HitlGateError(
                  [{ id: '', connector: 'agent_slack', entityType: 'agent_slack', actionType: slackToolName, payload: args } as never],
                  reason,
                );
              }
              const runSlack = () => toolGateway.execute({
                tenantId, agentId, instructionVersion, traceId,
                idempotencyKey: `${traceId}-${slackToolName}-${toolIndex++}`,
                // connector value is unused by the agent-slack route
                // (service.ts:170 routes on actionType prefix), but the
                // InternalExecuteInput contract requires a non-empty
                // string. 'agent_slack' is the descriptive value used by
                // audit + observability downstream.
                connector: 'agent_slack',
                entityType: 'agent_slack',
                actionType: slackToolName,
                payload: args,
                estimatedCredits: 1,
                _internalSkipHitl: true,
                bindingsByType,
              });
              // Per-side-effect idempotency (§4.5): mutating Slack sends route
              // in-process (no connector-service interceptor), so claim-before /
              // replay here so a redelivery does not re-post. Reads + chat
              // (no triggerKey) are unchanged passthroughs.
              const slackMutating = (slackTool.categories ?? []).some(
                (c) => c === 'write' || c === 'destructive' || c === 'outbound',
              );
              let result: Awaited<ReturnType<typeof toolGateway.execute>>;
              if (slackMutating && triggerKey) {
                const claim = await claimSideEffect({
                  tenantId, triggerKey, toolName: `agent_slack.${slackToolName}`,
                  args, policy: dedupPostureFor(`agent_slack.${slackToolName}`).policy,
                });
                if (claim.outcome === 'replay') {
                  result = claim.result as Awaited<ReturnType<typeof toolGateway.execute>>;
                } else if (claim.outcome === 'blocked') {
                  return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                      success: false,
                      error:
                        'BLOCKED_PRIOR_ATTEMPT: a previous attempt of this exact action was '
                        + 'interrupted before its result was recorded. Not re-run automatically '
                        + 'to avoid a duplicate side effect.',
                    }) }],
                    isError: true,
                  };
                } else {
                  try {
                    result = forModel(await runSlack(), invocationId);
                    await resolveSideEffect({ tenantId, stepKey: claim.stepKey, result });
                  } catch (e) {
                    await failSideEffect({ tenantId, stepKey: claim.stepKey, error: (e as Error).message });
                    throw e;
                  }
                }
              } else {
                result = forModel(await runSlack(), invocationId);
              }
              recordToolCall(slackToolName, args, result.data, result.success ? undefined : result.error);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                isError: !result.success,
              };
            } catch (err) {
              const message = (err as Error).message;
              recordToolCall(slackToolName, args, null, message);
              // HitlGateError is a structured signal the outer hybrid
              // loop converts to a HITL pause; re-throw so the adapter
              // path's anomaly handler escalates instead of returning
              // an error result to the LLM.
              if (err instanceof HitlGateError) throw err;
              return buildToolErrorContent({ message });
            }
          },
        );
        mcpTools.push(mcpTool);
      }
    }
  } catch (err) {
    logger.warn(
      { tenantId, agentId, err: (err as Error).message },
      'mcp-server: failed to load per-agent slack tools — skipping',
    );
  }

  // --- Shared-bot Microsoft Teams tools (teams_send_message, teams_reply_in_thread, …) ---
  // Gated on the agent having at least one bound Teams conversation
  // (agent_teams_conversations, populated when a user picks this agent via the
  // pick_agent card or the bot is added to a channel — the per-agent analogue
  // of Slack's install check above). One multi-tenant Liftoff bot serves all
  // agents; PB's bot adapter does the Graph work via /api/internal/agent-teams/*.
  // Mirrors the per-agent Slack block above (same oversight + idempotency).
  try {
    const { listAgentTeamsConversations } = await import('../agent-chat/agent-teams-client');
    const teamsConvs = await listAgentTeamsConversations(tenantId, agentId);
    if (teamsConvs.length > 0) {
      const { AGENT_TEAMS_TOOLS } = await import('./agent-teams-tool-catalog');
      for (const teamsTool of AGENT_TEAMS_TOOLS) {
        if (registeredToolNames.has(teamsTool.name)) continue;

        // Teams (like Slack) has no programmatic draft endpoint —
        // teams_update_message edits an already-sent message, not a draft.
        // Under communication='draft' the structurally correct behaviour is
        // HITL approval; passing draftVariant: undefined routes the decision to
        // 'require_approval' for any outbound teams tool under draft (or review +
        // matching sensitive category).
        const teamsOversightDecision = oversightDecisionFor({
          categories: teamsTool.categories,
          draftVariant: undefined,
        }, oversight);
        if (teamsOversightDecision.kind === 'skip_for_draft') {
          continue;
        }

        registeredToolNames.add(teamsTool.name);
        modelTools.push({
          name: teamsTool.name,
          description: teamsTool.description,
          categories: teamsTool.categories ?? [],
        });
        const rawShape = extractToolShape(convertJsonSchemaToZod(teamsTool.input_schema ?? {}));
        const teamsToolName = teamsTool.name;
        const teamsClosureOversight = teamsOversightDecision;
        const mcpTool = tool(
          teamsToolName,
          teamsTool.description,
          rawShape,
          async (args: Record<string, unknown>) => {
            try {
              // Same mapping as the connector site (message-check.ts).
              const verdict = await checkMessage({
                toolName: teamsToolName, categories: teamsTool.categories ?? [], args, oversight, decision: teamsClosureOversight,
                ...(contract ? { contract } : {}), tenantId, agentId, ...(invocationId ? { invocationId } : {}),
              });
              if (verdict.kind === 'pause') {
                recordGatewayHitlPause(invocationId, { toolName: teamsToolName, reason: verdict.reason, args, matchedCategory: verdict.matchedCategory, context: verdict.context });
                throw new HitlGateError(
                  [{ id: '', connector: 'agent_teams', entityType: 'agent_teams', actionType: teamsToolName, payload: args } as never],
                  verdict.reason,
                  verdict.matchedCategory,
                );
              }
              if (teamsClosureOversight.kind === 'require_approval' && verdict.kind !== 'send') {
                const reason = teamsClosureOversight.reason as 'communication_review' | 'sensitive_work';
                logger.info(
                  { tenantId, agentId, toolName: teamsToolName, reason, communication: oversight?.communication },
                  'oversight: HITL approval required before dispatching outbound Teams tool (no API draft exists)',
                );
                // See the connector site above: record before throwing so the pause
                // survives the SDK turning handler exceptions into tool errors.
                recordGatewayHitlPause(invocationId, { toolName: teamsToolName, reason, args, ...(verdict.context ? { context: verdict.context } : {}) });
                throw new HitlGateError(
                  [{ id: '', connector: 'agent_teams', entityType: 'agent_teams', actionType: teamsToolName, payload: args } as never],
                  reason,
                );
              }
              const runTeams = () => toolGateway.execute({
                tenantId, agentId, instructionVersion, traceId,
                idempotencyKey: `${traceId}-${teamsToolName}-${toolIndex++}`,
                // connector value is unused by the agent-teams route
                // (service.ts routes on actionType prefix); the contract
                // requires a non-empty string. 'agent_teams' is the descriptive
                // value used by audit + observability downstream.
                connector: 'agent_teams',
                entityType: 'agent_teams',
                actionType: teamsToolName,
                payload: args,
                estimatedCredits: 1,
                _internalSkipHitl: true,
                bindingsByType,
              });
              // Per-side-effect idempotency (§4.5): mutating Teams sends route
              // in-process (no connector-service interceptor), so claim-before /
              // replay here so a redelivery does not re-post. Reads (list/get)
              // are unchanged passthroughs.
              const teamsMutating = (teamsTool.categories ?? []).some(
                (c) => c === 'write' || c === 'destructive' || c === 'outbound',
              );
              let result: Awaited<ReturnType<typeof toolGateway.execute>>;
              if (teamsMutating && triggerKey) {
                const claim = await claimSideEffect({
                  tenantId, triggerKey, toolName: `agent_teams.${teamsToolName}`,
                  args, policy: dedupPostureFor(`agent_teams.${teamsToolName}`).policy,
                });
                if (claim.outcome === 'replay') {
                  result = claim.result as Awaited<ReturnType<typeof toolGateway.execute>>;
                } else if (claim.outcome === 'blocked') {
                  return {
                    content: [{ type: 'text' as const, text: JSON.stringify({
                      success: false,
                      error:
                        'BLOCKED_PRIOR_ATTEMPT: a previous attempt of this exact action was '
                        + 'interrupted before its result was recorded. Not re-run automatically '
                        + 'to avoid a duplicate side effect.',
                    }) }],
                    isError: true,
                  };
                } else {
                  try {
                    result = forModel(await runTeams(), invocationId);
                    await resolveSideEffect({ tenantId, stepKey: claim.stepKey, result });
                  } catch (e) {
                    await failSideEffect({ tenantId, stepKey: claim.stepKey, error: (e as Error).message });
                    throw e;
                  }
                }
              } else {
                result = forModel(await runTeams(), invocationId);
              }
              recordToolCall(teamsToolName, args, result.data, result.success ? undefined : result.error);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result) }],
                isError: !result.success,
              };
            } catch (err) {
              const message = (err as Error).message;
              recordToolCall(teamsToolName, args, null, message);
              // HitlGateError is a structured signal the outer hybrid loop
              // converts to a HITL pause; re-throw so the adapter path's anomaly
              // handler escalates instead of returning an error to the LLM.
              if (err instanceof HitlGateError) throw err;
              return buildToolErrorContent({ message });
            }
          },
        );
        mcpTools.push(mcpTool);
      }
    }
  } catch (err) {
    logger.warn(
      { tenantId, agentId, err: (err as Error).message },
      'mcp-server: failed to load per-agent teams tools — skipping',
    );
  }

  // --- Sandbox primitives (shell_exec, file_read/write/edit, browser_*, vscode_*, …) ---
  // Gated on sandboxCapabilities (subset of {shell, file, browser,
  // vscode}). Empty/absent = no raw primitives, only the higher-level
  // code_session tool is registered. Dispatch routes through
  // toolGateway.execute with connector='execution_environment' — the
  // sandbox-executor sidecar (see project_sandbox_executor_split memory)
  // does the actual work.
  if (sandboxCapabilities && sandboxCapabilities.length > 0) {
    try {
      const { filterSandboxFunctionsByCapabilities } = await import('../execution-environments/function-registry');
      const sandboxFns = filterSandboxFunctionsByCapabilities(sandboxCapabilities);
      for (const fn of sandboxFns) {
        if (registeredToolNames.has(fn.name)) continue;
        registeredToolNames.add(fn.name);
        modelTools.push({
          name: fn.name,
          description: fn.description,
          source: 'sandbox',
          categories: fn.categories ?? [],
        });
        const rawShape = extractToolShape(convertJsonSchemaToZod(fn.inputSchema ?? {}));
        const sandboxToolName = fn.name;
        const mcpTool = tool(
          sandboxToolName,
          fn.description,
          rawShape,
          async (args: Record<string, unknown>) => {
            try {
              const result = forModel(await toolGateway.execute({
                tenantId, agentId, instructionVersion, traceId, triggerKey,
                idempotencyKey: `${traceId}-${sandboxToolName}-${toolIndex++}`,
                connector: 'execution_environment',
                entityType: 'sandbox',
                actionType: sandboxToolName,
                invocationId,
                // The sandbox workspace is keyed by a RUN identity, never by
                // the trace id. A thread scopes the workspace across the turns
                // of a conversation; without one (delegated children, wake
                // polls) the invocation is the correct — and narrower — scope.
                // The trace id is a diagnostic string of the form
                // `exec-<workflowId>-<taskId>-<hash>`, which is not an identity
                // and failed the sandbox_state lookup outright. Both fields go
                // through as themselves and sandboxSessionIdFor owns the
                // precedence; `payload` stays the model's arguments, untouched,
                // because `sessionId` is one of them here.
                threadId,
                payload: { ...args, invocationId },
                estimatedCredits: 1,
                _internalSkipHitl: true,
                bindingsByType,
              }), invocationId);
              recordToolCall(sandboxToolName, args, result.data, result.success ? undefined : result.error);
              if (!result.success) {
                // Same envelope every other tool failure uses, so a sandbox
                // error is machine-readable rather than a JSON blob the model
                // has to interpret. Without this a retryable condition — a
                // workspace still starting — reads identically to a permanent
                // one and gets abandoned.
                return buildToolErrorContent({
                  message: result.error ?? 'sandbox tool call failed',
                  code: result.errorCode,
                  retryable: result.retryable,
                  retryAfterMs: result.retryAfterMs,
                });
              }
              // A notice leads, because buried in a JSON blob it is something
              // the model may not read until after it has already acted on the
              // assumption the notice exists to correct.
              return {
                content: [{
                  type: 'text' as const,
                  text: result.notice
                    ? `NOTICE: ${result.notice}\n\n${JSON.stringify(result)}`
                    : JSON.stringify(result),
                }],
                isError: false,
              };
            } catch (err) {
              const message = (err as Error).message;
              recordToolCall(sandboxToolName, args, null, message);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
                isError: true,
              };
            }
          },
          // The SDK defers large MCP catalogs behind its own tool search by
          // default (`defer_loading`, measured at 104 deferred tools on a live
          // run), so this is the Anthropic-path equivalent of the never-collapse
          // set our own tiering applies on every other engine. ONE list, two
          // mechanisms: a distilled prompt that says "read the file, then run the
          // tests" cannot be followed if `file_read` and `shell_exec` have to be
          // discovered by a ToolSearch first. The browser-navigation rules
          // hoisted above the persona block in interactive-chat/system-prompt.ts
          // are the scar from exactly this, patched in prose because the
          // mechanism was not being used.
          ...(isAlwaysLoadedTool(sandboxToolName) ? [{ alwaysLoad: true }] as const : []),
        );
        mcpTools.push(mcpTool);
      }
    } catch (err) {
      logger.warn(
        { tenantId, agentId, capabilities: sandboxCapabilities, err: (err as Error).message },
        'mcp-server: failed to load sandbox primitives — skipping',
      );
    }
  }

  // --- Platform tool: find_teammates (callback to Platform Backend) ---
  // Calls the Platform Backend's internal API to search for teammate agents.
  // The `internal_agents` table lives on the PB, so this is a cross-service call.
  const platformBackendUrl = process.env.PLATFORM_BACKEND_URL;
  const platformCallbackToken = getManagedSecret('PLATFORM_CALLBACK_TOKEN');

  if (platformBackendUrl && platformCallbackToken) {
    modelTools.push({
      name: 'find_teammates',
      description: 'Search for agents, teammates, and collaborators in your workspace',
      categories: [],
      effect: 'read',
    });

    const findTeammatesMcpTool = tool(
      'find_teammates',
      'Search for teammate agents in your workspace by name, role, or capability.\n\nThis is the step BEFORE delegating: use it once you have established that a request needs something your own role does not cover, to find who does cover it. Search by the capability you are missing rather than by a job title, so you find a teammate who adds something instead of one who merely shares your name. Also the way to get IDs for send_agent_message.',
      {
        query: z.string().max(200).describe('Search query — name, role, or capability to search for'),
      },
      async (args: { query: string }) => {
        try {
          const url = `${platformBackendUrl}/api/internal/platform-tools/find-teammates?tenantId=${encodeURIComponent(tenantId)}&agentId=${encodeURIComponent(agentId)}&query=${encodeURIComponent(args.query)}`;
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'X-Service-Auth': platformCallbackToken,
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(10000),
          });

          if (!response.ok) {
            const errorText = await readBoundedErrorText(response);
            logger.warn({ status: response.status, errorText, tenantId }, 'find_teammates callback failed');
            return buildToolErrorContent({ message: platformFailure(response.status, errorText) });
          }

          const data = await response.json();
          recordToolCall('find_teammates', args, data);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, tenantId }, 'find_teammates callback error');
          recordToolCall('find_teammates', args, null, message);
          return buildToolErrorContent({ message });
        }
      },
    );
    mcpTools.push(findTeammatesMcpTool);
  } else {
    logger.info('find_teammates tool skipped: PLATFORM_BACKEND_URL or PLATFORM_CALLBACK_TOKEN not set');
  }

  // --- Platform tool: recall_conversations (plan v13 Change 4) ---
  // Cross-channel recall of the CURRENT USER's attributed turns with this
  // agent (PB agent_chat_turns). Registered ONLY on attributable interactive
  // turns; absence is the fail-closed path for scheduled/cron/A2A runs:
  //   1. RECALL_CONVERSATIONS_ENABLED === 'true' (agent-service env)
  //   2. platform-callback ServiceClient configured (OIDC + service auth +
  //      breaker — NOT a raw fetch; PB verifies the minted full-endpoint-URL
  //      audience)
  //   3. input.messageSenderAccountId present (the sole gateway
  //      account-identity field; strictly an accounts.id after the
  //      chat-turn-handler mapping from the wire field senderAccountId)
  //   4. input.turnId present (recall must exclude the executing turn)
  //   5. runtime -> internal agent id RESOLVES — no identity fallback; a
  //      mapping miss or lookup failure skips registration (logged) and
  //      must never abort construction of the rest of the catalog.
  if (
    process.env.RECALL_CONVERSATIONS_ENABLED === 'true' &&
    input.messageSenderAccountId &&
    input.turnId
  ) {
    const { getPlatformCallbackClient } = await import('../platform-callback/client');
    const callbackClient = getPlatformCallbackClient();
    if (callbackClient) {
      let internalAgentId: string | null = null;
      try {
        const { resolveInternalAgentId } = await import('../agent-lifecycle/resolve-runtime-agent-id');
        internalAgentId = await resolveInternalAgentId(tenantId, agentId);
      } catch (err) {
        internalAgentId = null;
        logger.warn(
          { event: 'recall_conversations_skipped', tenantId, reason: `mapping lookup failed: ${(err as Error).message}` },
          'recall_conversations skipped',
        );
      }
      if (internalAgentId === null) {
        logger.warn(
          { event: 'recall_conversations_skipped', tenantId, reason: 'no runtime->internal agent mapping' },
          'recall_conversations skipped',
        );
      } else {
        const recallInternalAgentId = internalAgentId;
        const recallAccountId = input.messageSenderAccountId;
        const recallTurnId = input.turnId;

        modelTools.push({
          name: 'recall_conversations',
          description: 'Search OTHER conversations with the person you are talking to right now, across chat, Slack, Teams, and connected coding tools.',
          categories: [],
        });

        const recallConversationsMcpTool = tool(
          'recall_conversations',
          'Search OTHER conversations with the person you are talking to right now, across chat, Slack, Teams, and connected coding tools. '
          + 'Use when they refer to something settled somewhere else and not in this conversation — "last time", "as we agreed", "the account I set up with you", '
          + 'a decision or a figure from a previous session. Omit query to list your most recent conversations with them. '
          + 'For something said EARLIER IN THIS CONVERSATION, use read_conversation_history instead: that reads this thread in full, '
          + 'while this returns short excerpts and at most one hit per conversation.',
          {
            query: z.string().max(200).optional().describe('Words to search for in past conversations; omit for the most recent ones'),
            limit: z.number().int().min(1).max(10).optional().describe('Max turns to return (default 5)'),
          },
          async (args: { query?: string; limit?: number }) => {
            try {
              // No explicit Content-Type — ServiceClient defaults to
              // application/json (see WS-C note in platform-callback/client).
              const response = await callbackClient.fetch(
                'platform',
                '/api/internal/platform-tools/agent-conversations',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    tenantId,
                    agentId: recallInternalAgentId,
                    accountId: recallAccountId,
                    excludeTurnId: recallTurnId,
                    ...(args.query ? { query: args.query } : {}),
                    ...(args.limit ? { limit: args.limit } : {}),
                  }),
                  breakerKey: 'platform:agent-conversations',
                },
              );

              if (!response.ok) {
                const errorText = await readBoundedErrorText(response);
                logger.warn({ status: response.status, errorText, tenantId }, 'recall_conversations callback failed');
                recordToolCall('recall_conversations', args, null, platformFailure(response.status, errorText));
                return buildToolErrorContent({ message: platformFailure(response.status, errorText) });
              }

              let data: unknown;
              try {
                data = await response.json();
              } catch {
                recordToolCall('recall_conversations', args, null, 'malformed platform response');
                return buildToolErrorContent({ message: 'malformed platform response' });
              }

              recordToolCall('recall_conversations', args, data);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(data) }],
                isError: false,
              };
            } catch (error) {
              // Transport failure, timeout, or circuit-open rejection —
              // surface honestly, never a fabricated empty result (INV-4).
              const message = error instanceof Error ? error.message : String(error);
              logger.error({ err: error, tenantId }, 'recall_conversations callback error');
              recordToolCall('recall_conversations', args, null, message);
              return buildToolErrorContent({ message });
            }
          },
        );
        mcpTools.push(recallConversationsMcpTool);
      }
    }
  }

  // --- Platform tool: read_conversation_history ---
  // Reading further back in the chat thread this turn is already in. What the
  // model otherwise has of a long conversation is the SDK session (which
  // compacts itself, and is dropped when it goes stale) plus the rolling
  // summary the control plane injects, so a fact stated forty messages ago is
  // reachable only as a summary field.
  //
  // GATED ON THE THREAD ALONE, and deliberately not on the recall flag, the
  // account id or the internal agent id. Those three are recall_conversations'
  // preconditions because it searches ACROSS conversations for one person;
  // this reads the one thread the turn already holds, which the control plane
  // resolves under this tenant. A flag would make it a wiring with a default
  // that ships off.
  if (input.threadId) {
    const { getPlatformCallbackClient } = await import('../platform-callback/client');
    const historyCallbackClient = getPlatformCallbackClient();
    if (historyCallbackClient) {
      const historyThreadId = input.threadId;

      modelTools.push({
        name: 'read_conversation_history',
        description: 'Read what was said earlier in this conversation, further back than the messages you can see.',
        categories: [],
        effect: 'read',
      });

      const readConversationHistoryMcpTool = tool(
        'read_conversation_history',
        'Read what was said earlier in THIS conversation, further back than the messages you can currently see. '
        + 'Only the most recent messages are shown to you; everything older reaches you as a short summary that drops detail. '
        + 'Use this whenever the person refers to something from earlier that you cannot see in full — "the spec I sent", '
        + '"as I said above", "the figures from before", a decision already taken, a name or a link already given — instead of '
        + 'asking them to repeat it. Set match to find the exact message rather than paging: a filtered read reaches much '
        + 'further back. The result says whether older messages remain and how to continue.',
        {
          match: z.string().max(200).optional().describe('Only messages containing this text, case-insensitive. The most efficient way to find one fact.'),
          limit: z.number().int().min(1).max(100).optional().describe('Messages to return, 1-100 (default 30)'),
          before: z.string().max(64).optional().describe('Read messages older than this timestamp; pass the previous result\'s before value to continue further back'),
        },
        async (args: { match?: string; limit?: number; before?: string }) => {
          try {
            const response = await historyCallbackClient.fetch(
              'platform',
              '/api/internal/platform-tools/thread-history',
              {
                method: 'POST',
                body: JSON.stringify({
                  tenantId,
                  // The thread the turn is in. Never from the model's
                  // arguments: a thread id there would let a model name a
                  // conversation it is not part of.
                  threadId: historyThreadId,
                  ...(args.match ? { match: args.match } : {}),
                  ...(args.limit ? { limit: args.limit } : {}),
                  ...(args.before ? { before: args.before } : {}),
                }),
                breakerKey: 'platform:thread-history',
              },
            );

            if (!response.ok) {
              const errorText = await readBoundedErrorText(response);
              logger.warn({ status: response.status, errorText, tenantId }, 'read_conversation_history callback failed');
              recordToolCall('read_conversation_history', args, null, platformFailure(response.status, errorText));
              return buildToolErrorContent({ message: platformFailure(response.status, errorText) });
            }

            let data: unknown;
            try {
              data = await response.json();
            } catch {
              recordToolCall('read_conversation_history', args, null, 'malformed platform response');
              return buildToolErrorContent({ message: 'malformed platform response' });
            }

            const text = (data as { text?: unknown }).text;
            if (typeof text !== 'string') {
              recordToolCall('read_conversation_history', args, null, 'platform response carried no transcript');
              return buildToolErrorContent({ message: 'platform response carried no transcript' });
            }

            recordToolCall('read_conversation_history', args, { chars: text.length });
            return {
              content: [{ type: 'text' as const, text }],
              isError: false,
            };
          } catch (error) {
            // Transport failure, timeout, or circuit-open rejection — surface
            // honestly, never a fabricated empty history (INV-4): a model told
            // the thread is empty says so to the person.
            const message = error instanceof Error ? error.message : String(error);
            logger.error({ err: error, tenantId }, 'read_conversation_history callback error');
            recordToolCall('read_conversation_history', args, null, message);
            return buildToolErrorContent({ message });
          }
        },
      );
      mcpTools.push(readConversationHistoryMcpTool);
    }
  }

  // --- Platform tool: review_recent_activity (local — queries invocations DB) ---
  // The invocations table lives on the Tenant Runtime, so this is a direct DB query.
  modelTools.push({
    name: 'review_recent_activity',
    description: 'Review recent task history and activity for this agent',
    categories: [],
    effect: 'read',
  });

  const reviewRecentActivityMcpTool = tool(
    'review_recent_activity',
    'Review your recent task executions, invocations, and activity history. Use this when the user asks about your past work or what you have been doing.',
    {
      limit: z.number().int().min(1).max(20).optional().describe('Number of recent invocations to return (default: 10)'),
    },
    async (args: { limit?: number }) => {
      try {
        const result = await pool.query(
          `SELECT id, agent_id, thread_id, triggered_by, trigger_ref, outcome,
                  started_at, completed_at, input_tokens, output_tokens
           FROM invocations
           WHERE tenant_id = $1 AND agent_id = $2 AND completed_at IS NOT NULL
           ORDER BY started_at DESC
           LIMIT $3`,
          [tenantId, agentId, args.limit || 10],
        );

        const activity = result.rows.map(row => ({
          id: row.id,
          triggeredBy: row.triggered_by,
          triggerRef: row.trigger_ref,
          outcome: row.outcome,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
        }));

        recordToolCall('review_recent_activity', args, activity);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, recentActivity: activity }) }],
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, tenantId, agentId }, 'review_recent_activity query failed');
        recordToolCall('review_recent_activity', args, null, message);
        return buildToolErrorContent({ message });
      }
    },
  );
  mcpTools.push(reviewRecentActivityMcpTool);

  // --- Internal agent collaboration tools ---
  // One `internal__<agent>__execute` tool per active teammate. §4.13: these
  // dispatch through the inline delegateToAgent path (returns the result), NOT
  // the retired InternalAgentHandler.execute enqueue+resume-caller path.
  //
  // This roster is THE list of teams this agent may hand work to, and it is
  // shared with `delegate_to_agent` below. Both delegation surfaces resolve
  // candidates from the same filtered set so a team that is paused, archived or
  // otherwise not ACTIVE is never offered as a destination in the first place —
  // rather than being offered and then refused at call time. `delegate_to_agent`
  // used to take a free-form model-supplied agent_id with no filter at all,
  // which is how a paused team could be handed work.
  //
  // Declared outside the try so a roster read failure fails CLOSED for both
  // surfaces: an empty roster registers no teammate tools and no
  // delegate_to_agent, instead of leaving delegation open against an unknown set.
/** What a per-teammate hand-off tool tells the model.
 *
 *  One always-loaded tool per teammate, each labelled with that teammate's job
 *  title, makes handing work over the obvious move whenever a title matches the
 *  request — including when the matching title is the caller's own, which is a
 *  loop rather than a hand-off. The tool cannot be hidden (claude-agent-sdk
 *  offers everything registered on the in-process server), so the criterion has
 *  to travel in the description, which every engine reads.
 *
 *  Leads with the REMIT, because that is the thing worth choosing on. */
function teammateToolDescription(
  name: string,
  idSuffix: string,
  role: string | null,
): string {
  const remit = role && role.trim() && role.trim() !== name ? role.trim() : null;
  return [
    `Hand a task to "${name}" (id ${idSuffix})${remit ? ` — their remit: ${remit}` : ''}.`,
    'USE ONLY when the task needs a capability you do not have. You were built for a',
    'specific role; if the request falls inside it, do the work yourself. Handing your own',
    'job to someone else costs a full extra run and returns nothing you could not have',
    'produced. If this teammate\'s remit reads like yours they are a duplicate of you, not a',
    'specialist, and delegating to them is a loop.',
    'They work independently and reply as an agent message — check read_agent_messages for',
    'their answer. This returns as soon as they have picked the task up. For a question you',
    'need answered before your next step, use delegate_to_agent instead.',
  ].join(' ');
}

  const delegationRoster: Array<{ id: string; name: string; role: string | null }> = [];
  try {

    const activeAgents = await pool.query(
      `SELECT id, name, role FROM agents WHERE tenant_id = $1 AND lifecycle = 'ACTIVE' AND id != $2`,
      [tenantId, agentId]
    );
    for (const row of activeAgents.rows) {
      delegationRoster.push({ id: row.id, name: row.name, role: row.role ?? null });
    }

    for (const agent of activeAgents.rows) {
      const agentAlias = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const baseToolName = `internal__${agentAlias}__execute`;
      // Agent names are not unique per tenant (e.g. two "Code Reviewer" agents
      // is a legitimate org pattern). When the alias is already taken, append a
      // short ID so both agents stay reachable; routing is by UUID below so the
      // LLM-facing name is purely cosmetic.
      const idSuffix = agent.id.slice(0, 8);
      const intToolName = registeredToolNames.has(baseToolName)
        ? `internal__${agentAlias}__${idSuffix}__execute`
        : baseToolName;
      if (registeredToolNames.has(intToolName)) {
        logger.error(
          { tenantId, agentId: agent.id, intToolName },
          'BUG: internal agent tool name collided even after id-suffix; skipping',
        );
        continue;
      }
      registeredToolNames.add(intToolName);

      // MUST be pushed to `modelTools`, even though the intent is to discourage
      // this tool. `modelTools` is not what the model sees — it is what the
      // GOVERNANCE GATE resolves a call against (`cachedModelTools`, built from
      // it in agent-execution/service.ts). On claude-agent-sdk the model is
      // handed the in-process McpServer INSTANCE, so it can call anything
      // registered below regardless of this list.
      //
      // Dropping a tool from here therefore hides it from nobody and blinds the
      // gate: the model calls it, `resolveCatalogTool` misses, and
      // UnresolvedToolError fails the whole invocation — one missing entry is
      // enough to kill a customer's turn.
      //
      // Discouragement belongs in the DESCRIPTION, which is what the model
      // actually reads on every engine.
      modelTools.push({
        name: intToolName,
        description: teammateToolDescription(agent.name, idSuffix, agent.role),
        source: 'internal_agent',
        categories: [],
        effect: 'spawn',
      });

      const mcpTool = tool(
        intToolName,
        teammateToolDescription(agent.name, idSuffix, agent.role),
        {
          objective: z.string().describe('What you want this agent to accomplish'),
          context: z.record(z.string(), z.unknown()).optional().describe('Additional context'),
        },
        async (args: { objective: string; context?: Record<string, unknown> }) => {
          try {
            // §4.13: route through the working inline delegation path
            // (delegateToAgent) — the same one delegate_to_agent uses — instead
            // of the broken enqueue + resume-caller path
            // (InternalAgentHandler.execute), which returned {enqueued:true} and
            // never delivered the result (the resume-caller callback dead-ended
            // at a 410 with agentCallResult never read). Now the tool actually
            // "executes independently and returns the result" as its description
            // promises, inheriting the proven event_processing_ledger idempotency
            // + HITL-pause/resume safety.
            const { agentExecutionService } = require('../agent-execution/service');
            // No `collect` — this hands the task over and returns at admission.
            // The blocking shape gave the child five turns and thirty seconds
            // and handed the parent whatever it had managed to say, with
            // nothing in the text marking it as truncated. The answer now
            // arrives over A2A, where it has the child's own budget.
            const result = await agentExecutionService.delegateToAgent({
              agentId: agent.id,
              tenantId,
              objective: args.objective,
              inputData: args.context,
              parentInvocationId: invocationId,
              parentTrustLevel: trustRef?.current,
            });
            const text = JSON.stringify({
              accepted: true,
              agentId: agent.id,
              childInvocationId: result.childInvocationId,
              admittedAt: result.admittedAt,
              note: `${agent.name} has the task. Their reply will arrive as an agent message — use read_agent_messages to pick it up.`,
            });
            return {
              content: [{ type: 'text' as const, text }],
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
              isError: true,
            };
          }
        }
      );
      mcpTools.push(mcpTool);
    }
  } catch {
    // InternalAgentHandler not yet available (Phase 3.5A not deployed) — skip internal tools
    logger.info('InternalAgentHandler not available — skipping internal agent collaboration tools');
  }

  // --- External agent tools (route through tool gateway → ExternalAgentHandler) ---
  if (externalAgents?.length) {
    const { externalAgentHandler } = await import('./external-agent-handler');
    const { listExternalAgentTools } = await import('./external-agent-tools');

    for (const ext of externalAgents) {
      const extAlias = ext.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

      // The agent's CURRENT tools, not the discovery-time snapshot. Naming,
      // dispatch and classification below are unchanged — only the source of
      // this list moved, so external-agent authorization still runs through
      // ExternalAgentHandler.execute exactly as before.
      const liveTools = await listExternalAgentTools(
        ext,
        await externalAgentHandler.resolveCredentialsForEnumeration(ext),
      );

      for (const mcpToolDef of liveTools) {
        // INV-PB-008: skip degraded tools (schema not LLM-tool-API-acceptable)
        // so they're never registered in the model-facing catalog. Kept in sync
        // with buildToolsSchema in agent-execution/service.ts (parity test).
        if ((mcpToolDef as { degraded?: boolean }).degraded === true) continue;
        const extToolName = `external__${extAlias}__${mcpToolDef.name}`;
        const extCategories = ext.toolClassifications?.[mcpToolDef.name] || [];

        modelTools.push({
          name: extToolName,
          description: mcpToolDef.description || `${ext.name}: ${mcpToolDef.name}`,
          source: 'external_agent',
          categories: extCategories,
        });

        const rawShape = extractToolShape(convertJsonSchemaToZod(mcpToolDef.inputSchema || {}));

        const mcpTool = tool(
          extToolName,
          mcpToolDef.description || `Call ${ext.name} tool: ${mcpToolDef.name}`,
          rawShape,
          async (args: Record<string, unknown>) => {
            try {
              const executeInput: InternalExecuteInput = {
                tenantId, agentId, instructionVersion, traceId, invocationId,
                idempotencyKey: `${traceId}-ext-${extToolName}-${toolIndex++}`,
                connector: 'external',
                entityType: ext.id,
                actionType: mcpToolDef.name,
                payload: args,
                estimatedCredits: 1,
                _internalSkipHitl: true,
                bindingsByType,
              };
              const result = forModel(await toolGateway.execute(executeInput), invocationId);
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? result) }],
                isError: !result.success,
              };
            } catch (error) {
              return buildToolErrorContent({
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        );
        mcpTools.push(mcpTool);
      }
    }
  }

  // --- notify_team: the destination that always exists ---
  //
  // Every template that tells a team to post a notice names a channel on a
  // chat connector. With nothing connected, that destination resolves to a
  // phrase — "your engineering channel" — and the instruction stays live, so
  // the agent reports posting to a place it cannot reach.
  //
  // This is the floor under that: the team's own chat page, always present, no
  // connector. When a chat connector IS bound the template names its channel
  // and this is not reached; it exists so the unbound sentence is true.
  if (platformBackendUrl && platformCallbackToken) {
    const notifyTeamShape = {
      message: z.string().min(1).max(8000)
        .describe('The notice, written for a person to read on its own'),
    };
    const NOTIFY_TEAM_DESCRIPTION =
      'Post a notice to your team\'s chat page in Liftoff, where the people you work '
      + 'for will read it. Use this when your instructions tell you to notify a channel '
      + 'and no chat tool is connected.';
    modelTools.push({
      name: 'notify_team',
      description: NOTIFY_TEAM_DESCRIPTION,
      categories: [],
      effect: 'write',
      inputSchema: z.object(notifyTeamShape),
    });

    const notifyTeamTool = tool(
      'notify_team',
      NOTIFY_TEAM_DESCRIPTION,
      notifyTeamShape,
      async (args: { message: string }) => {
        try {
          const response = await fetch(`${platformBackendUrl}/api/internal/platform-tools/notify-team`, {
            method: 'POST',
            headers: {
              'X-Service-Auth': platformCallbackToken,
              'Content-Type': 'application/json',
            },
            // tenantId and agentId come from the runtime context, never from
            // params: an agent must not be able to post as another team.
            body: JSON.stringify({ tenantId, agentId, message: args.message }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) {
            const errorText = await readBoundedErrorText(response);
            logger.warn({ status: response.status, errorText, tenantId }, 'notify_team callback failed');
            return buildToolErrorContent({ message: platformFailure(response.status, errorText) });
          }
          const data = await response.json();
          recordToolCall('notify_team', args, data);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, tenantId }, 'notify_team error');
          recordToolCall('notify_team', args, null, message);
          return buildToolErrorContent({ message });
        }
      },
    );
    mcpTools.push(notifyTeamTool);
  }

  // --- Peer collaboration: send_agent_message ---
  // Sends a message to another agent in the workspace. Connected coding
  // tools are not addressable: the platform refuses an mcp_tokens recipient,
  // because nothing can ever read a message delivered to one.
  // sender_id is derived from agentId (the running agent's ID), never from tool params.
  if (platformBackendUrl && platformCallbackToken) {
    const sendAgentMessageShape = {
      recipientAgentId: z.string().describe('The ID of the recipient agent (from find_teammates)'),
      content: z.string().max(51200).describe('The message content'),
      metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata'),
    };
    modelTools.push({
      name: 'send_agent_message',
      description: 'Send a message or request to another agent. Use read_agent_messages to check for their reply.',
      categories: [],
      effect: 'write',
      inputSchema: z.object(sendAgentMessageShape),
    });

    const sendAgentMessageTool = tool(
      'send_agent_message',
      'Send a message or request to another agent. Use read_agent_messages to check for their reply.',
      sendAgentMessageShape,
      async (args: { recipientAgentId: string; content: string; metadata?: Record<string, unknown> }) => {
        try {
          const response = await fetch(`${platformBackendUrl}/api/internal/platform-tools/send-agent-message`, {
            method: 'POST',
            headers: {
              'X-Service-Auth': platformCallbackToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              tenantId,
              senderAgentId: agentId,   // always from runtime context, never params
              recipientAgentId: args.recipientAgentId,
              content: args.content,
              metadata: args.metadata ?? {},
              // Server-owned taint: stamp the SENDING run's live trust onto the
              // message so the recipient's run upgrades when it reads this.
              originTrust: trustRef?.current ?? 'trusted',
            }),
            signal: AbortSignal.timeout(10000),
          });

          if (!response.ok) {
            const errorText = await readBoundedErrorText(response);
            logger.warn({ status: response.status, errorText, tenantId }, 'send_agent_message callback failed');
            return buildToolErrorContent({ message: platformFailure(response.status, errorText) });
          }

          const data = await response.json();
          recordToolCall('send_agent_message', args, data);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, tenantId }, 'send_agent_message error');
          recordToolCall('send_agent_message', args, null, message);
          return buildToolErrorContent({ message });
        }
      },
    );
    mcpTools.push(sendAgentMessageTool);
  }

  // --- Peer collaboration: read_agent_messages ---
  if (platformBackendUrl && platformCallbackToken) {
    modelTools.push({
      name: 'read_agent_messages',
      description: 'Check for messages sent to you by other agents. Call this at the start of execution and after sending a message to check for a reply.',
      categories: [],
      // A read, but ALSO the taint producer: when it returns a message whose
      // origin_trust is untrusted_inbound, the run upgrades to untrusted_inbound.
      effect: 'read',
    });

    const readAgentMessagesTool = tool(
      'read_agent_messages',
      'Check for messages sent to you by other agents. Call this at the start of execution and after sending a message to check for a reply.',
      {
        limit: z.number().int().min(1).max(50).optional().describe('Max messages to return (default 20, max 50)'),
      },
      async (args: { limit?: number }) => {
        // Same-batch barrier: publish this taint-producing read's fetch+upgrade as a
        // promise on the run's TrustRef BEFORE awaiting it, so an effectful call emitted
        // in the same turn waits for the upgrade before its HITL gate classifies it.
        let resolveTaintRead: () => void = () => {};
        if (trustRef) {
          trustRef.pendingTaintRead = new Promise<void>((r) => { resolveTaintRead = r; });
        }
        try {
          const url = `${platformBackendUrl}/api/internal/platform-tools/agent-messages?agentId=${encodeURIComponent(agentId)}&tenantId=${encodeURIComponent(tenantId)}&limit=${args.limit ?? 20}`;
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              'X-Service-Auth': platformCallbackToken,
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(10000),
          });

          if (!response.ok) {
            const errorText = await readBoundedErrorText(response);
            logger.warn({ status: response.status, errorText, tenantId }, 'read_agent_messages callback failed');
            return buildToolErrorContent({ message: platformFailure(response.status, errorText) });
          }

          const data = await response.json();
          // Taint upgrade: if ANY returned message was sent by an untrusted-origin
          // run, this run becomes untrusted_inbound so its subsequent writes gate.
          if (trustRef && messagesCarryUntrustedOrigin(data)) {
            trustRef.current = 'untrusted_inbound';
          }
          recordToolCall('read_agent_messages', args, data);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data) }],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error({ err: error, tenantId }, 'read_agent_messages error');
          recordToolCall('read_agent_messages', args, null, message);
          return buildToolErrorContent({ message });
        } finally {
          // Release any effectful call waiting on this read's upgrade.
          resolveTaintRead();
          if (trustRef) trustRef.pendingTaintRead = undefined;
        }
      },
    );
    mcpTools.push(readAgentMessagesTool);
  }

  // --- Vendor MCP wiring (GitHub, Stripe, Notion, …) ------------------------
  //
  // For each integration whose connector type ships a vendor-hosted MCP server,
  // fetch the MCP URL from connector-service (authoritative registry + per-
  // workspace URL resolution) and the OAuth token via GetCredentials. Emit an
  // SDK-shaped entry keyed by `${type}-${shortId}` so multiple instances of
  // the same type (two GitHub orgs, two Notion workspaces) don't collide.
  //
  // Failures are logged and dropped. A missing token or unreachable RPC for
  // ONE integration must not prevent the rest of the agent from booting —
  // other connectors and the in-process mcpServer stay usable.
  // --- spawn_child_task: orchestrator spawns a child task with optional parent history handoff ---
  if (invocationId) {
    const spawnChildTaskShape = {
      parent_task_id: z.string().describe('Parent task ID — obtain from your execution context'),
      workflow_id: z.string().describe('Workflow ID this child task belongs to'),
      objective: z.string().describe('What the child agent should accomplish'),
      input_data: z.record(z.string(), z.unknown()).optional().describe('Structured data for the child agent'),
      parent_invocation_id: z.string().optional().describe('Parent invocation ID — enables handoff history injection'),
      collapse_history: z.boolean().optional().describe('Prepend a summary of parent conversation history to the child objective'),
    };
    modelTools.push({
      name: 'spawn_child_task',
      description: 'Spawn a child task assigned to a specialist agent. Optionally pass parent conversation history for context.',
      categories: [],
      effect: 'spawn',
      inputSchema: z.object(spawnChildTaskShape),
    });

    const spawnChildTaskTool = tool(
      'spawn_child_task',
      'Spawn a child task in the current workflow for a specialist agent to handle. Optionally include parent context via collapse_history.',
      spawnChildTaskShape,
      async (args: {
        parent_task_id: string;
        workflow_id: string;
        objective: string;
        input_data?: Record<string, unknown>;
        parent_invocation_id?: string;
        collapse_history?: boolean;
      }) => {
        try {
          const { CoordinatorService } = require('../coordinator/service');
          const coordService = new CoordinatorService();
          const childTask = await coordService.spawnChildTask({
            parentTaskId: args.parent_task_id,
            workflowId: args.workflow_id,
            objective: args.objective,
            inputData: args.input_data,
            agentId,
            tenantId,
            parentInvocationId: args.parent_invocation_id ?? invocationId,
            originTrust: trustRef?.current,
            handoffContext: args.collapse_history
              ? { collapseHistory: { enabled: true, maxItems: 50 } }
              : undefined,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, childTaskId: childTask.id }) }],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
            isError: true,
          };
        }
      },
    );
    mcpTools.push(spawnChildTaskTool);

    modelTools.push({
      name: 'spawn_task_graph',
      description:
        'Spawn a graph of child tasks with declared dependencies. Tasks with no dependencies ' +
        'run in parallel immediately; tasks with dependencies wait for their upstream tasks to ' +
        'complete and receive their results in inputData._dependencyResults. ' +
        'Use when you have multiple sub-tasks that have a clear ordering. ' +
        'Use spawn_child_task instead for single, isolated children.',
      categories: [],
      effect: 'spawn',
    });

    const spawnTaskGraphTool = tool(
      'spawn_task_graph',
      'Spawn a graph of child tasks with declared dependencies. Returns results in declaration order.',
      {
        tasks: z.array(z.object({
          id: z.string(), objective: z.string(),
          depends_on: z.array(z.string()).optional(),
          input_data: z.record(z.string(), z.unknown()).optional(),
          executor_agent_id: z.string().uuid().optional(),
        })).min(1).max(50),
        mode: z.enum(['sync', 'async']).optional().describe("'sync' blocks for results (<~4 min total); 'async' runs in the background and resumes you with results (large/long fan-out)."),
        graph_timeout_ms: z.number().int().min(10_000).max(2 * 60 * 60 * 1000).optional(),
      },
      async (args) => {
        // Local error helper — matches the tool-result error shape used across this file.
        const toolErr = (message: string) => ({
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
          isError: true,
        });
        const parentTaskId = randomUUID();          // runtime-injected grouping key (Gap-2)
        const workflowId  = randomUUID();
        const isAsync = args.mode === 'async';
        // Gap-16: async only for autonomous runs.
        if (isAsync && triggeredBy === 'human') return toolErr('async delegation is not available in chat; use mode:sync');
        // Gap-4: sync graphs must fit the parent's ~270s budget. Reject an explicit
        // over-budget request with a clear "use async" nudge, AND hard-clamp the
        // effective timeout so an unset value can't silently fall back to the 30-min
        // default and blow the parent's request/wall-clock budget across levels.
        const SYNC_BUDGET_MS = 240_000;
        if (!isAsync && (args.graph_timeout_ms ?? 0) > SYNC_BUDGET_MS) return toolErr('graph too long for sync; use mode:async');
        const graphTimeoutMs = isAsync
          ? args.graph_timeout_ms
          : Math.min(args.graph_timeout_ms ?? SYNC_BUDGET_MS, SYNC_BUDGET_MS);
        // snake_case → camelCase TaskNode shape the coordinator expects.
        const mappedTasks = args.tasks.map((t: { id: string; objective: string; depends_on?: string[]; input_data?: Record<string, unknown>; executor_agent_id?: string }) => ({
          id: t.id, objective: t.objective, dependsOn: t.depends_on, inputData: t.input_data, executorAgentId: t.executor_agent_id,
        }));
        const coord = new (require('../coordinator/service').CoordinatorService)();
        // parent_task_id/workflow_id are free UUIDs (migration 305 dropped the child_tasks FKs) — no anchor row needed.
        const gInput = { parentTaskId, workflowId, agentId, tenantId, parentInvocationId: invocationId, hitlLevel, tasks: mappedTasks, graphTimeoutMs, originTrust: trustRef?.current };
        if (isAsync) {
          // Dispatch dep-free nodes now; deeper levels advance via checkChildTasksCompletion.
          const { childTaskIds } = await coord.dispatchGraphAsync(gInput);
          const deadlineAt = new Date(Date.now() + (args.graph_timeout_ms ?? 30 * 60 * 1000)).toISOString();
          // Return a normal tool result whose content carries the pause marker.
          // Each adapter's extractDelegationPending() reads it and attaches the
          // tool_use callId (which only the adapter knows) before pausing.
          return { content: [{ type: 'text' as const, text: JSON.stringify({ __delegationPending: { parentTaskId, childTaskIds, deadlineAt } }) }], isError: false };
        }
        const result = await coord.executeTaskGraph(gInput);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: false };
      },
    );
    mcpTools.push(spawnTaskGraphTool);
  }

  // ── Self-wake tools. Validate + return the {__wakePending} marker; the adapter detects
  //    it and pauses (createWakePause owns the durable row + trigger). cancel_wake is a DIRECT action.
  //    Gated on SELF_WAKE_ENABLED; per-agent availability is also governed by the distilled allowedTools.
  if (process.env.SELF_WAKE_ENABLED === 'true') {
    // Server-owned allowlist of system_event topics an agent may wake on. Operator-vetted via
    // WAKE_ALLOWED_SYSTEM_TOPICS (comma-separated, server env — never model-provided); empty default =
    // none, so a topic must be explicitly vetted before agents can wait on it. Connector events are
    // gated separately by the agent's own integrations at arm time (below).
    const WAKE_ALLOWED_SYSTEM_TOPICS = new Set<string>(
      (process.env.WAKE_ALLOWED_SYSTEM_TOPICS ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    );
    const wakeMarker = (spec: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ __wakePending: {
        // wakeChainDepth is stamped to 0 here; createWakePause increments it from the resuming run's
        // depth so event/job self-wake loops are bounded. originSurface is left undefined
        // settlement derives the channel from the PB thread; autonomous runs have no thread.
        spec, originTrust: trustRef?.current ?? 'trusted', wakeChainDepth: 0,
      } }) }],
      isError: false,
    });
    const wakeErr = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true });
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

    // A model-chosen `label` (optional) is the stable handle the agent passes to cancel_wake — it is
    // the only way the agent can name a wake it created (the invocationId is server-side). Bounded.
    const labelField = z.string().max(120).optional().describe('Optional stable name; pass the same value to cancel_wake to cancel this wake.');
    const cleanLabel = (l?: string) => { const s = (l ?? '').trim().slice(0, 120); return s.length ? s : undefined; };

    // Authorize a connector/system event source: computed_metric is rejected (use a poll); a system
    // topic must be operator-vetted; a connector must be in THIS agent's integrations (matched the way
    // the subscription-router matches inbound events — by type/alias/UUID) and, when the integration
    // pins entity types, entityType must be one of them. Returns an error string, or null when allowed.
    const authorizeEventSource = (src: { kind?: string; connectorRef?: string; entityType?: string; topic?: string }): string | null => {
      if (src?.kind === 'computed_metric') return 'computed_metric is not allowed; use wake_on_poll';
      if (src?.kind === 'system_event') {
        return WAKE_ALLOWED_SYSTEM_TOPICS.has(String(src.topic)) ? null : `system topic not allowed: ${src.topic}`;
      }
      if (src?.kind === 'connector_event') {
        if (!src.connectorRef) return 'connector_event requires connectorRef';
        const authorizedRefs = new Set<string>([
          ...(allowedConnectors ?? []),
          ...((integrations ?? []).flatMap((i) => [i.id, i.type].filter(Boolean) as string[])),
        ]);
        if (!authorizedRefs.has(src.connectorRef)) return `connector not in this agent's integrations: ${src.connectorRef}`;
        const match = (integrations ?? []).find((i) => i.id === src.connectorRef || i.type === src.connectorRef);
        const pinned = match?.selectedObjects ?? [];
        if (src.entityType && pinned.length > 0 && !pinned.includes(src.entityType)) {
          return `entityType not supported by ${src.connectorRef}: ${src.entityType}`;
        }
        return null;
      }
      return 'unsupported source kind';
    };

    // Validate + normalize ONE wait-set member condition into a wake condition spec. Same checks the
    // standalone tools apply (source authz, predicate validation, bounds). Returns {spec} or {error}.
    const normalizeCondition = (cond: Record<string, unknown>): { spec?: Record<string, unknown>; error?: string } => {
      const kind = String(cond.kind ?? '');
      if (kind === 'timer') {
        const at = new Date(String(cond.at ?? ''));
        if (Number.isNaN(at.getTime())) return { error: 'timer condition: `at` is not valid ISO-8601' };
        const d = at.getTime() - Date.now();
        if (d < 60_000 || d > 30 * 24 * 3600_000) return { error: 'timer condition: `at` must be 60s..30d ahead' };
        return { spec: { kind: 'timer', firesAt: at.toISOString(), note: String(cond.note ?? '') } };
      }
      if (kind === 'event') {
        const err = authorizeEventSource(cond.source as { kind?: string; connectorRef?: string; entityType?: string; topic?: string });
        if (err) return { error: `event condition: ${err}` };
        try { validatePredicate(cond.filter as unknown as PredicateExpr); }
        catch (e) { return { error: `event condition: invalid filter — ${(e as Error).message}` }; }
        return { spec: { kind: 'event', source: cond.source, filter: cond.filter, ttlSeconds: Number(cond.ttl_seconds ?? 7 * 24 * 3600), note: String(cond.note ?? '') } };
      }
      if (kind === 'job') {
        if (!cond.invocation_id) return { error: 'job condition: invocation_id required' };
        return { spec: { kind: 'job', childInvocationId: String(cond.invocation_id), ttlSeconds: Number(cond.ttl_seconds ?? 7 * 24 * 3600), note: String(cond.note ?? '') } };
      }
      if (kind === 'poll') {
        try { validatePredicate(cond.until as unknown as PredicateExpr); }
        catch (e) { return { error: `poll condition: invalid until — ${(e as Error).message}` }; }
        return { spec: { kind: 'poll', checkTool: String(cond.check_tool ?? ''), checkArgs: (cond.check_args as Record<string, unknown>) ?? {}, until: cond.until, intervalSeconds: clamp(Number(cond.interval_seconds ?? 60), 60, 24 * 3600), maxAttempts: clamp(Number(cond.max_attempts ?? 1), 1, 100), note: String(cond.note ?? '') } };
      }
      return { error: `unsupported condition kind: ${kind || '(missing)'}` };
    };

    modelTools.push({ name: 'sleep_until', description: 'Suspend this run and resume at an ISO-8601 time (60s..30d ahead). For clock waits; use wake_on_event / wake_on_job to wait on a condition. For calendar-anchored waits (a time of day, a weekday) compute `at` in the person\'s timezone with an explicit UTC offset — and re-compute it fresh on each recurrence rather than chaining fixed 24h sleeps, which drift across DST. One wait per purpose: cancel_wake + a new sleep replaces a schedule; never stack overlapping waits for the same follow-up.', categories: [], effect: 'spawn' });
    mcpTools.push(tool('sleep_until', 'Suspend and resume at an ISO time.', {
      at: z.string().describe('ISO-8601 timestamp to resume at (60s..30d ahead).'),
      note: z.string().max(2000).optional().describe('Continuation intent, replayed on resume.'),
      label: labelField,
    }, async (args: { at: string; note?: string; label?: string }) => {
      const at = new Date(args.at);
      if (Number.isNaN(at.getTime())) return wakeErr('sleep_until: `at` is not valid ISO-8601');
      const deltaMs = at.getTime() - Date.now();
      if (deltaMs < 60_000 || deltaMs > 30 * 24 * 3600_000) return wakeErr('sleep_until: `at` must be 60s..30d ahead');
      return wakeMarker({ kind: 'timer', firesAt: at.toISOString(), note: args.note ?? '', label: cleanLabel(args.label) });
    }));

    modelTools.push({ name: 'wake_on_event', description: 'Suspend and resume when a connector/system event matches a filter. Bind to a stable id (e.g. a deploy id). computed_metric sources are not allowed — use wake_on_poll.', categories: [], effect: 'spawn' });
    mcpTools.push(tool('wake_on_event', 'Suspend and resume on a matching event.', {
      source: z.record(z.string(), z.unknown()).describe('SubscriptionSource: {kind:"connector_event",connectorRef,entityType?} or {kind:"system_event",topic}.'),
      filter: z.record(z.string(), z.unknown()).describe('PredicateExpr, e.g. {op:"eq",path:"deploy.id",value:"123"}.'),
      ttl_seconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
      note: z.string().max(2000).optional(),
      label: labelField,
    }, async (args: { source: Record<string, unknown>; filter: Record<string, unknown>; ttl_seconds?: number; note?: string; label?: string }) => {
      const authzErr = authorizeEventSource(args.source as { kind?: string; connectorRef?: string; entityType?: string; topic?: string });
      if (authzErr) return wakeErr(`wake_on_event: ${authzErr}`);
      try { validatePredicate(args.filter as unknown as PredicateExpr); }
      catch (e) { return wakeErr(`wake_on_event: invalid filter — ${(e as Error).message}`); }
      return wakeMarker({ kind: 'event', source: args.source, filter: args.filter, ttlSeconds: args.ttl_seconds ?? 7 * 24 * 3600, note: args.note ?? '', label: cleanLabel(args.label) });
    }));

    modelTools.push({ name: 'wake_on_job', description: 'Suspend and resume when a child invocation you spawned completes.', categories: [], effect: 'spawn' });
    mcpTools.push(tool('wake_on_job', 'Suspend and resume when a child completes.', {
      invocation_id: z.string().describe('The child invocation id to wait on.'),
      ttl_seconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
      note: z.string().max(2000).optional(),
      label: labelField,
    }, async (args: { invocation_id: string; ttl_seconds?: number; note?: string; label?: string }) =>
      wakeMarker({ kind: 'job', childInvocationId: args.invocation_id, ttlSeconds: args.ttl_seconds ?? 7 * 24 * 3600, note: args.note ?? '', label: cleanLabel(args.label) })));

    modelTools.push({ name: 'wake_on_poll', description: 'Suspend and re-check a read-only tool on an interval until a condition holds or attempts run out (no push source).', categories: [], effect: 'spawn' });
    mcpTools.push(tool('wake_on_poll', 'Suspend and poll a read-only check until it matches.', {
      check_tool: z.string(),
      check_args: z.record(z.string(), z.unknown()).optional(),
      until: z.record(z.string(), z.unknown()).describe('PredicateExpr on the check result.'),
      interval_seconds: z.number().int().min(60).max(24 * 3600),
      max_attempts: z.number().int().min(1).max(100),
      note: z.string().max(2000).optional(),
      label: labelField,
    }, async (args: { check_tool: string; check_args?: Record<string, unknown>; until: Record<string, unknown>; interval_seconds: number; max_attempts: number; note?: string; label?: string }) => {
      try { validatePredicate(args.until as unknown as PredicateExpr); }
      catch (e) { return wakeErr(`wake_on_poll: invalid until — ${(e as Error).message}`); }
      return wakeMarker({ kind: 'poll', checkTool: args.check_tool, checkArgs: args.check_args ?? {}, until: args.until, intervalSeconds: clamp(args.interval_seconds, 60, 24 * 3600), maxAttempts: clamp(args.max_attempts, 1, 100), note: args.note ?? '', label: cleanLabel(args.label) });
    }));

    // wake_on_any / wake_on_all: suspend on a SET of conditions. Each condition is a
    // {kind:'timer'|'event'|'job'|'poll', ...} object using the same fields as the single-wake tools.
    const conditionsField = z.array(z.record(z.string(), z.unknown())).min(1).max(10)
      .describe('1..10 conditions, each {kind:"timer"|"event"|"job"|"poll", ...} with the same fields as the matching single tool.');
    const buildWaitSet = (mode: 'any' | 'all') =>
      async (args: { conditions: Array<Record<string, unknown>>; note?: string; label?: string }) => {
        const specs: Record<string, unknown>[] = [];
        for (const cond of args.conditions) {
          const { spec, error } = normalizeCondition(cond);
          if (error) return wakeErr(`wake_on_${mode}: ${error}`);
          specs.push(spec!);
        }
        return wakeMarker({ kind: 'waitset', mode, conditions: specs, note: args.note ?? '', label: cleanLabel(args.label) });
      };

    modelTools.push({ name: 'wake_on_any', description: 'Suspend and resume when ANY of several conditions fires first (the others are cancelled). Conditions are timer/event/job/poll.', categories: [], effect: 'spawn' });
    mcpTools.push(tool('wake_on_any', 'Suspend and resume on the first of several conditions.', {
      conditions: conditionsField, note: z.string().max(2000).optional(), label: labelField,
    }, buildWaitSet('any')));

    modelTools.push({ name: 'wake_on_all', description: 'Suspend and resume once ALL of several conditions have fired. Conditions are timer/event/job/poll.', categories: [], effect: 'spawn' });
    mcpTools.push(tool('wake_on_all', 'Suspend and resume once every listed condition has fired.', {
      conditions: conditionsField, note: z.string().max(2000).optional(), label: labelField,
    }, buildWaitSet('all')));

    modelTools.push({ name: 'cancel_wake', description: 'Cancel a pending wake you created earlier. Pass the `label` you gave it (preferred), or its raw context_ref.', categories: [], effect: 'write' });
    mcpTools.push(tool('cancel_wake', 'Cancel a pending wake by label (or context_ref).', {
      label: z.string().max(120).optional().describe('The label you passed when creating the wake.'),
      context_ref: z.string().optional().describe('Raw context_ref (alternative to label).'),
    }, async (args: { label?: string; context_ref?: string }) => {
      const label = (args.label ?? '').trim().slice(0, 120);
      const raw = (args.context_ref ?? '').trim();
      if (!label && !raw) return wakeErr('cancel_wake: provide `label` or `context_ref`');
      const { agentScheduledInvocationsRepo } = await import('../scheduling/agent-scheduled-invocations-repo');
      const { wakeWaitSetRepo } = await import('../scheduling/wake-wait-set-repo');
      let cancelled = false;
      // A labelled wake's context_ref is deterministic: wake:<agentId>:label:<label> for a single wake,
      // waitset:<agentId>:label:<label> for a wait-set. Try both (and cancel the set's members).
      if (label) {
        if (await agentScheduledInvocationsRepo.cancelWakeByContextRef(tenantId, agentId, `wake:${agentId}:label:${label}`)) cancelled = true;
        const wsId = await wakeWaitSetRepo.cancelByContextRef(tenantId, agentId, `waitset:${agentId}:label:${label}`);
        if (wsId) { cancelled = true; await agentScheduledInvocationsRepo.cancelWaitSetMembers(wsId); }
      } else if (raw.startsWith('waitset:')) {
        const wsId = await wakeWaitSetRepo.cancelByContextRef(tenantId, agentId, raw);
        if (wsId) { cancelled = true; await agentScheduledInvocationsRepo.cancelWaitSetMembers(wsId); }
      } else {
        cancelled = await agentScheduledInvocationsRepo.cancelWakeByContextRef(tenantId, agentId, raw);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ cancelled }) }], isError: false };
    }));
  }

  // --- delegate_to_agent: inline synchronous delegation to a specialist agent ---
  //
  // Registered ONLY when this agent has at least one eligible teammate, and the
  // destination is an enum over that roster rather than a free-form string. The
  // model can no longer name an arbitrary agent id: a paused, archived or
  // cross-tenant team is not in the enum, so it is not a candidate. Previously
  // `agent_id` was `z.string()` and the only thing standing between the model
  // and a paused team was a lookup that checked existence but not lifecycle.
  //
  // Declared outside the block and returned to the caller: the chat turn
  // needs the same label -> id resolution to attribute a hand-over, and
  // building it twice would be two rosters that can disagree.
  const delegateIdByLabel = new Map<string, string>();
  if (delegationRoster.length > 0) {
    // Teammates are chosen BY NAME, not by id.
    //
    // The enum is what keeps a paused or archived team from being named at all,
    // and that part must not change. But its values were the raw UUIDs, and a
    // model asked to reproduce a UUID exactly does it unreliably: it can emit
    // something outside the enum AND drop `objective` trying to satisfy the
    // schema, which fails MCP validation, raises a tool_call_error anomaly, and
    // escalates the whole run. A hard schema
    // rejection is the worst possible failure mode here because the model
    // cannot see why it was wrong or correct itself from it.
    //
    // Names are what the model actually knows from its prompt, so it can
    // produce one reliably. Duplicates are disambiguated with a short id
    // suffix, the same convention the per-teammate internal__<alias>__execute
    // tools already use — team names are not unique per tenant.
    const nameCounts = new Map<string, number>();
    for (const a of delegationRoster) {
      nameCounts.set(a.name, (nameCounts.get(a.name) ?? 0) + 1);
    }
    /** Model-facing label -> the runtime agent id it resolves to. */
    const rosterByLabel = delegateIdByLabel;
    for (const a of delegationRoster) {
      const label = (nameCounts.get(a.name) ?? 0) > 1
        ? `${a.name} (${a.id.slice(0, 8)})`
        : a.name;
      rosterByLabel.set(label, a.id);
    }
    const rosterLabels = [...rosterByLabel.keys()] as [string, ...string[]];
    /** What each teammate is FOR, so the choice is made on remit rather than on
     *  a name that happens to echo the request. A roster listed by title alone
     *  makes "delegate to the one whose title matches the task" the obvious
     *  move, which is exactly wrong when the matching title is the caller's
     *  own. Falls back to the name when an agent carries no role. */
    const rosterCatalogue = delegationRoster
      .map((a) => {
        const label = (nameCounts.get(a.name) ?? 0) > 1
          ? `${a.name} (${a.id.slice(0, 8)})`
          : a.name;
        const remit = a.role && a.role.trim() && a.role.trim() !== a.name
          ? a.role.trim()
          : 'no stated remit';
        return `${label} — ${remit}`;
      })
      .join('; ');

    const delegateToAgentShape = {
      teammate: z
        .enum(rosterLabels)
        .describe(
          'Which teammate to hand this to, by name. Choose on REMIT, not on whose title '
          + 'resembles the request: a teammate whose remit matches yours is a duplicate of '
          + `you, not a specialist. Available: ${rosterCatalogue}`,
        ),
      objective: z.string().describe('Clear, specific question or task for the specialist'),
      input_data: z.record(z.string(), z.unknown()).optional().describe('Additional structured data for the specialist'),
    };
    modelTools.push({
      source: 'internal_agent',
      name: 'delegate_to_agent',
      description: 'Hand a task to a teammate ONLY when it needs a capability you do not have. If the work is within your own role, do it yourself.',
      categories: [],
      effect: 'spawn',
      inputSchema: z.object(delegateToAgentShape),
    });

    const delegateToAgentTool = tool(
      'delegate_to_agent',
      'Hand a task to a teammate and receive a structured answer. The teammate runs inline — no separate workflow or task is created.\n\nWHEN TO USE THIS: only when the work needs a capability you do not have. You were built for a specific role, and your instructions and workflow describe what that role covers. If the request is inside it, do the work yourself — handing your own job to someone else wastes a full run and returns you nothing you could not have produced. A teammate whose role reads like yours is not a specialist for your work; they are a duplicate of you, and delegating to them is a loop, not a hand-off. Use find_teammates first when you are unsure who covers the gap.\n\nName the teammate exactly as listed in the `teammate` options; a team that is paused or archived is not listed and cannot be reached. If the teammate hits errors mid-run, the result is JSON with an `anomalies` array (each: kind + context) describing what went wrong, so you can decide whether to retry, adjust, or report back.',
      delegateToAgentShape,
      async (args: { teammate: string; objective: string; input_data?: Record<string, unknown> }) => {
        try {
          const { agentExecutionService } = require('../agent-execution/service');
          // The enum guarantees a known label, so this lookup cannot miss. It
          // is the resolution step that carries the governance property: the
          // map was built from the ACTIVE-only roster, so there is no label
          // that resolves to a paused team.
          const targetAgentId = rosterByLabel.get(args.teammate)!;
          const result = await agentExecutionService.delegateToAgent({
            agentId: targetAgentId,
            tenantId,
            objective: args.objective,
            inputData: args.input_data,
            parentInvocationId: invocationId,
            parentTrustLevel: trustRef?.current,
            // This tool's own description promises a structured answer, so it
            // waits. The bounded wait is the contract here, not an oversight.
            collect: true,
          });
          // Surface child anomalies to the parent so they aren't silently swallowed.
          const anomalies = (result.anomalies ?? []) as Array<{ kind: string; context: unknown }>;
          const text = anomalies.length > 0
            ? JSON.stringify({ output: result.output || '(no output)', anomalies })
            : (result.output || '(no output)');
          return {
            content: [{ type: 'text' as const, text }],
            isError: anomalies.length > 0,
          };
        } catch (error) {
          // A pause is not a failure, and it must not round back into failure
          // prose — that indistinguishability was the original defect. The
          // parent gets a STRUCTURED result naming the fact, so its report to
          // the person says "waiting on an approval", not "the specialist did
          // not answer".
          //
          // isError is FALSE, deliberately. Every isError result is routed to
          // the adapter's anomaly handler as `tool_call_error`, which spends a
          // recovery-LLM turn and can escalate the whole run — so marking a
          // routine approval pause as an error would escalate the parent every
          // time somebody's team needed a decision. It also matches the
          // convention already in this codebase: the async pause markers
          // (__delegationPending / __wakePending) are read only from SUCCESS
          // results, because a pause means the tool did its job and the work
          // continues elsewhere.
          //
          // The delegation_paused flag is what the streaming layer keys on to
          // surface the status row and the way to the review queue; the
          // adapter forwards tool results verbatim either way.
          const { DelegationChildPausedError } = require('../agent-execution/governed-dispatch');
          if (error instanceof DelegationChildPausedError) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  delegation_paused: true,
                  approval_id: error.approvalId ?? null,
                  child_invocation_id: error.childInvocationId,
                  child_agent_id: error.childAgentId,
                  reason: error.message,
                  note: 'The teammate stopped for a human approval and will continue once it is decided. Tell the user their team is waiting on an approval in the review queue. Do not retry this delegation; the same approval would be required again.',
                }),
              }],
              isError: false,
            };
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
            isError: true,
          };
        }
      },
    );
    mcpTools.push(delegateToAgentTool);
  }

  // --- task_ledger_write: the agent's standing worklist (§4.9 Part B) ---------
  const taskLedgerWriteShape = {
    items: z.array(z.object({
      seq: z.number().int().describe('Stable position in your worklist'),
      text: z.string().describe('What this item is'),
      status: z.enum(['pending', 'in_progress', 'done', 'abandoned']),
      note: z.string().optional().describe('Short freeform context'),
    })).min(1).max(100),
  };
  modelTools.push({
    name: 'task_ledger_write',
    description:
      'Maintain a durable, ordered checklist that survives across steps AND across '
      + 'future triggers (it is YOUR standing worklist, not tied to this conversation). '
      + 'Use ONLY for multi-step or multi-session work (e.g. "process 200 records", a '
      + '6-step migration). For a single action, do NOT use this — just do it and finish. '
      + 'Upsert by seq; mark items in_progress / done as you go.',
    categories: [],
    effect: 'write',
    inputSchema: z.object(taskLedgerWriteShape),
  });
  const taskLedgerWriteTool = tool(
    'task_ledger_write',
    'Upsert ordered items in your standing worklist (survives across triggers).',
    taskLedgerWriteShape,
    async (args: { items: Array<{ seq: number; text: string; status: 'pending' | 'in_progress' | 'done' | 'abandoned'; note?: string }> }) => {
      try {
        const { writeTaskLedger } = await import('../agent-execution/task-ledger/service');
        await writeTaskLedger({ tenantId, agentId, items: args.items });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, written: args.items.length }) }], isError: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }], isError: true };
      }
    },
  );
  mcpTools.push(taskLedgerWriteTool);

  // --- report_task_outcome: the agent's terminal verdict on THIS run ---------
  // Registered ONLY when the system prompt carries the matching contract, so a
  // chat turn (which builds its own prompt and branches on execResult.success)
  // can never have a stray 'fail' report turn a normal reply into an error.
  if (terminalOutcomeContract) {
    const reportTaskOutcomeShape = {
      status: z.enum(['complete', 'fail', 'escalate'])
        .describe('complete = objective met; fail = cannot be done and no human action would change that; escalate = a human must act'),
      summary: z.string().max(2000)
        .describe('One line: what was accomplished, or precisely why not'),
      // "A human must act" was one audience covering two. The customer cannot
      // fix a connector-id mismatch or an unreachable provider, and a queue of
      // things they cannot act on teaches them to ignore the ones they can.
      whoCanUnblock: z.enum(['customer', 'platform']).optional()
        .describe(
          'status=escalate only, REQUIRED then. customer = someone in this workspace can '
          + 'clear it (grant access, unpause an agent, choose between options, supply a value). '
          + 'platform = only Liftoff can (a connector or tool is misconfigured or '
          + 'broken, a provider is unreachable, an internal error). If unsure, say platform.',
        ),
      requestedAction: z.string().max(500).optional()
        .describe(
          'status=escalate only, REQUIRED then: the single thing that person should do, '
          + 'written to them. "Share the sheet with the service account", not "permission error".',
        ),
    };
    modelTools.push({
      name: 'report_task_outcome',
      description:
        'Report the outcome of this run as your FINAL action, exactly once. '
        + 'Call it even when you failed — a run with no report is recorded as an engine failure.',
      categories: [],
      // 'read', not 'write': this tool mutates nothing — the value is the
      // captured INPUT, read off the adapter event stream, and the handler is a
      // pure ack. The untrusted-inbound gate gates any effect that is not
      // 'read' (effectPassesUngated), so 'write' here would put the agent's own
      // outcome report behind a HITL approval and pause the run.
      effect: 'read',
      inputSchema: z.object(reportTaskOutcomeShape),
    });
    const reportTaskOutcomeTool = tool(
      'report_task_outcome',
      "Report this run's outcome (complete | fail | escalate) as your final action.",
      reportTaskOutcomeShape,
      async (args: { status: 'complete' | 'fail' | 'escalate'; summary: string }) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, recorded: args.status }) }],
        isError: false,
      }),
      // Never deferred behind tool search. The SDK defers large MCP catalogs
      // (a live run can defer a hundred tools), which would make the
      // terminal contract depend on the model running a ToolSearch first.
      // `isAlwaysLoadedTool` names it too, so the telemetry counts what the
      // model is guaranteed to see without re-deriving this list.
      { alwaysLoad: true },
    );
    mcpTools.push(reportTaskOutcomeTool);
  }

  // --- record_step_output: this workflow STEP's declared result --------------
  //
  // Registered ONLY for a step that declares `outputField`, on the same rule as
  // report_task_outcome above: the tool exists exactly where the prompt carries
  // the matching contract.
  //
  // Why a tool and not responseSchema: responseSchema REPLACES the tools array
  // on the Anthropic providers (the reasoning already recorded for
  // RECOVERY_DECISION_TOOL_DEF), and an llm_reason step is not a pure judgment
  // turn — it does real work with its catalog. A support agent's reply step can
  // send the customer reply from inside one. Stripping the catalog to collect a value would break the
  // step it is meant to complete.
  //
  // The value is the captured INPUT, read off the adapter event stream by
  // readStepOutputReport. The handler is a pure ack; nothing here writes.
  if (stepOutputField) {
    // The step's outputField is a dot-path; the tool asks for the ROOT object
    // that path is read from, and getByPath walks the remainder. A step
    // declaring `customer.email` records `{customer: {...}}`.
    const stepOutputRoot = stepOutputField.split('.')[0];
    // `z.unknown()` let a bare string satisfy a contract whose readers all
    // address keys, so a step could record `task: "fix the lint error"` and
    // every downstream read silently resolved to undefined. When the graph
    // says keys are read, the value is an OBJECT by definition — enforce that
    // much, and name the keys so the model does not have to infer them from a
    // description written elsewhere.
    const reads = stepOutputReads ?? [];
    // An ITERATED key is required to be an array HERE, at the only boundary
    // that can refuse it.
    //
    // A loop reading a key that is null, absent or an object does not fail: it
    // runs its body zero times and the step reports having iterated. The breach
    // surfaces as the CONSUMER's failure, several steps later, with the material
    // that would have fixed it long gone — see step-output-keys.ts for the
    // battle-card step that wrote no cards this way. Refusing the recording
    // instead puts the error in front of the model that can still correct it, on
    // the turn that produced it, and `[]` satisfies it whenever there is
    // genuinely nothing.
    const iterated = reads.filter((r) => r.iterated);
    const shapeDescription = reads.length > 0
      ? `The step's result, as the "${stepOutputRoot}" value the next step reads. `
        + `It MUST be an object containing these keys, read from inside it by later steps: `
        + `${reads.map((r) => `"${r.key}"`).join(', ')}. A key you cannot determine must still `
        + `be present, set to null.`
        + describeIteratedKeys(iterated)
      : `The step's result, as the "${stepOutputRoot}" value the next step reads.`;
    const recordStepOutputShape = {
      [stepOutputRoot]: (reads.length > 0
        ? z.object(Object.fromEntries(
          iterated.map((r) => [
            r.key,
            z.array(z.unknown()).describe(
              `Iterated item by item by a later step, so it must be an array — `
              + `empty when there is nothing, never null.`,
            ),
          ]),
        )).passthrough()
        : z.unknown()
      ).describe(shapeDescription),
    };
    modelTools.push({
      name: STEP_OUTPUT_TOOL,
      description:
        `Record this step's result as your FINAL action, exactly once, under the key `
        + `"${stepOutputRoot}". The next step reads it; a step that never calls this fails `
        + `its output contract.`
        + (reads.length > 0
          ? ` "${stepOutputRoot}" must be an object holding: ${reads.map((r) => `"${r.key}"`).join(', ')}.`
            + describeIteratedKeys(iterated)
          : ''),
      categories: [],
      // 'read' for the same reason report_task_outcome is: the tool mutates
      // nothing, and any effect other than 'read' fails effectPassesUngated on
      // an untrusted_inbound run — which would put the step's own result behind
      // a HITL approval and pause the run. An inbound customer email is exactly
      // such a run.
      effect: 'read',
      inputSchema: z.object(recordStepOutputShape),
    });
    const recordStepOutputTool = tool(
      STEP_OUTPUT_TOOL,
      `Record this step's result under "${stepOutputRoot}" as your final action.`,
      recordStepOutputShape,
      async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, recorded: stepOutputRoot }) }],
        isError: false,
      }),
      // Never deferred behind tool search, for the same measured reason
      // report_task_outcome is not: the SDK defers large MCP catalogs (a live
      // run can defer a hundred tools), and a contract the model must satisfy
      // cannot depend on it running a ToolSearch first.
      { alwaysLoad: true },
    );
    mcpTools.push(recordStepOutputTool);
  }

  // --- delegate_task: DEPRECATED parallel fan-out variant (Part 5 §E) --------
  //
  // Deprecated now that the governed gate — depth, spawn pause, per-agent
  // capacity, the delegation_active kill-switch row and its interrupt poller —
  // lives on the shared delegateToAgent path, where every entry point gets it.
  // This tool existed because it was the only GOVERNED way to delegate; that
  // reason has evaporated. Parallel work is recovered by the model issuing
  // several delegate_to_agent calls in one turn, each individually governed.
  //
  // Its description also promised "Children cannot delegate recursively", which
  // had been false since the child catalog became the real one — recursion is
  // now actually bounded, by the depth cap, on every path.
  //
  // Registration stays behind the flag for tenants that still have it on —
  // removing a tool from under a resumed session replays a history that
  // references a tool no longer registered. Do not enable it anywhere new;
  // remove outright once the flag is off everywhere.
  if (process.env.DELEGATION_ENABLED === 'true') {
    const delegateTaskShape = {
      tasks: z.array(z.object({
        agent_id: z.string(),
        objective: z.string(),
        context: z.string().optional(),
        max_turns: z.number().int().positive().optional(),
        timeout_ms: z.number().int().positive().optional(),
      })).min(1),
      max_concurrent: z.number().int().positive().optional(),
    };

    modelTools.push({
      source: 'internal_agent',
      name: 'delegate_task',
      description: [
        'Spawn focused subagents in parallel.',
        '',
        'WHEN to delegate: reasoning-heavy subtasks you want isolated from your context, independent parallel workstreams, tasks that would flood your context with intermediate data.',
        'WHEN NOT to delegate: sequential tasks where each step depends on the previous, quick single-tool-call lookups, tasks requiring conversation with the user (children cannot ask the human).',
        '',
        'Subagents have NO memory of your conversation — pass all relevant info via `context` in each task. Subagent summaries are SELF-REPORTS, not verified facts. Delegation depth is capped for children, so a child may hand work on only while the chain is within the workspace cap. Default 16 parallel tasks per call; 8 run concurrently.',
        '',
        'DEPRECATED: prefer several delegate_to_agent calls in one turn — each is individually governed and interruptible.',
      ].join('\n'),
      categories: [],
      effect: 'spawn',
      inputSchema: z.object(delegateTaskShape),
    });

    const delegateTaskTool = tool(
      'delegate_task',
      'Spawn focused subagents in parallel. Returns one result per task with status, summary, usage, and per-child anomalies. Use for independent parallel workstreams; do NOT use for sequential steps or user-conversation flows.',
      delegateTaskShape,
      async (args: { tasks: Array<{ agent_id: string; objective: string; context?: string; max_turns?: number; timeout_ms?: number }>; max_concurrent?: number }) => {
        try {
          const { agentExecutionService } = require('../agent-execution/service');
          const { createHash: createHash2 } = require('crypto');
          const stateRef = agentExecutionService.getActiveExecutionStateRef(invocationId);
          // Per-invocation idempotency key so the same MCP delegate_task call
          // hashed against its args dedupes through event_processing_ledger.
          // The MCP runtime doesn't expose a tool-call id at this scope; using
          // a synthesized toolCallId is fine for stateRef bookkeeping.
          const syntheticToolCallId = `delegate_task:${invocationId}:${createHash2('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)}`;
          const idemKey = syntheticToolCallId;
          const results = await agentExecutionService.delegateToAgents({
            tenantId,
            parentInvocationId: invocationId,
            parentAgentId: agentId,
            parentPurpose: stateRef?.state.context.purpose,
            parentTrustLevel: trustRef?.current,
            tasks: args.tasks.map(t => ({
              agentId: t.agent_id,
              objective: t.objective,
              ...(t.context !== undefined ? { inputData: { context: t.context } } : {}),
              maxTurns: t.max_turns,
              timeoutMs: t.timeout_ms,
            })),
            maxConcurrent: args.max_concurrent,
            idempotencyKey: idemKey,
            ...(stateRef ? { stateRef: { state: stateRef.state, toolCallId: syntheticToolCallId } } : {}),
          });
          const text = JSON.stringify({
            results,
            total_duration_ms: results.reduce((s: number, r: { durationMs: number }) => s + r.durationMs, 0),
          });
          const anyFailed = results.some((r: { status: string }) => r.status !== 'completed');
          return { content: [{ type: 'text' as const, text }], isError: anyFailed };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
            isError: true,
          };
        }
      },
    );
    mcpTools.push(delegateTaskTool);
  }

  // --- code_session: vendor-neutral coding agent (Claude Code / Codex / Gemini) ---
  // Delegates a bounded code task to a vendor-native coding agent in a
  // fresh temp workspace (git clone → run agent → capture diff → cleanup).
  // The runner is selected from input.prefer_provider with the outer
  // agent's resolved provider as the 'auto' default.
  const codeSessionShape = {
    task: z.string().describe('Plain-language task description for the coding agent.'),
    repo: z.string().describe('owner/name (e.g. liftoff/backend). If this agent is bound to more than one version-control host, prefix the host to pick the right one: gitlab.com/group/repo or github.com/owner/repo.'),
    branch: z.string().describe('Branch to work on. If it does not exist on the remote yet it is created from the default branch — e.g. a new feature branch for the PR/MR the agent will open.'),
    // z.coerce: open-weights models (observed live: Qwen) emit numeric args as
    // strings ("180"); a hard z.number() turns that into a tool_call_error
    // anomaly loop instead of a working call.
    timeout_seconds: z.coerce.number().optional().describe('Hard cap on the inner agent (default 600).'),
    allowed_tools: z.array(z.string()).optional().describe('Optional vendor-specific tool whitelist.'),
    prefer_provider: z.enum(['anthropic', 'openai', 'google', 'openrouter', 'auto']).optional()
      .describe("Override which vendor coding SDK runs (default: 'auto' → outer agent's provider). 'openrouter' = the open-weights coder (GLM/Qwen/DeepSeek/Kimi, matched to the workspace vendor)."),
  };
  modelTools.push({
    source: 'sandbox',
    name: 'code_session',
    description:
      'Delegate a bounded code task to a vendor-native coding agent. Provisions a ' +
      'fresh temp workspace, clones the requested repo + branch, runs the coding ' +
      'agent, captures the resulting diff.',
    categories: [],
    effect: 'write',
    inputSchema: z.object(codeSessionShape),
  });
  const codeSessionTool = tool(
    'code_session',
    'Delegate a bounded code task to a vendor-native coding agent (Claude Code / Codex / Gemini). Use for code changes, debugging, multi-step shell + file ops.',
    codeSessionShape,
    async (args: {
      task: string;
      repo: string;
      branch: string;
      timeout_seconds?: number;
      allowed_tools?: string[];
      prefer_provider?: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'auto';
    }) => {
      try {
        const { codeSessionHandler } = await import('../agent-execution/adapter/tools/code-session');
        const outerProvider = resolvedProvider ?? 'anthropic';

        // Resolve the git remote from the agent's bound version-control connector(s):
        // the connector type selects the host (github.com / gitlab.com) and its OAuth
        // token authenticates both the clone and the nested coding agent's push. With
        // no VC binding we clone unauthenticated (public repos only). This is the same
        // GetCredentials RPC the connector tools use, so github and gitlab reach
        // code_session identically.
        //
        // An agent can be bound to MULTIPLE version-control hosts (e.g. a company using
        // both GitHub and GitLab). To route each task to the right host, the repo may
        // carry an explicit host prefix — `github.com/owner/repo` or
        // `gitlab.com/group/repo`. Selection rules:
        //   - host prefix present → use the matching bound connector (error if the
        //     agent isn't bound to that host);
        //   - no prefix, exactly one VC connector bound → use it (backward-compatible);
        //   - no prefix, multiple bound → ask the agent to prefix the host.
        // The prefix is stripped before the owner/name path reaches the clone URL.
        let gitCloneToken: string | undefined;
        let gitProvider: 'github' | 'gitlab' | undefined;
        let repoPath = args.repo;
        // Compare connectorType as a plain string: 'gitlab' is not yet in the shared
        // @liftoffos/connector-types ConnectorType union, though the manifest value
        // (loaded from the DB) is 'gitlab' at runtime.
        const vcManifests = manifests.filter((m) => {
          const t = m.connectorType as string;
          return t === 'github' || t === 'gitlab';
        });
        if (vcManifests.length > 0) {
          const hostMatch = args.repo.match(/^(?:https?:\/\/)?(github\.com|gitlab\.com)\/(.+)$/i);
          const requestedProvider: 'github' | 'gitlab' | undefined = hostMatch
            ? (hostMatch[1].toLowerCase() === 'gitlab.com' ? 'gitlab' : 'github')
            : undefined;
          if (hostMatch) repoPath = hostMatch[2].replace(/\.git$/, '');

          let chosen: (typeof vcManifests)[number] | undefined;
          if (requestedProvider) {
            chosen = vcManifests.find((m) => (m.connectorType as string) === requestedProvider);
            if (!chosen) {
              const bound = vcManifests.map((m) => m.connectorType).join(', ');
              return {
                content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `This agent has no ${requestedProvider} connector bound. Bound version-control host(s): ${bound}.` }) }],
                isError: true,
              };
            }
          } else if (vcManifests.length === 1) {
            chosen = vcManifests[0];
          } else {
            const bound = vcManifests.map((m) => m.connectorType).join(', ');
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `This agent is bound to multiple version-control hosts (${bound}). Prefix the repo with its host so the right one is used, e.g. 'gitlab.com/group/repo' or 'github.com/owner/repo'.` }) }],
              isError: true,
            };
          }

          gitProvider = (chosen.connectorType as string) === 'gitlab' ? 'gitlab' : 'github';
          try {
            const creds = await getConnectorServiceClient().getCredentials({
              tenantContext: { tenantId },
              connectorId: chosen.id,
            });
            gitCloneToken = creds.oauth?.accessToken || undefined;
          } catch (err) {
            logger.warn({
              message: 'code_session git credential fetch failed; cloning unauthenticated',
              connectorType: chosen.connectorType,
              err: (err as Error).message,
            });
          }
        }

        const result = await codeSessionHandler(
          {
            task: args.task,
            repo: repoPath,
            branch: args.branch,
            timeout_seconds: args.timeout_seconds,
            allowed_tools: args.allowed_tools,
            prefer_provider: args.prefer_provider ?? 'auto',
          },
          { tenantId, agentId, invocationId: invocationId ?? '', outerProvider, outerModelId: resolvedModelId, explicitModelId, gitCloneToken, gitProvider },
        );
        recordToolCall('code_session', args as Record<string, unknown>, result);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: result.exit_reason === 'error',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordToolCall('code_session', args as Record<string, unknown>, null, message);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
          isError: true,
        };
      }
    },
    // The PRIMARY code-work entry point on the Anthropic path, where the outer
    // agent has no file or shell tools at all. Deferring it behind a tool search
    // makes every coding run start by looking for the way to do coding.
    // `NEVER_COLLAPSE_SANDBOX_TOOLS` names it for our own tiering; this is the
    // same decision expressed to the SDK.
    { alwaysLoad: true },
  );
  mcpTools.push(codeSessionTool);

  // --- Document tools: per-manifest read/write tools for cloud storage connectors ---
  registerDocumentTools(mcpTools, manifests, { ...stdToolCtx, invocationId }, modelTools);

  // The allowlist, applied to what is REGISTERED. Everything above pushed into
  // `mcpTools` and `modelTools`; from here on only the allowed names exist —
  // the SDK server below is built from `registeredMcpTools`, the bridge reads
  // `registeredModelTools`, the schemas are derived from the same list, and
  // no vendor server is resolved (a vendor-hosted tool is a connector tool,
  // and none is ever on the list). A tool that is not registered cannot be
  // called on any engine, which is the property a display filter lacks.
  const allowed = (name: string): boolean => !toolAllowlist || toolAllowlist.has(name);
  const registeredMcpTools = toolAllowlist ? mcpTools.filter((t) => allowed(t.name)) : mcpTools;
  const registeredModelTools = toolAllowlist ? modelTools.filter((t) => allowed(t.name)) : modelTools;
  if (toolAllowlist) {
    logger.info(
      {
        event: 'tool_catalog_allowlisted',
        tenantId,
        agentId,
        invocationId,
        registered: registeredModelTools.map((t) => t.name),
        withheld: modelTools.length - registeredModelTools.length,
      },
      'tool catalog narrowed to an allowlist at registration',
    );
  }

  const vendorMcpServers = toolAllowlist
    ? {}
    : await resolveVendorMcpServers({
      tenantId,
      integrations: integrations ?? [],
    });

  // A direct read of one workspace file, for the subdirectory-context
  // hints. Built here rather than in the adapters because this is where the
  // gateway, the session identity and the file capability are all already in
  // scope; an adapter reaching for the same thing would have to re-derive them,
  // and the Anthropic engine could not reach the MCP server at all (the Claude
  // Agent SDK holds that instance, and the MCP protocol refuses a second
  // transport on one server).
  //
  // Null when the agent has no filesystem, which is the honest answer for a
  // connector-only agent and is what makes the whole feature scope itself.
  const readWorkspaceFile = sandboxCapabilities?.includes('file')
    ? async (path: string): Promise<string | null> => {
      const result = forModel(await toolGateway.execute({
        tenantId,
        agentId,
        instructionVersion,
        traceId,
        triggerKey,
        idempotencyKey: `${traceId}-context-hint-${path}`,
        connector: 'execution_environment',
        entityType: 'sandbox',
        actionType: 'file_read',
        // Same run identity the sandbox tools resolve to, so a file parked here
        // is one the agent's own tools can open. The trace-id fallback this
        // used to carry put a thread-less run's file in a workspace nothing
        // else addressed.
        threadId,
        invocationId,
        payload: { path, invocationId },
        estimatedCredits: 1,
        _internalSkipHitl: true,
        bindingsByType,
      }), invocationId);
      if (!result.success) return null;
      // The sandbox returns `{ content }` and wraps the body in the untrusted
      // frame. Unwrapping the envelope is this site's job because this is where
      // the shape is known; unwrapping the FRAME is the caller's, because only
      // it knows what to say instead (see renderContextHint).
      const data = result.data;
      if (typeof data === 'string') return data;
      const content = (data as { content?: unknown } | null)?.content;
      return typeof content === 'string' ? content : null;
    }
    : null;

  // The write counterpart, built here for the same three reasons: the gateway,
  // the session identity and the file capability are all in scope, and the
  // Anthropic engine cannot reach the MCP server itself.
  //
  // `_internalSkipHitl` matches the read above and is correct for the same
  // reason: this write is initiated by the platform to park a value the model
  // never asked to store, into the run's own scratch directory. It is not an
  // agent-chosen action, so there is nothing for a human to approve.
  // Retried, because this is the ONE sandbox consumer with no retrying party.
  //
  // sandbox-executor returns `vendor_unavailable` + `retryable: true` +
  // `retryAfterMs` while a workspace is provisioning, deliberately rather than
  // holding the request open ("the caller's own deadline is shorter than a
  // provision"). Every model-facing sandbox tool honours that: mcp-server hands
  // the flags to the model via buildToolErrorContent precisely so "a retryable
  // condition — a workspace still starting — reads identically to a permanent
  // one and gets abandoned".
  //
  // This writer had no such party. It is called by the platform, not the model,
  // so nobody downstream ever saw the flag — `result.success === true` threw it
  // away and the caller degraded to an unparked result. Provisioning takes
  // about a minute and a scheduled run gets a per-run workspace, so the cold
  // window lands on the FIRST oversized result of a run: exactly the one most
  // worth parking, failing for a reason that resolves itself in seconds.
  //
  // Bounded deliberately. Two attempts past the first cover a provision without
  // putting this anywhere near the run's wall clock, and only a `retryable`
  // failure waits — a refusal, a kill switch or a permanent error returns at
  // once, because retrying those burns the budget the parked result exists to
  // protect. Still fail-open: exhausting the retries returns false and
  // result-dataset passes the payload through inline, as before.
  const WRITE_MAX_ATTEMPTS = 3;
  const WRITE_RETRY_CAP_MS = 25_000;

  const writeWorkspaceFile = sandboxCapabilities?.includes('file')
    ? async (path: string, content: string): Promise<boolean> => {
      for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
        const result = forModel(await toolGateway.execute({
          tenantId,
          agentId,
          instructionVersion,
          traceId,
          // Stable across attempts on purpose: a retry of the same park is the
          // same write, and a per-attempt key would defeat the idempotency the
          // gateway uses to collapse them.
          idempotencyKey: `${traceId}-value-offload-${path}`,
          connector: 'execution_environment',
          entityType: 'sandbox',
          actionType: 'file_write',
          threadId,
          invocationId,
          payload: { path, content, invocationId },
          estimatedCredits: 1,
          _internalSkipHitl: true,
          bindingsByType,
        }), invocationId);
        if (result.success === true) return true;

        const last = attempt === WRITE_MAX_ATTEMPTS;
        if (!result.retryable || last) {
          logger.warn({
            tool: 'workspace_write', path, attempt,
            errorCode: result.errorCode, retryable: result.retryable === true,
          }, 'workspace park write failed — result will not be parked');
          return false;
        }

        const waitMs = Math.min(result.retryAfterMs ?? 0, WRITE_RETRY_CAP_MS);
        logger.info({
          tool: 'workspace_write', path, attempt, waitMs, errorCode: result.errorCode,
        }, 'workspace park write retrying — workspace not ready yet');
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }
      return false;
    }
    : null;

  /** The step-replay wrapper, or the identity when this catalog serves no step
   *  that has already run. Named so the tool list below reads as one expression. */
  const withStepReplay = <T extends { name: string; handler: (a: never, e: never) => Promise<unknown> }>(
    tools: T[],
  ): T[] => (stepReplay
    ? replayRecordedStepCalls(tools, stepReplay, {
        tenantId,
        agentId,
        ...(invocationId ? { invocationId } : {}),
      })
    : tools);

  return {
    mcpServer: createSdkMcpServer({
      name: `tools-${tenantId}`,
      version: '1.0.0',
      // Measured here, above the engine, because this is the one place every
      // tool on every engine passes through. The equivalent measurement in
      // mcp-bridge is correct and observes almost nothing: it sits on the
      // OpenAI/OpenRouter/Gemini loops, and the Anthropic path bypasses that
      // bridge by construction.
      // Bounds every in-process tool result on EVERY engine. The enforcement
      // used to live only in mcp-bridge, which the Anthropic path bypasses by
      // construction -- so Anthropic runs measured their results and passed
      // them through whole. `writeWorkspaceFile` is non-null exactly when the
      // run has a sandbox, which is the same "can this spill?" question
      // mcp-bridge asks of its catalog.
      //
      // And PARKS, which is the same protection without the loss: the records
      // go to the control plane as a dataset of this job and the model reads
      // them back through the dataset tools it already has. The scope is the
      // CONVERSATION when there is one (a person's thread accumulates across
      // turns) and otherwise the run — the same job identity
      // `standard-tool-handler` gives the dataset tools, so a result parked
      // here is found by the `dataset_list` those tools call.
      // A call this step has ALREADY completed is answered with that call's own
      // recorded result rather than dispatched again. Outermost, so a replayed
      // result reaches the model exactly as the record holds it: it was bounded
      // when it was first returned, and re-bounding it here would charge the same
      // characters to the turn budget twice. Present only for a step that already
      // ran (see agent-execution/step-replay-ledger.ts); absent, this is the
      // identity function.
      tools: withStepReplay(observeAndBoundToolResults(registeredMcpTools, {
        invocationId,
        writeFile: writeWorkspaceFile,
        tenantId,
        ...(threadId || invocationId ? { datasetScopeId: threadId || invocationId } : {}),
      })),
    }),
    modelTools: registeredModelTools,
    /** The tool-name prefix of each custom API connection this catalog carries.
     *  One group per connection is what keeps one workspace's two hundred
     *  operations from crowding out everything else. */
    customApiAliases,
    // Under an allowlist nothing outbound is offered, so nothing is withheld
    // from an offer either.
    withheldByOversight: toolAllowlist ? [] : withheldByOversight,
    // Read off `registeredMcpTools` — the SAME array the SDK server is built
    // from, and the only list that carries every tool's registered shape.
    // Deriving it from `modelTools` instead would cover the eight tools that
    // happen to set `inputSchema` there and silently drop the rest.
    toolInputSchemas: toolInputSchemasFrom(registeredMcpTools),
    delegateIdByLabel,
    vendorMcpServers,
    readWorkspaceFile,
    writeWorkspaceFile,
    activeBrowserSession: activeBrowserSession
      ? { id: activeBrowserSession.id, vendorSessionId: activeBrowserSession.vendorSessionId }
      : null,
  };
}

/**
 * Call connector-service once per integration: `GetMcpServerConfig` tells us
 * whether the connector has a vendor-hosted MCP entry (and the fully resolved
 * URL including Snowflake/Databricks per-workspace substitutions); if so,
 * `GetCredentials` fetches the live OAuth token. The result shape matches the
 * `@anthropic-ai/claude-agent-sdk` `mcpServers` map value — http + Bearer or
 * sse + Bearer.
 *
 * Exported so tests can assert the mapping without bootstrapping the whole
 * MCP server creation.
 */
export async function resolveVendorMcpServers(opts: {
  tenantId: string;
  integrations: AgentIntegration[];
}): Promise<ToolGatewayMcpResult['vendorMcpServers']> {
  const out: ToolGatewayMcpResult['vendorMcpServers'] = {};
  if (opts.integrations.length === 0) return out;

  let client;
  try {
    client = getConnectorServiceClient();
  } catch (err) {
    // No CONNECTOR_SERVICE_URL set — this happens in local dev without the
    // split service. Silently skip; vendor MCP is opt-in.
    logger.warn(
      { err: (err as Error).message, tenantId: opts.tenantId },
      'vendor_mcp_client_unavailable',
    );
    return out;
  }

  // Sequential per-integration so one flaky connector doesn't drag the rest
  // down via promise.all rejection semantics. Each integration is isolated.
  for (const integration of opts.integrations) {
    if (!integration.id) continue;
    // Non-connector integration types live in different tables and have their
    // own handlers (external-agent-handler, internal-agent-handler). Calling
    // connector-service for them produces a misleading vendor_mcp_resolve_failed
    // warning and pollutes logs. Skip them.
    if (integration.type === 'external_agent' || integration.type === 'internal_agent') continue;

    // Custom MCP servers live in PB's `custom_mcp_servers` table, NOT in
    // connector-service's `connectors` table — connector-service has no
    // record of them, so the standard `getMcpServerConfig` path below would
    // throw "Connector not found" and `vendor_mcp_resolve_failed` would be
    // logged for every custom MCP integration on every agent invocation.
    // The dispatch path already knows to call PB
    // (custom-mcp-server-handler.ts:136); this branch makes the catalog
    // path symmetric so the SDK's `mcpServers` map sees the server, the
    // SDK auto-discovers its tools via the MCP `tools/list` protocol, and
    // the LLM can actually call them. Without it the LLM never sees custom
    // MCP server tools: an agent with a Help Center bound as a
    // `custom_mcp_server` integration has no Help Center search tool in its
    // catalog, so it escalates every customer question instead of answering
    // from the Help Center.
    if (integration.type === 'custom_mcp_server') {
      try {
        const { customMcpServerHandler } = await import('./custom-mcp-server-handler');
        const { getTenantAllowlistProvider } = await import('../security/tenant-allowlist-provider');
        const tenantAllowlist = await getTenantAllowlistProvider().get(opts.tenantId);
        const entry = await customMcpServerHandler.resolveVendorEntry(
          opts.tenantId,
          integration.id,
          tenantAllowlist,
        );
        if (!entry) {
          // Not silent. resolveVendorEntry returns null when the server is
          // unresolvable or declares auth it cannot produce, and a bare
          // `continue` dropped it from the catalog with no signal at all — the
          // agent simply had no such tools and improvised. That lets a server
          // contribute nothing while looking correctly configured on the
          // connector page.
          logger.error(
            { integrationId: integration.id, tenantId: opts.tenantId },
            'vendor_mcp_custom_mcp_unresolved — server bound to this agent contributes NO tools',
          );
          continue;
        }
        const shortId = integration.id.replace(/-/g, '').slice(0, 8);
        const key = `custom-mcp-${shortId}`;
        out[key] = entry;

        // NOTE: the live `tools/list` observability probe that used to run here
        // was removed — the adapter catalog builder now enumerates vendor MCP
        // tools into catalog.tools (agent-execution/adapter/vendor-mcp-enumerate.ts),
        // doing the authoritative `tools/list` AND emitting the per-server
        // 'vendor_mcp_tools_enumerated' observability log. Keeping a second probe
        // here would mean two `tools/list` round-trips per custom MCP per
        // invocation.

        logger.info(
          { integrationId: integration.id, tenantId: opts.tenantId, key, url: entry.url },
          'vendor_mcp_server_configured_custom_mcp',
        );
      } catch (err) {
        logger.warn(
          { integrationId: integration.id, tenantId: opts.tenantId, err: (err as Error).message },
          'vendor_mcp_resolve_failed_custom_mcp',
        );
      }
      continue;
    }

    try {
      const configResp = await (client as unknown as {
        getMcpServerConfig: (req: unknown) => Promise<{
          exists: boolean;
          isVendorHosted: boolean;
          transport: McpTransport;
          mcpUrl: string;
          composioUserId?: string;
          requiresBearerAuth?: boolean;
        }>;
      }).getMcpServerConfig({
        tenantContext: { tenantId: opts.tenantId },
        connectorId: integration.id,
      });
      // `exists=false` → REST-path connector; skip. Non-vendor-hosted (self-
      // hosted sidecar) MCP also gets dispatched through Execute, not direct-
      // pass, so those get skipped here too.
      if (!configResp.exists || !configResp.isVendorHosted) continue;

      const sdkType = protoTransportToSdkType(configResp.transport);
      if (!sdkType) {
        logger.warn(
          { integrationId: integration.id, transport: configResp.transport },
          'vendor_mcp_unsupported_transport',
        );
        continue;
      }

      // Composio cutover-completion (C5): the Composio direct-dispatch
      // branch (vendorMcpServers entry for composio_managed connectors)
      // is REMOVED. After connector-service's @liftoffos/composio-overlays
      // merge lands, composio_managed tools register in-process via the
      // existing for-each-manifest loop above and the dispatch lambda
      // branches on definitionSource via stable-name-router →
      // composio-dispatcher (composio.tools.execute, SDK-direct REST,
      // NOT the MCP wire path).
      //
      // connector-service's getMcpServerConfig now returns exists=false
      // for composio_managed connectors (mcp-server-registry.ts composio
      // branch removed in C5), so this branch's predicate
      // (configResp.composioUserId !== '') would never trigger anyway.
      // Removing the dead code keeps the dispatch path single-source-of-truth.

      const creds = await client.getCredentials({
        tenantContext: { tenantId: opts.tenantId },
        connectorId: integration.id,
      });

      // Vendor-hosted MCPs authenticate with a Bearer token. For an OAuth or
      // DCR connector that is the access token; for an api_key connector it
      // is the key itself. (api_key connectors that route through Composio —
      // e.g. datadog — are composio_managed and return exists=false above, so
      // they never reach this path; their tools dispatch via
      // composio.tools.execute.)
      //
      // An api_key credential arrives in `apiKey`, never in `oauth`: sentry, databricks and
      // tolt authenticate their MCP with the key as the Bearer.
      const accessToken = creds.oauth?.accessToken || creds.apiKey?.apiKey;
      if (!accessToken) {
        logger.warn(
          { integrationId: integration.id, connectorType: integration.type },
          'vendor_mcp_missing_oauth_token',
        );
        continue;
      }
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };

      const shortId = integration.id.replace(/-/g, '').slice(0, 8);
      const key = integration.type ? `${integration.type}-${shortId}` : `connector-${shortId}`;
      out[key] = {
        type: sdkType,
        url: configResp.mcpUrl,
        headers,
      };
      logger.info(
        { integrationId: integration.id, connectorType: integration.type, tenantId: opts.tenantId, key },
        'vendor_mcp_server_configured',
      );
    } catch (err) {
      logger.warn(
        {
          integrationId: integration.id,
          connectorType: integration.type,
          tenantId: opts.tenantId,
          err: (err as Error).message,
        },
        'vendor_mcp_resolve_failed',
      );
    }
  }

  return out;
}

function protoTransportToSdkType(t: McpTransport): 'http' | 'sse' | null {
  switch (t) {
    case McpTransport.STREAMABLE_HTTP:
      return 'http';
    case McpTransport.SSE:
      return 'sse';
    case McpTransport.STDIO:
    case McpTransport.UNSPECIFIED:
    default:
      // stdio isn't a remote transport the SDK accepts via this config; the
      // static registry doesn't actually use it for vendor-hosted entries,
      // but we guard anyway so a future addition doesn't break silently.
      return null;
  }
}

/**
 * Phase 2c stub. The tool catalog previously used this to enumerate vendor-
 * hosted MCP tools live. Those tools now come from the tool-schema cache
 * seeded by ConnectorService.ListTools. Catalog callers source tools from the
 * cache directly and never hit this path; keeping the symbol for any legacy
 * import that hasn't been cleaned up yet. Returns an empty array.
 */
export async function discoverMCPToolsForCatalog(
  _connectorType: string,
  _mcpUrl: string,
  _tenantId: string,
  _timeoutMs: number = 5000,
): Promise<DiscoveredMCPTool[]> {
  return [];
}
