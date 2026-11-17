// VendorSdkAdapter interface — the platform contract for wrapping vendor
// agent SDKs. Every vendor SDK gets one adapter implementing this
// interface. Every platform feature is added once to the interface + each
// adapter. The platform layer above the adapter speaks only platform-
// defined events.
//
// Architectural rationale lives in docs/adr/002-vendor-sdk-adapter-architecture.md.

import type { McpToolCatalog } from './catalog-types';
// Self-wake reuses the reactive-subscription source + predicate shapes. Types-only.
import type { SubscriptionSource, PredicateExpr } from '../../agent-lifecycle/types';
import type { ProviderFailureInfo } from './provider-failure';
import { VENDORS, VENDOR_ENGINE_IDS } from './vendors';
import type { ExecutionEngineId } from './vendors';

/** Platform-defined usage shape. Adapters populate from vendor SDK
 *  token reports. Loose because per-vendor units vary. */
export interface AdapterUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /**
   * Tokens spent WRITING the prompt cache, which Anthropic bills at 1.25x the
   * input rate. A separate count because it is separate money: `cachedTokens` is
   * a cache READ at a tenth of the input rate, and the two differ by 12.5x.
   *
   * Distinct from the cache-write share of `contextTokens` below, which exists
   * to measure how full the window is and is not billable on its own. The rate
   * table has published `cacheWrite5m`/`cacheWrite1h` for every Anthropic model
   * since the table existed; this is the count that lets anything charge for
   * them.
   *
   * Absent on every OpenAI-convention vendor, where writing the cache is free.
   */
  cacheWriteTokens?: number;
  /**
   * What the vendor CHARGED for this call, as the vendor reported it.
   *
   * Set only where a gateway returns a per-call charge. OpenRouter does, on
   * `usage.cost`, and for its models no rate can be accurate in principle: one
   * model is served by many endpoints at different prices (Kimi K3 by nineteen,
   * $1.03 to $4.50 per million input) and a price list cannot say which one took
   * the request. Where this is present it is the only accurate figure there is.
   *
   * Undefined for every direct-API vendor — Anthropic, OpenAI, Google and xAI
   * publish price lists, not charges — and undefined means "price it from the
   * rate table", NEVER zero. A zero booked as a charge is an unbilled call.
   */
  vendorCostUsd?: number;
  /**
   * The WHOLE prompt this call carried, as the provider counted it — cached
   * part included.
   *
   * Separate from `inputTokens` because the two are asked for by different
   * consumers and the vendors disagree about what `inputTokens` means.
   * Anthropic reports `input_tokens` EXCLUSIVE of cache reads and cache
   * writes; OpenAI, Google and the rest report a prompt total that already
   * includes the cached part. `freshInputTokensFor` (llm/pricing.ts) knows
   * that split and BILLING depends on it, so `inputTokens` and `cachedTokens`
   * must keep meaning exactly what they mean today.
   *
   * The context guard cannot use either safely: `input + cached` is short on
   * Anthropic (cache writes are missing) and double-counts on every provider
   * whose input is already inclusive. So each adapter states the one figure
   * the guard needs, in the one place that knows which convention its numbers
   * arrived in. Absent from an adapter that predates the field, and the guard
   * then falls back to `inputTokens`, which is correct for every provider but
   * Anthropic.
   */
  contextTokens?: number;
  webSearchRequests?: number;
  webFetchRequests?: number;
  /** Per-vendor extra usage fields the platform doesn't normalize. */
  raw?: Record<string, unknown>;
}

/** Every resolved provider, as a VALUE.
 *
 *  Derived from the vendor record rather than listed, so a vendor added there is
 *  a provider here on the same edit. The type below derives from this in turn,
 *  because the places that recognise a provider at RUN time cannot read a type —
 *  and each one that hand-listed the members was a place a new provider could be
 *  missed while everything still compiled. Being missed is silent: the usual
 *  fallback for an unrecognised provider is `anthropic`, a working vendor. */
export const RESOLVED_PROVIDERS = Object.keys(VENDORS) as [
  keyof typeof VENDORS,
  ...(keyof typeof VENDORS)[],
];

