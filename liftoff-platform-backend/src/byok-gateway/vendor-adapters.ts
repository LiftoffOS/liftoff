// Per-vendor protocol knowledge for the BYOK gateway.
//
// Same shape as liftoff-developer-proxy's VendorAdapter, which runs the OPPOSITE
// direction (it issues Liftoff keys to a customer's Claude Code CLI). Everything
// vendor-neutral — auth, routing, lifecycle, storage — lives in the router;
// what belongs here is upstream URL construction, credential injection, header
// allow-listing, and usage parsing.
//
// USAGE PARSING IS NOT OPTIONAL. A vendor path that cannot report token usage
// back is not shippable, BYOK or not: every LLM call the platform makes produces
// a usage record with input and output token counts, whoever's key paid for it.
// Adding a vendor here means adding its usage parser in the same change.

// The one import this module has, and the reason it is worth having: Google's
// billable token arithmetic is shared with `llm/providers/google.ts`, which prices
// the same vendor directly. `llm/google-usage.ts` imports nothing itself, so this
// stays the thin protocol module it is meant to be.
import { googleInputTokens, googleOutputTokens } from '../llm/google-usage';

export interface GatewayTokenUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The CACHE READ, and nothing else — it once held the read and the write
   *  summed. Kept under its old name because the column and its existing readers
   *  are written against it; `cacheReadTokens` is the same number said plainly. */
  cachedTokens: number;
  /** Tokens served from the vendor's prompt cache, at a fraction of the input
   *  rate: Anthropic charges 0.1x. Identical to `cachedTokens`. */
  cacheReadTokens: number;
  /** Tokens spent POPULATING the cache, which is DIFFERENT MONEY from a read:
   *  Anthropic charges 1.25x the input rate for a write against a read's 0.1x,
   *  and `input_tokens` arrives exclusive of both. Never add this to the read —
   *  one number carrying their sum can be priced at neither rate. */
  cacheWriteTokens: number;
  /** Thinking the vendor bills, as a BREAKDOWN of `outputTokens` and never an
   *  addition to it. `outputTokens` is the billable completion total for every
   *  vendor here; this is carried separately only because the vendors disagree
   *  about whether their own completion count already contains it. */
  reasoningTokens: number;
  /**
   * WHAT THE VENDOR SAYS IT CHARGED for this one request, when it says.
   *
   * NULL for every direct-API vendor, which publishes a price list rather than a
   * per-call charge — and null is not zero: a zero booked as a charge is an
   * unbilled call.
   *
   * It is not a nicety on the OpenRouter path, it is the only figure that can be
   * right. One model there is served by many endpoints at different prices, and
   * the endpoint that took the request is not knowable from a price list: a turn
   * whose tokens reconstruct to $0.01411360 at the listed slug rate was charged
   * $0.01853990, 31% more, because the endpoint that served it charges above the
   * slug. No token count sees that spread. `usage.cost` does.
   */
  vendorCostUsd: number | null;
}

export interface GatewayVendorAdapter {
  readonly vendor: string;

  /** Upstream origin, overridable per environment for testing against a stub. */
  baseUrl(): string;

  /** Build the full upstream URL. The inbound path is never appended verbatim:
   *  path translation is an adapter responsibility. */
  buildUpstreamUrl(pathAndQuery: string): URL;

  /** CREDENTIAL headers only. Applied last, so nothing a caller sent can
   *  displace them — that is what stops a client smuggling its own key past
   *  the gateway. Anything that is not a credential belongs in
   *  `defaultRequestHeaders` instead, or a caller could never override it. */
  buildAuthHeaders(apiKey: string): Record<string, string>;

  /** Non-credential headers the vendor needs when the caller did not send one.
   *  Applied FIRST, so an allow-listed header from the caller wins. */
  readonly defaultRequestHeaders: Record<string, string>;

  /** Inbound client headers safe to forward upstream. Anything carrying a
   *  credential is excluded here and re-added by buildAuthHeaders, so a client
   *  cannot smuggle its own key past the gateway. */
  readonly allowedRequestHeaders: ReadonlySet<string>;

  /** Upstream response headers safe to return to the client. */
  readonly safeResponseHeaders: ReadonlySet<string>;

