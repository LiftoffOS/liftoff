// What a streaming LLM call failed with, and what a person may be told about it.
//
// TWO THINGS THE PROVIDER SDKs DO NOT DO FOR US.
//
// 1. A MID-STREAM FAILURE IS NOT RETRIED BY ANY PROVIDER SDK.
//
// Every provider client is constructed with a retry count (Anthropic's is
// SDK_MAX_RETRIES = 3), and every one of them applies that count to the INITIAL
// HTTP REQUEST ONLY. Once the server has answered 200 and the body is streaming,
// an error arriving as an SSE frame is terminal: the SDK throws it out of the
// iterator and there is nothing left to retry against.
//
// A short provider capacity episode can arrive by two different routes:
//
//   HTTP 529         The SDK retries with backoff, and if it exhausts them the
//                    caller logs one failure. Working as intended.
//   mid-stream frame Throws from `Stream.iterator` inside
//                    `MessageStream._createMessage`, with `headers: {}` because
//                    there is no HTTP error response to take them from, about a
//                    second after the person pressed send. No SDK retry runs,
//                    and each one becomes a user-visible toast.
//
// Same upstream condition, same key, same retry policy on paper. One is
// absorbed and one is shown to a person, and the only difference is which side
// of the 200 the error landed on. That is the gap this module closes.
//
// RETRY IS ONLY SAFE BEFORE THE FIRST CONTENT REACHES THE CONSUMER. A stream is
// not a request: once a text delta has been yielded, restarting produces the
// answer twice, and there is no way to un-yield the first copy. The caller
// enforces that; this module only says what MAY be retried, never when.
//
// 2. THE RAW PROVIDER PAYLOAD MUST NEVER REACH A PERSON.
//
// Such a toast reads, verbatim:
//
//   {"type":"error","error":{"details":null,"type":"overloaded_error",
//    "message":"Overloaded"},"request_id":"req_..."}
//
// That is Anthropic's wire frame, rendered in a chat window. It happens because
// every provider's stream catch yields `(err as Error).message` and the SDK puts
// the response body in that field. All five providers do it, so this is a class
// defect and not an Anthropic one, and it would be just as wrong on a genuine
// capacity blip as on any other error.
//
// The raw text stays in the LOG, which is ours and is where it is useful. What
// crosses to a consumer is one of the sentences below.

/** A closed set, because every member has to have an answer to "retry?" and
 *  "what do we say?". `unknown` is the honest default and is not retried. */
export type StreamFailureClass =
  | 'overloaded'
  | 'rate_limited'
  | 'timeout'
  | 'connection'
  | 'context_overflow'
  | 'auth'
  | 'invalid_request'
  | 'unknown';

/**
 * Retryable classes.
 *
 * Deliberately the same shape the provider SDKs use for the HTTP leg (429, 529,
 * 5xx, 408, connection errors), so a failure is treated identically whichever
 * side of the 200 it arrives on. That symmetry is the whole point: the failure
 * mode is two routes disagreeing about one condition.
 *
 * `invalid_request` and `auth` are excluded because repeating them cannot
 * change the answer, and `context_overflow` because the next attempt sends the
 * same oversized window.
 */
const RETRYABLE: ReadonlySet<StreamFailureClass> = new Set<StreamFailureClass>([
  'overloaded',
  'rate_limited',
  'timeout',
  'connection',
]);

export function isRetryableStreamFailure(cls: StreamFailureClass): boolean {
  return RETRYABLE.has(cls);
}

/**
 * Classify a thrown or yielded provider failure.
 *
 * Reads the STRUCTURE first and the text second. An Anthropic mid-stream frame
 * has no HTTP status to read — the status lives inside a JSON body that the SDK
 * stuffed into `.message` — so a status-only classifier scores it `unknown` and
 * does not retry it, which is the bug. A text-only classifier would misread a
 * person's message quoting the word "overloaded". Both are consulted, structure
 * winning, and the text patterns are matched against provider vocabulary rather
 * than ordinary English.
 */
