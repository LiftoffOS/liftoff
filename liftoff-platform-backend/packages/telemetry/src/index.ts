// Tracing
export {
  initTracing,
  shutdownTracing,
  getTracer,
  createSpan,
  endSpan,
  withSpan,
  getCurrentTraceId,
} from './tracing.js';
export type { TraceContext, InitTracingOptions } from './tracing.js';

// Async context
export { withTraceContext, getTraceContext, setTraceContext } from './context.js';

// Logging
export { createLogger } from './logger.js';
export type { Logger, LogLevel, LogEntry, LoggerConfig } from './logger.js';

// Metrics (optional — no-op unless configureMetrics is called)
export { configureMetrics, recordMetric } from './metrics.js';
export type { MetricsConfig } from './metrics.js';

// Request correlation (Phase 0k)
export {
  requestCorrelationPlugin,
  withRequestCorrelation,
  getRequestCorrelation,
  correlationHeadersForOutbound,
} from './request-correlation.js';
export type { RequestCorrelation, RequestCorrelationPluginOptions } from './request-correlation.js';