  /** Accumulate usage from one parsed SSE `data:` payload. Final provider
   *  totals are authoritative: a cumulative repeat REPLACES the earlier total
   *  rather than summing, or a streamed response double-counts itself. */
  accumulateStreamUsage(
    current: GatewayTokenUsage,
    event: Record<string, unknown>,
  ): GatewayTokenUsage;

  /** Usage from a non-streaming JSON body. Null when the body carries none —
   *  the request is still recorded, with the counts it has. */
  parseNonStreamingUsage(body: Record<string, unknown>): GatewayTokenUsage | null;
}

export const EMPTY_USAGE: GatewayTokenUsage = {
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  vendorCostUsd: null,
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A vendor-reported charge, or null.
 *
 *  Guarded on `> 0` rather than on presence, the same rule the runtime's own
 *  pricing applies: a zero must fall through to the rate table rather than book
 *  a free call. A vendor that reports no cost reports null, and null means
 *  "price this from the table" — never "this was free". */
function cost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Hop-by-hop headers, never forwarded in either direction (RFC 7230).
 *  content-encoding / content-length are resolved by undici fetch, so
 *  re-sending them would mislead the receiver. */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'host',
]);

const COMMON_REQUEST_HEADERS = ['content-type', 'accept', 'accept-encoding', 'user-agent'];
const COMMON_RESPONSE_HEADERS = ['content-type', 'cache-control'];

// ── Anthropic ────────────────────────────────────────────────────────────────

const anthropicAdapter: GatewayVendorAdapter = {
  vendor: 'anthropic',
  baseUrl: () => process.env.BYOK_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
  buildUpstreamUrl(pathAndQuery) {
    return new URL(pathAndQuery, this.baseUrl());
  },
  // Anthropic accepts x-api-key. The SDK subprocess sends its own
  // ANTHROPIC_AUTH_TOKEN as an Authorization bearer, which is the gateway
  // token — stripped by the allow-list below and replaced here.
  buildAuthHeaders: (apiKey) => ({ 'x-api-key': apiKey }),
  // A version the API accepts, for a caller that sends none. A caller that pins
  // its own wins, because this is applied before the allow-listed headers: the
  // claude-code subprocess sends the version its features need, and forcing
  // ours over it would break them.
  defaultRequestHeaders: { 'anthropic-version': '2023-06-01' },
  allowedRequestHeaders: new Set([
    ...COMMON_REQUEST_HEADERS,
    'anthropic-beta',
    'anthropic-version',
  ]),
  safeResponseHeaders: new Set([
    ...COMMON_RESPONSE_HEADERS,
    'request-id',
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-tokens-remaining',
    'retry-after',
  ]),
  accumulateStreamUsage(current, event) {
    const type = event.type;
    // message_start carries the input side and the model; message_delta carries
    // the running output total. Both are cumulative for the message, so both
    // REPLACE rather than add.
    if (type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      // EVERY FIELD NAMED, no spread of `current`. A field added to
      // `GatewayTokenUsage` then fails to compile here until somebody decides
      // what this vendor reports for it — which is the property this file exists
      // for. Spreading would carry the previous event's value silently, and a
      // count silently carried is a count nobody chose.
      return {
        model: str(message?.model) ?? current.model,
        inputTokens: usage ? num(usage.input_tokens) : current.inputTokens,
        outputTokens: usage ? num(usage.output_tokens) : current.outputTokens,
        // THE READ AND THE WRITE ARE NOT THE SAME MONEY. Anthropic charges
        // 0.1x for a read and 1.25x for a write, so one number carrying both
        // can be priced at neither rate. Both are on this event.
        cachedTokens: usage ? num(usage.cache_read_input_tokens) : current.cachedTokens,
        cacheReadTokens: usage ? num(usage.cache_read_input_tokens) : current.cacheReadTokens,
        cacheWriteTokens: usage
          ? num(usage.cache_creation_input_tokens)
          : current.cacheWriteTokens,
        // Anthropic folds extended thinking into `output_tokens` and reports no
        // separate count, so there is nothing to read. Zero here is the wire's
        // answer, not a gap: the thinking is already inside `outputTokens`.
        reasoningTokens: current.reasoningTokens,
        // A price list, not a per-call charge. Null means "price from the
        // table", which for a direct-API vendor is exactly right.
        vendorCostUsd: current.vendorCostUsd,
      };
    }
    if (type === 'message_delta') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (!usage) return current;
      return {
        ...current,
        // A message_delta that omits input_tokens leaves the message_start
        // value standing; Anthropic sends it on the final delta only.
        inputTokens: usage.input_tokens !== undefined ? num(usage.input_tokens) : current.inputTokens,
        outputTokens: num(usage.output_tokens),
      };
    }
    return current;
  },
  parseNonStreamingUsage(body) {
    const usage = body.usage as Record<string, unknown> | undefined;
    if (!usage) return null;
    return {
      model: str(body.model),
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cachedTokens: num(usage.cache_read_input_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: 0,
      vendorCostUsd: null,
    };
  },
};