/** The name a wire engine's agent-level input guardrail calls the HITL gate
 *  with, once, at the door. It is not a tool and must not be gated as one:
 *  admission is the only question it can answer. Shared so the adapter that
 *  sends it and the gate that recognises it cannot drift on the spelling. */
export const AGENT_INVOCATION_GATE_NAME = '__agent_invocation__';

/** Resolved provider — adapter selection is purely a function of this. */
export type ResolvedProvider = keyof typeof VENDORS;

/** Whether a value names a provider this runtime can execute. */
export function isResolvedProvider(v: unknown): v is ResolvedProvider {
  return typeof v === 'string' && (RESOLVED_PROVIDERS as readonly string[]).includes(v);
}

/** Closed, centrally-maintained identity of the CONCRETE outer-agent
 * engine that executed (or will execute) an invocation. Operational metadata,
 * NOT a tenant-extensible registry: a provider maps to one of two engines via a
 * deployment env flag, so `provider` alone cannot tell OpenAI-Agents from Codex,
 * Gemini-GenAI from ADK, or OpenAI-wire from OpenCode. `unknown-legacy` is
 * reserved for pre-provenance rows and is never produced by resolution. */
/** Re-exported: the union is declared beside the vendor record so the compiler
 *  can enforce that every engine a vendor names is a real one. This is where its
 *  callers import it from. */
export type { ExecutionEngineId } from './vendors';

/** The engine ids resolution can actually produce — everything but the
 *  provenance-only sentinel. */
export const RESOLVABLE_EXECUTION_ENGINE_IDS =
  VENDOR_ENGINE_IDS as readonly Exclude<ExecutionEngineId, 'unknown-legacy'>[];

/**.1 decision — nested `code_session` specialist runs record
 * provenance in a SEPARATE typed field (not the outer `ExecutionEngineId`), so
 * an outer OpenAI Codex engine is never conflated with a nested Codex coding
 * task. Used only in trajectory nested-provenance metadata. */
export type NestedSpecialistEngineId =
  | 'claude-code-session'
  | 'codex-code-session'
  | 'gemini-code-session'
  // The open-weights vendors have TWO, because they have two coding CLIs and
  // which one runs is a per-environment switch. This field is provenance, so
  // each id names the engine that actually ran and neither stands in for the
  // other; `nestedEngineFor` derives them from the same switch that selects the
  // runner, so an id cannot outlive the engine it names.
  | 'codex-open-weights-code-session'
  | 'opencode-code-session';

/** Platform-defined message shape (provider-agnostic). Adapters translate
 *  to/from their vendor SDK's message format. */
export interface PlatformMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: PlatformContent[];
  /** Provider detail belonging to THIS message, set only when a conversation is
   *  rebuilt from the canonical record onto an engine that needs it back.
   *
   *  Today's only key is OpenAI's `{ responses_api_id, encrypted_reasoning }`,
   *  which is per-message and un-repairable once flattened into a run-level
   *  array. Adapters that do not recognise a key must ignore it: this is
   *  optional detail a replay can improve on, never something an invocation
   *  depends on. */
  providerData?: Record<string, unknown>;
}

export type PlatformContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolName: string; args: unknown; callId: string }
  | { type: 'tool_result'; callId: string; result: unknown; error?: string }
  /**
   * Media the PERSON attached, carried to whichever vendor is running.
   *
   * ONE member for stills and video, discriminated by `mimeType`, because that
   * is how every renderer and every allow-list in this estate already tells
   * them apart. A separate 'video' member would double each adapter's switch to
   * say the same thing twice: Gemini builds one inlineData part for either, and
   * the engines that cannot carry media cannot carry either kind.
   *
   * Base64 rather than a reference: by the time content reaches an adapter the
   * bytes have already been fetched, and the vendors take media inline in the
   * request body. The type is always one the control plane's gate passed AND
   * the runtime re-checked — png / jpeg / gif / webp, or mp4 / webm where the
   * model and the engine both take video.
   *
   * Every adapter must handle this member EXPLICITLY: carry it as its vendor's
   * own part, or turn it into a sentence saying it could not be shown. Falling
   * through and dropping it is the one outcome that is not allowed, because the
   * model then answers about something it never received and nothing in the
   * answer says so.
   */
  | { type: 'media'; mimeType: string; dataBase64: string; alt?: string };

