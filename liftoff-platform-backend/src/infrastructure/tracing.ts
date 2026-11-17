// Platform-backend-specific tracing wrapper around @liftoffos/telemetry.
// Keeps the existing call-site API (`initTracing()` no args, hardcoded service
// name) while delegating to the shared package.

// Load environment variables before initialising the OTel SDK.
import 'dotenv/config';

import {
  initTracing as initTracingPkg,
  shutdownTracing as shutdownTracingPkg,
  getCurrentTraceId as getCurrentTraceIdPkg,
  createSpan as createSpanPkg,
  withSpan as withSpanPkg,
  getTracer as getTracerPkg,
  type TraceContext,
} from '@liftoffos/telemetry';
import type { Span } from '@opentelemetry/api';

const SERVICE_NAME = 'liftoff-platform-backend';

export type { TraceContext };

export function initTracing(): void {
  initTracingPkg({ serviceName: SERVICE_NAME });
  console.log('OpenTelemetry tracing initialized');
}

export function shutdownTracing(): Promise<void> {
  return shutdownTracingPkg();
}

export function getTracer() {
  return getTracerPkg(SERVICE_NAME);
}

export function createSpan(name: string, ctx?: TraceContext): Span {
  return createSpanPkg(SERVICE_NAME, name, ctx);
}

export function withSpan<T>(
  name: string,
  ctx: TraceContext | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpanPkg(SERVICE_NAME, name, ctx, fn);
}

export function getCurrentTraceId(): string | undefined {
  return getCurrentTraceIdPkg();
}