// ── OpenAI ───────────────────────────────────────────────────────────────────

/** Shared by OpenAI and xAI: xAI's API is OpenAI-compatible, which is the whole
 *  reason a direct xAI path is the smaller of the two adapter gaps. */
function openAiUsage(usage: Record<string, unknown>, model: string | null): GatewayTokenUsage {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  // Chat Completions says prompt_tokens / completion_tokens; Responses says
  // input_tokens / output_tokens. Both shapes reach this gateway.
  const input = num(usage.prompt_tokens) || num(usage.input_tokens);
  const completion = num(usage.completion_tokens) || num(usage.output_tokens);

  // Reasoning tokens are billed as output, and the two OpenAI-compatible
  // vendors disagree about whether `completion_tokens` already contains them.
  //
  // OpenAI includes them: `completion_tokens_details.reasoning_tokens` is a
  // BREAKDOWN of a number already counted. xAI does not. Measured against
  // api.x.ai on grok-4.6:
  //
  //     prompt_tokens 641, completion_tokens 1, total_tokens 906,
  //     completion_tokens_details.reasoning_tokens 264
  //
  // 641 + 1 = 642, and the missing 264 is exactly the reasoning count. Taking
  // `completion_tokens` alone recorded ONE output token for a call that
  // produced 265 — a 265x under-count on a reasoning model, silently, and only
  // on the customer-funded path, because managed Grok goes through OpenRouter
  // and is normalised before we see it.
  //
  // `total_tokens - input` is the arithmetic the VENDOR asserts, and it settles
  // the disagreement without this code having to know which side each vendor
  // takes. OpenAI reports total == input + completion, so it yields exactly
  // completion and nothing changes. xAI reports a larger total, and the
  // difference is the reasoning it did not fold in.
  //
  // Deliberately NOT `completion + reasoning_tokens`: that double-counts every
  // vendor whose completion already includes reasoning, and it can only ever
  // account for the categories this code happens to name today.
  //
  // Falls back to `completion` when no total is reported. There is then nothing
  // to discriminate on, and inventing a correction would be a guess in the
  // direction of over-billing.
  const total = num(usage.total_tokens);
  const derived = total > input ? total - input : 0;
  // The BREAKDOWN, carried beside the total rather than added to it. Both wire
  // shapes name it: Chat Completions under `completion_tokens_details`,
  // Responses under `output_tokens_details`. It is reported so a row can say
  // what it saw — `outputTokens` above is already the billable completion
  // figure, by the vendor's own arithmetic — and never summed in, which is the
  // double-count the comment above rules out.
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  return {
    model,
    inputTokens: input,
    outputTokens: derived || completion,
    cachedTokens: num(promptDetails?.cached_tokens) || num(inputDetails?.cached_tokens),
    // OpenAI-compatible vendors report a cache READ and have no write to
    // report: there is no explicit cache-population charge on this protocol.
    cacheReadTokens: num(promptDetails?.cached_tokens) || num(inputDetails?.cached_tokens),
    cacheWriteTokens: 0,
    reasoningTokens:
      num(completionDetails?.reasoning_tokens) || num(outputDetails?.reasoning_tokens),
    // WHAT THE VENDOR CHARGED, on the one wire that says. OpenRouter returns
    // `usage.cost` — its own charge for this request, in credits, 1:1 with USD —
    // and `cost_details.upstream_inference_cost` beside it for the part the
    // upstream provider billed. The total is what the invoice shows, so that is
    // what is read.
    //
    // It is the ONLY figure that sees the endpoint spread. A model there is served
    // by many endpoints at different prices and no price list says which one took
    // the request, so a reconstruction from tokens at the listed slug rate is
    // short by whatever premium the serving endpoint charges — measured at 31% on
    // a real turn. OpenAI and xAI report no cost and answer null.
    vendorCostUsd: cost(usage.cost),
  };
}

