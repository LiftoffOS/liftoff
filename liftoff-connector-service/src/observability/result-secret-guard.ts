// Credential-echo guard for connector results.
//
// The single execution seam `runConnectorExecution` resolves a connector's
// credentials and returns the vendor `result` (and, on failure, an `error`
// string) verbatim to the caller (tenant-runtime), from where it reaches the
// agent context, the GCS trajectory (SFT export), the audit `outputSummary`,
// and the replayed `actions.external_response`. A vendor that echoes our
// injected credential in its response would therefore leak it into durable,
// agent-visible stores.
//
// This module redacts that material before the response leaves the process. Two
// layers, defending different threats:
//
//   1. VALUE-BASED (primary) — redact the LITERAL credential values just used
//      (accessToken / refreshToken / apiKey / privateKey, NOT instanceUrl) plus
//      their common transformed echoes: base64, the two HTTP-Basic base64 pairs
//      (`base64(key:)` and `base64(:key)`), hex, and URL-encoded. Format-
//      agnostic, zero false positives; closes the opaque-key gap
//      (pipedrive/cal.com/trello) that a pattern denylist cannot.
//      INHERENT LIMIT: literal matching cannot catch a secret that a vendor
//      gzips, hashes, or splits across multiple JSON fields — those are the
//      domain of the format layer (recognizable shapes) and the structural
//      response-shape gate (prevention). Do not pretend the value layer covers
//      them.
//   2. FORMAT-BASED (secondary net) — conservative, PREFIX-ANCHORED provider-key
//      patterns only. Catches recognizable secrets from OTHER sources (a token
//      embedded in read data) that value-based cannot see. JWT + generic
//      hex/entropy patterns are deliberately EXCLUDED — they false-positive on
//      legitimate values the agent needs (git SHAs, real JWTs), corrupting
//      results.
//
// Fail-open by construction: any error inside the guard returns the original
// response unchanged. A guard bug must never turn a good vendor call into a
// failure; the clients' `.data`-projection discipline remains the primary
// protection and this is the runtime backstop.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecuteResponse } from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_pb.js';
import { logger } from '../infra/logging.js';
import { collectX402SecretValues } from '../x402/wallet.js';

const REDACTED = '[REDACTED]';

// Ignore short / low-entropy needles: a real credential is long, and scanning
// for a 3-char value would over-redact unrelated content.
const SECRET_VALUE_MIN_LENGTH = 8;

// composio_managed credentials surface as the literal string "REDACTED" (the
// Composio v3 API never returns the real token; it signs server-side). Treat
// those — and our own placeholder — as non-secrets so the guard never redacts
// legitimate occurrences of the word.
const PLACEHOLDER_VALUES = new Set(['REDACTED', REDACTED]);

// Opt-in (default OFF). When set, a VALUE-layer hit — the vendor echoed our own
// injected credential, an anomaly that should essentially never happen — causes
// the whole result to be REFUSED (fail-closed) rather than redacted-and-returned.
// Rationale: once we know our credential is in the result, returning even the
// redacted result risks leaking a copy in a form the value layer did not match
// (a split value, an unknown encoding). Default OFF keeps the hot path available
// (redact-and-continue); the echo is logged at error level either way. FORMAT-
// layer hits (recognizable third-party secrets in read data) are NEVER fail-
// closed — that is benign, expected data-flow filtering.
function failClosedOnCredentialEcho(): boolean {
  const v = (process.env.CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED ?? '').toLowerCase();
  return v === 'true' || v === '1';
}

