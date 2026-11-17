// LLM Module Types
// Shared infrastructure for multi-provider LLM integration

export type LLMProvider = 'anthropic' | 'google' | 'openai' | 'openrouter';

/** The routing tiers, largest first. Each provider resolves a tier to its own
 *  model ID.
 *  - large:  Most capable (Opus / GPT-6 Astra / Gemini 3.1 Pro)
 *  - medium: Balanced     (Sonnet / GPT-6 Sol / Gemini 3.5 Flash)
 *  - small:  Fast & cheap (Haiku / GPT-6 Luna / Gemini 3.1 Flash Lite)
 *
 *  A vendor's Frontier model (workspace-ai-vendors.ts) is a designation above
 *  these, not a tier, and is deliberately not in this list. */
export const LLM_MODEL_TIERS = ['large', 'medium', 'small'] as const;
export type LLMModelTier = (typeof LLM_MODEL_TIERS)[number];

/** A tier READ from outside this process, under its current name.
 *
 *  The top tier was 'large' until migration 196 renamed it 'flagship', and
 *  migration 534 renamed it back. This covers the minutes of a deploy when
 *  platform-backend and the tenant runtimes run different versions, and any
 *  stored value the migration cannot reach (an in-flight event, a restored
 *  backup, an older client). Call it at each read boundary, before validation;
 *  writers emit only 'large'. Any other value passes through unchanged, for
 *  the caller's own validation to accept or refuse. */
export function normalizeTier<T>(tier: T): T {
  return (tier === 'flagship' ? 'large' : tier) as T;
}

/** An object carrying a `tier` (an agent's modelConfig), with that tier
 *  normalized. Returns the same object when there is nothing to change. */
