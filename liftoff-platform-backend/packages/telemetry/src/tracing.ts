// OpenTelemetry tracing helpers — shared across all Liftoff platform services.
// Per Section 18: OpenTelemetry instrumentation, Cloud Trace.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { TraceExporter } from '@google-cloud/opentelemetry-cloud-trace-exporter';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from '@opentelemetry/semantic-conventions/incubating';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

// Correlation IDs attached to every span on every workflow/task/action/tool-call chain.
export interface TraceContext {
  tenantId?: string;
  agentId?: string;
  workflowId?: string;
  taskId?: string;
  actionId?: string;
  traceId?: string;
}

export interface InitTracingOptions {
  /** Service name exported as OTel resource attribute. Required. */
  serviceName: string;
  /** Semver string; defaults to env SERVICE_VERSION or '0.1.0'. */
  serviceVersion?: string;
  /** Deployment environment; defaults to env ENVIRONMENT or 'dev'. */
  environment?: string;
  /** GCP project ID for the Cloud Trace exporter; defaults to env GCP_PROJECT_ID. */
  projectId?: string;
}

let sdk: NodeSDK | null = null;

/** Initialise the OpenTelemetry SDK. Call once at process start. */
export function initTracing(options: InitTracingOptions): void {
  const exporter = new TraceExporter({
    projectId: options.projectId ?? process.env.GCP_PROJECT_ID,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]:
        options.serviceVersion ?? process.env.SERVICE_VERSION ?? '0.1.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
        options.environment ?? process.env.ENVIRONMENT ?? 'dev',
    }),
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  sdk.start();
}

/** Flush and shut down the OpenTelemetry SDK. Call once at process exit. */
export function shutdownTracing(): Promise<void> {
  return sdk ? sdk.shutdown() : Promise.resolve();
}

/** Get the tracer for the current service. Scoped by serviceName passed at init. */
export function getTracer(serviceName: string) {
  return trace.getTracer(serviceName);
}

/** Start a new span and attach standard TraceContext attributes. */
export function createSpan(
  serviceName: string,
  name: string,
  ctx?: TraceContext,
): Span {
  const span = getTracer(serviceName).startSpan(name);
  if (ctx) {
    if (ctx.tenantId) span.setAttribute('tenant_id', ctx.tenantId);
    if (ctx.agentId) span.setAttribute('agent_id', ctx.agentId);
    if (ctx.workflowId) span.setAttribute('workflow_id', ctx.workflowId);
    if (ctx.taskId) span.setAttribute('task_id', ctx.taskId);
    if (ctx.actionId) span.setAttribute('action_id', ctx.actionId);
    if (ctx.traceId) span.setAttribute('trace_id', ctx.traceId);
  }
  return span;
}

/** Set span status + end. Records exception on error. */
export function endSpan(span: Span, error?: Error): void {
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.recordException(error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

/**
 * Run `fn` inside a span. On success the span ends with OK; on throw the error
 * is recorded, status set to ERROR, and the error re-thrown.
 */
export async function withSpan<T>(
  serviceName: string,
  name: string,
  ctx: TraceContext | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = createSpan(serviceName, name, ctx);
  try {
    const result = await fn(span);
    endSpan(span);
    return result;
  } catch (error) {
    endSpan(span, error as Error);
    throw error;
  }
}

/** Current trace ID from the active span, if any. Useful for log correlation. */
export function getCurrentTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}
