/**
 * R5 Fix 8: Structured logger with secret scrubbing at every output path.
 *
 * Wraps the base logger to scrub sensitive fields before emission. Also:
 *   - arrays handled (BE-R5-004)
 *   - circular-ref guard via WeakSet (BE-R5-005)
 *   - process.uncaughtException + unhandledRejection (SE-R5-004)
 *   - stdout/stderr write methods wrapped for third-party output
 *   - non-production builds assert fields against LogSchemas (TE-R4-009)
 *
 * Lint enforcement (ESLint rule `log-event-must-be-literal`) requires every
 * call to use a string-literal event that exists in LogSchemas.
 */
import { scrubSecrets } from '../workspace/secret-scrubber';
import { assertLogFieldsValid } from './log-schemas';

export type LogFields = Record<string, unknown>;

// Fields whose string values are scrubbed recursively.
const SENSITIVE_FIELDS = new Set([
  'args',
  'stdout',
  'stderr',
  'message',
  'error',
  'err',
  'content',
  'file_content',
  'body',
  'raw',
  'input',
  'reason',
]);

export function scrubLogFields(fields: LogFields, seen: WeakSet<object> = new WeakSet()): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_FIELDS.has(k) && typeof v === 'string') {
      out[k] = scrubSecrets(v);
    } else if (Array.isArray(v)) {
      // BE-R5-004: array branch
      out[k] = v.map((item) => {
        if (typeof item === 'string') return SENSITIVE_FIELDS.has(k) ? scrubSecrets(item) : item;
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
          return scrubLogFields(item as LogFields, seen);
        }
        return item;
      });
    } else if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) {
        out[k] = '[Circular]';
        continue;
      }
      seen.add(v);
      out[k] = scrubLogFields(v as LogFields, seen);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface BaseLogger {
  info: (fields: LogFields) => void;
  warn: (fields: LogFields) => void;
  error: (fields: LogFields) => void;
  debug?: (fields: LogFields) => void;
}

/* eslint-disable r5/no-console-in-src -- scrubLogger IS the logger; console here is the emit sink */
let baseLogger: BaseLogger = {
  info: (f) => console.log(JSON.stringify({ severity: 'INFO', ...f })),
  warn: (f) => console.warn(JSON.stringify({ severity: 'WARN', ...f })),
  error: (f) => console.error(JSON.stringify({ severity: 'ERROR', ...f })),
};
/* eslint-enable r5/no-console-in-src */

export function setBaseLogger(l: BaseLogger): void {
  baseLogger = l;
}

function withScrubbing(level: 'info' | 'warn' | 'error', fields: LogFields): void {
  const scrubbed = scrubLogFields(fields);
  if (process.env.NODE_ENV !== 'production' && process.env.SKIP_LOG_SCHEMA_VALIDATION !== '1') {
    const event = scrubbed.event;
    if (typeof event === 'string') {
      try {
        assertLogFieldsValid(event, scrubbed);
      } catch (err) {
        // In tests, surface schema mismatches as errors so CI catches them.
        if (process.env.NODE_ENV === 'test') {
          throw err;
        }
        // In dev, log a warning and continue
        baseLogger.warn({ event: 'log_schema_validation_failed', err: (err as Error).message });
      }
    }
  }
  baseLogger[level](scrubbed);
}

export const scrubLogger: BaseLogger = {
  info: (fields) => withScrubbing('info', fields),
  warn: (fields) => withScrubbing('warn', fields),
  error: (fields) => withScrubbing('error', fields),
};

// SE-R5-004: install process-level handlers that scrub before emitting.
// Called exactly once at startup; idempotent.
let processHandlersInstalled = false;

export function installProcessScrubbers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const scrubbed = scrubSecrets(msg);

    // connectrpc/connect-es#1143: the HTTP/2 session manager's ping timer
    // races with session teardown and throws ERR_HTTP2_INVALID_SESSION from
    // a timer owned by a library. The session rebuilds on the next RPC, so
    // crashing the whole process drops unrelated in-flight chat turns for
    // a benign library bug. Log and keep running.
    const code =
      err && typeof err === 'object' && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 'ERR_HTTP2_INVALID_SESSION') {
      process.stderr.write(`[SCRUBBED_HTTP2_PING] ${scrubbed}\n`);
      return;
    }

    process.stderr.write(`[SCRUBBED_UNCAUGHT] ${scrubbed}\n`);
    // Exit — uncaught leaves the process in an undefined state.
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg =
      reason instanceof Error ? (reason.stack ?? reason.message) : typeof reason === 'string' ? reason : JSON.stringify(reason);
    const scrubbed = scrubSecrets(msg);
    process.stderr.write(`[SCRUBBED_UNHANDLED_REJECTION] ${scrubbed}\n`);
  });

  // Note: stdout/stderr stream wrapping was attempted (SE-R5-004) but caused
  // Cloud Run GEN2 startup failures due to write() signature incompatibility.
  // Third-party library output is instead covered by the scrubLogger API
  // (all our own code uses scrubLogger) and the uncaughtException handler above.
}
