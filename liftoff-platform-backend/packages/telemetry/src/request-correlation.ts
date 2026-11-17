// Phase 0k — request-level trace + correlation propagation. Every
// request carries three headers, and every log line from that request
// includes all three:
//
//   traceparent              W3C trace context
//   X-Liftoff-Request-Id     Unique per external request
//   X-Liftoff-Tenant-Id      Tenant-scoped logs
//
// Headers are read on inbound request (generated if missing), stashed
// in AsyncLocalStorage, and re-emitted on outbound HTTP calls via
// `correlationHeadersForOutbound()`.
//
// The Fastify plugin uses structural typing so this package does not
// hard-depend on fastify at build time — the plugin factory is a
// function that accepts a minimal Fastify-shaped instance. Consumers
// pass their real `fastify` app in.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestCorrelation {
  traceparent: string;
  requestId: string;
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<RequestCorrelation>();

export function getRequestCorrelation(): RequestCorrelation | undefined {
  return storage.getStore();
}

/** Run `fn` with the supplied correlation pinned to AsyncLocalStorage. */
export function withRequestCorrelation<T>(corr: RequestCorrelation, fn: () => T): T {
  return storage.run(corr, fn);
}

/** Headers suitable for outbound fetch / ServiceClient. Returns {} when no active correlation. */
export function correlationHeadersForOutbound(): Record<string, string> {
  const corr = storage.getStore();
  if (!corr) return {};
  const headers: Record<string, string> = {
    traceparent: corr.traceparent,
    'x-request-id': corr.requestId,
  };
  if (corr.tenantId) headers['x-tenant-id'] = corr.tenantId;
  return headers;
}

// Minimal Fastify-shaped types — avoids a build-time dependency on
// fastify. Matches the subset we use.
interface FastifyLogger {
  child: (bindings: Record<string, unknown>) => FastifyLogger;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}
interface FastifyRequestLike {
  headers: Record<string, string | string[] | undefined>;
  log: FastifyLogger;
}
interface FastifyReplyLike {
  header: (name: string, value: string) => unknown;
}
interface FastifyAppLike {
  addHook: (
    name: 'onRequest',
    fn: (req: FastifyRequestLike, reply: FastifyReplyLike, done: () => void) => void,
  ) => unknown;
}

export interface RequestCorrelationPluginOptions {
  /** Header from which to extract tenantId. Defaults to `x-tenant-id`. */
  tenantHeader?: string;
}

/**
 * Install the plugin on a Fastify app. Binds correlation to
 * AsyncLocalStorage, echoes on the response, and creates a per-request
 * child logger tagged with `traceId` / `requestId` / `tenantId`.
 */
export function requestCorrelationPlugin(
  app: FastifyAppLike,
  options: RequestCorrelationPluginOptions = {},
): void {
  const tenantHeader = options.tenantHeader ?? 'x-tenant-id';

  app.addHook('onRequest', (request, reply, done) => {
    const incomingTraceparent = pickHeader(request.headers['traceparent']);
    const incomingRequestId = pickHeader(request.headers['x-request-id']);
    const incomingTenantId = pickHeader(request.headers[tenantHeader]);

    const corr: RequestCorrelation = {
      traceparent: incomingTraceparent ?? generateTraceparent(),
      requestId: incomingRequestId ?? randomUUID(),
      tenantId: incomingTenantId ?? null,
    };

    reply.header('x-request-id', corr.requestId);
    reply.header('traceparent', corr.traceparent);

    request.log = request.log.child({
      traceId: extractTraceId(corr.traceparent),
      requestId: corr.requestId,
      tenantId: corr.tenantId ?? undefined,
    });

    storage.enterWith(corr);
    done();
  });
}

function pickHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** W3C traceparent: `00-<16-byte trace-id hex>-<8-byte parent-id hex>-01` */
function generateTraceparent(): string {
  const traceId = randomUUID().replace(/-/g, '');
  const parentId = randomUUID().replace(/-/g, '').slice(0, 16);
  return `00-${traceId}-${parentId}-01`;
}

function extractTraceId(traceparent: string): string {
  const parts = traceparent.split('-');
  return parts[1] ?? '';
}
