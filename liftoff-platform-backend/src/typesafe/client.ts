// One `ask` over the TypeSafe SDK, for every question set this service sends.
//
// Three properties, and everything else in this file serves them:
//
//   1. The model is pinned. `set.model` is a concrete id and it is what is
//      sent; a response naming another model is recorded and then rejected.
//   2. Exactly one usage row per logical call, and one vendor attempt that
//      could have been billed. The SDK never retries (`retry.maxRetries: 0`);
//      this loop re-sends ONLY on outcomes where the request provably never
//      reached the vendor's application: a DNS or TCP connect failure, a TLS
//      handshake failure, or a 429. A 503, 529, timeout, abort or interrupted
//      body is ambiguous — it can come back after the request was queued or
//      partly served — so it ends the call. The row records `attempts`.
//   3. No answer is used unrecorded. The row is written before `ask` returns,
//      and an `ask` whose write fails returns null. That rule does not by
//      itself give every attempt a row: a write that fails after a served
//      request leaves an attempt the vendor may bill and this estate did not
//      record. The `callId` is ours and is not sent to the vendor; what can
//      reconcile is the vendor's own request id, stored as `vendor_request_id`
//      when a response arrived. The residue that has neither is logged with
//      the callId, the set id and the timestamp, which bounds it in a vendor
//      usage export by time window, never row for row.
//
// Callers treat null as `unavailable` and take today's path. `ask` never
// throws.

import { randomUUID } from 'crypto';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeClient,
  type Questions,
  type SystemOneResult,
  type EntryType,
} from '@typesafe-ai/sdk';
import { log } from '../infrastructure/logging';
import { getTypeSafeApiKey } from '../infrastructure/secrets';
import { recordTypeSafeUsage, type TypeSafeUsageOutcome } from './usage';
import type { QuestionSet } from './questions';

export interface AskOptions {
  /** The whole call's budget, retries included. */
  deadlineMs: number;
  /** Per attempt. */
  attemptTimeoutMs: number;
  /** Bounds ONLY this loop's re-sends on the unserved outcomes named above.
   *  The SDK's own retry is always off. */
  maxRetries: number;
  purpose: string;
  /** Required for every purpose except `tool_classification` (platform
   *  overhead; the global connector inventory has no tenant). */
  tenantId?: string;
  agentId?: string;
  sessionId?: string;
  invocationId?: string;
  /** Some purposes depend on the answer (Phase 9: the chosen team, or none).
   *  Called on the response before the row is written; on no response the
   *  caller's default purpose is used. There is never a second write. */
  finalize?: (answers: unknown) => { purpose: string; agentId?: string };
}

export interface AskResult<Q extends Questions> {
  answers: SystemOneResult<Q>['answers'];
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  callId: string;
  attempts: number;
  vendorRequestId?: string;
  latencyMs: number;
}

/** The reference loop's backoff: 0.5 s × 2ⁿ. */
export const RETRY_BACKOFF_MS = (attemptIndex: number): number => 500 * 2 ** attemptIndex;

/** Error codes on a fetch failure's cause that mean the request never reached
 *  the vendor's application. ECONNRESET is deliberately absent: a reset can
 *  arrive after the request was sent. */
const UNSERVED_CAUSE_CODES: ReadonlySet<string> = new Set([
  // DNS
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME',
  // TCP connect
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
  // TLS handshake
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME', 'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'HOSTNAME_MISMATCH', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
]);

export type AttemptOutcomeClass =
  | 'served'
  | 'connect_failure'
  | 'tls_failure'
  | 'rate_limited'
  | 'timeout'
  | 'aborted'
  | 'interrupted_body'
  | 'http_error'
  | 'sdk_error';

function causeCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Which class an attempt's failure falls in, and whether it is one this loop
 *  may re-send on. Exported for the client test. */
export function classifyAttemptFailure(err: unknown): { klass: AttemptOutcomeClass; retryable: boolean } {
  if (err instanceof APIUserAbortError) return { klass: 'aborted', retryable: false };
  if (err instanceof APITimeoutError) return { klass: 'timeout', retryable: false };
  if (err instanceof RateLimitError) return { klass: 'rate_limited', retryable: true };
  if (err instanceof APIError) return { klass: 'http_error', retryable: false };
  if (err instanceof APIConnectionError) {
    const code = causeCode(err);
    if (code && UNSERVED_CAUSE_CODES.has(code)) {
      return { klass: code.includes('TLS') || code.includes('SSL') || code.includes('CERT') || code === 'HOSTNAME_MISMATCH'
        ? 'tls_failure'
        : 'connect_failure', retryable: true };
    }
    return { klass: 'interrupted_body', retryable: false };
  }
  return { klass: 'sdk_error', retryable: false };
}

let cachedClient: { key: string; client: TypeSafeClient } | null = null;

/** Test seam: replace the SDK client factory. */
let clientFactory: (apiKey: string) => TypeSafeClient = (apiKey) =>
  new TypeSafeClient({ apiKey, logLevel: 'off', retry: { maxRetries: 0 } });

export function _setTypeSafeClientFactoryForTesting(
  factory: ((apiKey: string) => TypeSafeClient) | null,
): void {
  clientFactory = factory ?? ((apiKey) => new TypeSafeClient({ apiKey, logLevel: 'off', retry: { maxRetries: 0 } }));
  cachedClient = null;
}