/** What the adapter receives from the hybrid loop. */
/** What an adapter is handed when the customer's own key funds the run.
 *
 *  Structurally identical to byok/session.ts's ByokCredential and declared here
 *  rather than imported so the adapter package keeps no dependency on the
 *  control-plane client — the adapters are the one part of this that has to run
 *  in certification and canary harnesses with no platform callback configured. */
export interface ByokAdapterCredential {
  /**
   * Whose key the gateway spends on this run.
   *
   *   'byok'            — the customer's own.
   *   'managed_gateway' — Liftoff's own, through the gateway so the tokens on the
   *                       wire are counted.
   *
   * An adapter mostly does not care: both hand it a base URL and a per-run token
   * in place of a key, which is all the wiring is. What it changes is the reason
   * — a managed session exists so the vendor's own response can be read for a run
   * Liftoff is paying for, on the engines whose summary cannot be priced.
   */
  mode: 'byok' | 'managed_gateway';
  /** A door the gateway serves, which is wider than an account a customer can
   *  hold a key for. `openrouter` has no customer-funded side at all — the
   *  invoice is Liftoff's — so it only ever arrives with mode
   *  'managed_gateway'. */
  vendor: 'anthropic' | 'google' | 'openai' | 'xai' | 'openrouter';
  baseUrl: string;
  token: string;
  /** True only for Grok. It predates Grok having its own provider: back then a
   *  customer-funded turn had to LEAVE OpenRouter mid-run, and this said so.
   *  Grok resolves to `xai` either way now, so the re-route is a no-op for a
   *  current config and still correct for one written before the move. */
  rerouteToVendorApi: boolean;
}

export interface InvocationInput {
  messages: PlatformMessage[];
  systemPrompt: string;
  /** Tools this agent's graph ENDS at, derived from steps with no success path.
   *
   *  An adapter that can act on it ends the turn when a round called nothing but
   *  these, saving the model call that exists only to say "done" after the
   *  delivery already happened. Empty for an agent with no graph, which is the
   *  honest answer — a conversational agent has no terminal step, so nothing can
   *  say when it is finished and the loop keeps today's behaviour. */
  terminalToolNames?: readonly string[];
  /** Resolved model identifier — adapter passes through to vendor SDK. */
  model: string;
  provider: ResolvedProvider;
  tenantId: string;
  invocationId: string;
  /** The tool a matched `groundsOn` rule named for this turn, when one
   *  matched.
   *
   *  Present so an adapter whose vendor exposes native forcing can name the
   *  tool on its round-0 request. It is an OPTIMISATION: the host has already
   *  prefetched that read and appended the result, so an adapter that ignores
   *  this is not degraded. Correctness never depends on it — three of the seven
   *  engines cannot force at all, and a guarantee that held on four of them
   *  would be INV-TR-019's failure with a different name. */
  groundingToolName?: string;

  /** The agent this run belongs to.
   *
   *  Distinct from `invocationId`, and the distinction is the point: an
   *  invocation is one run, an agent is the thing whose system prompt and tool
   *  catalog are the same across all of them. Anything grouping runs by what
   *  they have in COMMON — prompt-cache routing, most obviously — keys on this
   *  and never on the invocation. */
  agentId: string;
  /** Optional max-turns cap. Adapters enforce via vendor SDK options. */
  maxTurns?: number;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
  /** Purpose-group hint for billing-attribution routing. Adapters that own
   *  a vendor SDK pool (currently OpenAI via openai/provider.ts) select
   *  the per-purpose API key from this hint. Undefined → 'agent-execution'
   *  group (the routing default in purposeToOpenAIGroup). */
  purpose?: string;
  /** SDK session ID to resume. When set, the adapter passes it to the vendor
   *  SDK's resume option so the conversation continues with prior context
   *  (Claude Agent SDK: `query({ resume: sessionId })`). Undefined → start a
   *  fresh session. Used by interactive chat to carry per-(thread, agent)
   *  conversational continuity across turns. */
  resumeSessionId?: string;
  /** BYO provider keys: the customer's own account funds this run.
   *
   *  Carries a Liftoff gateway base URL and a short-lived per-run token, NEVER
   *  the customer's key. The distinction is the whole point on the Anthropic
   *  path: query() spawns claude-code as a child process, that child is what
   *  runs the agent's Bash tool, and a key in its environment is a key an agent
   *  can print into its own transcript or hand to a prompt-injected web page.
   *  What it can print here is a URL and something revocable.
   *
   *  Undefined on every ordinary run — the adapter then uses the managed pool
   *  exactly as it does today. */
  byok?: ByokAdapterCredential;
  /** Pinned `cwd` for the vendor SDK so the session JSONL lands at a
   *  deterministic path on disk — chat-turn-handler can then restore the
   *  externalized transcript from chat_sessions before the SDK reads it
   *  for resume, and capture the updated transcript afterward. When set,
   *  the adapter passes it as `cwd` on the Claude Agent SDK `query()` call;
   *  the SDK encodes it into the project directory under
   *  `<HOME>/.claude/projects/`. Undefined → SDK uses process.cwd(). */
  sessionStateDir?: string;
}