export function withNormalizedTier<T extends { tier?: unknown }>(config: T): T {
  const tier = normalizeTier(config.tier);
  return tier === config.tier ? config : { ...config, tier };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** When set, instructs Anthropic providers to create an ephemeral prompt
   *  cache checkpoint at this message's position. OpenAI and Google cache
   *  automatically based on prefix — they ignore this field.
   *
   *  THE MARK IS NOT A GUARANTEE, and the two things it needs are properties of
   *  the caller's prompt rather than of this flag:
   *
   *  1. A MINIMUM LENGTH. No vendor caches a short prefix, and Anthropic's floor
   *     is a property of the MODEL rather than of the family — which is the
   *     trap, because "Sonnet is 1,024 and Haiku is 2,048" is the shape the
   *     answer looks like and it is wrong. Verified against the vendor's own
   *     table, 2026-09-06: Opus 5, Fable 5 and Mythos 5 are 512; Sonnet 5,
   *     Sonnet 4.6/4.5 and Opus 4.8 are 1,024; Opus 4.7 and Mythos Preview are
   *     2,048; and Opus 4.6, Opus 4.5 and HAIKU 4.5 are 4,096. Haiku 3.5's
   *     2,048 is the number people remember, and it is retired. OpenAI's
   *     automatic caching starts at 1,024; Gemini's implicit caching needs
   *     4,096 on the 3.x models. Below the floor the request succeeds, nothing
   *     is cached,
   *     and `cache_read_input_tokens` stays zero forever. Marking a short
   *     prompt is harmless and worth doing — it costs nothing, states the
   *     intent, and starts working the day the prompt grows or the tier moves —
   *     but it is not evidence that anything is being cached, and a comment
   *     claiming otherwise sends the next reader hunting for a bug that is a
   *     vendor floor.
   *
   *  2. A PREFIX THAT DOES NOT MOVE. Everything up to and including the marked
   *     block must be byte-identical between calls. A timestamp, an id, a
   *     per-request fact or a rendered list ahead of the mark invalidates the
   *     entry on every call, and a miss is not free: a cache WRITE costs 1.25x
   *     the ordinary input rate. So a mark on a moving prefix is worse than no
   *     mark at all. Volatile material belongs after it, in the user turn.
   *
   *  Both are checked the same way, on `llm_usage_log`: a purpose whose second
   *  call reports zero `cache_read_input_tokens` either sits under the floor or
   *  has something moving in front of the mark. A second call reporting zero
   *  `cache_creation_input_tokens` is the FLOOR — the vendor declined to write
   *  an entry at all.
   *
   *  WHERE to put it is a real choice, and the two answers are opposite.
   *
   *  A CONVERSATION marks its system prompt. The part before the mark is what
   *  two different conversations share; the turns after it are this
   *  conversation's own and belong outside the cached span.
   *
   *  A SINGLE-SHOT call repeated with identical input marks its LAST turn, so
   *  the cached prefix is the whole request. The workflow-diagram generator is
   *  one: it runs once for the Optimize preview and again for the writer that
   *  persists the result, same agent, same inputs, seconds apart. Marked on its
   *  rules block, only that block is cacheable and it is ~450 tokens, so
   *  nothing would ever be written. Marked on the turn, the prefix is the whole
   *  request.
   *
   *  IT CAN STILL CACHE NOTHING, and the reason is worth keeping because it is
   *  the distinction this whole comment is about. The generator runs on the
   *  `small` tier; if that resolves to a model whose floor is 4,096 and its
   *  prompts run a few thousand tokens, most requests are UNDER the floor and
   *  report `cache_creation_input_tokens = 0` and `cache_read_input_tokens = 0`.
   *  The mark is in the right place and is inert until the prompt grows or the
   *  tier moves, which is exactly what point 1 says a mark is worth.
   *
   *  What those zeros do NOT mean is the thing worth ruling out: that the mark
   *  failed to reach the wire. `buildAnthropicMessages` emits `cache_control` on the
   *  marked turn's last content block, and the vendor documents this exact
   *  signature — no error, both counters zero — as "the prompt was shorter than
   *  the minimum". A zero here is not evidence of a bug in this file.
   *
   *  Getting that backwards is silent either way, which is why it is written
   *  down here rather than left to each caller. */
  cacheControl?: { type: 'ephemeral' };
  /** Tool calls this (assistant) message made. Used by multi-round tool-use
   *  loops (the insights chat in Phase 6) to replay prior assistant turns
   *  into the next request so the LLM sees its own tool_use blocks paired
   *  with the tool results. Ignored on non-assistant messages. */
  toolCalls?: LLMToolCall[];
  /** Tool results this (user) message carries. Used by multi-round tool-use
   *  loops to feed prior tool outputs back into the next request. Each
   *  toolCallId must match an id from a preceding assistant message's
   *  `toolCalls`. Ignored on non-user messages. */
  toolResults?: LLMToolResult[];
  /** Images this (user) message carries, emitted as real image blocks AHEAD of
   *  the text.
   *
   *  Only ever set when the resolved model advertises `vision`: a text-only
   *  model handed an image block returns a 400, not a worse answer. The caller
   *  makes that decision (see src/llm/vision.ts) because it is the caller that
   *  knows which model the request will resolve to, and because a model that
   *  cannot see must be TOLD about the picture in words instead — dropping it
   *  silently lets the model answer about something it never received.
   *
   *  Ignored on non-user messages. */
  images?: LLMImageBlock[];
}

/**
 * One image on its way to a model.
 *
 * Base64 rather than a URL, deliberately. The bytes live in a private bucket
 * behind a membership check, and every URL this platform can mint for them
 * expires in an hour — handing a vendor a link means either making the object
 * public or watching the call fail whenever the model fetches it late.
 */
export interface LLMImageBlock {
  /** An allow-listed image type. Vendors accept png, jpeg, gif and webp. */
  mimeType: string;
  /** Raw base64, with no `data:` prefix and no newlines. */
  dataBase64: string;
  /** What the person or the producer called it, for a provider that takes a
   *  text label alongside the image. */
  alt?: string;
  /** Pixel dimensions, when they were read out of the image header at upload.
   *  No provider is sent these — they exist so a context budget can COST the
   *  image, on the vendors' own width x height / 750. Without them a turn
   *  carrying four screenshots counts as the length of its text, which is how
   *  an image pushes the person's own question out of the window. */
  width?: number;
  height?: number;
}

