// One `ask` over the TypeSafe SDK, for every question set this runtime sends.
//
// The runtime calls the vendor DIRECTLY, as the reference loop does: one
// keep-alive client per process, the key from the platform control project
// (`typesafe-api-key`, the same cross-project read steel-api-key takes), the
// pinned model id from questions.ts. No control-plane hop sits on the critical
// path of a decision.
//
// Usage still lands on the control plane, per request, SYNCHRONOUSLY, before
// the answer is used: every logical call produces exactly one record, posted
// to POST /api/internal/usage/record with a runtime-minted callId the route
// inserts idempotently on. The POST is retried up to twice on a 5xx or a
// timeout — a retried POST after an ambiguous response is one row — and a
// POST that fails after its retries makes `ask` return null, so the caller
// takes today's path rather than continuing on an unaccounted step. There is
// no in-memory queue and nothing is drained at task end: a process exit loses
// nothing that was not already refused.
//
// The retry rule is the control plane's (INV-PB-013): the SDK never retries
// (`retry.maxRetries: 0`); this loop re-sends only on a DNS or TCP connect
// failure, a TLS handshake failure, or a 429 — outcomes where the request
// provably never reached the vendor's application — at most twice, with the
// reference loop's backoff of 0.5 s × 2ⁿ. A 503, 529, timeout, abort or
// interrupted body is ambiguous and ends the call. (The reference loop retries
// 503 and 529 too; this one does not, for the billing reason above.)
//
// `agentId` is the RUNTIME agent id; it is translated with resolveInternalAgentId
// before the post and omitted on a miss. The route classifies by purpose, not
// by the id's absence: every runtime purpose is a run's own work and is
// customer usage, so a miss changes attribution, never chargeability.

import { randomUUID } from 'crypto';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  RateLimitError,
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult,
} from '@typesafe-ai/sdk';
import { logger } from '../infrastructure/logging';
import { getWebToolSecret } from '../integrations/web-fetch/web-tool-secrets';
import { getPlatformCallbackClient } from '../platform-callback/client';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import type { QuestionSet, RuntimeSetId } from './questions';

export interface AskOptions {
  /** The whole call's budget, retries included: the task's remaining clock. */
  deadlineMs: number;
  /** Per attempt. 25 s is the reference loop's request timeout. */
  attemptTimeoutMs?: number;
  /** Bounds ONLY this loop's re-sends on the unserved outcomes named above. */
  maxRetries?: number;
  tenantId: string;
  /** The RUNTIME agent id, translated before the post; omitted on a miss. */
  runtimeAgentId?: string;
  invocationId?: string;
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

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_RETRIES = 2;
export const RETRY_BACKOFF_MS = (attemptIndex: number): number => 500 * 2 ** attemptIndex;
/** The usage POST's own retries, on a 5xx or a timeout. */
export const USAGE_POST_RETRIES = 2;
export const USAGE_POST_TIMEOUT_MS = 5_000;

const UNSERVED_CAUSE_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME',
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_TLSV1_UNRECOGNIZED_NAME', 'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'HOSTNAME_MISMATCH', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
]);

export type AttemptOutcomeClass =
  | 'served' | 'connect_failure' | 'tls_failure' | 'rate_limited' | 'timeout' | 'aborted'
  | 'interrupted_body' | 'http_error' | 'sdk_error';

function causeCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Exported for the client test. */
export function classifyAttemptFailure(err: unknown): { klass: AttemptOutcomeClass; retryable: boolean } {
  if (err instanceof APIUserAbortError) return { klass: 'aborted', retryable: false };
  if (err instanceof APITimeoutError) return { klass: 'timeout', retryable: false };
  if (err instanceof RateLimitError) return { klass: 'rate_limited', retryable: true };
  if (err instanceof APIError) return { klass: 'http_error', retryable: false };
  if (err instanceof APIConnectionError) {
    const code = causeCode(err);
    if (code && UNSERVED_CAUSE_CODES.has(code)) {
      const tls = code.includes('TLS') || code.includes('SSL') || code.includes('CERT') || code === 'HOSTNAME_MISMATCH';
      return { klass: tls ? 'tls_failure' : 'connect_failure', retryable: true };
    }
    return { klass: 'interrupted_body', retryable: false };
  }
  return { klass: 'sdk_error', retryable: false };
}