/** Pending tool call shape carried through the HITL pause-and-resume
 *  contract. Matches `hitl-enforcement/types.ts#ToolCallRequest` so the
 *  outer hybrid loop can thread it directly into createApprovalRequest. */
export interface PendingHitlToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Gate context attached to a pause_requested event when the pause was
 *  triggered by an oversight HITL gate (not an admin pause or vendor
 *  guardrail). Outer hybrid loops use this to createApprovalRequest +
 *  persist a hitl_approval row with the right pendingToolCalls. */
export interface PauseGateContext {
  gateReason: string;
  pendingToolCalls: PendingHitlToolCall[];
  matchedCategory?: string;
  /** How the gate classified the pending calls when it fired: the tools as it
   *  saw them and the run facts the reasons depend on. Persisted on the
   *  approval so what the yes covered can be recomputed at approval and at
   *  consumption. Never the settings — those are read live both times. */
  gateView?: {
    tools: Array<{ name: string; description?: string; effect?: 'read' | 'write' | 'spawn'; categories?: string[]; writeRole?: 'stage' | 'apply' | 'direct' }>;
    trustLevel?: 'trusted' | 'untrusted_inbound';
    externalContentGateDisabled?: boolean;
    triggerTarget?: unknown;
    declaredStep?: unknown;
    runningTotals?: { entitiesTouched: number; destructiveOps: number; clearedFields: number };
  };
  /** What was measured, when the pause was triggered by the SIZE of the change
   *  rather than its kind. The card renders one static label per reason, so
   *  "would archive 14 records" has nowhere else to go — without this the
   *  approver sees that a large change is pending but not how large. */
  measuredReasons?: string[];
  /** The gate's own detail line, when it states one: which contract the
   *  contract check judged against and the recorded probability. */
  detail?: string;
  /** The gate's own record for the approval's `context` column
   *  (`contract_check = { kind, stepId?, p }`). */
  context?: Record<string, unknown>;
}