function makeOpenAiCompatibleAdapter(
  vendor: string,
  defaultBase: string,
  baseUrlEnvVar: string,
): GatewayVendorAdapter {
  return {
    vendor,
    baseUrl: () => process.env[baseUrlEnvVar] ?? defaultBase,
    buildUpstreamUrl(pathAndQuery) {
      return new URL(pathAndQuery, this.baseUrl());
    },
    buildAuthHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    defaultRequestHeaders: {},
    allowedRequestHeaders: new Set([
      ...COMMON_REQUEST_HEADERS,
      'openai-beta',
      'openai-organization',
      'openai-project',
    ]),
    safeResponseHeaders: new Set([
      ...COMMON_RESPONSE_HEADERS,
      'x-request-id',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-remaining-tokens',
      'retry-after',
    ]),
    accumulateStreamUsage(current, event) {
      // Chat Completions with stream_options.include_usage puts `usage` on the
      // final chunk; Responses puts it on response.completed. Either way the
      // value is a total for the whole response, so it replaces.
      const direct = event.usage as Record<string, unknown> | undefined;
      if (direct) {
        return openAiUsage(direct, str(event.model) ?? current.model);
      }
      const response = event.response as Record<string, unknown> | undefined;
      const nested = response?.usage as Record<string, unknown> | undefined;
      if (nested) {
        return openAiUsage(nested, str(response?.model) ?? current.model);
      }
      return { ...current, model: str(event.model) ?? current.model };
    },
    parseNonStreamingUsage(body) {
      const usage = body.usage as Record<string, unknown> | undefined;
      if (!usage) return null;
      return openAiUsage(usage, str(body.model));
    },
  };
}

// ── Google (Vertex AI) ───────────────────────────────────────────────────────
//
// The SAME service Liftoff's own managed path uses, which is the whole reason
// this vendor is unremarkable. A customer's Google AI capacity lives in their
// own Vertex project, and the credential for it is a service account rather than
// an API key — so what this adapter attaches is a bearer token minted from that
// service account, and the request goes to the customer's project instead of
// ours. Same protocol, same catalogue, same request shape.
//
// The base URL is per-request, not a constant: Vertex serves from
// `{location}-aiplatform.googleapis.com`, and the location belongs to the
// customer's credential. `baseUrl()` returns the platform default, used only
// when nothing has been resolved yet; the router passes the real host.

