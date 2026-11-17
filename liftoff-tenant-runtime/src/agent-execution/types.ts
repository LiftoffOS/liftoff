// Agent Execution Types
// Per Section 1: Agent execution is part of tenant runtime
// Per implementation plan: Phase 5 Agent Types, Phase 1 HITL, Phase 2 Memory

import { CompiledInstruction } from '../instruction-compiler/types';
import type { InvocationEvent, ExecutionEngineId, PlatformMessage } from './adapter/types';
import { OversightSettings, ModelTool } from '../hitl-enforcement/types';
import { RetrievedMemory } from '../memory/types';
import type { ExternalAgentConfig } from '../tool-gateway/external-agent-handler';
import type { RepoConfig } from './engine/claude-md-materializer';
import type { AgentTrigger, TrustRef } from '../agent-lifecycle/types';
import type { ToolErrorCode } from '@liftoffos/connector-types';
import type { UnblockableBy } from './terminal-state';

export type { AgentTrigger };

// Agent type for execution pattern selection.
//
//   agent    = dynamic LLM loop (formerly Type A=Manager and Type B=IC)
//   workflow = predetermined step graph (formerly Type C=Single-task scheduled)
//
// Phase 1c: narrowed from the Phase 1a transitional union to canonical only.
// All legacy {A,B,C} literals have been migrated out of the control-plane DB
// (migration 089) and the subscriber normalizer ensured no legacy values
// land in the tenant-runtime agents table.
export type AgentType = 'agent' | 'workflow';

/** Interactive chat only: the shared `run_routine_now` cell.
 *
 *  The chat-turn handler creates it and threads the SAME object into both the
 *  tool catalog and executeTask (the trustRef pattern), so the tool's write is
 *  visible to the engine's dispatch. Absent everywhere else, which keeps chat
 *  conversational by default and the tool inert outside chat. */
export interface WorkflowRunRef {
  /** Flipped by `run_routine_now` mid-turn; the hybrid dispatch reads it when
   *  the conversational segment ends and runs the step graph in the same
   *  invocation. */
  requested: boolean;
  /** The engine's real preflight — hash check, trigger-bound rewrite, alias
   *  remap, validation, fatal/degradable split — memoized. The engine consumes
   *  this same result when it reaches the graph; it must not run the passes
   *  again, because the rewrites mutate `context.workflowSteps` in memory.
   *
   *  Optional: the cell is created in chat-turn-handler, which has no engine
   *  state to close over, so it is installed later, at the top of
   *  `runAgentHybridLoop`. A cell with no preflight is a caller that is not the
   *  interactive chat path. */
  preflight?: () => Promise<{ ok: true } | { ok: false; blockedReason: string }>;
  /** The person's own message on this turn, so the tool can tell a request for a
   *  run from a question about the last one's work.
   *
   *  "so where is my report" armed a second sweep and answered with the
   *  fresh-start note, while the same turn was holding the link to the document
   *  the person was asking for. The tool cannot know a run already happened — it
   *  sees the preflight and nothing else — but it can be told what was asked.
   *  See `tools/run-now-intent.ts`.
   *
   *  Optional: a caller that supplies none keeps the previous behaviour, which is
   *  to arm on the call alone. */
  personMessage?: string;
}