/** Events the adapter emits during an invocation. */
export type InvocationEvent =
  /** Incremental assistant text as the vendor SDK streams tokens. Additive:
   *  consumers that don't stream (autonomous) ignore it; the streaming chat
   *  layer forwards it as an SSE text_delta. Always followed by a terminal
   *  `assistant_message` carrying the complete content for history/accounting. */
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_message'; content: PlatformContent[] }
  /** A fragment of a tool call's ARGUMENTS as the vendor streams them, before
   *  the call is complete. Additive, like `assistant_delta`: consumers that do
   *  not stream ignore it, and the complete call still arrives as
   *  `tool_call_started` when the block closes. A consumer reassembles the
   *  arguments by concatenating `partialJson` per `callId` in order; the
   *  fragments are not individually parseable.
   *
   *  Only an engine that streams argument deltas emits it. The Claude Agent SDK
   *  does (`content_block_start` names the tool and its block index,
   *  `input_json_delta` blocks follow by index); so do the OpenAI-wire engines
   *  — OpenAI and xAI through the Responses API's `output_item.added` +
   *  `function_call_arguments.delta`, OpenRouter through Chat Completions'
   *  `delta.tool_calls[]` — read off the Agents SDK's raw `model` events, since
   *  its typed union carries no argument delta (openai-wire/argument-deltas.ts).
   *  The Google SDKs stream whole parts; the external loops emit nothing
   *  partial. */
  | { type: 'tool_call_partial'; callId: string; toolName: string; partialJson: string }
  | { type: 'tool_call_started'; toolName: string; args: unknown; callId: string }
  /** A workflow step is about to run.
   *
   *  The step loop is the ONE shape of run that produced no stream events at
   *  all: the sink is fed from the conversational adapter loop, so a
   *  workflow-shaped run sent nothing to the chat until it finished, and a
   *  sixteen-step run left a person watching an empty thread for ten minutes.
   *  Emitted at the top of the loop, where the cursor is already known. */
  | { type: 'workflow_step_started'; stepId: string; index: number; total: number }
  | {
      type: 'tool_call_finished';
      callId: string;
      result: unknown;
      error?: string;
      /** True when the engine handed this call's result to the registered
       *  `ToolResultObserver`, waited, and the observer said it was
       *  remembered — before the model saw the result. A listener that
       *  remembers calls off the stream skips such a call: it was remembered
       *  where the ordering could be guaranteed, and the stream's own timing
       *  cannot guarantee anything. Absent when the observer failed or timed
       *  out, so the stream listener still remembers the call, late. */
      recordedAtDispatch?: boolean;
      /** The id the bridge dispatched and recorded the call under, when it
       *  differs from `callId`: the HTTP-MCP engines never hand the bridge
       *  their own id, so the bridge issues one and returns it on the result.
       *  A listener remembering this call off the stream records under THIS
       *  id, so a record the bridge already wrote is the same row, not a
       *  second one. */
      dispatchCallId?: string;
    }
  | {
      type: 'pause_requested';
      reason: PauseReason;
      token: ResumeToken;
      /** Present only when reason === 'hitl_gate' AND the pause was triggered by
       *  the registered hitlGate's `hitlPause` signal (oversight). Absent for
       *  admin pauses and vendor-builtin tripwires. */
      gateContext?: PauseGateContext;
      delegationContext?: PauseDelegationContext;
      /** Present only when reason === 'self_wake'. Carries the validated wake spec + provenance so
       * the core engine's createWakePause can persist the wake row + arm the trigger. */
      wakeContext?: WakeContext;
    }
  | { type: 'anomaly_detected'; kind: AnomalyKind; context: AnomalyContext }
  | { type: 'usage'; usage: AdapterUsage }
  /** Emitted once near the start of the vendor stream with the SDK's session
   *  identifier. For Claude Agent SDK this is the `session_id` from the
   *  `system` init message. Consumed by the interactive-chat handler so the
   *  control plane (platform-backend) can persist it per (thread, agent) and
   *  pass it back as `resumeSessionId` on the next turn. */
  | { type: 'session_started'; sessionId: string }
  /** `limit_reached` is the run hitting a ceiling WE configured — a turn budget,
   *  a provider's own cap — while still working. Every engine has its own name
   *  for it (Anthropic `error_max_turns`, Gemini a non-normal `finishReason`,
   *  the hybrid loop its own bound); each adapter translates into this one, the
   *  way vendor tool errors already translate into the shared error contract.
   *  Collapsing it into `error` made a run that had done its work
   *  indistinguishable from a crash. */
  | {
    type: 'completion';
    outcome: 'success' | 'error' | 'escalated' | 'limit_reached';
    reason?: string;
    /** What the PROVIDER said went wrong, read from the thrown error's
     *  structured fields rather than inferred from its message. Present only on
     *  a failing terminal, and only when the engine had something structured to
     *  read; `classifyFailure` falls back to its prose path when it is absent. */
    failure?: ProviderFailureInfo;
  };

export type PauseReason = 'ask_user' | 'hitl_gate' | 'admin' | 'delegation' | 'self_wake';
export interface PauseDelegationContext { parentTaskId: string; parentToolCallId: string; childTaskIds: string[]; deadlineAt: string; }