// Prefix-anchored, bounded-quantifier (ReDoS-safe) provider-key patterns. All
// carry a distinctive vendor prefix, so false-positive rates are near zero.
// DO NOT add JWT or generic hex/entropy patterns here — they match legitimate
// data the agent is meant to read.
export const PREFIXED_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'anthropic-api-key', re: /sk-ant-(?:api0[0-9]-)?[A-Za-z0-9_-]{32,128}/g },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{40,200}/g },
  { name: 'github-classic-pat', re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'github-app-token', re: /ghs_[A-Za-z0-9]{36}/g },
  { name: 'github-user-token', re: /gho_[A-Za-z0-9]{36}/g },
  { name: 'github-fine-grained-pat', re: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}/g },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'stripe-live-key', re: /sk_live_[A-Za-z0-9]{24,99}/g },
  { name: 'stripe-restricted-key', re: /rk_live_[A-Za-z0-9]{24,99}/g },
  { name: 'slack-bot-token', re: /xoxb-\d{1,20}-\d{1,20}-[A-Za-z0-9]{24,48}/g },
  { name: 'slack-user-token', re: /xoxp-\d{1,20}-\d{1,20}-\d{1,20}-[A-Za-z0-9]{24,48}/g },
  { name: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{20}/g },
  { name: 'npm-token', re: /npm_[A-Za-z0-9]{36}/g },
  { name: 'linear-api-key', re: /lin_api_[A-Za-z0-9]{40,60}/g },
  { name: 'huggingface-token', re: /hf_[A-Za-z]{34}/g },
];

// Single combined pass over each string leaf (one regex instead of N) — same
// matching semantics as running each pattern in sequence, but O(1) traversals
// per leaf instead of O(patterns). Each source is a complete standalone pattern;
// top-level `|` alternation preserves them. All bounded → ReDoS-safe.
const COMBINED_SECRET_RE = new RegExp(
  PREFIXED_SECRET_PATTERNS.map((p) => p.re.source).join('|'),
  'g',
);

interface SecretCreds {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  privateKey?: string;
}

/**
 * Build the literal needle list for the value-based layer from the resolved
 * credentials. For each secret, emit the raw value plus its common transformed
 * echoes so a vendor that reflects the credential in any of these forms is still
 * caught:
 *   - raw value
 *   - base64(value)                — bare base64 echo
 *   - base64(`${value}:`)          — HTTP Basic with the key as username
 *   - base64(`:${value}`)          — HTTP Basic with the key as password
 *   - hex(value)                   — hex echo
 *   - encodeURIComponent(value)    — key reflected inside a returned URL
 * instanceUrl / flowKind are NOT secrets and are excluded by the field
 * selection. Values shorter than the min length or equal to a known placeholder
 * (composio_managed "REDACTED") are skipped. Needles are returned longest-first
 * so a value that is a substring of a longer one is redacted after it.
 */
export function collectSecretValues(creds: SecretCreds | undefined): string[] {
  // The platform x402 wallet's CDP credentials are process-level secrets, not
  // per-connector ones, so they join EVERY response's needle list: whichever
  // connector's response somehow carried one, it must not leave the process.
  const platformSecrets = collectX402SecretValues();
  if (!creds && platformSecrets.length === 0) return [];
  const raw = [
    creds?.accessToken,
    creds?.refreshToken,
    creds?.apiKey,
    creds?.privateKey,
    ...platformSecrets,
  ];
  const needles = new Set<string>();
  for (const v of raw) {
    if (!v || v.length < SECRET_VALUE_MIN_LENGTH || PLACEHOLDER_VALUES.has(v)) continue;
    const variants = [
      v,
      Buffer.from(v).toString('base64'),
      Buffer.from(`${v}:`).toString('base64'),
      Buffer.from(`:${v}`).toString('base64'),
      Buffer.from(v).toString('hex'),
      encodeURIComponent(v),
    ];
    for (const variant of variants) {
      if (variant.length >= SECRET_VALUE_MIN_LENGTH && !PLACEHOLDER_VALUES.has(variant)) {
        needles.add(variant);
      }
    }
  }
  return Array.from(needles).sort((a, b) => b.length - a.length);
}

/** Redact both layers from a single string. Value layer first (literal), then
 *  format layer (prefix-anchored patterns). */
function redactString(
  input: string,
  needles: string[],
): { out: string; valueHits: number; formatHits: number } {
  let out = input;
  let valueHits = 0;
  let formatHits = 0;

  for (const needle of needles) {
    if (!needle) continue;
    const parts = out.split(needle);
    if (parts.length > 1) {
      valueHits += parts.length - 1;
      out = parts.join(REDACTED);
    }
  }

  out = out.replace(COMBINED_SECRET_RE, () => {
    formatHits += 1;
    return REDACTED;
  });

  return { out, valueHits, formatHits };
}

/** Deep-walk a JSON-safe value (protobuf Struct / JsonObject), redacting string
 *  leaves. Keys are never redacted. Returns the ORIGINAL reference when nothing
 *  changed (the common no-secret case allocates nothing); a new structure only
 *  along paths that actually contained a secret. */
