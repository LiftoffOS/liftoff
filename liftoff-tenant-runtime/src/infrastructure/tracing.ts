// Tenant-runtime tracing — delegates to @liftoffos/telemetry with the
// service name fixed to 'liftoff-tenant-runtime'.

import {
  initTracing as initTracingPkg,
  shutdownTracing as shutdownTracingPkg,
  createSpan as createSpanPkg,
  endSpan as endSpanPkg,
  withSpan as withSpanPkg,
  getTracer as getTracerPkg,
  getCurrentTraceId,
} from '@liftoffos/telemetry';
import type { TraceContext } from '@liftoffos/telemetry';
import type { Span } from '@opentelemetry/api';

export type { TraceContext };

const SERVICE_NAME = 'liftoff-tenant-runtime';

export function initTracing(serviceName: string = SERVICE_NAME): void {
  initTracingPkg({ serviceName });
}

export function shutdownTracing(): Promise<void> {
  return shutdownTracingPkg();
}

export function getTracer() {
  return getTracerPkg(SERVICE_NAME);
}

export function createSpan(name: string, ctx: TraceContext): Span {
  return createSpanPkg(SERVICE_NAME, name, ctx);
}

export function endSpan(span: Span, error?: Error): void {
  endSpanPkg(span, error);
}

export function withSpan<T>(
  name: string,
  ctx: TraceContext,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpanPkg(SERVICE_NAME, name, ctx, fn);
}

export { getCurrentTraceId };
