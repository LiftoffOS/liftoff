// Log scrubber — recursively redacts signing-secret and signature material
// before anything from the event-sources module reaches the logger.
//
// Used two ways:
//   1. `scrubForLog(value)` — pure function for ad-hoc redaction.
//   2. `scrubbedLogger(log)` — wraps the project logger so every method call
//      from this module runs the first object argument through `scrubForLog`
//      automatically. Use `import { log } from './log-scrubber'` inside the
//      event-sources module instead of importing from infrastructure/logging
//      directly. This is the plan §6.8 "logger middleware everywhere" pattern.
//
// Patterns are intentionally broad — false-positive redactions are fine,
// leaking a signing secret is not.

import { log as rawLog } from '../infrastructure/logging';

const REDACT_KEY_EXACT = new Set([
  'authorization',
  'cookie',
  'secret',
  'signing_secret',
  'signature',
]);
const REDACT_KEY_SUBSTRINGS = ['secret', 'signature', 'token', 'bearer', 'apikey', 'api_key'];

// Signature-header shape: t=<unix>,v1=<hex>
const SIGNATURE_VALUE_RE = /(?:^|,)\s*(?:t|v\d+)\s*=\s*[A-Za-z0-9]+/;
// Bearer-token-shaped values inside arbitrary strings.
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}\b/;

function shouldRedactKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (REDACT_KEY_EXACT.has(lower)) return true;
  for (const sub of REDACT_KEY_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  return false;
}

function redactValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (SIGNATURE_VALUE_RE.test(v)) return '[redacted-signature]';
    if (BEARER_VALUE_RE.test(v)) return v.replace(BEARER_VALUE_RE, 'Bearer [redacted]');
    return v;
  }
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(redactValue);
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (shouldRedactKey(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redactValue(value);
    }
  }
  return out;
}

/**
 * Returns a sanitized copy of the input safe to pass to the logger. The
 * input is not mutated.
 */
export function scrubForLog<T>(value: T): T {
  return redactValue(value) as T;
}

// ──────────────────────────────────────────────────────────────────────────
// Logger middleware
//
// Every log method in this codebase is called either as `log.info(msg)` or
// `log.info(payload, msg)`. We wrap each method so that when the first
// argument is an object, it's run through scrubForLog before being passed to
// the underlying logger. Strings (the no-payload form) and other primitives
// pass through unchanged.
//
// The wrapped instance is named `log` for drop-in import compatibility with
// the rest of the codebase: `import { log } from './log-scrubber'`.
// ──────────────────────────────────────────────────────────────────────────

type LogMethod = (...args: unknown[]) => void;
interface LoggerShape {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  debug: LogMethod;
}

function wrapMethod(fn: LogMethod | undefined): LogMethod {
  // Test mocks frequently stub only a subset of log methods. Skip the wrap
  // (return a no-op) when the underlying method is missing rather than
  // throwing at module-import time — that would block every consumer of
  // this scrubber from booting under those test harnesses.
  if (typeof fn !== 'function') return () => {};
  return (...args: unknown[]) => {
    if (args.length === 0) return fn();
    const first = args[0];
    if (first !== null && typeof first === 'object') {
      const scrubbed = redactValue(first);
      return fn(scrubbed, ...args.slice(1));
    }
    return fn(...args);
  };
}

/** Wraps a pino-like logger so every payload argument is scrubbed in place.
 *  Missing methods on the underlying logger fall through to a no-op so partial
 *  test mocks don't crash on import. */
export function scrubbedLogger(underlying: Partial<LoggerShape>): LoggerShape {
  const bind = (key: keyof LoggerShape): LogMethod | undefined => {
    const m = underlying[key];
    return typeof m === 'function' ? m.bind(underlying) : undefined;
  };
  return {
    info: wrapMethod(bind('info')),
    warn: wrapMethod(bind('warn')),
    error: wrapMethod(bind('error')),
    debug: wrapMethod(bind('debug')),
  };
}

/** Pre-wrapped instance for the event-sources module. */
export const log = scrubbedLogger(rawLog as unknown as LoggerShape);