// Agent execution context passed through the execution loop
export interface ExecutionContext {
  tenantId: string;
  agentId: string;
  /** The run's workflow and task ids. Optional because a run resumed from a
   *  task body may genuinely not have them; in that case they are absent, and
   *  every write to a uuid column must turn absence into NULL. An empty string
   *  is never a valid value here — it is not an id and a uuid column rejects
   *  it — so a reader that needs a string must treat a blank as absent too. */
  workflowId?: string;
  taskId?: string;
  instructionVersion: number;
  instruction: CompiledInstruction;
  traceId: string;
  // Per implementation plan: Runtime config fields
  agentType: AgentType;
  hitlLevel: number;
  modelConfig: ModelConfig;
  execConfig: ExecConfig;
  memoryScope: MemoryScope;
  workflowSteps?: WorkflowStep[];
  workflowStepsHash?: string;
  // Injected memories
  memories?: RetrievedMemory[];
  // Oversight settings
  oversight?: OversightSettings;
  // Thread ID for SSE streaming
  threadId?: string;
  // Invocation ID for tracking
  invocationId?: string;
  /** Invocation-level resolved provider (agent config > entitlements routing >
   *  'anthropic') — the SAME value recorded on invocations.provider. Threaded to
   *  the tool gateway so code_session's 'auto' routing follows the provider that
   *  actually runs, not the agent-config-only fallback (which reads 'anthropic'
   *  for workspaces routed via entitlements — the Workspace AI selection path). */
  resolvedProvider?: string;
  /** Invocation-level resolved model id (explicit config > entitlements routing
   *  > provider tier table) — the SAME value recorded on invocations.model_id.
   *  Threaded to the tool gateway so code_session can pick the vendor-matched
   *  coding model for the gateway-served families: they share one CLI and one
   *  endpoint, so the model id is what says which vendor's coding model to
   *  match. */
  resolvedModelId?: string;
  /** The concrete engine a RESUMED run must run on: the one the paused half
   *  ran on, read off the pause envelope (or the invocation row) and never
   *  resolved from this deployment's engine flags.
   *
   *  A provider names a family; a deployment flag picks the engine. Resolving
   *  the engine from the provider at resume time re-runs that choice under
   *  whatever the flags say NOW, so a pause taken under one engine could resume
   *  under another and read the first engine's session artifact as foreign.
   *  Every adapter constructed for a resumed run reads this first; the pause
   *  envelopes the resumed half writes carry it forward. Absent on a fresh run,
   *  where the provider path is the only path. */
  resumeEngine?: ExecutionEngineId;
  /** The model id an operator DELIBERATELY pinned on this agent
   *  (`model_config.modelId`), or undefined when they pinned none.
   *
   *  `resolvedModelId` above cannot answer this: it is always populated,
   *  because resolution falls back to the workspace policy default and then to
   *  the provider tier table. code_session needs the distinction — a vendor
   *  coding agent keeps its own default model unless somebody actually chose
   *  one for it. */
  explicitModelId?: string;
  /** Triggering human, copied from ExecuteTaskInput.triggeredByUserId — PB account
   *  id or slack:/teams:<id>. Undefined for non-human / user-id-less triggers. */
  triggeredByUserId?: string;
  /** Copied from ExecuteTaskInput.impersonatedBy. Present only while a Liftoff
   *  support session is driving this run; the run is the customer's everywhere
   *  it is rendered. */
  impersonatedBy?: string;
  /** Stable trigger identity (plan §4.1/§4.7), copied from ExecuteTaskInput.
   *  Threaded to the tool-gateway so per-side-effect idempotency keys are stable
   *  across redelivery. Undefined for chat / interactive runs (not redelivered). */
  triggerKey?: string;
  /** Optional per-request event sink. When set (interactive chat), the
   *  conversational consumer forwards every adapter InvocationEvent here so the
   *  chat-turn handler relays it to its SSE response in chat format. Runtime-only,
   *  never persisted (functions don't serialize into HybridResumeState). */
  streamSink?: (event: InvocationEvent) => void;
  /** When set (interactive chat), buildSystemPrompt returns this verbatim
   *  instead of composing the autonomous prompt — so a chat turn driven through
   *  executeTask uses the exact chat system prompt (user/channel/interaction
   *  context). The conversational adapter loop completes on the adapter's
   *  `completion` event, so no `[COMPLETE]` termination directive is needed. */
  systemPromptOverride?: string;
  /** Interactive chat only: the shared run_routine_now cell, the same object
   *  the prebuilt catalog's tool captured (the trustRef pattern). */
  workflowRunRef?: WorkflowRunRef;
  /** Media attached to the objective, carried on the context so the
   *  conversational turn builder can seed it onto the first user message.
   *  Interactive chat only; absent everywhere else. */
  objectiveMedia?: Array<{ mimeType: string; dataBase64: string; alt?: string }>;
  /** Interactive chat only: the prior thread rebuilt from the vendor-neutral
   *  canonical record, set when the persisted native artifact belongs to a
   *  DIFFERENT engine than this turn resolves to.
   *
   *  REPLACES the database text replay rather than adding to it. Both describe
   *  the same conversation; the canonical copy also carries the tool calls and
   *  results the text history flattens away. Sending both would show the model
   *  every turn twice. */
  rebuiltConversation?: PlatformMessage[];
  /** Interactive chat only: prior SDK session ID for the (thread, agent) pair.
   *  Forwarded to the adapter's InvocationInput.resumeSessionId so the vendor
   *  SDK resumes the same conversational session. See ExecuteTaskInput. */
  resumeSessionId?: string;
  /** Interactive chat only: pinned `cwd` for the vendor SDK so the session
   *  JSONL lands at a deterministic path. chat-turn-handler builds it per
   *  (tenant, thread, agent), restores the externalized transcript before
   *  the call, and captures it after. Forwarded to
   *  InvocationInput.sessionStateDir. See ExecuteTaskInput. */
  sessionStateDir?: string;
  // Self-schedule chain depth (generation count). 0 = triggered by a
  // non-self-scheduled source (human/cron/event); incremented per
  // schedule_followup generation to bound runaway self-loops.
  chainDepth?: number;
  // Delegation-graph depth. Distinct from chainDepth: that counts a run
  // re-scheduling ITSELF, this counts how far down a parent/child tree the run
  // sits. It decides the run's ROLE — a run with nowhere below it for a child
  // to go is a leaf, and a leaf is not offered the tools that start more work.
  delegationDepth?: number | null;
  /** Cancellation owned by whoever started this run, carried from
   *  ExecuteTaskInput.signal.
   *
   *  Linked into the run's own AbortController so a caller giving up — a parent
   *  that timed out, an operator using the kill switch — actually stops the
   *  work. Without it a delegated child outlives the run that asked for it and
   *  keeps spending on an answer nobody will read. */
  abortSignal?: AbortSignal;
  // External agents for collaboration
  externalAgents?: ExternalAgentConfig[];
  // Sandbox capabilities — populated from compiled_instructions.runtime_config.
  // Empty array (or absent) for connector-only agents; array of {shell, file,
  // browser, vscode} for execution-enabled agents. The schema-building step
  // filters sandbox tools against this list.
  sandboxCapabilities?: Array<'shell' | 'file' | 'browser' | 'vscode'>;
  /** Tools whose result this agent may only act on in full. A result too large
   *  to return whole is parked in the workspace; for these tools the call fails
   *  retryably instead of returning a view as a success, because a view of the
   *  data answers a keying, counting or reconciliation question wrongly rather
   *  than partially. From compiled_instructions.runtime_config. */
  completeResultRequiredTools?: string[];
  // The agent's integrations (connector instances) from the compiled
  // instruction row. Each entry carries the connector UUID (`id`) and its
  // type string (`type`). The engine forwards these to the tool-gateway MCP
  // builder so vendor-hosted MCP connectors (GitHub, Stripe, Notion, …) can
  // be wired directly into the Claude SDK's `mcpServers` map.
  integrations?: Array<{
    id: string;
    type?: string;
    selectedObjects?: string[];
    /** Per-binding config (e.g. Gmail gmailQuery, sendAs). Threaded into
     *  the tool-gateway's bindingsByType map so tool calls get the right
     *  injection (q, from) before dispatch. */
    config?: Record<string, unknown>;
  }>;
  /**
   * Pre-built `bindingsByType` keyed by every identifier the LLM might
   * emit (alias, canonical type, UUID — both stale and current). Built
   * once at executeTask startup from `integrations` + the agent's
   * `connector_manifests` rows so every toolGateway.execute call site
   * can pass it through. Without this, the gateway's resolveBinding
   * returns the alias string as-is for `connectorId`, connector-service
   * casts to UUID, and emits `invalid input syntax for type uuid: "X"`.
   *
   * Source: src/tool-gateway/binding-resolver.ts buildBindingsByType.
   * Set by the legacy reasoning loop in executeTask; engines that route
   * through the MCP layer (Codex / Anthropic SDK) build their own at the
   * MCP boundary and do not consume this field.
   */
  bindingsByType?: Record<string, { connectorId: string; config?: Record<string, unknown> }>;
  // Summary of the agent's most recent completed invocation (for continuity across runs)
  priorInvocationSummary?: string;
  // What triggered this invocation — forwarded from ExecuteTaskInput so engines can
  // write accurate lifecycle audit events (e.g. "cron", "agent:<id>", "human:<id>").
  triggeredBy?: string;
  /**
   * Discriminated trigger union — see `AgentTrigger` in
   * src/agent-lifecycle/types.ts. The custom_event variant carries
   * trustLevel='untrusted_inbound' which the executor uses to coerce
   * hitlLevel ≥ 1, wrap the payload in `<webhook_payload>` markers, gate
   * SSRF-prone tool calls, and tag every audit row.
   */
  trigger?: AgentTrigger;
  /** The payload the run was woken with — `{eventSource, eventEntityType,
   *  eventData}` on a connector-event run. Carried on the context because a
   *  trigger-bound step's identity arguments are built from the normalized
   *  record at dispatch, and the dispatch site has the context, not the input.
   *  Same gap `trigger` had: present on ExecuteTaskInput, absent here, so the
   *  one place that needs it could not reach it. */
  inputData?: Record<string, unknown>;
  /**
   * Cached trust level derived from `trigger`. Kept as a separate field
   * because it's read on every tool call and we don't want every read to
   * walk the discriminated union. Computed by the executor on entry; not
   * something subscribers need to populate.
   */
  trustLevel?: 'trusted' | 'untrusted_inbound';
  /**
   * Domains (lower-cased) the agent treats as internal — derived from the
   * `sendAs` value on its Gmail / Outlook integration config. The citation-
   * warning PostToolUse hook compares outbound mail recipients against this
   * set: when no recipient is external, the warning silently skips. Empty
   * array means "we have no signal" and the warning refuses to guess.
   */
  internalDomains?: string[];
  /** Liftoff accounts.id of the sender of the message that triggered this
   *  turn. Unset for autonomous / scheduled runs — in which case browser tools
   *  are absent and the spawn-via-run_browser_task path is unreachable. */
  messageSenderAccountId?: string;
  /** Memoized per-turn lookup, shared between tool-catalog gating and
   *  system-prompt preamble. */
  activeBrowserSession?: { id: string; vendorSessionId: string } | null;
  /** Interactive chat only: a tool catalog the caller already built (via
   *  AgentExecutionService.buildChatToolCatalog) to source the system prompt's
   *  capability list. When set, buildPlatformMcpCatalog returns it verbatim
   *  instead of calling createToolGatewayMcpServer a SECOND time — so the chat
   *  prompt and the engine's execution share ONE catalog (one vendor-sidecar /
   *  browser-session spin-up, no divergence). Unset for autonomous runs, which
   *  build their catalog as before. */
  prebuiltCatalog?: import('./adapter').McpToolCatalog;
  /** Purpose-group hint for billing-attribution routing (Part 1 §B2). Copied
   *  from ExecuteTaskInput.purpose at executeTask entry; threaded into each
   *  InvocationInput so purpose-pooled adapters (currently OpenAI) select
   *  the right per-purpose API key. Undefined → 'agent-execution' group. */
  purpose?: string;
  /** The grant a snapshot-replay dispatch carries past the gate: the calls a
   *  person approved, consumed once at `consumeApprovedCalls`. `executeToolCalls`
   *  skips `checkHitlGate` ONLY for a batch the grant covers — the same ids and
   *  arguments, nothing else — and re-gates anything it does not. Set by
   *  `resumeFromHitlApproval` right before dispatching the operator-approved
   *  tool calls; cleared in the `finally` of the same call. Never persisted.
   *  Replaces a boolean that waved through whatever batch happened to be in
   *  flight. */
  approvedGrant?: import('./approval-consumption').ConsumedGrant;
  /** Structured HITL resume (§4.10 Part C). Set ONLY when resuming a persisted
   *  autonomous SDK session after an operator decision (AUTONOMOUS_RESUME_ENABLED
   *  + a saved session): the SDK re-attempts the gated tool call(s) on resume,
   *  and the adapter HITL gate resolves them per the operator's decision instead
   *  of re-gating — approved → allow once, rejected → deny once with the reason.
   *  Each (name|args) signature is resolved at most once (`resolved`); a genuinely
   *  new identical call later re-gates normally. Absent on every non-structured
   *  path, so the snapshot-replay fallback is byte-for-byte unchanged. */
  hitlResumeDecision?: {
    decision: 'approved' | 'rejected';
    rejectionReason?: string;
    /** `input` is the call as the MODEL proposed it, which is what the signature
     *  match is keyed on. `editedInput`, when present, is the reviewer's
     *  replacement and is what actually gets dispatched. */
    pending: Array<{
      name: string;
      input: Record<string, unknown>;
      editedInput?: Record<string, unknown>;
    }>;
    resolved: string[];
  };
  /** Suppress the conversational loop's initial-prompt push on a structured HITL
   *  resume — the resumed SDK session already carries the full task + history, and
   *  pushing a user turn would orphan the session's dangling tool_use. */
  skipInitialPromptPush?: boolean;
  /** The continuation turn of a resumed run — a wake event, pushed after the
   *  restored transcript in place of the objective prompt. Copied from
   *  ExecuteTaskInput.resumeUserTurn at executeTask entry; read by the
   *  conversational loop's opening-turn push and by a re-entered workflow
   *  adapter step. Absent on every ordinary run. */
  resumeUserTurn?: string;
  /** The transcript a resumed run continues, when it came from the pause's
   *  own checkpoint (pause-checkpoint.ts) rather than the payload snapshot:
   *  the canonical record through the completed pending call, and the same
   *  record converted for the engine this run resolves to. The conversational
   *  loop hands `messages` to the adapter ahead of this run's own turns and
   *  seeds its recorder from `canonical`, so the run's next checkpoint holds
   *  the whole conversation. Set by the two resume readers; absent on every
   *  ordinary run and on every snapshot-path resume. */
  resumeTranscript?: import('./pause-checkpoint').ResumeTranscript;
  /** Connector type whose event envelope this run's inputData carries.
   *
   *  Set by the companion-cron fan-out. Graph validation reads it so a routine
   *  that IS handed `input.message` is judged by the event contract rather than
   *  the bare-cron one, which would reject the very fields it is about to
   *  receive. */
  inputSource?: string;
}