// JSON Schema for structured output (subset of JSON Schema spec)
export interface JSONSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  /** JSON Schema `const` for literal-string discriminator fields. */
  const?: string;
  /** JSON Schema `format` hint (e.g. 'date-time'). */
  format?: string;
  /** Lower bound on string length (for type='string'). */
  minLength?: number;
  /** Upper bound on string length (for type='string'). */
  maxLength?: number;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  /** Array item bounds. */
  maxItems?: number;
  minItems?: number;
  /** Numeric bounds for integer/number properties. */
  minimum?: number;
  maximum?: number;
  /** For type='object': schema applied to property values whose names are
   *  not listed in `properties`. Used to model open-ended maps like
   *  `Record<string, { gmailQuery?: string; sendAs?: string }>`. */
  additionalProperties?: JSONSchemaProperty | boolean;
  /** JSON Schema oneOf — discriminated-union variants for array items. */
  oneOf?: JSONSchemaProperty[];
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  /** Required by Anthropic's strict mode, which rejects a schema that does not
   *  close the object. Omitted otherwise, so non-strict tools are unchanged. */
  additionalProperties?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Generic multi-tool support (Phase 4)
//
// `responseSchema` (below) is the existing forced-single-tool path used by
// 12+ structured-output call sites. The new `tools` array is the additive
// general-purpose path for the insights chat agentic loop.
// ──────────────────────────────────────────────────────────────────────────

/** A tool that the LLM can choose to call. The shape mirrors Anthropic's
 *  `Tool` type because it is the most permissive — OpenAI and Google adapt
 *  to/from this in their respective providers. */
export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema;
  /** When set, instructs Anthropic providers to cache up to and including
   *  this tool's position in the tools array. Ignored by OpenAI and Google. */
  cacheControl?: { type: 'ephemeral' };
  /**
   * Ask the vendor to ENFORCE this schema rather than describe it.
   *
   * With it, a required field cannot be missing from the tool call — the
   * difference between persuading a model and constraining it. Worth reaching
   * for when an absent field fails the whole operation rather than degrading it.
   *
   * Not free, and not universally applicable: Anthropic's strict mode rejects
   * `oneOf`, `maxItems` and `maxLength`, so a schema using any of them cannot
   * opt in without being rewritten. Set it on the small, closed schemas where
   * it works; leave it off elsewhere rather than dismantling a schema to
   * qualify. Ignored by providers that do not support it.
   */
  strict?: boolean;
}

