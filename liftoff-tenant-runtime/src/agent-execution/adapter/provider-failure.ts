// Read a provider failure off the thrown error, instead of off its prose.
//
// WHY THIS EXISTS. `classifyFailure` is ~90 lines of regex over
// `invocations.error_message`. It is careful work — its `hasStatusCode` helper
// has to require digit boundaries AND a context marker so "processed 401
// records" is not read as an auth failure, and an `isSomeoneElsesFailure`
// pre-pass exists because tool-gateway rejections carry their own status codes
// into the message. It is also matching prose, and prose changes. Three commits
// in one day patched misfires in it.
//
// The providers already tell us what happened, in structured fields, and we
// throw that away before the classifier ever runs. This reads it instead. The
// regex path is not deleted — it stays as the fallback for anything that arrives
// as a bare string — but a failure that carries a type or a status no longer has
// to be inferred from a sentence.
//
// SECOND THING THIS FIXES. `provider_request_id` appears NOWHERE in
// src/agent-execution/. When a provider asks "what was the request id?" on a
// support ticket, we cannot answer. Every extraction below looks for one.

/** What actually went wrong at the provider, as the provider describes it —
 *  plus `adapter_internal`, which is the one member that is NOT about the
 *  provider at all.
 *
 *  `adapter_internal` is a fault in OUR code or the vendor SDK: a TypeError, a
 *  ReferenceError, a RangeError thrown while translating, dispatching or
 *  consuming. It earns a name because it is the opposite kind of problem from
 *  everything else here. A provider failure is somebody else's outage and the
 *  remediation is to wait, re-authenticate or top up; an adapter fault is a bug
 *  with our name on it and the remediation is a patch. Retrying one is polite;
 *  retrying the other reproduces it exactly.
 *
 *  The motivating case: a conversation rebuilt from the canonical record,
 *  replayed onto the OpenAI engine, can die with
 *  `item.content.map is not a function` — thrown inside @openai/agents because
 *  the adapter handed it an assistant item whose `content` was a string. No
 *  provider is involved, nothing carries a type or a status, so without this
 *  member it classifies as `unknown` and lands in the bucket that is supposed to mean "nobody has
 *  looked at this yet". */
export type ProviderFailureKind =
  | 'refusal' | 'safety' | 'overloaded' | 'rate_limit' | 'server_error'
  | 'auth' | 'quota' | 'invalid_request' | 'malformed_response' | 'network'
  | 'adapter_internal' | 'unknown';

/** JS runtime error constructors. Their presence means the failure was thrown
 *  by executing code, not returned by a service — no HTTP status, no provider
 *  error type, nothing to classify against. `Error` itself is excluded: it is
 *  the generic base every SDK also throws deliberately, so treating it as a
 *  runtime fault would swallow real provider errors. */
const RUNTIME_FAULT_NAMES: ReadonlySet<string> = new Set([
  'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError',
]);

/** Transport failures that arrive wearing a runtime constructor.
 *
 *  `TypeError` is not proof of a bug on its own: Node's fetch (undici) throws
 *  `TypeError: fetch failed` for a genuine network drop, and `TypeError:
 *  terminated` when a response stream dies mid-flight. Those are the provider
 *  being unreachable — retryable, and nothing to patch. Classifying them as an
 *  adapter defect would both mislabel the failure and stop the retry that
 *  fixes it.
 *
 *  So the constructor decides only when the message does not already name a
 *  transport failure. Kept deliberately narrow: these two shapes, plus the
 *  errno family, are what undici actually emits. */
const TRANSPORT_FAULT_MESSAGE =
  /fetch failed|terminated|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|network error|TLS handshake|certificate/i;

/** True when this error is a fault in OUR code rather than the provider's.
 *
 *  Takes the message as well as the name, because the name alone is ambiguous:
 *  see `TRANSPORT_FAULT_MESSAGE`. An existing test caught this — it asserts
 *  `TypeError: fetch failed` classifies as `provider_network`, and it was right
 *  to. */
export function isRuntimeFaultName(name: string | undefined, message?: string): boolean {
  if (!name || !RUNTIME_FAULT_NAMES.has(name)) return false;
  return !(message && TRANSPORT_FAULT_MESSAGE.test(message));
}