function clientFor(apiKey: string): TypeSafeClient {
  if (cachedClient && cachedClient.key === apiKey) return cachedClient.client;
  const client = clientFactory(apiKey);
  cachedClient = { key: apiKey, client };
  return client;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function thresholdsPinned(set: QuestionSet): boolean {
  return Object.values(set.thresholds).every((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Ask one question set. Returns the typed answers, or null on any failure
 * after one structured log line.
 */
export async function ask<Q extends Questions>(
  set: QuestionSet<Q>,
  state: EntryType,
  opts: AskOptions,
): Promise<AskResult<Q> | null> {
  const base = { setId: set.id, setVersion: set.version, purpose: opts.purpose, tenantId: opts.tenantId };
  if (opts.purpose !== 'tool_classification' && !opts.tenantId) {
    log.warn({ metric: 'typesafe.ask.no_tenant', ...base }, 'TypeSafe ask refused: a tenant is required for this purpose');
    return null;
  }
  if (!thresholdsPinned(set)) {
    log.warn({ metric: 'typesafe.ask.threshold_unset', ...base }, 'TypeSafe ask refused: a threshold on this set is unpinned');
    return null;
  }
  const apiKey = await getTypeSafeApiKey();
  if (!apiKey) {
    log.warn({ metric: 'typesafe.ask.no_key', ...base }, 'TypeSafe ask refused: no API key configured');
    return null;
  }

  const callId = randomUUID();
  const startedAt = Date.now();
  const deadlineAt = startedAt + opts.deadlineMs;
  const signal = AbortSignal.timeout(opts.deadlineMs);
  const client = clientFor(apiKey);

  let attempts = 0;
  let lastFailure: { klass: AttemptOutcomeClass; message: string } | null = null;
  let result: { data: SystemOneResult<Q>; requestId: string | undefined } | null = null;

  for (let attemptIndex = 0; attemptIndex <= opts.maxRetries; attemptIndex++) {
    if (Date.now() >= deadlineAt || signal.aborted) break;
    attempts += 1;
    try {
      const attemptTimeout = Math.min(opts.attemptTimeoutMs, Math.max(1, deadlineAt - Date.now()));
      const res = await client
        .systemOne({ state, questions: set.questions, model: set.model }, {
          signal,
          timeout: attemptTimeout,
          // Always. The SDK never retries; this loop owns the decision.
          retry: { maxRetries: 0 },
        })
        .withResponse();
      result = { data: res.data, requestId: res.requestId };
      lastFailure = null;
      break;
    } catch (err) {
      const { klass, retryable } = classifyAttemptFailure(err);
      lastFailure = { klass, message: (err as Error)?.message ?? String(err) };
      if (!retryable || attemptIndex >= opts.maxRetries) break;
      // A 429 carries the server's own wait; honoured only when it fits the
      // deadline. Otherwise the reference backoff.
      let waitMs = RETRY_BACKOFF_MS(attemptIndex);
      if (err instanceof RateLimitError && typeof err.retryAfterMs === 'number') waitMs = err.retryAfterMs;
      if (Date.now() + waitMs >= deadlineAt) break;
      await sleep(waitMs, signal);
    }
  }

  const latencyMs = Date.now() - startedAt;

  // The row, whatever happened. Purpose and agent are finalised from the
  // answer when the caller asked for that; on no response the defaults stand.
  let purpose = opts.purpose;
  let agentId = opts.agentId;
  if (result && opts.finalize) {
    try {
      const f = opts.finalize(result.data.answers);
      purpose = f.purpose;
      agentId = f.agentId;
    } catch (err) {
      log.warn({ ...base, callId, err: (err as Error).message }, 'TypeSafe finalize threw; default purpose kept');
    }
  }

  const drifted = result !== null && result.data.model !== set.model;
  const outcome: TypeSafeUsageOutcome = result
    ? (drifted ? 'drift' : 'success')
    : 'no_response';

  const recorded = await recordTypeSafeUsage({
    callId,
    attempts,
    setId: set.id,
    model: result?.data.model ?? set.model,
    inputTokens: result?.data.usage.input_tokens ?? 0,
    outputTokens: result?.data.usage.output_tokens ?? 0,
    outcome,
    error: drifted
      ? `model_drift: expected ${set.model}, got ${result?.data.model}`
      : lastFailure
        ? `${lastFailure.klass}: ${lastFailure.message}`.slice(0, 500)
        : undefined,
    vendorRequestId: result?.requestId,
    context: {
      purpose,
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.invocationId ? { invocationId: opts.invocationId } : {}),
    },
  });
  if (!recorded) {
    log.error(
      { metric: 'typesafe.usage.unrecorded', ...base, callId, attempts, vendorRequestId: result?.requestId, at: new Date(startedAt).toISOString() },
      'TypeSafe usage row could not be written; the answer is not used',
    );
    return null;
  }

  if (!result) {
    log.warn(
      { metric: 'typesafe.ask.failed', ...base, callId, attempts, outcome: lastFailure?.klass, error: lastFailure?.message, latencyMs },
      'TypeSafe ask returned no response',
    );
    return null;
  }
  if (drifted) {
    log.warn(
      { metric: 'typesafe.model_drift', ...base, callId, expected: set.model, actual: result.data.model },
      'TypeSafe answered with a model other than the pinned one; answer rejected',
    );
    return null;
  }

  return {
    answers: result.data.answers,
    model: result.data.model,
    usage: { inputTokens: result.data.usage.input_tokens, outputTokens: result.data.usage.output_tokens },
    callId,
    attempts,
    vendorRequestId: result.requestId,
    latencyMs,
  };
}