/** A tool call requested by the LLM in an assistant turn. */
export interface LLMToolCall {
  /** Provider-assigned id used to correlate this call to its result. For
   *  Gemini (which doesn't return ids) we synthesize one as `${name}-${index}`. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result fed back into the next assistant turn. */
export interface LLMToolResult {
  toolCallId: string;
  /** JSON-stringified result. Sanitization happens in the chat service before this. */
  content: string;
  /** Frames the tool produced, for a tool whose answer IS a picture — a
   *  browser screenshot being the one that exists today.
   *
   *  Not every vendor can carry an image back inside a tool result, and the
   *  split is not the one you would guess: Anthropic takes image blocks in
   *  `tool_result.content` and Google takes them as `functionResponse.parts`,
   *  while OpenAI's tool-role message is `string | ChatCompletionContentPartText`
   *  — text, and only text (verified against the installed SDK types,
   *  2026-09-24). OpenRouter extends the OpenAI provider and inherits that.
   *
   *  So each provider carries these as far as it can and no further: the two
   *  that take them natively put them in the tool result, and the two that
   *  cannot put them on a user turn immediately after it, which every vendor
   *  accepts. The model sees the picture either way, in the same position in
   *  the conversation; what differs is the envelope. A caller sets this field
   *  and does not care which happened. */
  images?: LLMImageBlock[];
}

/** Why the model stopped generating.
 *  - 'end_turn':   natural, successful completion.
 *  - 'tool_use':   the model requested one or more tool calls.
 *  - 'max_tokens': generation was truncated at the token limit.
 *  - 'refusal':    a provider safety classifier declined the request. Each
 *                  provider signals this DIFFERENTLY (Anthropic stop_reason
 *                  "refusal"; OpenAI finish_reason "content_filter" or a
 *                  populated message.refusal; Gemini candidate finishReason
 *                  SAFETY/PROHIBITED_CONTENT/RECITATION/BLOCKLIST/SPII/
 *                  IMAGE_SAFETY, or a prompt-level promptFeedback.blockReason
 *                  with no candidates). The adapters normalise all of these to
 *                  this single value. Callers MUST NOT treat 'refusal' as a
 *                  successful completion — the content is empty (blocked before
 *                  any output) or partial (blocked mid-stream) and must be
 *                  discarded. The unified client turns a resolved 'refusal'
 *                  into a thrown LLMRefusalError so callers fail loud. */
export type LLMStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

/** Thrown by the unified LLM client when a completion resolves with
 *  stopReason === 'refusal'. A safety classifier on the provider side declined
 *  the request, so there is no usable content. Carries the provider, model, and
 *  a provider-specific refusal category (e.g. Anthropic 'refusal', OpenAI
 *  'content_filter', Gemini 'SAFETY' / 'prompt_block:BLOCKLIST') for logging
 *  and triage. Callers that want to tolerate refusals should catch this
 *  explicitly rather than reading a would-be-empty successful response. */
export class LLMRefusalError extends Error {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly category?: string;
  constructor(args: { provider: LLMProvider; model: string; category?: string }) {
    super(
      `LLM provider '${args.provider}' refused the request` +
        (args.category ? ` (category: ${args.category})` : '') +
        ` [model: ${args.model}]`,
    );
    this.name = 'LLMRefusalError';
    this.provider = args.provider;
    this.model = args.model;
    this.category = args.category;
  }
}

/** Discriminated union of streaming events. The chat service consumes these
 *  via `for await (const event of stream)`. Every stream yields exactly one
 *  `message_complete` *or* `error` event as its terminator. */
export type LLMStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; toolCall: LLMToolCall }
  | {
      type: 'message_complete';
      stopReason: LLMStopReason;
      /** The model the provider actually served, as it names it.
       *
       *  Streaming had no way to report this, so `llmClient.completeStream`
       *  recorded `request.model || 'default'` — and a tier-based caller
       *  supplies no `request.model`, so every streamed call from one was
       *  written to `llm_usage_log` as the literal string 'default'. The
       *  non-streaming path never had the problem: it records
       *  `response.model`.
       *
       *  That is a pricing defect, not a cosmetic one. `computeRowCost` never
       *  bills zero — an unrecognised model falls back to a conservative
       *  default rate — so those rows were charged at a rate belonging to no
       *  model, indefinitely and silently. They are also invisible to the
       *  pricing-coverage ratchet, which reasons about model ids, and to any
       *  per-model cache analysis, since 'default' has no floor. */
      model?: string;
      /** Provider-specific refusal category. Only set when stopReason === 'refusal'. */
      refusalCategory?: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        /** Anthropic server-tool web search requests (present when the
         *  call used the web_search server tool; 0 otherwise). */
        webSearchRequests?: number;
        /** Number of web fetch requests made. undefined when the provider cannot report separately (e.g. OpenAI bundles search+fetch); 0 means confirmed zero fetches. */
        webFetchRequests?: number;
        /** Tokens written to the prompt cache this call (Anthropic cache_creation_input_tokens;
         *  not applicable for OpenAI/Google which cache automatically). */
        cacheWriteTokens?: number;
        /** Tokens served from the prompt cache this call (Anthropic cache_read_input_tokens;
         *  OpenAI prompt_tokens_details.cached_tokens; Google cachedContentTokenCount). */
        cacheReadTokens?: number;
        /** What the vendor charged for this call, as the vendor reported it
         *  (OpenRouter's `usage.cost`). Undefined for the direct-API providers,
         *  which publish a price list rather than a charge — and undefined means
         *  "price it from the rate table", never zero. */
        vendorCostUsd?: number;
        /** The PROMPT this call carried, whole, as the provider counts it: the
         *  size of the context the model read on this one request. Set by each
         *  adapter, because the vendors report it differently: Anthropic gives
         *  the uncached part as `input_tokens` and the cache reads and writes
         *  beside it, so for Anthropic it is the three added together; OpenAI's
         *  `prompt_tokens` and Google's `promptTokenCount` already include what
         *  was cached, so for them it is the input count alone. A loop reads it
         *  to know how full the model's window is; summing it across rounds
         *  measures nothing, because the same prompt is re-sent every round. */
        contextTokens?: number;
      };
    }
  | { type: 'error'; message: string };

// ──────────────────────────────────────────────────────────────────────────