export interface ProviderFailureInfo {
  kind: ProviderFailureKind;
  /** Provider's own identifier, e.g. "overloaded_error", "SAFETY". */
  providerErrorType?: string;
  status?: number;
  requestId?: string;
  /** What the provider actually SAID, bounded. A gateway wraps its upstream's
   *  refusal — OpenRouter answers "Provider returned error" and puts the
   *  upstream body under `metadata.raw` — so the message alone names nothing
   *  a person can act on. This is the one field that says WHY a 400 was a
   *  400, and without it the only way to diagnose one is to guess at the
   *  request shape and try again. */
  detail?: string;
}

/** Map a provider's own error type + HTTP status to our taxonomy.
 *
 *  The type is consulted FIRST where present: a provider naming its own failure
 *  is better evidence than the status code it happened to be delivered under
 *  (Anthropic sends `overloaded_error` as a 529, Google sends `SAFETY` with a
 *  200). Status is the fallback, and it is a fact rather than an inference. */
export function classifyProviderFailure(
  providerErrorType?: string,
  status?: number,
): ProviderFailureKind {
  const t = (providerErrorType ?? '').toLowerCase();

  if (t) {
    if (t.includes('overloaded')) return 'overloaded';
    if (t.includes('rate_limit') || t.includes('rate-limit') || t.includes('ratelimit')) return 'rate_limit';
    if (t.includes('authentication') || t.includes('permission') || t.includes('unauthorized')
      || t.includes('invalid_api_key') || t.includes('forbidden')) return 'auth';
    if (t.includes('quota') || t.includes('billing') || t.includes('insufficient_quota')
      || t.includes('credit')) return 'quota';
    if (t.includes('safety') || t.includes('blocklist') || t.includes('prohibited_content')
      || t.includes('content_filter')) return 'safety';
    if (t.includes('refusal') || t.includes('refused')) return 'refusal';
    // Order matters: `invalid_request_error` contains both 'invalid_request'
    // and 'error', and it is a client mistake rather than a server fault.
    if (t.includes('invalid_request') || t.includes('bad_request')
      || t.includes('invalid_argument')) return 'invalid_request';
    if (t.includes('api_error') || t.includes('server_error') || t.includes('internal')
      || t.includes('unavailable')) return 'server_error';
    if (t.includes('timeout') || t.includes('connection') || t.includes('network')
      || t.includes('econn') || t.includes('socket')) return 'network';
    if (t.includes('not_found')) return 'invalid_request';
  }

  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'quota';
    if (status === 429) return 'rate_limit';
    if (status === 529) return 'overloaded';
    if (status === 400 || status === 404 || status === 413 || status === 422) return 'invalid_request';
    if (status >= 500) return 'server_error';
  }

  return 'unknown';
}

/** Dig the structured failure out of whatever an engine threw.
 *
 *  The shapes are the ones our engines actually produce, verified against the
 *  installed SDKs rather than guessed:
 *    · `err.error` and `err.error.error` — Anthropic and OpenAI both nest, and
 *      OpenAI nests one level deeper than Anthropic;
 *    · `err.$metadata.requestId` — Bedrock / AWS SDK v3;
 *    · `headers.get('request-id')` and `x-request-id` — the two spellings in use;
 *    · `err.requestID` / `err.request_id` — SDK-surfaced ids;
 *    · `err.status` / `err.statusCode` — the two spellings in use;
 *    · `err.code` — errno-style transport failures;
 *    · `err.name`, but only when it is not the generic `Error`.
 *
 *  Always returns a value. `kind: 'unknown'` with no fields is the honest answer
 *  for an error that carried no structure, and it lets the caller fall through to
 *  the prose classifier instead of having to null-check first. */
