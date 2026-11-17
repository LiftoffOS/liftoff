// HTTP client base for Cloud Run → Cloud Run calls.
//
// Bundles everything a service-to-service caller needs:
//   - OIDC bearer token per target URL (via google-auth-library)
//   - X-Service-Auth shared token
//   - HTTP/1.1 keep-alive via its OWN undici Agent (persistent TCP/TLS
//     connections), passed per request, never installed process-wide
//   - A default per-request timeout covering the response body as well
//   - Circuit breaker per key (tenant:method)
//   - URL caching with TTL (for tenant-runtime URL resolution)
//   - Safe logging: headers + URL get redacted through redact.ts before
//     any log hook fires
//
// Usage:
//   const client = new ServiceClient({
//     serviceAuthEnvVar: 'TENANT_RUNTIME_SERVICE_TOKEN',
//     resolveTargetUrl: (tenantId) => resolveRuntimeBaseUrl(tenantId),
//     resolveTargetUrlTtlMs: 5 * 60_000,
//     breaker: new CircuitBreaker({ failureThreshold: 5 }),
//     onLog: (level, ctx, msg) => log[level](ctx, msg),
//   });
//   const res = await client.fetch(tenantId, '/api/...', { method: 'POST', body });

import { buildOidcAuthHeader } from './oidc-auth.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { CallPolicy, type CallInvocation, type CallPolicyOptions } from './call-policy.js';
import { redactHeaders, redactUrl, type RedactionOptions } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFn = (level: LogLevel, ctx: Record<string, unknown>, msg: string) => void;

export interface ServiceClientOptions {
  /**
   * Env var whose value is sent as the X-Service-Auth header. Omit to
   * skip the shared-token auth.
   */
  serviceAuthEnvVar?: string;
  /**
   * Resolver returning the target service's base URL for a given key
   * (typically tenantId). Called on every fetch unless cached.
   */
  resolveTargetUrl: (key: string) => Promise<string>;
  /**
   * How long to cache resolveTargetUrl() results. 0 = always re-resolve.
   * Default 5 minutes — matches tenant-runtime URL cache behaviour.
   */
  resolveTargetUrlTtlMs?: number;
  /**
   * Legacy circuit breaker. Callers can share one across multiple
   * clients. If omitted and `callPolicy` is also omitted, a fresh
   * breaker with defaults is used. Deprecated in favour of
   * `callPolicy` (Phase 0q) — but preserved so existing callsites
   * keep working unchanged.
   */
  breaker?: CircuitBreaker;
  /**
   * Phase 0q CallPolicy. When set, the client wraps every fetch in
   * the policy (retry budget + rolling-window circuit breaker +
   * timeout + RETRY_BUDGET_EXHAUSTED error). Supersedes `breaker`
   * when both are present; the legacy `init.breakerKey` path still
   * short-circuits for callers that pin a specific breaker key.
   */
  callPolicy?: CallPolicy;
  /**
   * Options to construct a default `CallPolicy` if none is injected.
   * Ignored when `callPolicy` is explicitly provided.
   */
  callPolicyOptions?: CallPolicyOptions;
  /**
   * Extra headers to add to every request. Merged with auth headers
   * (auth wins on conflict).
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Logging hook — called on every fetch with redacted headers + URL.
   * Omit to silence logging.
   */
  onLog?: LogFn;
  /**
   * Extra redaction knobs (e.g. service-specific header names).
   */
  redaction?: RedactionOptions;
  /**
   * Override the fetch implementation. Default: globalThis.fetch. Whatever
   * is passed receives `dispatcher` and `signal` in its init and should
   * forward them to fetch (a wrapper that spreads `init` does).
   */
  fetchImpl?: typeof fetch;
  /**
   * The undici dispatcher every request of this client goes through, passed
   * per request as `fetch(url, { dispatcher })`. Default: the package's
   * shared keep-alive Agent (see getServiceClientDispatcher). `null` sends
   * requests through whatever the process's global dispatcher is.
   */
  dispatcher?: unknown | null;
  /**
   * Upper bound on one request, from the first byte sent until the response
   * body has been read, enforced with an AbortSignal handed to fetch.
   * Default DEFAULT_REQUEST_TIMEOUT_MS (5 minutes). 0 disables it. A call's
   * own `timeoutMs` overrides it, and a caller's `signal` still applies
   * alongside it: whichever fires first ends the request.
   */
  defaultTimeoutMs?: number;
}