export interface LLMCompletionRequest {
  messages: LLMMessage[];
  /** Explicit model ID. Passed directly to the provider — must be valid for
   *  the target provider. Prefer `tier` for cross-provider compatibility. */
  model?: string;
  /** Model capability tier. Resolved to a provider-specific model ID.
   *  Ignored if `model` is also set (explicit model wins). */
  tier?: LLMModelTier;
  maxTokens?: number;
  temperature?: number;
  /** When provided, enforces structured JSON output matching this schema via tool use.
   *  Mutually exclusive with `tools` — if both are passed, `responseSchema` wins
   *  (existing behavior, preserved for the 12+ call sites that depend on it).
   *
   *  `name` is load-bearing, not decorative: it becomes the forced tool's name
   *  AND the `tool_choice.name` that forces it. Omit it and the provider sends
   *  `tool_choice: {type:'tool'}`, which the vendor rejects — see
   *  LLMWireResponseSchema in @liftoffos/shared-types for what that
   *  costs. Structurally compatible with that shared type (JSONSchema is a
   *  narrowing of its `Record<string, unknown>`), so a cross-repo caller and
   *  this in-process shape cannot disagree about the required fields. */
  responseSchema?: {
    name: string;
    description?: string;
    schema: JSONSchema;
  };
  /** General-purpose tools the LLM may choose to call (Phase 4). */
  tools?: LLMToolDefinition[];
  /** Built-in server tools provided by the LLM platform (e.g. web_search).
   *  Passed alongside user-defined tools but using a different wire shape:
   *  `{ type: "web_search_20250305", name: "web_search" }`. The Anthropic
   *  provider merges them into the tools array when building the API request. */
  serverTools?: ReadonlyArray<{ name: string; type?: string }>;
  /** Controls whether the model must call a tool. Only applies when `tools` is set.
   *  - 'auto': model decides whether to call a tool (default)
   *  - 'required': model MUST call exactly one tool
   *  - 'none': model must NOT call a tool — the tools stay defined, so a
   *    conversation carrying earlier tool calls and results is still valid
   *    on every provider, and the model writes its answer instead
   *  - { name: string }: model MUST call the named tool */
  toolChoice?: 'auto' | 'required' | 'none' | { name: string };
  /** How hard the model should think, where the vendor exposes the control.
   *  Anthropic maps it to `output_config.effort`. Left unset, the provider uses
   *  whatever its per-model surface states and otherwise sends nothing — the
   *  parameter is rejected outright by models that predate it. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Results from previously requested tool calls, fed back into the next turn.
   *  Must align with assistant turn(s) in `messages` containing the matching tool calls. */
  toolResults?: LLMToolResult[];
  /** Cancels the call in flight. Set by chat surfaces that support a user stop
   *  (ADR-041) so pressing Stop ends the turn now instead of waiting out the
   *  rest of the model's output. Providers that cannot pass it to their SDK
   *  still stop yielding: the unified client checks it between events. */
  abortSignal?: AbortSignal;
}

export interface LLMCompletionResponse {
  /** Text content from the assistant. May be empty if the assistant only requested tools. */
  content: string;
  model: string;
  provider: LLMProvider;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic server-tool web search requests (present when the
     *  call used the web_search server tool; 0 otherwise). */
    webSearchRequests?: number;
    /** Number of web fetch requests made. undefined when the provider cannot report separately (e.g. OpenAI bundles search+fetch); 0 means confirmed zero fetches. */
    webFetchRequests?: number;
    /** Tokens written to the prompt cache this call. */
    cacheWriteTokens?: number;
    /** Tokens served from the prompt cache this call. */
    cacheReadTokens?: number;
    /** The whole prompt this call carried, as the provider counts it. Same
     *  field and same per-vendor rule as the streamed `message_complete`
     *  usage; set by each adapter on both paths. */
    contextTokens?: number;
    /** What the vendor charged for THIS call, as the vendor reported it.
     *
     *  Set only by gateways that return a per-call charge — OpenRouter does,
     *  on `usage.cost`. Undefined for every direct-API provider, which
     *  publishes a price list rather than a charge.
     *
     *  Undefined means "price this from the rate table", never zero. A model
     *  served by many endpoints at different prices has no knowable rate, so
     *  where this is present it is the only accurate figure available and the
     *  rate table is a fallback rather than a cross-check. */
    vendorCostUsd?: number;
  };
  /** Tool calls requested by the assistant (Phase 4). Undefined when stopReason !== 'tool_use'. */
  toolCalls?: LLMToolCall[];
  stopReason?: LLMStopReason;
  /** Provider-specific refusal category. Only set when stopReason === 'refusal'.
   *  Threaded into LLMRefusalError by the unified client for logging/triage. */
  refusalCategory?: string;
}