// Model configuration
// Per implementation plan Phase 3.4: Include provider for multi-provider routing
export interface ModelConfig {
  provider?: 'anthropic' | 'google' | 'openai';
  modelId?: string;
  tier?: 'large' | 'medium' | 'small';
  maxTokens?: number;
  temperature?: number;
}

// Execution configuration
export interface ExecConfig {
  maxToolCalls?: number;
  timeoutMs?: number;
  repos?: RepoConfig[];
}

// Re-export RepoConfig so callers can import from agent-execution/types
export type { RepoConfig };

// Memory scope configuration
export interface MemoryScope {
  readableLayers?: string[];
  writableLayers?: string[];
  scopeKeys?: string[];
}

// Workflow step definition — canonical camelCase shape.
//
// Phase 3: renamed from snake_case (step_id, tool_name, etc.) to camelCase
// (stepId, toolName, etc.) to match the rest of both codebases and the
// @liftoffos/runtime-shared-types contract. Extended with new fields for Phase 4's
// workflow executor rewrite: toolInputTemplate, outputField, loop, retry,
// timeoutMs, requiresApproval, idempotencyKey.
//
// The Phase 0 workflow-step-case CI fence enforces that no snake_case
// field names appear in files that import WorkflowStep.

export interface WorkflowStepLoop {
  /** Dot-path into the current stepOutput pointing at an array */
  over: string;
  /** Name under which each item is exposed in templates (default "item") */
  itemVar?: string;
  /** Safety cap; default 100, hard max 1000 */
  maxIterations?: number;
  /** If true, aggregate iteration outputs into an array at output.<stepId> */
  collect?: boolean;
  /** The items are INDEPENDENT: one failing does not invalidate the others, so
   *  the loop finishes the rest instead of abandoning them.
   *
   *  Default false, which is today's behaviour — the first failure returns and
   *  the remaining items are never attempted. That is right for a sequence
   *  where each step depends on the last, and wrong for a fan-out.
   *
   *  A code-review graph is the worked example. s8 attaches each finding from
   *  s5 to the open review, and the findings are independent by construction:
   *  one whose line anchor GitHub rejects says nothing about the next. Under
   *  the abort rule a single mis-anchored finding discards ALL of them, so a
   *  review publishes "Blocking issues: 1, Suggestions: 2" with nothing
   *  attached to the diff — three findings lost to one bad line number.
   *
   *  Partial completion is NOT silent success. Every failed item is logged, and
   *  the step reports them so the graph-end check escalates: a run that
   *  attached two findings of three has not done what it declared, and the
   *  operator needs to know which one is missing. All items failing still fails
   *  the step outright, because nothing was accomplished. */
  continueOnItemFailure?: boolean;
}

export interface WorkflowStepRetry {
  /** Default 1 (no retry). Counts against execConfig.maxToolCalls. */
  maxAttempts: number;
  /** Default 1000ms, doubles per attempt, ceiling 30000ms */
  backoffMs?: number;
}

/** Workflow delay step configuration. */
export interface WorkflowDelayStep {
  /** Duration to wait, in seconds. Bounds [60, 30d] enforced by handler. */
  durationSeconds?: number;
  /** Alternative absolute fire time. Bounds [now+60s, now+30d] enforced. */
  untilIso?: string;
  /** Optional cancellation key; defaults to '{workflowId}:{stepId}'. */
  contextRef?: string;
}

/** Vendor-agnostic capability NEED stored on a `capability` step. Mirrors the
 *  @liftoffos/runtime-shared-types WorkflowCapabilityNeed. The runtime resolves it to a
 *  concrete capability at execution time (search then run), so no vendor name or
 *  short-TTL handle is ever stored in agent config. */
export interface WorkflowCapabilityNeed {
  operation: string;
  entity: string;
  mode: 'public_data' | 'own_account';
  targetSystem?: string;
  availableInputs?: string[];
  requiredOutputFields?: string[];
}

export interface WorkflowStep {
  stepId: string;
  description: string;

  /** Step kind. Default 'tool_call' for back-compat with steps that
   *  set toolName without setting type. 'delay' suspends the workflow via a
   *  scheduled resume Cloud Task (HybridResumeState in
   *  agent_scheduled_invocations.workflow_resume_payload). 'ask_user' suspends
   *  the workflow with a plain-text question posted to the chat thread; the
   *  next user reply is the answer (hybrid execution engine). 'capability'
   *  resolves a vendor-agnostic capabilityNeed to a concrete capability at run
   *  time and runs it through the same admission/HITL path as a model-issued
   *  run_capability (so a write/outbound capability pauses for approval). */
  type?: 'tool_call' | 'llm_reason' | 'delay' | 'ask_user' | 'capability';

  // Tool execution
  /** Canonical aliased form, e.g. "salesforce_prod__read_record" */
  toolName?: string;
  /** The vendor-agnostic capability need; required when type === 'capability'.
   *  Call arguments come from toolInput / toolInputTemplate; outputField threads
   *  the result onward, exactly as for a tool_call. */
  capabilityNeed?: WorkflowCapabilityNeed;
  /** Static tool input */
  toolInput?: Record<string, unknown>;
  /** JSON template with {{input.X}} / {{output.X}} / {{item.X}} substitution */
  toolInputTemplate?: string;
  /** Dot-path into the result for the next step's stepOutput */
  outputField?: string;

  /** Config for delay steps (when type === 'delay'). */
  delay?: WorkflowDelayStep;

  // Control flow
  /** Condition evaluated by condition.ts */
  condition?: string;
  /** Next stepId on success; empty string = terminate */
  onSuccess?: string;
  /** Fallback stepId on failure */
  onFailure?: string;
  /** Optional loop iteration configuration */
  loop?: WorkflowStepLoop;

  // Reliability
  retry?: WorkflowStepRetry;
  /** Per-step timeout; default 60000ms (inherited from execConfig if set) */
  timeoutMs?: number;

  // Human-in-the-loop
  /** Force HITL gate on this step regardless of agent hitlLevel */
  requiresApproval?: boolean;

  /** Plain-text clarification question; required when type === 'ask_user'.
   *  Rendered through applyTemplate so it can reference {{output.X}}. */
  question?: string;

  /** Opt-in LLM-driven semantic validation of the step output. When true,
   *  the hybrid loop invokes validateSemanticValue after the step produces
   *  output, before threading it to the next step. */
  semanticValidation?: boolean;

  /**
   * Optional explicit idempotency key. If absent, the executor derives one as
   * sha256(runId + stepId + iteration + toolName + canonical(toolInput)).
   */
  idempotencyKey?: string;
  /** Set by the trigger-bound resolution pass on a step that will NOT run in
   *  this run — either the triggering host needs no such call, or there was no
   *  triggering connector at all. Carries the reason, for the log line.
   *
   *  Typed rather than cast in place, because validation has to read it: a
   *  skipped step keeps its `trigger__<op>` name, which is an operation and not
   *  a tool, and neither the catalog check nor the dispatch check can resolve
   *  one. Judging a retired step reported UNRESOLVABLE_TOOL and failed the run
   *  — for a step the runtime had already decided not to execute. */
  __triggerBoundSkip?: string;
  /** Set when graph validation could not resolve this step's tool: the name is
   *  not in the run's catalog, matches two connected accounts, or belongs to no
   *  dispatch family.
   *
   *  The step is skipped and recorded UNSATISFIED rather than failing the whole
   *  run, so a graph does not stop dead because one connector was reconnected
   *  overnight. It is deliberately not improvised by the model: the author named
   *  a specific tool, and a step that quietly does something adjacent is worse
   *  than one that does nothing, because downstream steps read its output and
   *  cannot tell the difference. */
  __unresolvableTool?: string;
  /** Set on a step the runtime SYNTHESISED with its `{{…}}` references already
   *  resolved, so invokeStepLLM renders the description as it is rather than
   *  running the template pass over it again. The step salvage turn sets it:
   *  its description embeds the material the step's tools returned, and a
   *  placeholder inside a fetched page must neither read the run's data into
   *  the prompt nor fail the pass for the whole prompt. */
  __proseResolved?: boolean;
}

