// VendorAdapter interface — the single extension point for adding new vendors.
// Authentication, routing, lifecycle, and storage are vendor-neutral; protocol
// transformations and usage parsing belong here.

export interface ParsedSseEvent {
  type: string;
  data: unknown;
}

// Stream/parse-time usage accumulator. `cacheWriteTokens` is the canonical
// nullable cache-write value: Anthropic always reports it (mirrors
// cacheCreationInputTokens); OpenAI reports it per response on GPT-5.6+ and
// the adapter preserves null — never a coerced zero — when absent.
export interface TokenUsage {
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Legacy Anthropic field name; kept for existing consumers/tests. */
  cacheCreationInputTokens: number;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number;
  totalTokens?: number;
  serviceTier?: string;
}

export type LifecycleStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'aborted_by_client'
  | 'aborted_by_proxy'
  | 'timed_out'
  | 'transport_error';

export interface LifecycleSignal {
  status: 'completed' | 'failed' | 'incomplete';
  /** Failure/incomplete reason category; never prompt content. */
  errorCategory?: string;
}

/** Codex/vendor correlation identifiers captured as Liftoff attributes. */
export interface RequestCorrelation {
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  clientRequestId?: string;
}

export interface ModelPricing {
  inMicros: number;       // micros per million input tokens
  outMicros: number;      // micros per million output tokens
  cacheReadMicros?: number;
  cacheWriteMicros?: number;
}

export interface VendorConfig {
  vendor: string;
  baseUrl: string;
  allowedModels: string[];
  /** Legacy pricing snapshot — dual-read during the pricing-history migration
   *  window only; the versioned history table is authoritative. */
  pricing: Record<string, ModelPricing>;
  /** Reviewed Codex catalog metadata per model.
   *  Served verbatim; no capability values are invented in code. */
  modelCatalog: Record<string, Record<string, unknown>>;
}

export interface VendorAdapter {
  readonly vendor: string;

  /** Classify a Liftoff route path into an operation, e.g.
   *  'responses.create' | 'responses.compact' | 'models.list' |
   *  'messages.create' | 'messages.count_tokens'. Null = unsupported path. */
  classifyOperation(method: string, path: string): string | null;

  /** Build the full upstream URL for a given request path. Path translation is
   *  an adapter responsibility; the inbound URL is never appended
   *  verbatim to the upstream base. */
  buildUpstreamUrl(path: string, config: VendorConfig): URL;

  /** Build the auth headers to inject on the outbound request. */
  buildAuthHeaders(apiKey: string): Record<string, string>;

  /** Headers from the inbound client request that are safe to forward upstream. */
  getAllowedRequestHeaders(): ReadonlySet<string>;

  /** Response headers from upstream that are safe to forward to the client. */
  getSafeResponseHeaders(): ReadonlySet<string>;

  /** Capture vendor correlation identifiers from inbound headers/body. These
   *  are Liftoff attributes only; they are NOT forwarded upstream unless the
   *  request-header allowlist explicitly admits them. */
  extractCorrelation(
    headers: Record<string, string | string[] | undefined>,
    parsedBody: Record<string, unknown> | null,
  ): RequestCorrelation;

  /** Validate/normalize the request body for upstream. Returns the exact bytes
   *  to send: the raw buffer (verbatim passthrough) or a re-serialized
   *  allowlisted body. Throws {statusCode} on invalid. */
  normalizeRequestBody(parsedBody: Record<string, unknown>, rawBody: Buffer): Buffer;

  /** Parse a single raw SSE data line. Returns null for non-data or [DONE] lines. */
  parseSseDataLine(rawData: string): ParsedSseEvent | null;

  /** Accumulate usage from a parsed SSE event. Final provider totals are
   *  authoritative: cumulative repeats REPLACE earlier totals, never sum
   *  blindly. */
  accumulateUsage(current: TokenUsage, event: ParsedSseEvent): TokenUsage;

  /** Extract a terminal lifecycle signal from a parsed SSE event, if any
   *  (response.completed / response.failed / response.incomplete / error). */
  extractLifecycle(event: ParsedSseEvent): LifecycleSignal | null;

  /** Parse usage from a non-streaming JSON response body. Null when the body
   *  carries no usage (the attempt is still durably recorded). */
  parseNonStreamingUsage(
    parsedBody: Record<string, unknown>,
    fallbackModel: string,
  ): TokenUsage | null;

  /** Vendor-specific model normalization for pricing alias resolution
   *  (e.g. Anthropic date-suffix strip). */
  canonicalizeModel(model: string): string;

  /** Legacy cost computation against the vendor-config pricing snapshot.
   *  Dual-read migration path only; unknown models return null (fail closed —
   *  no cross-model fallback, the design). */
  computeCost(usage: TokenUsage, config: VendorConfig): bigint | null;
}
