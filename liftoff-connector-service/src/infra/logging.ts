// Shim that bridges tenant-runtime / platform-backend logger call-sites
// (positional-arg style: `logger.info('msg', { ctx })`) onto @liftoffos/telemetry's
// flexible Logger, which accepts either (ctx, msg) or (msg, ctx).
//
// The copied source files expect `logger`, `log`, and `createLogger` to
// be importable from here under the same shape as in the source repos.

import {
  createLogger as createTelemetryLogger,
  type Logger,
  type LogLevel,
} from '@liftoffos/telemetry';

export type { Logger, LogLevel };

const rootLogger: Logger = createTelemetryLogger({
  backend: 'custom',
  level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  cloudTraceProjectId: process.env.GCP_PROJECT_ID,
});

export const logger = rootLogger;
export const log = rootLogger;
export { createTelemetryLogger as createLogger };