// Input for starting agent task execution
export interface ExecuteTaskInput {
  /** B1 — set on the ONE verify-on-stop continuation, so it does not gate
   *  itself into an unbounded loop and so the learning triggers (reflection,
   *  skill feedback, usefulness scoring) fire exactly once, on the final
   *  outcome, rather than twice with the first firing on a half-finished run. */
  verifyContinuation?: boolean;
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  objective: string;
  /** Media the person attached to THIS objective, already fetched.
   *
   *  Interactive chat only. An autonomous run has no attachments — nobody is
   *  there to attach anything — so this is absent on every other path and the
   *  turn behaves exactly as it did before.
   *
   *  Base64 rather than references, because by the time an adapter sees content
   *  the bytes have to be present: every vendor SDK here takes an image inline
   *  in the request body. The fetch happens once, in the chat turn handler, so
   *  a run that retries an adapter does not re-download the picture. */
  objectiveMedia?: Array<{ mimeType: string; dataBase64: string; alt?: string }>;
  inputData?: Record<string, unknown>;
  /** Connector type whose event envelope this run's `inputData` carries.
   *
   *  Set by the companion-cron fan-out, which resolves a routine's work items
   *  and runs the graph once per item with `input.message` built by the SAME
   *  function the event trigger uses. Without it the run is judged as a bare
   *  cron and its `{{input.message.*}}` references are rejected — which killed
   *  every fire of a workSource routine before its first step. */
  inputSource?: string;
  // Per implementation plan: Optional fields for invocation tracking
  threadId?: string;
  /** Caller-provided invocation UUID. When set (interactive chat), executeTask
   *  uses it for the invocation record instead of generating one, so the chat
   *  turn's invocationId is honored end-to-end. Must be a valid UUID. */
  invocationId?: string;
  /** Interactive chat only: relay each adapter InvocationEvent to the chat-turn
   *  SSE response (translated to chat format). Threaded into ExecutionContext. */
  streamSink?: (event: InvocationEvent) => void;
  /** Interactive chat only: the fully-built chat system prompt; buildSystemPrompt
   *  returns it verbatim so the chat turn keeps its user/channel/interaction context. */
  systemPromptOverride?: string;
  /** Interactive chat only: the run_routine_now cell shared with the prebuilt
   *  catalog. See ExecutionContext.workflowRunRef. */
  workflowRunRef?: WorkflowRunRef;
  /** Interactive chat only: the prior thread rebuilt from the vendor-neutral
   *  canonical record, set when the persisted native artifact belongs to a
   *  DIFFERENT engine than this turn resolves to.
   *
   *  REPLACES the database text replay rather than adding to it. Both describe
   *  the same conversation; the canonical copy also carries the tool calls and
   *  results the text history flattens away. Sending both would show the model
   *  every turn twice. */
  rebuiltConversation?: PlatformMessage[];
  /** Interactive chat only: prior SDK session ID for the (thread, agent) pair,
   *  carried from the control-plane chat-service. When set, the adapter passes
   *  it to the vendor SDK's resume option so this turn continues the same
   *  conversational session (Claude Agent SDK: `query({ resume: sessionId })`).
   *  Undefined → start a fresh session. The new (or resumed) session_id is
   *  surfaced back via the `session_started` InvocationEvent on streamSink. */
  resumeSessionId?: string;
  /** Interactive chat only: pinned `cwd` for the vendor SDK so the session
   *  JSONL file lands at a deterministic path on disk. chat-turn-handler
   *  uses it to read/write the externalized transcript in chat_sessions
   *  (migration 294), making SDK resume work across Cloud Run instances. */
  sessionStateDir?: string;
  /** Interactive chat only: a tool catalog the handler already built (to source
   *  the prompt's capability list) so the engine reuses it instead of building a
   *  second one. See ExecutionContext.prebuiltCatalog. */
  prebuiltCatalog?: import('./adapter').McpToolCatalog;
  /** Test-harness only: skip the per-agent execution lock so synthetic runs
   *  don't queue behind real production chat / autonomous traffic for the
   *  same (tenant, agent). The lock exists to serialize real concurrent
   *  executions; harness invocations are synthetic threads on synthetic
   *  invocation ids and don't interfere with real state, so making them
   *  contend with prod traffic just blocks the harness on a heavily-used
   *  agent and produces 'agent_already_running' for reasons unrelated to
   *  the test. Defaults to false — only the test-harness router sets it. */
  bypassAgentLock?: boolean;
  /** D4 — SERVICE-AUTH-ONLY (test-harness /run-agent) candidate-model override for the tuning
   *  gate: run THIS invocation with the given full modelConfig instead of the agent's configured
   *  one. Never set on product paths (the harness router is requireServiceAuth + OIDC-gated), so
   *  it cannot leak into product execution. */
  modelConfigOverride?: ModelConfig;
  /** Purpose-group hint for billing-attribution routing (Part 1 §B2). Set by
   *  the entry-point caller — e.g. reflection-engine → 'reflection',
   *  memory-consolidation → 'memory_consolidation'. Leave undefined for
   *  chat / scheduler / autonomous flows so the call routes to the
   *  'agent-execution' pool. Copied into ExecutionContext.purpose at
   *  executeTask entry. */
  purpose?: string;
  triggeredBy?: 'human' | 'agent' | 'cron' | 'event';
  /** Granular source label persisted to invocations.triggered_by_label.
   *  Examples: 'companion:weekly-summary', 'reactive:campaign-bounce-watch',
   *  'workflow_delay:<workflowId>', 'computed_metric:<label>'. The DB CHECK
   *  on triggered_by stays unchanged; granular attribution
   *  rides in this separate column. */
  triggeredByLabel?: string;
  /** Triggering human — PB account id, or slack:<id>/teams:<id> for unmapped channel
   *  users (web resolves the Firebase UID to an account id before sending). Only
   *  meaningful when triggeredBy === 'human'; some human paths carry none. */
  triggeredByUserId?: string;
  /** The triggering human's validated `accounts.id`, when there is one. Distinct
   *  from the overloaded `triggeredByUserId`, which also carries synthetic
   *  `slack:<uid>` / `teams:<uid>` forms for senders with no account. Only this
   *  strict form may be sent as the control plane's audit `userId`: that field is
   *  `z.string().uuid()` over a `user_id UUID` column, so a synthetic id 400s at
   *  the zod boundary and the whole audit row is discarded. Set by the chat turn;
   *  no other entry point has a human account. */
  senderAccountId?: string;
  /** The Liftoff operator's `accounts.id` when a support delegation session set
   *  this run in motion. Same strictness rule as senderAccountId above: the
   *  control plane's column is UUID, so only the real account id may travel
   *  here. Absent on every ordinary run. Copied to ExecutionContext at
   *  executeTask entry and written to audit_logs.impersonated_by (migration
   *  379) and, via the control plane, agent_audit_logs.impersonated_by. */
  impersonatedBy?: string;
  /** ADR-030: when this run was started by "Run again", the id of the original
   *  failed invocation it re-runs. Threaded into createInvocation so the new
   *  invocation records invocations.rerun_of_invocation_id (backend lineage). */
  rerunOfInvocationId?: string;
  /** Self-schedule chain depth carried from the triggering scheduled row.
   *  Threaded into the tool context so schedule_followup can bound self-loops. */
  chainDepth?: number;
  hitlLevel?: number;
  escalation?: 'exceptions' | 'important' | 'sensitive';
  requestedByType?: 'mcp_key' | 'a2a_token' | 'internal';
  requestedById?: string;
  /**
   * Discriminated trigger union (src/agent-lifecycle/types.ts). When set to
   * the `custom_event` variant, the executor coerces hitlLevel ≥ 1, wraps
   * the payload in `<webhook_payload>` markers, gates SSRF-prone tool
   * calls, and tags every audit row with `trigger_trust_level`.
   */
  trigger?: AgentTrigger;
  /** Stable trigger identity for run-level idempotency (plan §4.7). When set,
   *  executeTask claims an `event_processing_ledger` `agent_run` row keyed on
   *  this value so a redelivery of the same trigger does not re-run the agent.
   *  Inline event path → the control-plane `event_id` (stable across Pub/Sub
   *  redelivery). Omitted for chat / interactive / delegation-child runs (not
   *  redelivered) — executeTask then runs without a run-level claim. */
  triggerKey?: string;
  /** Lock-contention policy. 'reject' (default) → return { error:'agent_already_running' }
   *  immediately (interactive/direct HTTP surface "busy"). 'defer' → durably re-enqueue via
   *  Cloud Tasks with backoff (inbound: connector events, webhooks, reactive). Requires triggerKey. */
  onConflict?: 'defer' | 'reject';
  /** Defer retry generation (0 = original). Incremented per re-enqueue; bounded by
   *  MAX_DEFER_ATTEMPTS then dead-lettered. */
  deferAttempt?: number;
  /**
   * Convenience override — when the caller already knows the trust level
   * (e.g. test fixtures), skip having to construct a full trigger object.
   * Subscribers in production should populate `trigger` instead, which
   * implies trustLevel via `trustLevelFor()`.
   */
  trustLevel?: 'trusted' | 'untrusted_inbound';
  /** Shared trust cell created by a caller that also builds the tool catalog up front
   *  (interactive chat / test harness build a `prebuiltCatalog` whose tools captured
   *  this cell). Passing it here keeps ONE object across the catalog's tools and the
   *  gate, so read_agent_messages taint upgrades + the same-batch barrier work on that
   *  path. Omitted for the autonomous path, which mints its own. */
  trustRef?: import('../agent-lifecycle/types').TrustRef;
  /** A wake continuation of a PAUSED run, entered through the task lifecycle.
   *
   *  The four fields below are what distinguishes continuing a run from
   *  starting one. `objective` stays the original objective; the wake event is
   *  `resumeUserTurn`, a continuation turn pushed after the restored transcript
   *  instead of the objective prompt. `resumeConversationHistory` is restored
   *  ONCE onto the run's history — the thread history the task would otherwise
   *  load is skipped, so no turn is seen twice. `resumeState` is the saved
   *  cursor and outputs, handed to the hybrid loop exactly as the HITL snapshot
   *  replay hands its own, so the loop enters at `resumeAfterStepId` and the
   *  step that scheduled the wait does not run again. Absent on every ordinary
   *  run, which then behaves exactly as before. */
  resumeUserTurn?: string;
  resumeConversationHistory?: ConversationMessage[];
  /** The paused run's transcript from its pause checkpoint, in place of
   *  `resumeConversationHistory`: the wake reader sets exactly one of the two.
   *  Copied onto ExecutionContext.resumeTranscript; the thread history the task
   *  would otherwise load is skipped for it the way it is for the snapshot. */
  resumeTranscript?: import('./pause-checkpoint').ResumeTranscript;
  resumeState?: import('./service').HybridResumeState;
  /** The trigger key that OWNS the paused state this run continues. Recorded on
   *  the continuation's invocation-start audit row as `continues_run` — a name
   *  without `key` in it, because the audit sanitizer redacts any field whose
   *  name carries one — so
   *  the two invocations that make one run are joined on the record an operator
   *  reads. The continuation's own `triggerKey` remains its idempotency
   *  identity, and any pause it raises is saved under that key, so a chained
   *  wake finds the continued state in its own row. */
  previousTriggerKey?: string;
  /** Delegation-graph depth (parent depth + 1). Threaded into the child's
   *  invocation so a child that itself spawns is depth-capped. */
  delegationDepth?: number | null;
  /** Per-run wall-clock override (ms). Child dispatch sets 240_000 so the child
   *  finalizes cleanly INSIDE the 270s Cloud Task dispatch deadline instead of
   *  being killed at 300s. Overrides execConfig.timeoutMs for this run only. */
  execTimeoutMsOverride?: number;
  /** The invocation that asked for this run, when an agent asked rather than a
   *  person, a schedule or a trigger.
   *
   *  Written to invocations.parent_invocation_id, which is what makes the run a
   *  child rather than a root: resolveAccountability reads it to classify the
   *  run as `delegation` (and inherit the human) instead of `direct_human`, the
   *  depth cap resolves the parent's depth from it, and diagnostics excludes
   *  delegated children from the top-level run population by testing it for
   *  NULL. A delegated run without it is graded as somebody's root run.
   *
   *  Absent on every non-delegated path, which is the majority. */
  parentInvocationId?: string;
  /** Cancellation for this run, owned by whoever started it.
   *
   *  A delegated child needs this because its parent — or an operator using the
   *  kill switch — must be able to stop it. Without a signal threaded down, a
   *  child outlives the run that asked for it and keeps burning tokens on an
   *  answer nobody is waiting for any more. `execTimeoutMsOverride` covers only
   *  the hard wall clock; it cannot express "the caller gave up". */
  signal?: AbortSignal;
  /** Turn ceiling for this run, overriding the agent's configured
   *  execConfig.maxToolCalls.
   *
   *  Delegation sets it because a child answering one scoped question does not
   *  need its parent's full budget. It is an override, not a replacement for
   *  role clamping: iterationBudgetFor still applies on top, so a leaf cannot be
   *  handed a budget larger than its role allows. */
  maxTurnsOverride?: number;
}