export function classifyStreamFailure(err: unknown): StreamFailureClass {
  const e = (err ?? {}) as Record<string, unknown>;

  // Structured: an HTTP status, however the SDK spells it.
  const status =
    numberOrNull(e.status) ??
    numberOrNull(e.statusCode) ??
    numberOrNull((e.response as Record<string, unknown> | undefined)?.status);
  if (status != null) {
    const byStatus = classifyStatus(status);
    if (byStatus) return byStatus;
  }

  // Structured: a provider error type, either on the object or inside the JSON
  // body the SDK put in `.message`. This is the branch that catches the
  // mid-stream frame that carries no status.
  const providerType = extractProviderErrorType(e);
  if (providerType) {
    const byType = classifyProviderType(providerType);
    if (byType) return byType;
  }

  // Node connection failures carry a code and no status.
  const code = typeof e.code === 'string' ? e.code : null;
  if (code && CONNECTION_CODES.has(code)) return 'connection';

  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';

  // Text, last and narrowest.
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (!message) return 'unknown';
  if (message.includes('overloaded_error') || message.includes('overloaded')) return 'overloaded';
  if (message.includes('rate_limit') || message.includes('too many requests')) return 'rate_limited';
  if (message.includes('context_length') || message.includes('too many tokens')) {
    return 'context_overflow';
  }
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('econnreset') || message.includes('socket hang up')) return 'connection';
  return 'unknown';
}

/** Node/undici connection failures. No HTTP status ever reaches us for these. */
const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

function classifyStatus(status: number): StreamFailureClass | null {
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  if (status >= 500) return 'overloaded';
  return null;
}

function classifyProviderType(type: string): StreamFailureClass | null {
  switch (type) {
    case 'overloaded_error': return 'overloaded';
    case 'rate_limit_error': return 'rate_limited';
    case 'timeout_error': return 'timeout';
    case 'authentication_error':
    case 'permission_error': return 'auth';
    case 'invalid_request_error':
    case 'not_found_error': return 'invalid_request';
    case 'api_error':
    case 'overloaded': return 'overloaded';
    default: return null;
  }
}

/**
 * Dig the provider's own error type out, including from a JSON body that the SDK
 * turned into the message string.
 *
 * The mid-stream case is exactly this: `.message` is the whole frame
 * `{"type":"error","error":{"type":"overloaded_error",...},"request_id":...}`
 * and there is nothing else structured to read.
 */
function extractProviderErrorType(e: Record<string, unknown>): string | null {
  const direct = (e.error as Record<string, unknown> | undefined) ?? undefined;
  const nested = (direct?.error as Record<string, unknown> | undefined) ?? undefined;
  for (const candidate of [nested, direct, e]) {
    const t = candidate?.type;
    // `type: 'error'` is the envelope, not the class; keep digging past it.
    if (typeof t === 'string' && t !== 'error') return t;
  }

  const message = typeof e.message === 'string' ? e.message : '';
  // The SDK also prefixes an HTTP body with its status ("529 {...}"), so find
  // the JSON rather than assuming the string starts with it.
  const brace = message.indexOf('{');
  if (brace === -1) return null;
  try {
    const body = JSON.parse(message.slice(brace)) as Record<string, unknown>;
    const inner = body.error as Record<string, unknown> | undefined;
    const t = inner?.type ?? body.type;
    if (typeof t === 'string' && t !== 'error') return t;
  } catch {
    // Not JSON. The text patterns above still get their turn.
  }
  return null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * What a person is told.
 *
 * One sentence per class, saying what happened and whether it is worth trying
 * again, and carrying no identifiers, no provider name and no payload. A person
 * cannot act on `req_011Cea...` and should not be shown which vendor is behind
 * the assistant.
 *
 * Product voice: no em dashes, no contractions, does not say "agent".
 */
export function streamFailureMessage(cls: StreamFailureClass): string {
  switch (cls) {
    case 'overloaded':
      return 'The service is busy right now. Please try again in a moment.';
    case 'rate_limited':
      return 'Too many requests right now. Please try again in a moment.';
    case 'timeout':
      return 'That took too long to answer. Please try again.';
    case 'connection':
      return 'The connection dropped while the reply was being written. Please try again.';
    case 'context_overflow':
      return 'This conversation has grown too long to continue. Please start a new one.';
    case 'auth':
      return 'This assistant is not configured correctly. Please contact support.';
    case 'invalid_request':
      return 'That request could not be processed. Please try again.';
    case 'unknown':
      return 'Something went wrong. Please try again.';
  }
}