export interface LLMProviderClient {
  readonly provider: LLMProvider;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;
  /** Stream a completion as a sequence of normalized events. Yields exactly one
   *  `message_complete` or `error` event as its terminator. */
  completeStream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent>;
  /**
   * Which concrete model this request WOULD run against, without running it.
   *
   * Callers have never needed this: a provider resolves `model` / `tier` /
   * its own default internally, and the answer comes back on the response.
   * Vision changed that. Whether a turn may carry an image block has to be
   * decided while the request is still being BUILT, and it depends on the
   * model — so a caller that cannot ask which model it will get has to either
   * guess or send the image and find out from a 400.
   *
   * Optional so a provider that has no meaningful answer can omit it; a caller
   * treats its absence exactly like an unknown model, which is to say no
   * vision.
   */
  resolveModelId?(request: LLMCompletionRequest): string;
}

// Every LLM call emits one of these — success or failure.
// This is the single source of truth for token accounting.
/** The provider on a USAGE ROW. `LLMProvider` selects provider clients and
 *  routing and is untouched; `typesafe` (the Jev classifier, src/typesafe/)
 *  exists only on usage rows, so it widens this type and nothing else. */
/** A provider value a usage row can CARRY, which is not the same set as the
 *  providers a call can execute on.
 *
 *  'anthropic-vertex' is named explicitly and must stay that way. Claude over
 *  Google Vertex is retired and is no longer an LLMProvider, so deriving this
 *  type from that one alone would narrow it in lockstep — and llm_usage_log
 *  rows written while it existed still say it, with no CHECK constraint or
 *  enum to stop them. Cost attribution, the runtime ingester and the branding
 *  redaction all still have to resolve it. */
export type LLMUsageProvider = LLMProvider | 'typesafe' | 'anthropic-vertex';

export interface LLMUsageEvent {
  /** Timestamp of the call */
  timestamp: Date;
  /** Provider that handled the request */
  provider: LLMUsageProvider;
  /** Model used (resolved, not the alias) */
  model: string;
  /** Tokens reported by the provider (present when the API responded) */
  inputTokens: number;
  outputTokens: number;
  /** Number of Anthropic web-search server-tool requests in this call.
   *  Undefined / zero when the call used no server tools. Billed at
   *  $10 per 1000 requests on top of token cost. */
  webSearchRequests?: number;
  /** Number of web fetch requests made. undefined when the provider cannot report separately (e.g. OpenAI bundles search+fetch); 0 means confirmed zero fetches. */
  webFetchRequests?: number;
  /** Tokens written to the prompt cache (Anthropic cache_creation_input_tokens).
   *  Zero / undefined for OpenAI and Google (they cache automatically at no write cost). */
  cacheWriteTokens?: number;
  /** Tokens served from the prompt cache across all providers. */
  cacheReadTokens?: number;
  /** What the vendor charged for this call, as the vendor reported it. Set only
   *  where a gateway returns a per-call charge (OpenRouter's `usage.cost`);
   *  undefined for the direct-API providers, which publish a price list.
   *  Undefined means "price it from the rate table" and never zero. */
  vendorCostUsd?: number;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if the call failed */
  error?: string;
  /** Caller-supplied context for attribution. Recognized keys (all string):
   *    tenantId   (required — drives attribution queries)
   *    purpose    (required — drives bucket categorization in /insights)
   *    agentId    (optional — set when the cost belongs to a specific agent)
   *    sessionId  (optional — pre-creation distill sessions; see attributeSessionToAgent) */
  context?: Record<string, string>;
  /** One stable id per logical call, minted by the caller before its first
   *  attempt. The writer inserts idempotently on it (migration 506), so a
   *  retried write is one row. Absent on the providers' streaming path. */
  callId?: string;
  /** How many vendor attempts the call sent. */
  attempts?: number;
  /** The vendor's own request identifier, when a response arrived. The one
   *  value that can be reconciled against the vendor's records. */
  vendorRequestId?: string;
}

/** Callback invoked after every LLM call. Can be sync or async; when async,
 *  the client awaits the returned promise before returning to the caller so
 *  downstream operations (e.g. attributeSessionToAgent) can rely on the
 *  usage row being committed to llm_usage_log by the time they run. */
export type LLMUsageCallback = (event: LLMUsageEvent) => void | Promise<void>;

export interface LLMClientConfig {
  preferredProvider?: LLMProvider;
}
