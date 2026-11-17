// OpenTelemetry Telemetry Module
// Per Section 18: Full observability stack - traces, metrics, and logs exported to GCP
//
// Integrates with:
// - Cloud Trace: Distributed tracing for request flows
// - Cloud Monitoring: Metrics collection and dashboards
// - Cloud Logging: Structured log export with trace correlation

import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { TraceExporter } from '@google-cloud/opentelemetry-cloud-trace-exporter';
import { MetricExporter } from '@google-cloud/opentelemetry-cloud-monitoring-exporter';
import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  Span,
  SpanKind,
  Context,
  Tracer,
} from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { logger as appLogger } from './logging';

// Service configuration
const SERVICE_NAME = process.env.SERVICE_NAME || 'liftoff-tenant-runtime';
const SERVICE_VERSION = process.env.SERVICE_VERSION || '1.0.0';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || '';

// Per Section 18: Standard trace context fields
export interface TelemetryContext {
  tenantId: string;
  agentId?: string;
  workflowId?: string;
  taskId?: string;
  actionId?: string;
  traceId?: string;
  spanId?: string;
}

// SDK instance for lifecycle management
let sdk: NodeSDK | null = null;
let meterProvider: MeterProvider | null = null;
let loggerProvider: LoggerProvider | null = null;
let isInitialized = false;

/**
 * Initialize the OpenTelemetry SDK with all providers
 * Must be called before any other telemetry operations
 */
export async function initTelemetry(): Promise<void> {
  if (isInitialized) {
    appLogger.warn('Telemetry already initialized, skipping');
    return;
  }

  appLogger.info({
    message: 'Initializing OpenTelemetry telemetry',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    environment: ENVIRONMENT,
    projectId: GCP_PROJECT_ID,
  });

  // Create shared resource for all providers
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: ENVIRONMENT,
    'cloud.provider': 'gcp',
    'cloud.account.id': GCP_PROJECT_ID,
  });

  // Initialize trace exporter for Cloud Trace
  const traceExporter = new TraceExporter({
    projectId: GCP_PROJECT_ID,
  });

  // Initialize metric exporter for Cloud Monitoring
  const metricExporter = new MetricExporter({
    projectId: GCP_PROJECT_ID,
  });

  // Create meter provider with periodic export.
  // otel 2.x (sdk-metrics): metric readers are passed via the constructor
  // `readers` option; the former `addMetricReader()` method was removed.
  meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60000, // Export every 60 seconds
      }),
    ],
  });

  // Create logger provider.
  // otel 2.x (sdk-logs): log-record processors are passed via the constructor
  // `processors` option; the former `addLogRecordProcessor()` method was removed.
  // Note: For production, use a GCP-specific log exporter.
  // Here we use console which Cloud Logging picks up via stdout.
  loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }),
    ],
  });

  // Initialize the main SDK with auto-instrumentation
  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Configure specific instrumentations
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => {
            // Ignore health check requests
            return req.url === '/health' || req.url === '/ready';
          },
        },
        '@opentelemetry/instrumentation-express': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
          enhancedDatabaseReporting: true,
        },
      }),
    ],
    // Use W3C Trace Context propagation for distributed tracing
    textMapPropagator: new W3CTraceContextPropagator(),
  });

  // Start the SDK
  sdk.start();
  isInitialized = true;

  appLogger.info({ message: 'OpenTelemetry telemetry initialized successfully' });
}

/**
 * Gracefully shutdown all telemetry providers
 */
export async function shutdownTelemetry(): Promise<void> {
  appLogger.info({ message: 'Shutting down OpenTelemetry telemetry' });

  const shutdownPromises: Promise<void>[] = [];

  if (sdk) {
    shutdownPromises.push(sdk.shutdown());
  }
  if (meterProvider) {
    shutdownPromises.push(meterProvider.shutdown());
  }
  if (loggerProvider) {
    shutdownPromises.push(loggerProvider.shutdown());
  }

  await Promise.all(shutdownPromises);
  isInitialized = false;

  appLogger.info({ message: 'OpenTelemetry telemetry shutdown complete' });
}

/**
 * Get the tracer instance for creating spans
 */
