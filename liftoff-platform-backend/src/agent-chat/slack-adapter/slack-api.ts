// Shared Slack Web API client.
//
// Every call to slack.com/api/* in this adapter goes through slackApiFetch
// so we get one place to enforce:
//
//   1. Request timeout (AbortSignal.timeout) — a hung Slack call must not
//      hold an advisory lock, a Cloud Run request slot, or block a
//      scheduler invocation indefinitely.
//
//   2. Rate-limit retry — on `data.error === 'ratelimited'` or HTTP 429,
//      sleep for the `Retry-After` header (capped) and retry. apps.manifest.*
//      have tighter app-creation limits than standard tiers, so the helper
//      respects whatever Slack tells us.
//
//   3. Consistent error semantics — see SlackApiError below. Callers can
//      branch on `data.error` strings without re-implementing the wire
//      handling.

import { log } from '../../infrastructure/logging';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
// Cap server-suggested Retry-After to keep one stuck rate-limit from
// holding the advisory lock or scheduler attempt past their own deadlines.
const MAX_RETRY_AFTER_MS = 30_000;

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export type SlackApiBody =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'form'; value: Record<string, string> };

export interface SlackApiOptions {
  /** Bearer token for Authorization header. Omit for public endpoints. */
  authToken?: string;
  /**
   * Request body. `kind` states the caller's intent; the wire encoding is
   * decided by chooseEncoding below, which downgrades a scalar-only JSON body
   * to form. See that comment for why the caller does not get to be wrong.
   */
  body: SlackApiBody;
  /** Per-call timeout override. Defaults to 10s. */
  timeoutMs?: number;
  /** Max ratelimited retries. Defaults to 3. */
  maxRetries?: number;
}

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string | undefined,
    public readonly httpStatus: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/**
 * Slack parses a JSON body for WRITE methods only.
 *
 * A read method (users.info, conversations.info, users.list) reads its
 * arguments from the form body and ignores JSON entirely. It does not reject
 * the request: the arguments simply never arrive, and Slack then reports the
 * resulting ABSENCE as a domain error — users.info answers `user_not_found`,
 * conversations.info answers `invalid_arguments`. Both read as "your argument
 * was wrong" rather than "your argument was missing", and they differ per
 * method, so there is no one error string to notice. That is how
 * `users.info` can fail on every call while every chat.postMessage beside it
 * succeeds: every Slack turn is attributed to a guest with a null accountId,
 * and nothing anywhere says so.
 *
 * So encoding is not a decision a call site gets to make wrong. A payload
 * whose values are ALL scalars is form-encoded, which every Slack method
 * accepts, read and write alike. JSON is used only when a value is an object
 * or array — blocks, attachments, a view — which form cannot represent and
 * which only write methods take anyway.
 *
 * Verified against the live Slack API, same token and same id:
 * users.info form → ok, JSON → user_not_found; conversations.info JSON →
 * invalid_arguments; conversations.open (a write) → ok either way.
 */
function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Drop keys Slack should not receive at all.
 *
 * JSON.stringify omits `undefined` values; URLSearchParams would faithfully
 * send the string "undefined" instead. Without this, downgrading a body to
 * form would turn an absent optional argument into a literal — which is
 * exactly the class of silent wrong-argument bug this function exists to end.
 */
function definedEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).filter(([, v]) => v !== undefined && v !== null);
}

/** The wire encoding for a body, given the rule above. Exported for the test. */
export function chooseEncoding(
  body: SlackApiBody,
): { contentType: string; body: BodyInit } {
  if (body.kind === 'form') {
    return {
      contentType: 'application/x-www-form-urlencoded',
      body: new URLSearchParams(body.value),
    };
  }

  const entries = definedEntries(body.value);
  if (entries.every(([, v]) => isScalar(v))) {
    const form = new URLSearchParams();
    for (const [k, v] of entries) form.set(k, String(v));
    return { contentType: 'application/x-www-form-urlencoded', body: form };
  }

  return {
    contentType: 'application/json',
    body: JSON.stringify(body.value),
  };
}

/**
 * POST to https://slack.com/api/<method> and return the parsed response.
 * Retries on `ratelimited` up to maxRetries; throws on transport errors,
 * non-2xx HTTP, or non-JSON bodies.
 */
export async function slackApiFetch(
  method: string,
  options: SlackApiOptions,
): Promise<SlackApiResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const url = `https://slack.com/api/${method}`;

  const headers: Record<string, string> = {};
  const encoded = chooseEncoding(options.body);
  headers['Content-Type'] = encoded.contentType;
  const body: BodyInit = encoded.body;
  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
  }

  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network failure or timeout — throw without retry. The caller decides
      // whether to retry at a higher level; we don't blindly retry transport
      // errors because some endpoints (e.g. tooling.tokens.rotate) are
      // destructive and may have already succeeded server-side.
      throw new SlackApiError(method, undefined, undefined, `Slack ${method} transport error: ${(err as Error).message}`);
    }

    let data: SlackApiResponse;
    try {
      data = (await response.json()) as SlackApiResponse;
    } catch (err) {
      throw new SlackApiError(
        method,
        undefined,
        response.status,
        `Slack ${method} returned non-JSON response (HTTP ${response.status}): ${(err as Error).message}`,
      );
    }

    if (data.ok) {
      return data;
    }

    const isRateLimited = data.error === 'ratelimited' || data.error === 'rate_limited' || response.status === 429;
    if (isRateLimited && attempt < maxRetries) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const delayMs = Math.min(
        Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 2000 * (attempt + 1),
        MAX_RETRY_AFTER_MS,
      );
      log.warn(
        { method, attempt: attempt + 1, delayMs, slackError: data.error },
        'Slack API ratelimited — backing off',
      );
      await new Promise((r) => setTimeout(r, delayMs));
      attempt += 1;
      continue;
    }

    // Not retriable — let the caller branch on data.error.
    return data;
  }
}
