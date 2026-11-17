import type { ResolvedProvider } from '../agent-execution/adapter/types';

// LLM Module Types
// Per implementation plan Phase 3: Multi-provider LLM integration for tenant-runtime
// Ported from liftoff-platform-backend/src/llm/types.ts

/** The providers a run can resolve to.
 *
 *  Derived from the vendor record rather than written out. Written out, it held
 *  six members and the record held nine — it had gone stale at the moment three
 *  approved providers were added, and a stale copy of a closed set does not
 *  announce itself: it type-checks, and the mismatch surfaces somewhere else
 *  entirely. */
export type LLMProvider = ResolvedProvider;

/** Canonical model-tier names. Mirrors platform-backend's LLMModelTier so a
 *  modelConfig record can be typed end-to-end without losing the union when
 *  it crosses the PB → TR boundary.
 *
 *  Frontier is deliberately NOT a tier: it sits above this ladder and is
 *  reached only by a pinned model id, never by tier routing. */
export type LLMModelTier = 'large' | 'medium' | 'small';

/** The top tier's name from platform-backend migration 196 until it was renamed
 *  back to 'large' so it would not read as a peer of Frontier. */
const RETIRED_LARGE_TIER_NAME = 'flagship';

/** A tier as read from outside this codebase, under its current name.
 *
 *  Every read boundary passes a tier through this first: the routing policy and
 *  agent model_config the control plane sends, the rows cached from them, the
 *  test harness input and deploy-time env config. Any of those can still say
 *  the retired name — a control plane not yet redeployed, a cache not yet
 *  refreshed, an env var not yet changed — and an unrecognised tier does not
 *  fail, it silently resolves to `medium` (see modelForTierOrUndefined).
 *  Writers emit only 'large'. Anything else passes through unchanged. */
export function normalizeTier<T>(tier: T): T | 'large' {
  return tier === RETIRED_LARGE_TIER_NAME ? 'large' : tier;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

// Tool definition for Claude-style tool use
export interface LLMTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  // Concrete examples of valid tool inputs. Anthropic passes these natively;
  // for providers without native support (e.g. OpenAI) they are embedded in
  // the description string by the provider adapter.
  input_examples?: Array<Record<string, unknown>>;
}

// JSON Schema for structured output (subset of JSON Schema spec)
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

/**
 * Which model serves a call, as ONE value.
 *
 * A model id is only meaningful on the provider it belongs to, and this union
 * is shaped so the incoherent pairing cannot be written down: naming a model
 * requires naming its provider, and a call that names no provider may only
 * express a tier, which the resolved provider maps against its own map.
 *
 * It replaces a `model` inside the request plus a separate `provider` argument,
 * which were independent optionals with nothing coupling them. Three call sites
 * took the model from one source and let the provider fall back to the platform
 * default, so a provider pinned to Anthropic was handed `x-ai/grok-4.6` and
 * answered 404 — surfacing as `recovery_llm_unavailable` on every non-Anthropic
 * agent, and as a silent `{ pass: true }` in step validation.
 *
 * The entitlements layer already models this as a pair and refuses to hand out
 * a model that could be foreign to its provider (see taskSpecificPair, which
 * drops "the possibly-foreign model id"). Only this signature tore the pair
 * apart and asked every caller to reassemble it.
 */
export type ModelSelection =
  /** A named provider, optionally with a model id that belongs to it. */
  | { provider: LLMProvider; model?: string }
  /** No provider named: the platform default serves it and chooses its own
   *  model. A model id is deliberately not accepted here — one written without
   *  a provider is a model from an unknown provider, which is the mistake this
   *  type exists to prevent. Use `llmClient.modelSelectionFor` when the model
   *  came from entitlements and may legitimately carry no provider. */
  | { provider?: undefined; model?: undefined };

// `tier` is deliberately NOT part of this. A tier is provider-AGNOSTIC by
// construction — every provider maps `large` onto its own largest model — so it
// needs no coupling and stays on the request, where its eleven callers already
// put it. Only the model id is meaningless without its provider.