export function getTracer(name?: string): Tracer {
  return trace.getTracer(name || SERVICE_NAME, SERVICE_VERSION);
}

/**
 * Create a new span with Liftoff-specific attributes
 */
export function createSpan(
  name: string,
  ctx: TelemetryContext,
  kind: SpanKind = SpanKind.INTERNAL
): Span {
  const tracer = getTracer();
  const span = tracer.startSpan(name, { kind });

  // Add standard Liftoff attributes per Section 18
  span.setAttribute('liftoff.tenant_id', ctx.tenantId);
  if (ctx.agentId) span.setAttribute('liftoff.agent_id', ctx.agentId);
  if (ctx.workflowId) span.setAttribute('liftoff.workflow_id', ctx.workflowId);
  if (ctx.taskId) span.setAttribute('liftoff.task_id', ctx.taskId);
  if (ctx.actionId) span.setAttribute('liftoff.action_id', ctx.actionId);
  if (ctx.traceId) span.setAttribute('liftoff.trace_id', ctx.traceId);

  return span;
}

/**
 * Create a child span from the current context
 */
export function createChildSpan(
  name: string,
  ctx: TelemetryContext,
  parentContext?: Context
): Span {
  const tracer = getTracer();
  const activeContext = parentContext || context.active();

  const span = tracer.startSpan(
    name,
    { kind: SpanKind.INTERNAL },
    activeContext
  );

  // Add standard attributes
  span.setAttribute('liftoff.tenant_id', ctx.tenantId);
  if (ctx.agentId) span.setAttribute('liftoff.agent_id', ctx.agentId);
  if (ctx.workflowId) span.setAttribute('liftoff.workflow_id', ctx.workflowId);
  if (ctx.taskId) span.setAttribute('liftoff.task_id', ctx.taskId);
  if (ctx.actionId) span.setAttribute('liftoff.action_id', ctx.actionId);

  return span;
}

/**
 * End a span with optional error recording
 */
export function endSpan(span: Span, error?: Error): void {
  if (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    span.recordException(error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

/**
 * Execute an async function within a traced span
 * Automatically handles span lifecycle and error recording
 */
export async function withSpan<T>(
  name: string,
  ctx: TelemetryContext,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  const span = createSpan(name, ctx, kind);

  try {
    // Run the function within the span's context
    const result = await context.with(
      trace.setSpan(context.active(), span),
      async () => fn(span)
    );
    endSpan(span);
    return result;
  } catch (error) {
    endSpan(span, error as Error);
    throw error;
  }
}

/**
 * Execute a sync function within a traced span
 */
export function withSpanSync<T>(
  name: string,
  ctx: TelemetryContext,
  fn: (span: Span) => T,
  kind: SpanKind = SpanKind.INTERNAL
): T {
  const span = createSpan(name, ctx, kind);

  try {
    const result = context.with(
      trace.setSpan(context.active(), span),
      () => fn(span)
    );
    endSpan(span);
    return result;
  } catch (error) {
    endSpan(span, error as Error);
    throw error;
  }
}

/**
 * Get the current active span
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * Get the current trace context from the active span
 */
export function getCurrentTraceContext(): { traceId: string; spanId: string } | null {
  const span = getCurrentSpan();
  if (!span) return null;

  const spanContext = span.spanContext();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

/**
 * Add an event to the current span
 */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
  const span = getCurrentSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Set attributes on the current span
 */
export function setSpanAttributes(attributes: Record<string, string | number | boolean>): void {
  const span = getCurrentSpan();
  if (span) {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
  }
}

/**
 * Record an error on the current span without ending it
 */
export function recordSpanError(error: Error): void {
  const span = getCurrentSpan();
  if (span) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
  }
}

/**
 * Extract trace context from carrier (headers)
 */
export function extractContext(carrier: Record<string, string | string[] | undefined>): Context {
  return propagation.extract(context.active(), carrier);
}

/**
 * Inject trace context into carrier (headers)
 */
export function injectContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

// Re-export commonly used OpenTelemetry types
export { SpanKind, SpanStatusCode, Span, Context } from '@opentelemetry/api';