export function extractProviderFailure(error: unknown): ProviderFailureInfo {
  if (!error || typeof error !== 'object') return { kind: 'unknown' };
  const err = error as Record<string, unknown>;

  // Tested FIRST, and the order is the point. A TypeError carries a `name` and
  // nothing else, so the extraction below would read that name as the
  // provider's own error type, find no substring it recognises, and answer
  // 'unknown' — filing our bug in the bucket reserved for unclassified ones.
  // A runtime fault is decidable from the constructor alone and needs no
  // inference at all.
  const errorName = typeof err.name === 'string' ? err.name : undefined;
  const errorMessage = typeof err.message === 'string' ? err.message : undefined;
  if (isRuntimeFaultName(errorName, errorMessage)) {
    return {
      kind: 'adapter_internal',
      providerErrorType: errorName,
      ...(extractRequestId(err) ? { requestId: extractRequestId(err) } : {}),
    };
  }

  // Anthropic: { error: { type, message } }. OpenAI: { error: { type, code } }
  // and sometimes { error: { error: { type } } } through the Agents SDK wrapper.
  const nested1 = asRecord(err.error);
  const nested2 = nested1 ? asRecord(nested1.error) : undefined;

  const providerErrorType =
    firstString(nested2?.type, nested1?.type, err.type)
    ?? firstString(nested2?.code, nested1?.code)
    // `err.code` is errno-shaped on transport failures (ECONNRESET) and a
    // provider code on API failures; both are useful, both go here.
    ?? firstString(typeof err.code === 'string' ? err.code : undefined)
    // `name` last, and never the generic 'Error' — that names the class, not
    // the failure, and treating it as a type would classify everything.
    ?? firstString(typeof err.name === 'string' && err.name !== 'Error' ? err.name : undefined);

  const status = firstNumber(
    err.status,
    err.statusCode,
    nested1?.status,
    nested1?.status_code,
    (asRecord(err.response) ?? {}).status,
  );

  const requestId = extractRequestId(err);
  const detail = extractDetail(err, nested1, nested2);

  return {
    kind: classifyProviderFailure(providerErrorType, status),
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(requestId ? { requestId } : {}),
    ...(detail ? { detail } : {}),
  };
}

const DETAIL_MAX = 600;

/** The provider's own words, from wherever the SDK and the gateway put them.
 *
 *  Gathered rather than picked: OpenRouter's wrapper message is "Provider
 *  returned error" and the upstream's actual complaint sits in
 *  `metadata.raw`; a direct OpenAI error puts it in `error.message`; Anthropic
 *  in `error.error.message`. Any one of those alone is the one that is empty
 *  on the day it matters. Bounded, because a provider can echo the request. */
function extractDetail(
  err: Record<string, unknown>,
  nested1: Record<string, unknown> | undefined,
  nested2: Record<string, unknown> | undefined,
): string | undefined {
  const meta = asRecord(nested1?.metadata) ?? asRecord(err.metadata);
  const parts = [
    firstString(nested2?.message, nested1?.message),
    meta ? firstString(meta.provider_name) : undefined,
    meta ? firstString(typeof meta.raw === 'string' ? meta.raw : JSON.stringify(meta.raw ?? '')) : undefined,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0 && v !== 'undefined' && v !== '""');
  if (parts.length === 0) return undefined;
  const joined = parts.join(' | ');
  return joined.length > DETAIL_MAX ? `${joined.slice(0, DETAIL_MAX)}…` : joined;
}

/** The provider's own request id, whichever of the six places it landed in.
 *
 *  Worth the breadth on its own: this is the single field a provider asks for
 *  when we open a support ticket, and today we have none of them. */
function extractRequestId(err: Record<string, unknown>): string | undefined {
  const direct = firstString(err.requestID, err.request_id, err.requestId);
  if (direct) return direct;

  // Bedrock / AWS SDK v3.
  const meta = asRecord(err.$metadata);
  const fromMeta = meta ? firstString(meta.requestId, meta.requestID) : undefined;
  if (fromMeta) return fromMeta;

  // Headers, as a fetch Headers instance or as a plain object. Both spellings
  // are in use across providers.
  for (const source of [err.headers, asRecord(err.response)?.headers]) {
    const fromHeaders = readHeader(source, 'request-id') ?? readHeader(source, 'x-request-id');
    if (fromHeaders) return fromHeaders;
  }
  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const get = (headers as { get?: (k: string) => string | null }).get;
  if (typeof get === 'function') {
    try {
      const v = get.call(headers, name);
      if (typeof v === 'string' && v) return v;
    } catch {
      /* a Headers-shaped object that throws is not a header source */
    }
  }
  const rec = asRecord(headers);
  if (!rec) return undefined;
  const v = rec[name];
  return typeof v === 'string' && v ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}