// ── Self-wake ──────────────────────────────────────────────────
export type WakeKind = 'timer' | 'event' | 'job' | 'poll';
// DEVIATION from: `AgentChatChannel` lives in platform-backend (agent-chat/
// chat-repository.ts) and cannot be imported into TR. Use a local union with the same members.
export type WakeOriginSurface = 'web' | 'slack' | 'teams' | 'mcp';

/** A single wake condition (discriminated by kind). filter/until reuse the RE2 PredicateExpr; event
 * source is the authorized SubscriptionSource subset (see wake-tool-handler). `label` (optional,
 * agent-chosen) is the stable handle the agent passes to cancel_wake — it makes the wake's context_ref
 * deterministic and agent-knowable (the invocationId is not). These are also the member conditions of
 * a wait-set (wake_on_any / wake_on_all). */
export type WakeConditionSpec =
  | { kind: 'timer'; firesAt: string; note: string; label?: string }
  | { kind: 'event'; source: SubscriptionSource; filter: PredicateExpr; ttlSeconds: number; note: string; label?: string }
  | { kind: 'job'; childInvocationId: string; ttlSeconds: number; note: string; label?: string }
  | {
      kind: 'poll';
      checkTool: string;
      checkArgs: Record<string, unknown>;
      until: PredicateExpr;
      intervalSeconds: number;
      maxAttempts: number;
      note: string;
      label?: string;
    };

/** The agent-declared wake spec: a single condition, or a wait-set that resumes when ANY (or ALL) of
 * its member conditions fire. A wait-set cannot nest another wait-set. */
export type WakeSpec =
  | WakeConditionSpec
  | { kind: 'waitset'; mode: 'any' | 'all'; conditions: WakeConditionSpec[]; note: string; label?: string };

export interface WakeContext {
  spec: WakeSpec;
  originSurface?: WakeOriginSurface;   // undefined = autonomous (no chat origin)
  /** Server-set run trust captured at pause (never model-provided). Resume trust = max(this, payload). */
  originTrust: 'trusted' | 'untrusted_inbound';
  /** PB-supplied chat-message cursor for the native-resume staleness gate. */
  threadRevision?: number;
  /** Self-wake lineage; increments across ALL wake kinds. */
  wakeChainDepth: number;
}

/** Opaque token — adapters round-trip it through HybridResumeState. */
export interface ResumeToken {
  adapterKind: string;
  serialized: string;
}

/** Anomaly kinds match the existing hybrid loop's anomaly taxonomy
 *  (12 kinds). Adapters detect tool-result errors / unexpected stop
 *  reasons / etc and translate to these. */
export type AnomalyKind =
  | 'tool_call_error'
  | 'tool_missing'
  | 'invalid_args'
  | 'rate_limited'
  | 'context_overflow'
  | 'unexpected_stop'
  | 'malformed_output'
  | 'semantic_validation_failed'
  | 'tool_timeout'
  | 'auth_failed'
  | 'connector_missing'
  | 'unknown';

export interface AnomalyContext {
  toolName?: string;
  /** The model's own id for the call that failed. What lets the strike ledger
   *  fold a model turn's rejections into one strike: a batch boundary names
   *  the ids it closes, and nothing else the runtime sees is ordered against
   *  the hooks that report a rejection. */
  callId?: string;
  /** The arguments the model sent. A strike is a repeat of the SAME call, so
   *  the ledger keys on these with the tool name — two different URLs both
   *  returning not_found are two facts, not one tool failing twice. */
  args?: unknown;
  error?: string;
  rawData?: unknown;
}

/** Result of a HITL gate decision.
 *
 *  Runtime branches (the order matters for the adapter's interpretation):
 *  - `allow === true` → admit the tool call.
 *  - `allow === false && hitlPause` → oversight requires human approval.
 *    The adapter MUST NOT report this as a deny-and-continue; it MUST stop
 *    the invocation cleanly and emit `pause_requested(reason: 'hitl_gate',
 *    gateContext)` so the outer hybrid loop can createApprovalRequest +
 *    createHitlPause. Treating this as a plain deny is the bug this
 *    contract was widened to prevent (see
 *  - `allow === false && !hitlPause` → hard deny (admission denied, kill
 *    switch, etc). The adapter reports deny to the SDK; the LLM sees a
 *    tool error. */
