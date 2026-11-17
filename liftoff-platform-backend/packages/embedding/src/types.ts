// Public types for @liftoffos/embedding.
//
// Designed for an OPEN provider set: well-known providers ship with the
// package, but consumers can register their own `EmbeddingProviderClient`
// implementations under any string name without modifying the package.

/** Well-known providers shipped with the package. Consumers can register
 *  additional providers under any string name — the `EmbeddingProvider`
 *  type is intentionally open. */
export const WELL_KNOWN_PROVIDERS = ['openai', 'google', 'voyage'] as const;
export type WellKnownEmbeddingProvider = typeof WELL_KNOWN_PROVIDERS[number];

/** Provider identifier. Closed over the well-known set for autocomplete
 *  but open to any string so consumers can plug in Cohere, Mistral, AWS
 *  Bedrock, BGE-via-Replicate, etc. without editing the package. */
export type EmbeddingProvider = WellKnownEmbeddingProvider | (string & Record<never, never>);

/** Whether the embedded text is a search query or a document being indexed.
 *  Asymmetric retrieval models (Google gemini-embedding-001/text-embedding-005,
 *  Voyage voyage-4) produce measurably better cosine scores when query and
 *  document are embedded with different task hints — typically a 3-7 point
 *  MTEB lift. Defaults to undefined (no hint) which uses the model's symmetric
 *  default. Providers that don't support it (OpenAI text-embedding-3) ignore. */
export type EmbeddingTaskType = 'retrieval_query' | 'retrieval_document';

/** Provider-level request — what gets handed to a single
 *  `EmbeddingProviderClient.embed()` implementation. Does NOT include
 *  provider/context, which are client-level concerns. */
export interface EmbeddingRequest {
  /** Single string or batch of strings. Output[i] aligns with input[i]. */
  input: string | string[];
  /** Provider-specific model id. Falls back to provider default. */
  model?: string;
  /** Output dimensionality. Provider must support it; OpenAI accepts 1536/3072,
   *  Google text-embedding-004 is 768, Voyage voyage-4 supports
   *  256/512/1024/2048 (Matryoshka). */
  dimensions?: number;
  /** Asymmetric-retrieval hint. See EmbeddingTaskType. */
  taskType?: EmbeddingTaskType;
  /** Per-call HTTP timeout forwarded to the provider transport
   *  (fetchJsonWithRetry timeoutMs / OpenAI SDK timeout). A timed-out
   *  call is truly ABORTED (AbortController), not abandoned — no orphan
   *  work, no stray usage. */
  timeoutMs?: number;
  /** Max transient retries (fetchJsonWithRetry retries / OpenAI SDK
   *  maxRetries). Set 0 for latency-bounded query-time embeds. */
  retries?: number;
}

/** Top-level call passed to EmbeddingClient.embed. Single options object —
 *  all parameters named, no positional gymnastics. */
export interface EmbedCall extends EmbeddingRequest {
  /** Provider to dispatch to. Defaults to the client's resolved default
   *  (see EmbeddingClient.init's defaultProvider / defaultPreference). */
  provider?: EmbeddingProvider;
  /** Caller-supplied context attached to every usage callback. Recognized
   *  keys (all string): tenantId (required for ledger writes), purpose,
   *  agentId, sessionId, threadId, invocationId, itemId. */
  context?: Record<string, string>;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  /** Tokens consumed by the call. Reported by the provider when possible;
   *  Vertex AI's response sometimes lacks usage so providers may approximate
   *  at ~4 chars/token. */
  promptTokens: number;
  model: string;
  /** The provider that actually served the request. Forced to client.provider
   *  by the EmbeddingClient backstop regardless of what the provider returns. */
  provider: EmbeddingProvider;
}

/** Static capability flags a provider advertises. Consumers can introspect
 *  via EmbeddingClient.capabilitiesOf(provider) to avoid passing options
 *  that will be silently ignored. */
export interface EmbeddingProviderCapabilities {
  /** True if `EmbeddingRequest.taskType` materially affects the embedding
   *  (e.g. Google Vertex `task_type`, Voyage `input_type`). False if the
   *  provider only exposes symmetric models (e.g. OpenAI text-embedding-3). */
  taskType: boolean;
  /** Per-API-call input ceiling. Providers chunk client requests above this
   *  internally; callers can use this to surface progress, throttle, or
   *  pre-chunk for streaming UX. */
  maxBatchSize: number;
  /** True if at least one model on this provider supports output-dim
   *  truncation (Matryoshka). Per-model granularity isn't exposed here;
   *  consumers requiring an exact dim must check the model docs. */
  matryoshka: boolean;
}

export interface EmbeddingProviderClient {
  readonly provider: EmbeddingProvider;
  readonly capabilities: EmbeddingProviderCapabilities;
  /** Model used when EmbeddingRequest.model is omitted. Surfaced for
   *  introspection (e.g. cost dashboards showing "what will this provider
   *  use by default?"). */
  readonly defaultModel: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

// Every embedding call emits one of these — success OR failure. Consumers
// (platform-backend, tenant-runtime) attach onUsage callbacks to persist
// the event into their respective ledgers (llm_usage_log vs usage_ledger).
export interface EmbeddingUsageEvent {
  timestamp: Date;
  provider: EmbeddingProvider;
  model: string;
  inputTokens: number;
  success: boolean;
  error?: string;
  context?: Record<string, string>;
}

export type EmbeddingUsageCallback = (event: EmbeddingUsageEvent) => void | Promise<void>;

/** Categorized embedding failure. Consumers can branch on `kind` to decide
 *  whether to retry, refresh credentials, or surface to the user. */
export type EmbeddingErrorKind =
  | 'transient'   // 5xx, network, timeout — safe to retry
  | 'auth'        // 401/403 — refresh credentials, do not retry blindly
  | 'rate_limit'  // 429 — back off and retry with longer delay
  | 'invalid'     // 400 — request is malformed, fix the code
  | 'unknown';    // anything else

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  readonly status?: number;
  readonly provider?: EmbeddingProvider;
  constructor(message: string, opts: { kind: EmbeddingErrorKind; status?: number; provider?: EmbeddingProvider; cause?: unknown }) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.provider = opts.provider;
    if (opts.cause !== undefined) (this as Error & { cause?: unknown }).cause = opts.cause;
  }
}