function redactJson(
  value: unknown,
  needles: string[],
  acc: { valueHits: number; formatHits: number },
): unknown {
  if (typeof value === 'string') {
    const r = redactString(value, needles);
    acc.valueHits += r.valueHits;
    acc.formatHits += r.formatHits;
    return r.out; // value-equal to input when unchanged (strings compare by value)
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const red = redactJson(item, needles, acc);
      if (red !== item) changed = true;
      return red;
    });
    return changed ? out : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const red = redactJson(v, needles, acc);
      if (red !== v) changed = true;
      out[k] = red;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * Redact echoed secret material from an ExecuteResponse before it leaves the
 * process. Mutates `response.result` (deep) and `response.error` (string) IN
 * PLACE and returns the same message — never constructs a new ExecuteResponse
 * (keeps the Phase-7 error-response fence satisfied).
 *
 * Observability is split by severity: a value-layer hit (our own injected
 * credential echoed back — an anomaly) logs at ERROR under
 * `connector_result_credential_echo_detected`; a format-layer hit (a
 * recognizable third-party secret in read data — benign) logs at WARN under
 * `connector_result_secret_redacted`.
 *
 * Default posture is redact-and-continue for BOTH layers. When
 * `CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED` is set, a value-layer hit additionally
 * refuses the whole result (fail-closed); format hits are never fail-closed.
 *
 * Fail-open on guard bugs: on any internal error, returns the original response
 * unchanged so a guard defect can never turn a good vendor call into a failure.
 */
export function redactResponseSecrets(
  response: ExecuteResponse,
  secretValues: string[],
  ctx: { connectorType: string; functionName: string },
): ExecuteResponse {
  try {
    const acc = { valueHits: 0, formatHits: 0 };

    if (response.result !== undefined) {
      response.result = redactJson(response.result, secretValues, acc) as JsonObject;
    }
    if (response.error) {
      const r = redactString(response.error, secretValues);
      response.error = r.out;
      acc.valueHits += r.valueHits;
      acc.formatHits += r.formatHits;
    }

    // Severity split — the two layers mean very different things:
    //  - a VALUE hit is the vendor echoing our OWN injected credential: an
    //    anomaly that should never happen legitimately and signals a
    //    misbehaving / compromised connector. Elevate to ERROR so alerting
    //    fires; it is not routine.
    //  - a FORMAT hit is a recognizable third-party secret in read data: the
    //    benign, expected case ("we prevented a leak"). WARN.
    if (acc.valueHits > 0) {
      logger.error(
        {
          event: 'connector_result_credential_echo_detected',
          connectorType: ctx.connectorType,
          functionName: ctx.functionName,
          valueHits: acc.valueHits,
          formatHits: acc.formatHits,
          failClosed: failClosedOnCredentialEcho(),
        },
        'connector echoed an injected credential in its result — the result is untrusted. ' +
          'This connector may be misbehaving or compromised; investigate.',
      );
    }
    if (acc.formatHits > 0) {
      logger.warn(
        {
          event: 'connector_result_secret_redacted',
          connectorType: ctx.connectorType,
          functionName: ctx.functionName,
          formatHits: acc.formatHits,
        },
        'redacted recognizable secret pattern(s) from connector result before returning to caller',
      );
    }

    // Fail-closed applies to VALUE hits only (opt-in). Refuse the whole result:
    // discard it and return a safe structured error carrying no secret material.
    // Format hits are always redact-and-continue and never reach here.
    if (acc.valueHits > 0 && failClosedOnCredentialEcho()) {
      response.result = undefined;
      response.success = false;
      response.error = 'connector result refused: it echoed an injected credential (fail-closed)';
      response.errorCode = 'internal_error';
      response.retryable = false;
      response.recovery =
        'The connector returned our injected credential in its response, so the result was withheld. ' +
        'Investigate the connector before retrying.';
    }
    return response;
  } catch (err) {
    logger.warn(
      {
        event: 'connector_result_secret_redaction_failed',
        connectorType: ctx.connectorType,
        functionName: ctx.functionName,
        err: (err as Error).message,
      },
      'result-secret guard failed — returning original response unredacted (fail-open)',
    );
    return response;
  }
}
