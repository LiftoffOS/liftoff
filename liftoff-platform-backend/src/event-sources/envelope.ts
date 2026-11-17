// Canonical event envelope — hybrid acceptance.
//
// If the body parses as JSON and contains both `event_id` and `event_type` at
// the top level, treat it as the canonical envelope and parse fields out of
// it. Otherwise synthesize a minimal envelope:
//   - event_id   ← Idempotency-Key header, else sha256(rawBody)
//   - event_type ← 'webhook.received'
//   - occurred_at ← now()
//   - data       ← parsed body (or { raw: <base64> } for non-JSON)
//
// Regardless of which path is taken, the envelope is run through a strict
// scrubbing pass before it leaves this module:
//   1. Top-level key allowlist
//   2. Recursive permission-key stripping inside data/subject/actor
//   3. Per-string length cap (8 KB)
//   4. Role-marker substring scrubbing
//   5. Hidden-Unicode stripping
// Any change made by 2–5 sets `contentRedacted = true` on the result, which
// the inbound handler propagates onto the delivery row and the dispatched
// envelope for downstream visibility.

import crypto from 'crypto';
import { shouldStripPermissionKey } from './permission-keys';

export interface CanonicalEnvelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
  subject?: unknown;
  actor?: unknown;
  data?: unknown;
}

export interface EnvelopeResult {
  envelope: CanonicalEnvelope;
  contentRedacted: boolean;
}

const TOP_LEVEL_KEYS = new Set([
  'event_id',
  'event_type',
  'occurred_at',
  'subject',
  'actor',
  'data',
]);

// Self-declared permission keys (STRIP_KEYS_EXACT / STRIP_KEY_PREFIXES) are
// stripped recursively inside data / subject / actor so callers can't grant
// themselves authority via the payload. That key list is shared with the GitHub
// webhook router via ./permission-keys.

// Role markers replaced with [redacted] in every string field. Covers
// Anthropic, ChatML, Llama, and Markdown-style attempted impersonation.
const ROLE_MARKERS = [
  'system:',
  'assistant:',
  'user:',
  '<|im_start|>',
  '<|im_end|>',
  '<|system|>',
  '<|user|>',
  '<|assistant|>',
  '\n\nHuman:',
  '\n\nAssistant:',
  '### Instruction:',
  '### Response:',
];

const MAX_STRING_BYTES = 8 * 1024;
// event_id is unique-indexed and stored verbatim — keep it short. Anything
// longer than 256 chars is almost certainly garbage or hostile.
const MAX_EVENT_ID_CHARS = 256;
// event_type drives trigger-rule matching; cap separately so a megabyte
// "event_type" can't widen rules' WHERE clause indirectly.
const MAX_EVENT_TYPE_CHARS = 128;

function stripHiddenUnicode(s: string): { value: string; changed: boolean } {
  // Tag chars (U+E0000–U+E007F), zero-width spaces (U+200B–U+200D),
  // RTL/LTR overrides (U+202A–U+202E). Written with \u-escapes so the
  // source itself doesn't trip irregular-whitespace lint rules.
  const cleaned = s.replace(/[\u{E0000}-\u{E007F}\u{200B}-\u{200D}\u{202A}-\u{202E}]/gu, '');
  return { value: cleaned, changed: cleaned !== s };
}

function scrubRoleMarkers(s: string): { value: string; changed: boolean } {
  let out = s;
  let changed = false;
  for (const marker of ROLE_MARKERS) {
    if (out.toLowerCase().includes(marker.toLowerCase())) {
      // Case-insensitive replace via regex
      const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const replaced = out.replace(re, '[redacted]');
      if (replaced !== out) {
        out = replaced;
        changed = true;
      }
    }
  }
  return { value: out, changed };
}

interface ScrubState { changed: boolean }

/**
 * Cap a UTF-8 string at `maxBytes` without splitting a multibyte codepoint.
 * Iterates the string by codepoint via Array.from so surrogate pairs and
 * accented characters survive truncation intact (instead of becoming the
 * U+FFFD replacement character that a naive Buffer.slice would produce).
 */
function truncateBytes(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { value: s, truncated: false };
  let out = '';
  let used = 0;
  for (const cp of s) {
    const len = Buffer.byteLength(cp, 'utf8');
    if (used + len > maxBytes) break;
    out += cp;
    used += len;
  }
  return { value: out, truncated: true };
}