// Result from LLM reasoning step
export interface ReasoningResult {
  thinking: string;
  /** Hybrid execution engine adds 'ask_user' (clarification question to the
   *  user; halts the workflow until the next chat message in the thread). */
  decision: 'continue' | 'complete' | 'escalate' | 'fail' | 'ask_user';
  toolCalls: ToolCallRequest[];
  output?: unknown;
  escalationReason?: string;
  /** Which surface the resulting escalation belongs on, when the caller knows
   *  better than the default.
   *
   *  An `escalate` decision normally carries a reason the model wrote for a
   *  person, and lands in the customer's review queue. Some escalate results
   *  are synthesized by code instead — the recovery advisor being unreachable,
   *  or returning nothing parseable — and those reasons are internal state, not
   *  something a customer can accept or deny. They set 'system_internal' here
   *  so the queue keeps meaning "a person can do something about this".
   *
   *  See CreateEscalationOptions.kind for the full rule. */
  escalationKind?: 'escalation' | 'system_internal';
  /** decision='escalate' only: who can clear the blocker. Absent means nobody
   *  said, which routes to the operator record rather than to a customer. */
  whoCanUnblock?: UnblockableBy;
  /** decision='escalate' only: the one thing that person should do, written to
   *  them. Becomes the question when the run parks for a customer. */
  requestedAction?: string;
  failureReason?: string;
  /** Required when decision === 'ask_user'. Plain text — posted to the chat
   *  thread as a regular assistant message. */
  userQuestion?: string;
  /** Optional forward-only skip-to-step on decision === 'continue'. Validated
   *  against the workflowSteps array; backward / invalid → fall through to
   *  next-sequential per D8. */
  nextStepId?: string;
  // Per implementation plan Phase 3.3: Token usage tracking
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

// ── Hybrid execution engine: anomaly discriminated union ─────────────────
//
// Every step-execution failure or interrupt is mapped to one of these
// anomaly kinds via mapErrorToAnomalyContext. The recovery LLM is invoked
// with the resulting AnomalyContext as the prompt's per-anomaly snippet
// (see engine/recovery-prompts.ts).
export type AnomalyContext =
  | { kind: 'tool_error';                 step: WorkflowStep; error: string }
  | { kind: 'hitl_rejected';              step: WorkflowStep; reason: string; matchedCategory?: string }
  | { kind: 'guardrail_blocked';          step: WorkflowStep; reason: string }
  | { kind: 'snapshot_unavailable';       step: WorkflowStep; reason: string }
  | { kind: 'timeout';                    step: WorkflowStep; elapsedMs: number }
  | { kind: 'admission_denied';           step: WorkflowStep; reason: string }
  | { kind: 'template_expansion';         step: WorkflowStep; reference: string }
  | { kind: 'output_shape';               step: WorkflowStep; expected: string; received: unknown }
  | { kind: 'anomalous_value';            step: WorkflowStep; reason: string; value: unknown }
  | {
      kind: 'user_message_during_run';
      step: WorkflowStep;
      userMessage: string;
      /** Who interrupted. Null for signals written before identity was carried,
       *  and for unresolved Slack/Teams guests. */
      senderDisplayName?: string | null;
      senderAccountId?: string | null;
    }
  | { kind: 'llm_reason_failure';         step: WorkflowStep; error: string }
  | { kind: 'user_answered_clarification'; step: WorkflowStep; originalQuestion: string; userAnswer: string }
  /** The advisor's `continue` proposal named a tool outside what recovery may
   *  call — a tool the graph never names that is not read-only — and none of
   *  it was executed. `rejected` carries the resolved catalog names (or the
   *  formatted name, for a call that resolved to nothing) so the re-ask can
   *  say which names it may not use. Raised only under
   *  TR_RECOVERY_SCOPE_ENFORCE=1; see dispatchRecoveryDecision. */
  | { kind: 'recovery_proposal_rejected'; step: WorkflowStep; rejected: string[] };

// ── Hybrid execution engine: custom errors thrown by the deterministic path ──

/** A `{{root.path}}` placeholder that the run cannot resolve.
 *
 *  Substitution used to answer an unresolvable placeholder with the text
 *  `null`, which inside a JSON string literal is the four-character STRING
 *  "null" — schema-valid, so it passed every check and went to the vendor as if
 *  it were a real value. It now throws, and this class is why the throw is
 *  classified rather than pattern-matched.
 *
 *  Earlier revisions deliberately introduced no class here and let
 *  mapErrorToAnomalyContext recognise template failures by a regex over the
 *  message prose (`/Template reference|did not resolve|missing template/`).
 *  That was survivable while the only throws were the byte caps, which no
 *  recovery model acts on. It is not survivable now: an unresolved placeholder
 *  is the common case, its message is authored right next to the regex, and the
 *  two drift the moment either is reworded — silently, into the `tool_error`
 *  bucket, whose recovery prompt talks about the remote API rather than the
 *  workflow's own template. Same reasoning that removed the vendor-prose regex
 *  from the ToolExecutionError path in favour of a carried taxonomy. */
export class TemplateResolutionError extends Error {
  /** The full `root.path` reference that failed, for the recovery prompt. */
  public readonly reference: string;
  /**
   * The producing step RAN and deliberately reported nothing there.
   *
   *  Two failures wear this one class and they are not the same thing.
   *
   *  A reference that cannot be read at all — a missing root, an absent key —
   *  means the step was never attempted on data it was written against. That is
   *  a broken contract, and sending it down the author's `onFailure` presents it
   *  as an anticipated business condition: a support agent reading
   *  `{{input.message.threadId}}` on a cron fire that carries no message takes
   *  its failure branch into "acknowledge" and marks mail read in a mailbox it
   *  never opened.
   *
   *  A reference that resolved to NULL is the opposite. The producing step ran,
   *  and null is what it had to say: "there is no snapshot document yet". The
   *  author who wrote `onFailure: <create one>` was answering exactly that, and
   *  routing it to recovery instead spends a model turn rediscovering a fact the
   *  graph already states — on every first run of every workflow shaped this
   *  way, which is the common shape for "update it, or make it if it is not
   *  there".
   */
  public readonly producedNull: boolean;
  constructor(reference: string, message: string, producedNull = false) {
    super(message);
    this.name = 'TemplateResolutionError';
    this.reference = reference;
    this.producedNull = producedNull;
  }
}

/** A condition compared a value the run does not carry.
 *
 *  Distinct from a predicate that is simply false. `evalPredicate` coerces with
 *  `String(actual)`, so an absent left side compares as the string "undefined"
 *  and the branch is not taken — which reads downstream as the author's else
 *  case, taken deliberately. It is not: the run does not hold the data the
 *  predicate was written against, so no decision was made at all.
 *
 *  Carried as a class rather than inferred from prose for the reason
 *  TemplateResolutionError above records: a regex over an authored message
 *  drifts the moment either side is reworded.
 *
 *  Handled like TemplateResolutionError — a contract defect goes to recovery
 *  rather than down `onFailure`, because `onFailure` means "this can fail in
 *  the course of business" and a predicate with no input never ran. */
export class ConditionInputMissingError extends Error {
  public readonly step: WorkflowStep;
  /** Every path the predicate compares that resolved to nothing. */
  public readonly paths: string[];
  constructor(step: WorkflowStep, paths: string[]) {
    super(
      `Step ${step.stepId} has a condition reading ${paths.map((p) => `"$.${p}"`).join(', ')}, `
      + 'which this run does not carry. The predicate was not evaluated: a comparison against '
      + 'a value that is absent is not a decision.',
    );
    this.name = 'ConditionInputMissingError';
    this.step = step;
    this.paths = paths;
  }
}

/** A loop's collection did not resolve to an array, so the loop's body ran
 *  ZERO times.
 *
 *  This is the third contract defect, and it is the quietest. A template that
 *  cannot resolve throws; a condition with no input throws; a loop whose
 *  collection is absent simply iterates nothing and reports success, so the
 *  step did not fail — it never happened. The validator has refused the
 *  unresolvable AUTHORED forms as fatal since `loopCollectionRef` landed, on
 *  exactly that reasoning; this is the same property at runtime, where the path
 *  is authored correctly and the producing step did not put a collection there.
 *
 *  `onFailure` is the wrong route for it, for the reason it is the wrong route
 *  for the other two: `onFailure` means "this operation can fail in the course
 *  of business, and here is what to do about it". A battle-card step taking its
 *  failure branch on `Loop.over did not resolve to an array` lets the run walk
 *  on to delegation and write its digest with zero battle cards written by a
 *  step whose own description is one card per competitor. Presented as an
 *  anticipated business condition, a step that never ran reads as a step that
 *  had nothing to do.
 *
 *  `absent` separates the two causes the one message used to cover, because the
 *  recovery turn needs them apart: a MISSING key is the producing step never
 *  recording it, and a present non-array is the producing step recording the
 *  wrong shape. */
export class LoopCollectionUnresolvedError extends Error {
  public readonly step: WorkflowStep;
  /** The `loop.over` string as authored. */
  public readonly over: string;
  /** True when the path resolved to nothing; false when it held a non-array. */
  public readonly absent: boolean;
  constructor(step: WorkflowStep, over: string, received: unknown) {
    const absent = received === undefined || received === null;
    super(
      `Step ${step.stepId} loops over "${over}", which `
      + (absent
        ? 'resolved to nothing, so the loop iterated zero times and the step never ran. '
          + 'The step that produces that value did not record it.'
        : `resolved to ${Array.isArray(received) ? 'an array' : typeof received} rather than an `
          + 'array, so the loop iterated zero times and the step never ran.')
      + ' An empty collection is an empty array.',
    );
    this.name = 'LoopCollectionUnresolvedError';
    this.step = step;
    this.over = over;
    this.absent = absent;
  }
}

export class OutputShapeMismatchError extends Error {
  public readonly step: WorkflowStep;
  public readonly received: unknown;
  constructor(step: WorkflowStep, received: unknown) {
    super(`Step ${step.stepId} outputField "${step.outputField}" did not resolve in tool result`);
    this.name = 'OutputShapeMismatchError';
    this.step = step;
    this.received = received;
  }
}
export class AnomalousValueError extends Error {
  public readonly step: WorkflowStep;
  public readonly value: unknown;
  public readonly reason: string;
  constructor(step: WorkflowStep, value: unknown, reason: string) {
    super(`Semantic validation failed for step ${step.stepId}: ${reason}`);
    this.name = 'AnomalousValueError';
    this.step = step;
    this.value = value;
    this.reason = reason;
  }
}

// Raised when the vendor SDK (via the adapter) requests a pause during
// a workflow llm_reason step. The outer hybrid loop converts this into
// either createClarificationPause (ask_user) or createHitlPause
// (hitl_gate) and persists HybridResumeState so a resume re-enters the
// same step.
export class AdapterPauseRequestedError extends Error {
  constructor(
    public readonly question: string,
    public readonly pauseReason: 'ask_user' | 'hitl_gate' | 'self_wake',
    /** Present when pauseReason === 'hitl_gate' AND the pause was triggered
     *  by the registered hitlGate's `hitlPause` signal (oversight). The
     *  outer hybrid loop's catch uses this to populate hitlContext on the
     *  HybridResumeState (approvalId + pendingToolCalls). */
    public readonly gateContext?: {
      gateReason: string;
      pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      matchedCategory?: string;
      /** What was measured, when the pause was triggered by the SIZE of the
       *  change rather than its kind. Mirrors `PauseGateContext`. */
      measuredReasons?: string[];
      /** The gate's own detail line and record, when it states them.
       *  Mirrors `PauseGateContext`. */
      detail?: string;
      context?: Record<string, unknown>;
    },
    /** Adapter resume token captured at pause time. Persisted in
     *  HybridResumeState.hitlContext.adapterResumeToken so the resume path
     *  can re-invoke the adapter past the gated dispatch. */
    public readonly resumeToken?: { adapterKind: string; serialized: string },
    /** Present when pauseReason === 'self_wake' — the validated wake spec + provenance the
     * outer catch hands to createWakePause. */
    public readonly wakeContext?: import('./adapter/types').WakeContext,
    /** The paused step's own transcript, when pauseReason === 'self_wake' was raised
     *  inside a workflow adapter step: what the model said and called during that
     *  turn, ending with the wake-producing call and its marker. The outer catch
     *  persists it so the wake can re-enter the step with its conversation rather
     *  than fail it as unresumable. */
    public readonly stepTranscript?: ConversationMessage[],
  ) {
    super(`Adapter requested pause (${pauseReason}): ${question}`);
    this.name = 'AdapterPauseRequestedError';
  }
}

// Tool call request from LLM
export interface ToolCallRequest {
  id: string;
  connector: string;
  entityType: string;
  actionType: string;
  payload: Record<string, unknown>;
}

// Result from executing a tool call
export interface ToolCallResult {
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  /** The call itself, when the recorder of the result saw its start. Set by
   *  both adapter loops off the engine's `tool_call_started` event; absent
   *  when the finish arrived for an id nothing had started. Typed here rather
   *  than cast in at each site, because `toolCallsForPersistence` reads it
   *  ahead of the trajectory recorder's `tool_use` by id: engines that number
   *  calls `item_0, item_1, …` per turn reuse ids across turns, and the
   *  recorder's last write for an id is not this call. */
  name?: string;
  input?: Record<string, unknown>;
  // ── Structured tool-error contract (populated only when success = false).
  // Carried from the ExecuteResult so workflow recovery + anomaly mapping read
  // the classified cause instead of regex-grepping the message. ──
  errorCode?: ToolErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  recovery?: string;
}

/** How a run ended, as a single discriminated value.
 *
 *  `success` and `escalated` are independent booleans that six of the seven
 *  escalation paths set BOTH of, so consumers that tested them in different
 *  orders disagreed about the same run: invocations.outcome and thread status
 *  read `success` first and recorded an escalated run as a clean success, while
 *  runtime status and run state read `escalated` first and got it right.
 *  Everything terminal now resolves through resolveTerminalState(). */
export type TerminalState =
  | 'success'       // objective met
  | 'task_failed'   // a reasoning agent deliberately concluded it cannot be done
  | 'escalated'     // handed to a human by design
  | 'gated'         // governance stopped the run
  | 'stopped'       // user-initiated stop (an abort signal, not a failure)
  | 'limit_reached' // ran out of its configured budget mid-work, not a fault
  | 'engine_error'  // engine / infrastructure failure
  // Stopped at a step boundary because the invocation ran out of wall clock,
  // with its own continuation already scheduled. It resumes BY ITSELF and
  // nobody owes it anything.
  //
  // Split from 'paused' because every consumer of that value reasonably reads
  // it as "a person owes this run a decision" — that is what the three total
  // maps below it say, and it is not true of a wall-clock continuation. Read
  // as 'paused', a parked run would report the agent WAITING_FOR_HUMAN, the
  // thread 'waiting_on_human' and the invocation 'gated', while nothing had
  // been asked of anyone — a fired continuation and no approval request
  // anywhere.
  | 'parked'
  // Suspended awaiting something outside the run: a human decision (HITL
  // approval, ask_user), or a scheduled wake. NOT terminal in the sense of
  // "finished" — the run resumes — but terminal for THIS pass, which is what
  // this type describes.
  //
  // It is a member because it has to be. A pause used to be expressed only as
  // the out-of-band `TaskExecutionResult.paused` boolean while terminalState
  // stayed undefined, so resolveTerminalState fell through to `success` and
  // every consumer downstream treated a run waiting on a person as a finished
  // one: the agent went IDLE, the invocation recorded outcome 'success', and
  // the thread read 'completed' — directly against the invariant stated on
  // THREAD_STATUS_BY_TERMINAL. Correctness depended on each author remembering
  // to check a boolean the type never mentioned, and most did not; the same
  // defect surfaced four separate times before the missing member was found.
  //
  // Being in the union means the Record<TerminalState, …> maps below no longer
  // compile until every consumer says what a pause means to it.
  | 'paused';

// Task execution result
export interface TaskExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  toolCallsExecuted: number;
  reasoningSteps: number;
  /** True when a user-initiated abort ended the run early. */
  stopped?: boolean;
  escalated?: boolean;
  escalationId?: string;
  /** Authoritative terminal state. When set it wins over success/escalated;
   *  legacy producers may omit it and resolveTerminalState() derives it. */
  terminalState?: TerminalState;
  /** Recorded by the site that knows WHY the run failed; written straight
   *  through to invocations.failure_class. A failure state with no explicit
   *  class is persisted as 'unknown' rather than NULL. */
  failureClass?: import('../invocations/types').FailureClass;
  /** What the PROVIDER said, structured, when the engine had something
   *  structured to read. Carried alongside `failureClass` rather than folded
   *  into it: the class is our derived label and this is the evidence, and
   *  keeping both is what lets a mislabelled failure be found. Written through
   *  to invocations.provider_failure_* on completion. */
  providerFailure?: import('./adapter/provider-failure').ProviderFailureInfo;
  /** Mid-run problems the adapter reported, whether or not the run recovered
   *  from them.
   *
   *  Present so a CALLER can see them. A run started by a person surfaces
   *  trouble through the transcript and /activity, but a run started by another
   *  agent has a caller waiting on a single return value — and a delegated child
   *  that hit three connector errors and recovered is materially different from
   *  one that sailed through, in a way the answer text alone does not convey.
   *  Accumulated regardless of the recovery decision, so this is a record of
   *  what happened rather than only of what proved fatal. */
  anomalies?: Array<{ kind: import('./adapter').AnomalyKind; context: import('./adapter').AnomalyContext }>;
  /** Workflow steps whose output was produced by a salvage turn: the step was
   *  interrupted after doing read-only work and finished from the material its
   *  tools had already returned (see the loop's step-salvage boundary). Set in
   *  ONE place, `finishRunResult`, from `ExecutionState.salvagedSteps`, so a
   *  pause, a failure or an escalation after the salvage keeps the list. The
   *  invocation's completion audit names them in `outputSummary`; a
   *  delegating parent reads them off `DelegationResult.salvagedSteps`. */
  salvagedSteps?: string[];
  /** The run's LIVE content trust at the moment it settled, off the run's own
   *  TrustRef. A run starts at its caller-derived trust and can only be
   *  ELEVATED by what it reads (read_agent_messages taint and the like), so
   *  the final value is the honest answer to "may what this run produced be
   *  treated as trusted content". Carried for delegation: the detached A2A
   *  delivery reports the CHILD's final trust, and hardcoding either constant
   *  is wrong in a different direction — permanent taint on the majority, or
   *  laundering for the child that read untrusted content mid-run. */
  finalTrustLevel?: 'trusted' | 'untrusted_inbound';
  /** Tokens this run spent, for a caller that has to report them.
   *
   *  The invocation row is the billing record and remains authoritative; this is
   *  the same numbers handed back in-process so a delegating parent does not
   *  have to re-read its child's row to answer for the spend it caused. */
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  /** This turn's vendor-neutral messages, for the CHAT path to persist onto the
   *  session row after its native save has created that row.
   *
   *  Handed back rather than written here because the two halves have opposite
   *  timing constraints. The snapshot must be TAKEN inside executeTask, before
   *  `writeTrajectoryIfEnabled` releases the recorder buffer. The write must
   *  happen AFTER `saveChatSessionJsonl`, which owns row creation — a canonical
   *  UPDATE issued first matches no row on the opening turn of a thread and is
   *  silently dropped, so every single-turn conversation had no canonical copy
   *  at all and could only ever cold-start on an engine change.
   *
   *  Unset for the autonomous path, which checkpoints onto a row it already has
   *  and writes its own copy inline. */
  canonicalSnapshot?: import('../trajectories/recorder').CanonicalSnapshot;
  /** Workflow suspended on a delay step; the resume task is in flight.
   *  Workflow executor returns success:true with paused:true and the resume time
   *  so the calling Cloud Tasks request returns 200 cleanly. */
  paused?: boolean;
  /** Durably re-enqueued on contention — NOT a failure. */
  deferred?: boolean;
  resumeAt?: string;
  pausedAtStepId?: string;
  /** Populated when paused for human input (createClarificationPause /
   *  createHitlPause). Lets the interactive-chat handler surface the pause to
   *  the user instead of treating it as a silent completion:
   *  - 'ask_user'      → emit `awaiting_input { question, sessionId }` (the user
   *                      types an answer; the thread-state router resumes via
   *                      the clarification row keyed by clarificationSessionId).
   *  - 'hitl_approval' → emit `hitl_required { approvalId, reason }`; the operator
   *                      approves/rejects out-of-band in /dashboard/review and the
   *                      SAME run resumes to completion (no silent `complete`). */
  //  - 'continuation'  → the run ran out of wall clock at a step boundary and
  //                      is picking up in a fresh invocation. Not a failure and
  //                      not a question: nothing is asked of the reader, and the
  //                      result is delivered to the thread when it lands.
  pauseKind?: 'ask_user' | 'hitl_approval' | 'self_wake' | 'continuation';
  /** The question (ask_user) or gate reason (hitl_approval) shown to the user. */
  clarificationQuestion?: string;
  /** The agent_scheduled_invocations row id the user's answer resumes against. */
  clarificationSessionId?: string;
  /** The hitl_approval_requests id for a `hitl_approval` pause. The chat-turn
   *  handler surfaces it as the `hitl_required { approvalId }` terminal frame so
   *  the caller (web UI / MCP durable-run worker) can track the pending approval
   *  and, on resume, correlate the completed run. Unset for `ask_user`. */
  approvalId?: string;
  /** Approval-card summary (see agent-execution/hitl-card-content.ts) for a
   *  `hitl_approval` pause. The chat-turn handler puts these on the `hitl_required`
   *  frame so the MCP durable-run worker / web UI can relay the same Action/Why/Details
   *  the card + dashboard show. Null when the generic-card flag is off. */
  actionSummary?: string | null;
  whySummary?: string | null;
  detail?: string | null;
  /** Concrete engine that executed a resume, surfaced by the resume primitives so
   *  the resume dispatcher can emit engine-sliced pause/resume telemetry without
   *  re-reading the persisted pause state. Unset on early failures that return
   *  before the engine is resolved. */
  executionEngine?: ExecutionEngineId;
  /** Set on an idempotent resume no-op — a duplicate/replayed resume delivery that
   *  lost the atomic claim, hit an already-fired row, or found the approval still
   *  pending. The resume dispatcher skips the attempt/duration telemetry for these
   *  so a redelivery never inflates the resume denominators or an engine's success
   *  rate. Not a failure: the original resume already ran (or will). */
  resumeNoop?: boolean;
}