const googleAdapter: GatewayVendorAdapter = {
  vendor: 'google',
  baseUrl: () => process.env.BYOK_GOOGLE_BASE_URL ?? 'https://aiplatform.googleapis.com',
  buildUpstreamUrl(pathAndQuery) {
    return new URL(pathAndQuery, this.baseUrl());
  },
  // An OAuth bearer, never the credential itself: a Vertex service account is
  // exchanged for a token, and the key pair behind it never goes on the wire.
  buildAuthHeaders: (accessToken) => ({ Authorization: `Bearer ${accessToken}` }),
  defaultRequestHeaders: {},
  // `authorization` is deliberately absent: the Vertex SDKs mint an ADC token of
  // their own and send it, and that one has to be REPLACED rather than
  // forwarded, or the request would arrive on Liftoff's identity while the
  // ledger recorded it as customer-funded.
  allowedRequestHeaders: new Set([...COMMON_REQUEST_HEADERS, 'x-goog-user-project']),
  safeResponseHeaders: new Set([...COMMON_RESPONSE_HEADERS, 'retry-after']),
  accumulateStreamUsage(current, event) {
    const meta = event.usageMetadata as Record<string, unknown> | undefined;
    if (!meta) return { ...current, model: str(event.modelVersion) ?? current.model };
    // usageMetadata on a streamed chunk is cumulative for the response.
    return {
      model: str(event.modelVersion) ?? current.model,
      // THE SAME ARITHMETIC THE PROVIDER USES, from the one module that states it.
      // Google's own identity is `totalTokenCount = prompt + candidates +
      // toolUsePrompt + thoughts` and none of the four sits inside another, so the
      // tool-result prompt is INPUT that `promptTokenCount` does not contain — and
      // reading the prompt alone under-counted every tool-using turn, which on the
      // gemini-cli engine is nearly every turn.
      inputTokens: googleInputTokens(meta),
      outputTokens: googleOutputTokens(meta),
      cachedTokens: num(meta.cachedContentTokenCount),
      cacheReadTokens: num(meta.cachedContentTokenCount),
      // Vertex bills an explicit cache through Context Caching, which is a
      // separate resource with its own create call and is not something this
      // request's usageMetadata reports. Zero is the wire's answer.
      cacheWriteTokens: 0,
      // Already inside `outputTokens` above — Google reports thoughts as their
      // own count and bills them at the output rate, so the total folds them in
      // and this carries the breakdown.
      reasoningTokens: num(meta.thoughtsTokenCount),
      // Vertex bills the project, not the request; there is no per-call charge on
      // the response to read.
      vendorCostUsd: null,
    };
  },
  parseNonStreamingUsage(body) {
    const meta = body.usageMetadata as Record<string, unknown> | undefined;
    if (!meta) return null;
    return {
      model: str(body.modelVersion),
      inputTokens: googleInputTokens(meta),
      outputTokens: googleOutputTokens(meta),
      cachedTokens: num(meta.cachedContentTokenCount),
      cacheReadTokens: num(meta.cachedContentTokenCount),
      cacheWriteTokens: 0,
      reasoningTokens: num(meta.thoughtsTokenCount),
      vendorCostUsd: null,
    };
  },
};

// ── OpenRouter ───────────────────────────────────────────────────────────────
//
// The one door with NO customer-funded path, and it is here for the other half
// of what this gateway is for: counting.
//
// An OpenRouter invoice is Liftoff's and `keyVendorForProvider` answers null for
// every family it serves, so every request through this door is
// `served_by = 'managed'` on Liftoff's own OpenRouter key. What it buys is the
// wire: OpenRouter reports reasoning tokens in `completion_tokens_details`, and
// the engine reached through it splits them out of the count it publishes — its
// own per-call `cost` is no independent check either, being derived from the same
// figure.
//
// OpenRouter serves at /api/v1 rather than at the origin, so the base carries
// its own path prefix and the vendor path is joined RELATIVE to it.
const openRouterAdapter: GatewayVendorAdapter = {
  ...makeOpenAiCompatibleAdapter('openrouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_BASE_URL'),
  buildUpstreamUrl(pathAndQuery) {
    const base = this.baseUrl().replace(/\/+$/, '');
    // RELATIVE, not absolute. Resolving `/v1/…` against `https://openrouter.ai/api/v1`
    // as an absolute path discards `/api/v1` and reaches a host root that does
    // not exist — the same join `callUpstream` makes for a substituted base.
    let relative = pathAndQuery.replace(/^\/+/, '');
    // The vendor's own `v1/` is dropped only when the base ALREADY ends in it,
    // or the segment would be doubled. `OPENROUTER_BASE_URL` is an operator
    // override that also points the estate's OpenRouter traffic at a self-hosted
    // vLLM or SGLang host, and such a host may be named without the segment —
    // stripping unconditionally would lose it and 404 on every request.
    if (/\/v1$/.test(base)) relative = relative.replace(/^v1\//, '');
    return new URL(relative, `${base}/`);
  },
};

const ADAPTERS = new Map<string, GatewayVendorAdapter>([
  ['anthropic', anthropicAdapter],
  ['openai', makeOpenAiCompatibleAdapter('openai', 'https://api.openai.com', 'BYOK_OPENAI_BASE_URL')],
  ['google', googleAdapter],
  ['xai', makeOpenAiCompatibleAdapter('xai', 'https://api.x.ai', 'BYOK_XAI_BASE_URL')],
  ['openrouter', openRouterAdapter],
]);

export function getGatewayAdapter(vendor: string): GatewayVendorAdapter | null {
  return ADAPTERS.get(vendor) ?? null;
}

/** Every vendor the gateway can serve. Exported so a fitness test can assert
 *  each one parses usage, rather than discovering it in production. */
export function gatewayVendors(): string[] {
  return [...ADAPTERS.keys()];
}