export interface HitlGateResult {
  allow: boolean;
  reason?: string;
  hitlPause?: PauseGateContext;
  /** The arguments to dispatch INSTEAD of the ones the model proposed, when a
   *  human reviewer approved a rewritten version.
   *
   *  Only ever set alongside `allow: true`, and only on a structured HITL
   *  resume. The model re-proposes its own draft on resume — the edit never
   *  reached it — so the gate matches on what the model sent and substitutes
   *  what the person approved on the way out. The SDK's `updatedInput` is the
   *  seam that makes this possible; `applyCommentAuthorship` already rides it. */
  updatedInput?: Record<string, unknown>;
}

/** HITL gate callback — adapter invokes before each tool call.
 *
 *  `callId` is the engine's own id for the call — the id the trajectory
 *  recorder holds the same call under — when the engine has one at the gate
 *  (the Claude SDK's toolUseID, the model's call id on the bridge engines).
 *  A pause stamps it on the pending call, so a resume can find the call in
 *  the checkpointed record by identity. Absent where nothing has an id yet. */
export type HitlGate = (input: {
  toolName: string;
  args: unknown;
  tenantId: string;
  invocationId: string;
  callId?: string;
}) => Promise<HitlGateResult>;

/** Recovery-LLM hook — adapter invokes on detected anomaly. Returns
 *  either a new user-message to inject, or null to let the error
 *  bubble. */
export type AnomalyHandler = (input: {
  kind: AnomalyKind;
  context: AnomalyContext;
  invocationId: string;
}) => Promise<{ injectMessage?: PlatformMessage; escalate?: boolean }>;

/** Tool-batch boundary hook — see VendorSdkAdapter.registerToolBatchHandler. */
export type ToolBatchHandler = (callIds: string[]) => Promise<void> | void;

/** One tool call's outcome, as the tool produced it — see
 *  VendorSdkAdapter.registerToolResultObserver. */
export interface ToolResultObservation {
  /** The name the model called, in the engine's own form. */
  toolName: string;
  /** The arguments that were dispatched. */
  args: Record<string, unknown>;
  /** The model's id for the call, when the engine has one. */
  callId?: string;
  /** What the tool RETURNED, before anything rewrote it for the model. */
  result: unknown;
  /** Why the call failed, when it did — including a call the engine refused
   *  to dispatch at all. */
  error?: string;
}
/** Resolves TRUE when the call is remembered — the record exists before the
 *  model sees the result — and FALSE when it is not (the store failed or did
 *  not answer in time). An engine marks a call `recordedAtDispatch` only on
 *  true; on false the stream listeners remember it, late, as before. */
export type ToolResultObserver = (observation: ToolResultObservation) => Promise<boolean>;

/** User message — used by injectMessage and resume. */
export interface UserMessage {
  text: string;
  /** Optional sender metadata. */
  source?: 'human' | 'system' | 'interrupt';
}

export interface UserResponse {
  text: string;
}

/** The perpetual platform contract. */
export interface VendorSdkAdapter {
  /** True when the wrapped SDK owns conversation history and compacts it
   *  itself (the Claude Agent SDK does; the raw OpenAI / Gemini loops do not).
   *  When false or absent, the platform holds the history in
   *  runConversationalTurnsViaAdapter and is the only thing standing between a
   *  long conversation and a provider "context length exceeded" rejection —
   *  see agent-execution/context-pressure.ts. */
  readonly managesOwnContext?: boolean;

  /** Run an agent invocation through the wrapped vendor SDK. Returns
   *  an AsyncIterable that emits a stream of InvocationEvents and
   *  terminates after a `completion` event. */
  invoke(input: InvocationInput, signal: AbortSignal): AsyncIterable<InvocationEvent>;

  /** Inject a new user message into the in-flight invocation. */
  injectMessage(message: UserMessage): Promise<void>;

  /** Pause the invocation and persist state. Returns a resume token
   *  the platform stores in HybridResumeState. */
  pause(reason: PauseReason): Promise<ResumeToken>;

