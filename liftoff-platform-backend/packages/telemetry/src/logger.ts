// Selectable logger — pino (platform-backend) or a zero-dep custom backend
// (tenant-runtime). Both implement the same interface, both consult
// AsyncLocalStorage for trace context, both accept a redactor hook.
//
// Usage:
//   const log = createLogger({ backend: 'pino', level: 'info' });
//   log.info({ tenantId: 'x' }, 'something happened');
//
//   const log = createLogger({
//     backend: 'custom',
//     redact: (entry) => redactSecrets(entry),
//   });
//   log.info('string-first works too', { extra: 'context' });

import { getTraceContext } from './context.js';
import type { TraceContext } from './tracing.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message?: string;
  tenant_id?: string;
  agent_id?: string;
  workflow_id?: string;
  task_id?: string;
  action_id?: string;
  trace_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(ctx: Record<string, unknown> | string, msg?: string | Record<string, unknown>): void;
  info(ctx: Record<string, unknown> | string, msg?: string | Record<string, unknown>): void;
  warn(ctx: Record<string, unknown> | string, msg?: string | Record<string, unknown>): void;
  error(ctx: Record<string, unknown> | string, msg?: string | Record<string, unknown>): void;
  child(ctx: Partial<TraceContext> & Record<string, unknown>): Logger;
}

export interface LoggerConfig {
  /** 'pino' for platform-backend's existing semantics, 'custom' for tenant-runtime's. */
  backend?: 'pino' | 'custom';
  /** Minimum level. Default 'info'. */
  level?: LogLevel;
  /**
   * Secret redactor hook — runs over every entry just before emission.
   * tenant-runtime's src/security/log-redactor plugs in here.
   */
  redact?: (entry: LogEntry) => LogEntry;
  /**
   * GCP project ID — when set, entries get the
   * `logging.googleapis.com/trace: projects/<id>/traces/<traceId>` field
   * that Cloud Logging uses to correlate logs with Cloud Trace spans.
   */
  cloudTraceProjectId?: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Normalise the two historical call shapes:
//   logger.info(ctx, msg)    — pino-style
//   logger.info(msg, ctx)    — tenant-runtime-style
//   logger.info(msg)         — just a message
//   logger.info(ctx)         — just context
function buildEntry(
  a: Record<string, unknown> | string,
  b: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (typeof a === 'object' && typeof b === 'string') return { ...a, message: b };
  if (typeof a === 'string' && typeof b === 'object') return { message: a, ...b };
  if (typeof a === 'string') return { message: a };
  return a;
}

function mergeTraceContext(entry: Record<string, unknown>, cloudTraceProjectId?: string): LogEntry {
  const tctx = getTraceContext();
  const out: LogEntry = {
    timestamp: new Date().toISOString(),
    level: 'info', // overwritten by caller
    ...(tctx?.tenantId && { tenant_id: tctx.tenantId }),
    ...(tctx?.agentId && { agent_id: tctx.agentId }),
    ...(tctx?.workflowId && { workflow_id: tctx.workflowId }),
    ...(tctx?.taskId && { task_id: tctx.taskId }),
    ...(tctx?.actionId && { action_id: tctx.actionId }),
    ...(tctx?.traceId && {
      trace_id: tctx.traceId,
      ...(cloudTraceProjectId && {
        'logging.googleapis.com/trace': `projects/${cloudTraceProjectId}/traces/${tctx.traceId}`,
      }),
    }),
    ...entry,
  };
  return out;
}

// ─── Custom backend (zero-dep, writes JSON lines to stdout/err) ──────────────

class CustomLogger implements Logger {
  constructor(
    private readonly config: LoggerConfig,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private emit(level: LogLevel, a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.config.level ?? 'info']) return;

    const entry = mergeTraceContext(
      { ...this.bindings, ...buildEntry(a, b) },
      this.config.cloudTraceProjectId,
    );
    entry.level = level;

    const final = this.config.redact ? this.config.redact(entry) : entry;
    const line = JSON.stringify(final);

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'debug') console.debug(line);
    else console.info(line);
  }

  debug(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('debug', a, b);
  }
  info(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('info', a, b);
  }
  warn(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('warn', a, b);
  }
  error(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('error', a, b);
  }

  child(ctx: Partial<TraceContext> & Record<string, unknown>): Logger {
    return new CustomLogger(this.config, { ...this.bindings, ...ctx });
  }
}

// ─── Pino backend (platform-backend's existing semantics) ────────────────────

// Dynamically require pino at factory time so the package doesn't force
// pino as a dependency for services that only want the custom backend.

interface PinoLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: object): PinoLike;
}

class PinoLogger implements Logger {
  constructor(
    private readonly pino: PinoLike,
    private readonly config: LoggerConfig,
  ) {}

  private emit(level: LogLevel, a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    const entry = mergeTraceContext(
      buildEntry(a, b),
      this.config.cloudTraceProjectId,
    );
    const final = this.config.redact ? this.config.redact(entry) : entry;
    const { message, ...obj } = final;
    (this.pino[level] as (obj: object, msg?: string) => void)(obj, message as string | undefined);
  }

  debug(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('debug', a, b);
  }
  info(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('info', a, b);
  }
  warn(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('warn', a, b);
  }
  error(a: Record<string, unknown> | string, b?: string | Record<string, unknown>): void {
    this.emit('error', a, b);
  }

  child(ctx: Partial<TraceContext> & Record<string, unknown>): Logger {
    return new PinoLogger(this.pino.child(ctx), this.config);
  }
}

function loadPino(level: LogLevel): PinoLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pino = require('pino') as (opts: Record<string, unknown>) => PinoLike;
  return pino({
    level,
    formatters: {
      level: (label: string) => ({ severity: label.toUpperCase() }),
    },
    messageKey: 'message',
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createLogger(config: LoggerConfig = {}): Logger {
  const backend = config.backend ?? 'custom';
  const resolvedConfig: LoggerConfig = { level: 'info', ...config, backend };
  if (backend === 'pino') {
    return new PinoLogger(loadPino(resolvedConfig.level ?? 'info'), resolvedConfig);
  }
  return new CustomLogger(resolvedConfig);
}