let cachedClient: { key: string; client: TypeSafeClient } | null = null;
let clientFactory: (apiKey: string) => TypeSafeClient = (apiKey) =>
  new TypeSafeClient({ apiKey, logLevel: 'off', retry: { maxRetries: 0 } });

/** Test seam: the SDK client. */
export function _setTypeSafeClientFactoryForTesting(factory: ((apiKey: string) => TypeSafeClient) | null): void {
  clientFactory = factory ?? ((apiKey) => new TypeSafeClient({ apiKey, logLevel: 'off', retry: { maxRetries: 0 } }));
  cachedClient = null;
}

/** Test seam: the key. */
let keyReader: () => Promise<string | null> = async () => {
  try {
    return await getWebToolSecret('typesafe-api-key');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'typesafe: no API key readable');
    return null;
  }
};
export function _setTypeSafeKeyReaderForTesting(reader: (() => Promise<string | null>) | null): void {
  keyReader = reader ?? (async () => {
    try { return await getWebToolSecret('typesafe-api-key'); } catch { return null; }
  });
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

function thresholdsPinned(set: Pick<QuestionSet, 'thresholds'>): boolean {
  return Object.values(set.thresholds).every((v) => typeof v === 'number' && Number.isFinite(v));
}

export interface UsageRecordBody {
  callId: string;
  attempts: number;
  provider: 'typesafe';
  model: string;
  inputTokens: number;
  outputTokens: number;
  tenantId: string;
  invocationId?: string;
  agentId?: string;
  setId: RuntimeSetId;
  success: boolean;
  error?: string;
  vendorRequestId?: string;
}

/** Test seam: the usage post. Returns true when the control plane acknowledged
 *  the row. */
let usagePoster: (body: UsageRecordBody) => Promise<boolean> = postUsageRecord;
export function _setUsagePosterForTesting(poster: ((body: UsageRecordBody) => Promise<boolean>) | null): void {
  usagePoster = poster ?? postUsageRecord;
}

/**
 * POST the record to the control plane, retrying up to twice on a 5xx or a
 * timeout. Idempotent on `callId` at the route, so a retry after an ambiguous
 * response is one row. False after every attempt failed.
 */
export async function postUsageRecord(body: UsageRecordBody): Promise<boolean> {
  const client = getPlatformCallbackClient();
  if (!client) {
    logger.error({ callId: body.callId, setId: body.setId }, 'typesafe: no platform callback client; usage cannot be recorded');
    return false;
  }
  for (let attempt = 0; attempt <= USAGE_POST_RETRIES; attempt++) {
    try {
      const resp = await client.fetch('platform', '/api/internal/usage/record', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(USAGE_POST_TIMEOUT_MS),
      });
      if (resp.ok) return true;
      if (resp.status < 500) {
        logger.error({ callId: body.callId, setId: body.setId, status: resp.status }, 'typesafe: usage record refused');
        return false;
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, callId: body.callId, attempt }, 'typesafe: usage post failed');
    }
  }
  return false;
}

/**
 * Ask one question set. Returns the typed answers, or null after one
 * structured log line. Never throws. The row is acknowledged before the
 * answer is returned.
 */