  /** Resume from a prior pause. */
  resume(token: ResumeToken, response: UserResponse, signal: AbortSignal): AsyncIterable<InvocationEvent>;

  /** Register the tool catalog. Called once per invocation before
   *  invoke(). The adapter translates MCP definitions to its vendor's
   *  native tool format (Anthropic: mcpServers config; OpenAI: native
   *  MCPServerStreamableHttp). */
  registerToolCatalog(catalog: McpToolCatalog): void;

  /** Register the HITL gate. Adapter calls this before every tool
   *  execution. */
  registerHitlGate(gate: HitlGate): void;

  /** Register the anomaly handler (recovery LLM). Adapter calls this
   *  on detected anomalies. */
  registerAnomalyHandler(handler: AnomalyHandler): void;

  /** Register the tool-batch boundary. An engine that can name the calls one
   *  model turn contained calls the handler with their ids once every call in
   *  that turn has resolved and before the next model request. Absent on an
   *  engine that cannot (the HTTP MCP engines see no model call id), which
   *  tells the platform to account per call instead. The ids are the contract:
   *  a boundary consumed late must still close only its own calls. */
  registerToolBatchHandler?(handler: ToolBatchHandler): void;

  /** Register the observer of tool results. An engine that implements this
   *  calls the observer with each call's RAW result and WAITS for it before
   *  handing the result to the model, so whatever the observer remembers is
   *  remembered before the model can act on it — the property the event
   *  stream cannot give, since the engine does not wait for stream listeners.
   *  The engine then marks the call `recordedAtDispatch` on its finished
   *  event. Absent on an engine that has no such seam, whose calls are
   *  remembered off the stream instead, with no ordering guarantee. */
  registerToolResultObserver?(observer: ToolResultObserver): void;

  /** Part 6 §A2 — register a trajectory recorder. Adapters call this with
   *  raw vendor SDK output at the pre-translation tap point so the recorder
   *  captures lossless content. Optional on the interface so adapters
   *  without recorder hookup still compile (tests, scaffolding). */
  registerTrajectoryRecorder?(recorder: TrajectoryRecorder): void;

  /** Can this engine actually READ a conversation rebuilt for it? Throws with a
   *  specific reason when it cannot.
   *
   *  There is a seam between "we produced the right messages" and "the engine
   *  can consume them", and until this existed nothing tested it. The inverse
   *  mappers had 129 unit tests and a 7x7 cross-engine matrix, all of which
   *  assert on what `canonicalToEngine` EMITS; none fed the result to an
   *  adapter. A rebuilt conversation could therefore die inside the OpenAI
   *  SDK on `item.content.map is not a function`, because the adapter's own
   *  translation produced an assistant item the SDK could not
   *  parse. Both halves were individually tested; the join between them was
   *  not, and the join is where cross-engine rebuild lives.
   *
   *  Implementations should run the SAME translation `invoke()` runs and then
   *  check the result against the vendor's own contract — the SDK's exported
   *  schema where one exists, so the check tracks the vendor rather than our
   *  reading of it. A mocked-SDK `invoke()` cannot serve here: the mock accepts
   *  whatever it is handed, which is precisely how the defect stayed invisible.
   *
   *  Optional. An engine that takes history as a text preamble rather than
   *  structured items (Codex, opencode, ADK — see conversation-preamble.ts)
   *  has no shape to get wrong and may omit it. */
  assertCanReplayHistory?(messages: PlatformMessage[]): void;
}

/** Part 6 §A2 — recorder contract. Adapters call recordRaw() with their
 *  native SDK message shape at the pre-translation tap point; the recorder
 *  routes to a per-vendor mapper inside makeRecorder(). */
export interface TrajectoryRecorder {
  recordRaw(input: {
    invocationId: string;
    provider: ResolvedProvider;
    model: string;
    rawKind: 'anthropic_sdk_message' | 'openai_run_item' | 'gemini_response' | 'adk_event' | 'codex_thread_item' | 'opencode_part' | 'gemini_cli_event';
    raw: unknown;
  }): void;
}

export type AdapterFactory = (provider: ResolvedProvider) => VendorSdkAdapter;