// Execution step for audit logging
export interface ExecutionStep {
  stepNumber: number;
  type: 'reasoning' | 'tool_call' | 'checkpoint' | 'escalation';
  timestamp: Date;
  input?: unknown;
  output?: unknown;
  durationMs: number;
}

// Configuration for execution limits
export interface ExecutionLimits {
  maxReasoningSteps: number;
  maxToolCalls: number;
  maxExecutionTimeMs: number;
  maxRetryAttempts: number;
}

// Default execution limits
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxReasoningSteps: 50,
  maxToolCalls: 100,
  maxExecutionTimeMs: 30 * 60 * 1000, // 30 minutes
  maxRetryAttempts: 3,
};

// Execution state tracked during task execution
export interface ExecutionState {
  context: ExecutionContext;
  reasoningSteps: number;
  toolCallsExecuted: number;
  startTime: Date;
  steps: ExecutionStep[];
  conversationHistory: ConversationMessage[];
  pendingToolCalls: ToolCallRequest[];
  completedToolCalls: ToolCallResult[];
  // Circuit breaker — tracks failures by (connector, actionType, payload-fingerprint).
  // The execution loop terminates with an error if any single tuple exceeds
  // MAX_REPEAT_FAILURES (see service.ts). Prevents the LLM from looping on a
  // permanent error (expired credentials, missing IAM, malformed args, etc.) and
  // burning the entire reasoning-step budget on one broken tool call.
  toolFailureCounts: Map<string, number>;
  // IDs of skills injected into the system prompt for this invocation.
  // Populated by buildSystemPrompt(); read after execution for usefulness tracking.
  injectedSkillIds: string[];
  /** The deadline on this run's setup (pre-engine-watchdog.ts). The loop calls
   *  `engineStarting()` where the engine or the workflow graph takes over;
   *  absent on paths that enter the loop without a fresh setup. */
  preEngineWatchdog?: import('./pre-engine-watchdog').PreEngineWatchdog;
  /** Set by invokeStepLLM when an adapter step's SDK session was durably written
   *  on a pause. The pause reads it to mark itself structured-resumable only when
   *  the exact turn can actually be restored; false/undefined routes the resume
   *  to the snapshot path, which fails the adapter step closed. */
  stepSessionPersisted?: boolean;
  /** The catalog the CURRENT workflow step registered on its engine — the same
   *  object `runAdapterHitlGate` receives for that step. Set by invokeStepLLM
   *  once it has built it, so the loop's salvage boundary can resolve the
   *  step's completed calls against the tools the step actually had, and
   *  refuse to salvage past any call that does not resolve to a read. */
  stepCatalog?: import('./adapter/catalog-types').McpToolCatalog;
  /** Workflow steps this run salvaged (see the loop). The loop's own Set,
   *  hydrated from the resume payload on a continuation, so `finishRunResult`
   *  can project it onto the result from one place. */
  salvagedSteps?: Set<string>;
  /** Per step: the mutating calls that step has already completed, so a retry of
   *  it — or a resume that re-dispatches it — answers an identical call with that
   *  call's own recorded result rather than performing the write a second time.
   *
   *  THE SAME Map as `WorkflowLoopState.stepReplay`, for the reason
   *  `salvagedSteps` is the same Set: the loop owns it and carries it on every
   *  pause, while the seams that consult it only have `state`.
   *
   *  Written by four sites, each holding evidence the others do not. The loop's
   *  catch records the step's own MODEL-issued calls, which reach
   *  `completedToolCalls` with their tool names. `executeToolStep` and
   *  `executeLoopStep` record from the REQUEST, because the result they push
   *  carries no name at all and the catch would skip it.
   *  `executeRecoveryCalls` records each proposal it dispatches, so a re-ask of
   *  the same proposal replays rather than repeats.
   *
   *  Read by four sites too: the gateway's tool wrapper (a model-issued call in a
   *  re-dispatched turn), those same two dispatch sites, and the recovery
   *  dispatch. An entry exists only for a step that has already run, which is
   *  what makes "an attempt that already happened" a fact about the data rather
   *  than a flag a caller must remember. See `step-replay-ledger.ts`. */
  stepReplay?: Map<string, import('./step-replay-ledger').StepReplayLedger>;
  /** Memoised `ModelTool[]` for the registered adapter hitlGate's
   *  oversight `checkHitlGate` call. Rebuilding per-call walks the entire MCP
   *  catalog and burns a few ms × every tool the LLM emits, so it is cached —
   *  but keyed to the CATALOG it was built from, not to the invocation.
   *
   *  A workflow run does not have one catalog. Each step builds its own, and a
   *  step declaring `outputField` registers `record_step_output` that no other
   *  step's catalog contains. Cached once per invocation, the list was whatever
   *  the FIRST gated step happened to see, and every tool added later resolved
   *  to undefined — which the untrusted-inbound invariant reads as unknown and
   *  fails closed on. See the guard at its rebuild site. */
  cachedModelTools?: ModelTool[];
  /** The catalog `cachedModelTools` was built from. Identity comparison only:
   *  a step builds one catalog object and reuses it for every call it makes, so
   *  this keeps the cache hitting within a step while rebuilding across steps. */
  cachedModelToolsSource?: unknown;
  /** Set when oversight blocked or paused this run, so completion can record
   *  outcome='gated' (migration 329) instead of letting a governance stop masquerade
   *  as a clean run — blocked by the gate, no approval created, nothing on
   *  /dashboard/review, yet recorded outcome='success'.
   *  `result.escalated` cannot carry this — it means the agent handed off to a human
   *  by design, which is a normal successful outcome. */
  governanceStopped?: boolean;
  /** The run's shared mutable trust cell. `context.trustLevel` reads through it and
   *  read_agent_messages writes to it, so a mid-run taint upgrade is visible to the
   *  gate, SSRF scan, audit, and delegate/spawn inheritance. */
  trustRef?: TrustRef;
  /** Memoised per-run resolution of the `external_content_write_gate_disabled`
   *  operator kill-switch (negative polarity — true means the gate is OFF for this
   *  tenant). Resolved fail-closed (missing/error → false → gate ON) the first time
   *  an untrusted-origin run reaches the adapter gate. undefined = not yet resolved. */
  externalContentGateDisabled?: boolean;
  /** The injection screen's verdict for an untrusted-inbound run — otherwise a
   *  discarded local — stashed so an external_content_write approval can attach it
   *  as provenance ({ finding, mode }). */
  injectionScreenVerdict?: { finding: unknown; mode: string };
  /** How much this run has changed so far: entities touched, destructive
   *  operations, fields emptied.
   *
   *  Blast radius has to accumulate. The gate fires once per tool call, so a
   *  per-call check can never see the realistic failure — four hundred deletes
   *  issued one at a time, every individual call unremarkable. Incremented only
   *  after a call is actually dispatched, so a resumed run does not double-count
   *  work the operator already approved. */
  blastRadiusTotals?: { entitiesTouched: number; destructiveOps: number; clearedFields: number };
  /** True iff `corpus_search` was registered in this turn's tool catalog — the
   *  proxy for "the agent has a knowledge base it could have cited". Set when
   *  the platform catalog is built; read by the citation-warning guardrail in
   *  executeToolCalls (ported from the chat SDK hooks so chat AND autonomous
   *  share the once-only governance). */
  hasCorpusSearch?: boolean;
  /** Part 5 §C3 — snapshot of the currently-running delegate_task fan-out so
   *  the HITL pause path can serialize it into HybridResumeState.hitlContext
   *  and reawaitInFlightDelegations can rebuild DelegationResult[] after
   *  operator approval. Set by delegateToAgents at fan-out entry; cleared
   *  to null when the fan-out resolves. */
  inFlightDelegateTaskCall?: {
    parentToolCallId: string;
    idempotencyKey: string;
    childInvocationIds: string[];
    taskSummaries: Array<{ agentId: string; objective: string; inputData?: Record<string, unknown> }>;
    deadlineAt: string;
  } | null;
  /** Part 6 — context the trajectory writer needs at invocation-completion
   *  time. Populated once per invocation (by runConversationalTurnsViaAdapter
   *  after systemPrompt + platformCatalog are built). NULL when the adapter
   *  loop never ran (e.g. workflow-step early-exit). */
  trajectoryContext?: {
    systemPrompt: string;
    objective: string;
    toolDefs: Array<{ name: string; description: string; input_schema: unknown }>;
    /** IDs of the bound vendor-hosted MCP servers (GitHub/Stripe/custom MCP) for
     *  this invocation — the remote McpServerConfig entries. Their tools are
     *  named `mcp__<id>__<tool>` and are reachable by the model but NOT
     *  enumerated in toolDefs (the adapter introspects them from the remote
     *  server), so downstream conformance evaluation needs the server list to
     *  recognise those calls as in-set rather than out-of-set. */
    vendorMcpServers?: string[];
  };
}

// Conversation message for LLM context
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Media this (user) message carries — stills, and video on the engines that
   *  can express one. Set only on the turn a person actually attached something
   *  to; every other message in the history is text, which is why this is
   *  optional rather than a widened `content`. */
  media?: Array<{ mimeType: string; dataBase64: string; alt?: string }>;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
}

// Agent status update event
export interface AgentStatusUpdate {
  agentId: string;
  status: 'IDLE' | 'RUNNING' | 'WAITING_FOR_EVENT' | 'WAITING_FOR_HUMAN' | 'STOPPING' | 'FAILED';
  taskId?: string;
  workflowId?: string;
  updatedAt: Date;
}