/**
 * Default bound on one request when neither the client nor the call names
 * one. It must outlast the slowest legitimate service-to-service call
 * (tenant-runtime's tool-gateway `execute` carries run_browser_task, bounded
 * at 210 s by its step timeout; an unattended colleague request aborts itself
 * at 180 s) and it matches undici's own 300 s headers/body defaults, so it
 * only ever ends a request that would otherwise have waited forever.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

interface CachedUrl {
  url: string;
  expiresAt: number;
}

let sharedDispatcherInitialised = false;
let sharedDispatcher: unknown = null;

/**
 * The package's shared undici Agent: HTTP/1.1 keep-alive with bounded
 * timeouts. It is passed per request and is NEVER installed with
 * `setGlobalDispatcher`, so importing this package or constructing a
 * ServiceClient changes nothing about any other `fetch` in the process.
 *
 * Why not HTTP/2 (0.1.x negotiated it with `allowH2: true` and made the
 * Agent global, so every fetch in the process, the Anthropic SDK and Vertex
 * included, ran over it):
 *   - undici 6's HTTP/2 client has no liveness check and no request timeout.
 *     lib/dispatcher/client-h2.js (6.28.0) connects with `http2.connect`
 *     and no ping, and leaves stream timeouts unimplemented
 *     (`// stream.on('timeout') ... TODO(HTTP/2): Support timeout`, :514);
 *     headersTimeout/bodyTimeout are read only by client-h1.js. A session
 *     that died in an instance network reset without a FIN/RST reaching us
 *     is reused, and a request on it waits until the caller gives up.
 *   - This package does not depend on undici. It resolves the consumer's
 *     copy: 6.28 in tenant-runtime, none at all in platform-backend's
 *     production image (it is a dev-only transitive dependency there). The
 *     7.x HTTP/2 client does have pingInterval and stream timeouts, but no
 *     setting here can rely on that version being the one that loads.
 *   - Over HTTP/1.1, undici retires an idle socket at keepAliveTimeout and
 *     applies headersTimeout/bodyTimeout to every request (client-h1.js
 *     :944-952), so a stale connection fails instead of hanging. Multiplexing
 *     buys little for this traffic; the keep-alive is what saves the TCP/TLS
 *     handshake, and HTTP/1.1 keeps it.
 *
 * Falls back to null (the global dispatcher) when undici cannot be loaded.
 */
export function getServiceClientDispatcher(): unknown {
  if (sharedDispatcherInitialised) return sharedDispatcher;
  sharedDispatcherInitialised = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require('undici') as { Agent: new (opts: object) => unknown };
    sharedDispatcher = new undici.Agent({
      allowH2: false, // explicit: see above, and future undici majors may flip the default
      keepAliveTimeout: 30_000, // retire a socket idle for 30 s
      keepAliveMaxTimeout: 10 * 60_000, // cap on a server-advertised keep-alive
      connections: 32, // per-origin pool
      connect: { timeout: 10_000 },
      headersTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
      bodyTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    });
  } catch {
    sharedDispatcher = null;
  }
  return sharedDispatcher;
}

/**
 * Service-to-service HTTP client with OIDC + X-Service-Auth + HTTP/1.1
 * keep-alive + request timeout + circuit breaker + URL caching + safe logging.
 */