export async function ask<Q extends Questions>(
  set: QuestionSet<Q>,
  state: EntryType,
  opts: AskOptions,
): Promise<AskResult<Q> | null> {
  const base = { setId: set.id, setVersion: set.version, tenantId: opts.tenantId, invocationId: opts.invocationId };
  if (!thresholdsPinned(set)) {
    logger.warn({ metric: 'typesafe.ask.threshold_unset', ...base }, 'typesafe: a threshold on this set is unpinned; no request');
    return null;
  }
  if (opts.deadlineMs <= 0) {
    logger.info({ metric: 'typesafe.ask.no_time', ...base }, 'typesafe: no clock left for a request');
    return null;
  }
  const apiKey = await keyReader();
  if (!apiKey) {
    logger.warn({ metric: 'typesafe.ask.no_key', ...base }, 'typesafe: no API key; no request, no row');
    return null;
  }

  const callId = randomUUID();
  const startedAt = Date.now();
  const deadlineAt = startedAt + opts.deadlineMs;
  const signal = AbortSignal.timeout(opts.deadlineMs);
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = clientFor(apiKey);

  let attempts = 0;
  let lastFailure: { klass: AttemptOutcomeClass; message: string } | null = null;
  let result: { data: SystemOneResult<Q>; requestId: string | undefined } | null = null;

  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++) {
    if (Date.now() >= deadlineAt || signal.aborted) break;
    attempts += 1;
    try {
      const res = await client
        .systemOne({ state, questions: set.questions, model: set.model }, {
          signal,
          timeout: Math.min(attemptTimeoutMs, Math.max(1, deadlineAt - Date.now())),
          retry: { maxRetries: 0 },
        })
        .withResponse();
      result = { data: res.data, requestId: res.requestId };
      lastFailure = null;
      break;
    } catch (err) {
      const { klass, retryable } = classifyAttemptFailure(err);
      lastFailure = { klass, message: (err as Error)?.message ?? String(err) };
      if (!retryable || attemptIndex >= maxRetries) break;
      let waitMs = RETRY_BACKOFF_MS(attemptIndex);
      if (err instanceof RateLimitError && typeof err.retryAfterMs === 'number') waitMs = err.retryAfterMs;
      if (Date.now() + waitMs >= deadlineAt) break;
      await sleep(waitMs, signal);
    }
  }
  const latencyMs = Date.now() - startedAt;

  const drifted = result !== null && result.data.model !== set.model;
  let agentId: string | undefined;
  if (opts.runtimeAgentId) {
    try {
      agentId = (await resolveInternalAgentId(opts.tenantId, opts.runtimeAgentId, `typesafe:${set.id}`)) ?? undefined;
    } catch {
      // The resolver logs its own miss; the row carries no agent id.
    }
  }
  const recorded = await usagePoster({
    callId,
    attempts,
    provider: 'typesafe',
    model: result?.data.model ?? set.model,
    inputTokens: Math.max(0, Math.floor(result?.data.usage.input_tokens ?? 0)),
    outputTokens: Math.max(0, Math.floor(result?.data.usage.output_tokens ?? 0)),
    tenantId: opts.tenantId,
    ...(opts.invocationId ? { invocationId: opts.invocationId } : {}),
    ...(agentId ? { agentId } : {}),
    setId: set.id,
    success: result !== null && !drifted,
    ...(drifted
      ? { error: `model_drift: expected ${set.model}, got ${result?.data.model}` }
      : lastFailure ? { error: `${lastFailure.klass}: ${lastFailure.message}`.slice(0, 500) } : {}),
    ...(result?.requestId ? { vendorRequestId: result.requestId } : {}),
  });
  if (!recorded) {
    logger.error(
      { metric: 'typesafe.usage.unrecorded', ...base, callId, attempts, vendorRequestId: result?.requestId, at: new Date(startedAt).toISOString() },
      'typesafe: usage row not acknowledged; the answer is not used',
    );
    return null;
  }
  if (!result) {
    logger.warn({ metric: 'typesafe.ask.failed', ...base, callId, attempts, outcome: lastFailure?.klass, error: lastFailure?.message, latencyMs }, 'typesafe: no response');
    return null;
  }
  if (drifted) {
    logger.warn({ metric: 'typesafe.model_drift', ...base, callId, expected: set.model, actual: result.data.model }, 'typesafe: model drift; answer rejected');
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