export interface LLMCompletionRequest {
  messages: LLMMessage[];
  model?: string;
  /** Tier preference for tier-based selection — used only when `model` is
   *  not pinned. Provider implementations consult their TIER_MODELS map to
   *  pick a concrete model id. */
  tier?: LLMModelTier;
  maxTokens?: number;
  temperature?: number;
  tools?: LLMTool[];
  /** When provided, enforces structured JSON output matching this schema via tool use */
  responseSchema?: {
    name: string;
    description?: string;
    schema: JSONSchema;
  };
  /** Per-attempt deadline for THIS call, in ms. Unset keeps the provider's
   *  generous default (anthropic: 10 min), which is right for a long agent
   *  turn and wrong for a short call on a run's critical path: a request on a
   *  dead pooled connection waits for exactly this timer. Honoured by the
   *  anthropic, openai and google providers. */
  timeoutMs?: number;
  /** Max SDK retries for THIS call. Unset keeps the provider default
   *  (anthropic: 3, openai: 2). The google provider does not retry, so any
   *  value is already satisfied there. */
  maxRetries?: number;
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Unified stop-reason enum across providers.
 *
 *   end_turn   — model finished its turn naturally with no tool calls; the
 *                canonical "I'm done" signal. Anthropic emits this directly;
 *                OpenAI emits 'stop' which is mapped here.
 *   tool_use   — model produced one or more tool calls and expects results.
 *                Anthropic emits 'tool_use'; OpenAI emits 'tool_calls'.
 *   max_tokens — output was cut off by max_tokens limit. NOT a completion.
 *   other      — provider returned something we don't recognise; treat
 *                cautiously (do not assume completion).
 *
 * Used by the agent execution loop as the canonical termination signal,
 * replacing the brittle [COMPLETE] text-marker parsing.
 */
// 'refusal' = a provider safety classifier declined the request. Each provider
// signals this differently (Anthropic stop_reason 'refusal'; OpenAI
// finish_reason 'content_filter' or a populated message.refusal; Gemini
// finishReason SAFETY/PROHIBITED_CONTENT/… or a prompt-level
// promptFeedback.blockReason) — the provider adapters normalise all of them to
// this one value. Callers MUST NOT treat a refusal as a successful completion:
// content is empty (pre-output) or partial (mid-stream) and must be discarded.
export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

/**
 * Thrown by `llmClient.complete()` when a provider safety classifier declined
 * the request (`stopReason === 'refusal'`). Before this existed, a refusal was
 * mapped to `'other'`/`'end_turn'` and returned as an empty-but-"successful"
 * completion, which callers (e.g. the reflection suggestion-applier, autonomous
 * runs) would treat as a real answer. Failing loud here means a refusal
 * surfaces to the run's failure-classification path instead of silently writing
 * empty content. `partialContent` is attached for logging only and MUST NOT be
 * used as an answer (it is empty for a pre-output refusal, partial for a
 * mid-stream one).
 */
export class LLMRefusalError extends Error {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly partialContent: string;
  constructor(provider: LLMProvider, model: string, partialContent: string) {
    super(`LLM request refused by ${provider} safety classifier (model=${model})`);
    this.name = 'LLMRefusalError';
    this.provider = provider;
    this.model = model;
    this.partialContent = partialContent;
  }
}

/**
 * A `responseSchema` request came back without the structured payload.
 *
 * Distinct from a JSON parse failure on the caller's side: this means the
 * provider never produced the forced call at all. Callers previously could not
 * tell the two apart, because a provider that ignored `responseSchema` returned
 * ordinary prose and the caller's JSON.parse blew up with a generic message.
 */
export class LLMStructuredOutputError extends Error {
  readonly provider: LLMProvider;
  readonly schemaName: string;
  constructor(provider: LLMProvider, schemaName: string) {
    super(`${provider} returned no structured output for schema '${schemaName}'`);
    this.name = 'LLMStructuredOutputError';
    this.provider = provider;
    this.schemaName = schemaName;
  }
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  provider: LLMProvider;
  toolCalls?: LLMToolCall[];
  /**
   * Unified stop reason. Optional for backwards compatibility with provider
   * stub implementations that don't yet populate it; consumers MUST treat an
   * absent stopReason as "unknown — fall back to text-marker parsing".
   */
  stopReason?: LLMStopReason;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
}

/** Part 2 — token-counting surface. Public signature is the same across both
 *  repos; per-repo `tools` types differ (LLMTool here, LLMToolDefinition in
 *  platform-backend) so each repo declares this against its own tool type. */
export interface LLMTokenCountRequest {
  messages: LLMMessage[];
  system?: string;
  /** Per-repo tool type — see note above. */
  tools?: LLMTool[];
  model: string;
  /** Optional. When the caller intends to invoke with extended thinking on,
   *  include the same config here so the count reflects the thinking budget.
   *  Provider-specific: Anthropic accepts `{ type: 'adaptive' | 'enabled',
   *  budget_tokens? }`; Gemini's countTokens does NOT accept a thinking
   *  parameter (Vertex docs). Pass-through is best-effort per provider.
   *
   *  WHICH VALUES A MODEL ACTUALLY TAKES IS NOT UNIFORM, and this union is
   *  wider than any one model. On Sonnet 5.5 `disabled` is a 400 — the lowest
   *  setting there is `between_tools`, which is also the only setting that
   *  returns the prose the model writes between tool calls as readable text
   *  rather than as an empty thinking block. `enabled` + `budget_tokens` is a
   *  400 on every model from Sonnet 5 / Opus 4.7 onward. Nothing in this repo
   *  constructs `disabled`, and `countTokens` is the one path that would
   *  forward whatever it is handed, so the union stays permissive and the
   *  per-model truth lives in `anthropic-model-surface.ts`. */
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled' | 'between_tools'; budget_tokens?: number };
}

export interface LLMTokenCountResult {
  inputTokens: number;
  /** False for exact API-backed counts; true for tiktoken-style estimates. */
  estimated: boolean;
}

export interface LLMProviderClient {
  readonly provider: LLMProvider;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
  countTokens(request: LLMTokenCountRequest): Promise<LLMTokenCountResult>;
}

// Every LLM call emits one of these — success or failure.
// This is the single source of truth for token accounting.
export interface LLMUsageEvent {
  /** Timestamp of the call */
  timestamp: Date;
  /** Provider that handled the request */
  provider: LLMProvider;
  /** Model used (resolved, not the alias) */
  model: string;
  /** Tokens reported by the provider (present when the API responded) */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if the call failed */
  error?: string;
  /** Caller-supplied context for attribution */
  context?: Record<string, string>;
}

export type LLMUsageCallback = (event: LLMUsageEvent) => void;

 
export type LLMClientConfig = Record<string, never>;

// Per implementation plan Phase 3.4: Model configuration
export interface ModelConfig {
  provider?: LLMProvider;
  modelId: string;
  maxTokens?: number;
  temperature?: number;
}