export class ServiceClient {
  private readonly urlCache = new Map<string, CachedUrl>();
  private readonly breaker: CircuitBreaker;
  private readonly callPolicy: CallPolicy | null;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher: unknown | null;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly options: ServiceClientOptions) {
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.callPolicy =
      options.callPolicy ??
      (options.callPolicyOptions ? new CallPolicy(options.callPolicyOptions) : null);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.dispatcher =
      options.dispatcher === undefined ? getServiceClientDispatcher() : options.dispatcher;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Exposed for Phase 0q observability — callers can poll metrics. */
  getCallPolicyMetrics(): ReturnType<CallPolicy['getMetrics']> | null {
    return this.callPolicy?.getMetrics() ?? null;
  }

  async resolveTargetUrl(key: string): Promise<string> {
    const ttl = this.options.resolveTargetUrlTtlMs ?? 5 * 60_000;
    if (ttl > 0) {
      const cached = this.urlCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.url;
    }
    const url = await this.options.resolveTargetUrl(key);
    if (ttl > 0) {
      this.urlCache.set(key, { url, expiresAt: Date.now() + ttl });
    }
    return url;
  }

  /** Invalidate the cached target URL for a key (e.g. after a re-provision). */
  invalidateUrl(key: string): void {
    this.urlCache.delete(key);
  }

  /**
   * Build the full header set for a request: Content-Type,
   * X-Service-Auth, Authorization (OIDC), plus any defaults.
   */
  async buildHeaders(targetUrl: string, extra?: Record<string, string>): Promise<Record<string, string>> {
    // HTTP header names are case-insensitive, but a plain object treats
    // 'Content-Type' and 'content-type' as distinct keys. `init.headers`
    // gets normalised to lowercase by `new Headers()` in fetch(), so an
    // explicit `headers: { 'Content-Type': 'application/json' }` from a
    // caller arrives here as `content-type` and coexists with the default
    // `Content-Type`. Node's fetch then sends both as a single
    // comma-joined value ("application/json, application/json"), which
    // express.json refuses to parse and silently leaves req.body empty —
    // every required field fails zod validation downstream.
    // Normalise every key to lowercase so caller overrides actually
    // replace defaults rather than coexisting with them.
    const merged: Record<string, string> = {};
    const assign = (src?: Record<string, string>) => {
      if (!src) return;
      for (const [k, v] of Object.entries(src)) merged[k.toLowerCase()] = v;
    };
    assign({ 'content-type': 'application/json' });
    assign(this.options.defaultHeaders);
    assign(extra);

    if (this.options.serviceAuthEnvVar) {
      const token = process.env[this.options.serviceAuthEnvVar];
      if (token) merged['x-service-auth'] = token;
    }

    // Audience = the FULL endpoint URL, never the origin. This is the live
    // contract, not a style choice: platform-backend's strict tenant-caller
    // verifier (platform-tools-router.ts verifyTenantCallerStrict) calls
    // verifyIdToken with audience pinned to the exact canonical endpoint URL
    // (plan v13 Change 3), and tenant-runtime pins the same in
    // platform-callback/__tests__/oidc-audience.test.ts — an origin-audience
    // token 403s every legitimate recall call. The published 0.1.0 minted the
    // full URL; an unpublished in-repo edit ("correct OIDC token audience to
    // service origin") briefly changed this and broke tenant-runtime's suite
    // the moment 0.1.1 was consumed. Cloud Run's own IAM check accepts the
    // full-URL audience (months of deployed 0.1.0 traffic prove it).
    assign(await buildOidcAuthHeader(targetUrl));
    return merged;
  }

  /**
   * Resolve the target URL for `key`, build auth headers, and fetch.
   * The provided `init.headers` is merged with the auth headers (the
   * caller's headers win on conflict for names like `Content-Type`).
   *
   * Circuit breaker wrapping is OPT-IN via `breakerKey` — pass a key
   * to run through the breaker, omit to bypass.
   */
  async fetch(
    key: string,
    path: string,
    init: RequestInit & {
      breakerKey?: string;
      breakerFallback?: Response;
      /**
       * Phase 0q — when the client is constructed with a CallPolicy,
       * setting `idempotent: true` enables retries (up to 3 attempts
       * with exponential backoff). Default false (no retries).
       */
      idempotent?: boolean;
      /**
       * Per-call timeout override, covering the response body too. 0
       * disables the client's timer for this call. With a CallPolicy the
       * policy also races the call against it, clamped to [1, 30000] ms
       * (and against its own default when this is 0 or omitted).
       */
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const {
      breakerKey,
      breakerFallback,
      idempotent,
      timeoutMs,
      signal: callerSignal,
      ...requestInit
    } = init;
    const baseUrl = await this.resolveTargetUrl(key);
    const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

    const extra = init.headers
      ? Object.fromEntries(new Headers(init.headers as HeadersInit))
      : undefined;
    const headers = await this.buildHeaders(url, extra);

    const redactedUrl = redactUrl(url, this.options.redaction);
    const redactedHeaders = redactHeaders(headers as Record<string, string>, this.options.redaction);

    this.options.onLog?.('debug', { key, url: redactedUrl, method: init.method ?? 'GET' }, 'service-client fetch');

    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;

    const runFetch = async () => {
      // A fresh signal per attempt (a CallPolicy retry must not inherit a
      // spent timer). fetch keeps honouring it after the headers arrive, so
      // a body that stops mid-stream ends with the same TimeoutError.
      const signals: AbortSignal[] = [];
      if (callerSignal) signals.push(callerSignal);
      if (effectiveTimeoutMs > 0) signals.push(AbortSignal.timeout(effectiveTimeoutMs));
      const signal =
        signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      const fetchInit: RequestInit & { dispatcher?: unknown } = { ...requestInit, headers };
      if (signal) fetchInit.signal = signal;
      if (this.dispatcher) fetchInit.dispatcher = this.dispatcher;
      try {
        const res = await this.fetchImpl(url, fetchInit);
        this.options.onLog?.(
          'debug',
          { key, url: redactedUrl, status: res.status },
          'service-client response',
        );
        return res;
      } catch (err) {
        this.options.onLog?.(
          'error',
          {
            key,
            url: redactedUrl,
            headers: redactedHeaders,
            error: (err as Error).message,
          },
          'service-client fetch failed',
        );
        throw err;
      }
    };

    // Phase 0q — if a CallPolicy is configured, wrap the fetch in it.
    // The CallPolicy handles retries, circuit breaking, timeouts, and
    // retry budget. Falls through to the legacy breaker path when no
    // CallPolicy is set.
    if (this.callPolicy) {
      const invocation: CallInvocation<Response> = {
        idempotent: idempotent ?? false,
        // 0 turns off the client's timer only; the policy clamps 0 to 1 ms,
        // so let it fall back to its own default instead.
        timeoutMs: timeoutMs === 0 ? undefined : timeoutMs,
        invoke: runFetch,
      };
      return this.callPolicy.execute(invocation);
    }

    if (breakerKey) {
      return this.breaker.executeOrFallback(
        breakerKey,
        runFetch,
        breakerFallback ?? new Response(null, { status: 503, statusText: 'circuit_open' }),
      );
    }
    return runFetch();
  }
}