function scrubString(s: string, state: ScrubState): string {
  // Length cap first — defeats megabyte-long jailbreaks hidden in one field.
  let value = s;
  const trunc = truncateBytes(value, MAX_STRING_BYTES);
  if (trunc.truncated) state.changed = true;
  value = trunc.value;
  const unicode = stripHiddenUnicode(value);
  if (unicode.changed) state.changed = true;
  value = unicode.value;
  const markers = scrubRoleMarkers(value);
  if (markers.changed) state.changed = true;
  value = markers.value;
  return value;
}

function scrubValue(v: unknown, state: ScrubState): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return scrubString(v, state);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(item => scrubValue(item, state));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (shouldStripPermissionKey(key)) {
        state.changed = true;
        continue;
      }
      out[key] = scrubValue(value, state);
    }
    return out;
  }
  return v;
}

function isCanonicalShape(o: unknown): o is Record<string, unknown> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const obj = o as Record<string, unknown>;
  return typeof obj.event_id === 'string' && typeof obj.event_type === 'string';
}

function syntheticEventId(idempotencyKey: string | undefined, rawBody: Buffer): string {
  if (idempotencyKey && idempotencyKey.trim().length > 0) {
    return idempotencyKey.trim().slice(0, MAX_EVENT_ID_CHARS);
  }
  return 'sha256:' + crypto.createHash('sha256').update(rawBody).digest('hex');
}

function capEventId(raw: unknown, fallback: () => string, state: ScrubState): string {
  if (raw === null || raw === undefined) return fallback();
  const s = String(raw);
  if (s.length === 0) return fallback();
  if (s.length > MAX_EVENT_ID_CHARS) {
    state.changed = true;
    return s.slice(0, MAX_EVENT_ID_CHARS);
  }
  return s;
}

function capEventType(raw: unknown, state: ScrubState): string {
  if (typeof raw !== 'string') return 'webhook.received';
  if (raw.length > MAX_EVENT_TYPE_CHARS) {
    state.changed = true;
    return raw.slice(0, MAX_EVENT_TYPE_CHARS);
  }
  return raw;
}

/**
 * Parse + sanitize the inbound body. Always returns an envelope — synthesizes
 * fields when the body isn't shaped canonically. Sets contentRedacted=true
 * iff the scrubber removed/replaced anything.
 */
export function parseAndSanitizeEnvelope(opts: {
  rawBody: Buffer;
  idempotencyKey: string | undefined;
  now?: Date;
}): EnvelopeResult {
  const { rawBody, idempotencyKey, now = new Date() } = opts;
  const state: ScrubState = { changed: false };

  // Try JSON parse. Non-JSON bodies are still acceptable per the plan; we
  // wrap them in { raw: <base64> } so downstream handlers see a uniform
  // shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    parsed = { raw: rawBody.toString('base64') };
  }

  if (isCanonicalShape(parsed)) {
    const obj = parsed;
    // Top-level allowlist: anything not in TOP_LEVEL_KEYS is dropped.
    const allowlisted: Record<string, unknown> = {};
    let droppedAny = false;
    for (const [k, v] of Object.entries(obj)) {
      if (TOP_LEVEL_KEYS.has(k)) {
        allowlisted[k] = v;
      } else {
        droppedAny = true;
      }
    }
    if (droppedAny) state.changed = true;

    // Scrub subject / actor / data. event_id and event_type are length-capped
    // separately because they hit indexed columns (uniqueness, trigger lookup)
    // and the 8 KB scrubString cap would still be too generous for them.
    const env: CanonicalEnvelope = {
      event_id: capEventId(obj.event_id, () => syntheticEventId(idempotencyKey, rawBody), state),
      event_type: capEventType(obj.event_type, state),
      occurred_at: typeof allowlisted.occurred_at === 'string'
        ? allowlisted.occurred_at
        : now.toISOString(),
      subject: 'subject' in allowlisted ? scrubValue(allowlisted.subject, state) : undefined,
      actor: 'actor' in allowlisted ? scrubValue(allowlisted.actor, state) : undefined,
      data: 'data' in allowlisted ? scrubValue(allowlisted.data, state) : undefined,
    };
    return { envelope: env, contentRedacted: state.changed };
  }

  // Synthesize an envelope from a non-canonical body. Pre-scrub the data
  // payload so the same protections apply.
  const env: CanonicalEnvelope = {
    event_id: syntheticEventId(idempotencyKey, rawBody),
    event_type: 'webhook.received',
    occurred_at: now.toISOString(),
    data: scrubValue(parsed, state),
  };
  return { envelope: env, contentRedacted: state.changed };
}
