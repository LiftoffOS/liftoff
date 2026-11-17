// Governance-engine logging — thin wrapper over @liftoffos/telemetry.
// Exports both `logger` and `log` for compatibility with the ported modules
// (tenant-runtime exported both names).

import {
  createLogger as createTelemetryLogger,
  withTraceContext as pkgWithTraceContext,
  getTraceContext as pkgGetTraceContext,
  setTraceContext as pkgSetTraceContext,
} from '@liftoffos/telemetry';
import type {
  Logger,
  LogEntry,
  LogLevel,
  TraceContext,
} from '@liftoffos/telemetry';

export type { Logger, LogEntry, LogLevel, TraceContext };

const rootLogger: Logger = createTelemetryLogger({
  backend: 'custom',
  level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  cloudTraceProjectId: process.env.GCP_PROJECT_ID,
});

export const logger = rootLogger;
export const log = rootLogger;

export {
  pkgWithTraceContext as withTraceContext,
  pkgGetTraceContext as getTraceContext,
  pkgSetTraceContext as setTraceContext,
};
