// Trace Context Middleware
// Per Section 18: Extract and propagate trace context through request lifecycle
//
// This middleware:
// - Extracts trace context from incoming request headers (W3C Trace Context)
// - Creates a root span for the HTTP request
// - Propagates tenant and agent IDs through the request
// - Creates child spans for key operations
// - Ensures trace context is available to all downstream services

import { Request, Response, NextFunction } from 'express';
import {
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  Span,
} from '@opentelemetry/api';
import { v4 as uuidv4 } from 'uuid';
import {
  withTraceContext,
  TraceContext,
} from '../infrastructure/logging';
import { getTracer, TelemetryContext } from '../infrastructure/telemetry';

// Extend Express Request to include trace context
declare global {
  namespace Express {
    interface Request {
      traceContext?: TelemetryContext;
      span?: Span;
    }
  }
}

// Header names for trace context propagation
const HEADERS = {
  TRACE_PARENT: 'traceparent',
  TRACE_STATE: 'tracestate',
  TENANT_ID: 'x-tenant-id',
  AGENT_ID: 'x-agent-id',
  WORKFLOW_ID: 'x-workflow-id',
  TASK_ID: 'x-task-id',
  ACTION_ID: 'x-action-id',
  REQUEST_ID: 'x-request-id',
  TRACE_ID: 'x-trace-id',
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(s: string): boolean { return UUID_RE.test(s); }

function extractTenantIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  for (const key of ['tenantId', 'tenant_id']) {
    const v = b[key];
    if (typeof v === 'string' && isUuidLike(v)) return v;
  }
  return undefined;
}

function extractTenantIdFromPubSubAttributes(body: unknown): string | undefined {
  // Pub/Sub push body shape: { message: { data: base64, attributes: { ... } } }
  if (!body || typeof body !== 'object') return undefined;
  const msg = (body as { message?: { attributes?: Record<string, string>; data?: unknown } }).message;
  const v = msg?.attributes?.tenant_id ?? msg?.attributes?.tenantId;
  if (typeof v === 'string' && isUuidLike(v)) return v;
  if (msg && typeof msg === 'object' && 'data' in msg && typeof (msg as { data?: unknown }).data === 'string') {
    try {
      const decoded = JSON.parse(Buffer.from((msg as { data: string }).data, 'base64').toString('utf8'));
      const inner = decoded?.tenantId ?? decoded?.tenant_id;
      if (typeof inner === 'string' && isUuidLike(inner)) return inner;
    } catch {
      // ignore parse failures — fall through to 'unknown'
    }
  }
  return undefined;
}

/**
 * Extract trace context from request headers
 */
function extractTraceContext(req: Request): TelemetryContext {
  // Header is the fast path. Pub/Sub push, Cloud Tasks, and any caller that
  // submitted JSON with tenantId/tenant_id in the body get a body-side fallback
  // before defaulting to 'unknown'. The body fallback is best-effort and only
  // reads tenant id-shaped fields — never poisons the context with arbitrary body data.
  const headerTenant = req.headers[HEADERS.TENANT_ID] as string | undefined;
  const bodyTenant = extractTenantIdFromBody(req.body);
  const pubsubAttrTenant = extractTenantIdFromPubSubAttributes(req.body);
  const tenantId = headerTenant ?? bodyTenant ?? pubsubAttrTenant ?? 'unknown';
  const agentId = req.headers[HEADERS.AGENT_ID] as string | undefined;
  const workflowId = req.headers[HEADERS.WORKFLOW_ID] as string | undefined;
  const taskId = req.headers[HEADERS.TASK_ID] as string | undefined;
  const actionId = req.headers[HEADERS.ACTION_ID] as string | undefined;

  // Generate or use existing trace ID
  let traceId = req.headers[HEADERS.TRACE_ID] as string | undefined;
  if (!traceId) {
    traceId = uuidv4();
  }

  return {
    tenantId,
    agentId,
    workflowId,
    taskId,
    actionId,
    traceId,
  };
}

/**
 * Create the root span for an HTTP request
 */
function createRequestSpan(req: Request, telemetryCtx: TelemetryContext): Span {
  const tracer = getTracer('http-middleware');

  // Extract parent context from headers if present (for distributed tracing)
  const parentContext = propagation.extract(context.active(), req.headers);

  const span = tracer.startSpan(
    `HTTP ${req.method} ${req.path}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method': req.method,
        'http.url': req.url,
        'http.route': req.route?.path || req.path,
        'http.target': req.path,
        'http.host': req.hostname,
        'http.scheme': req.protocol,
        'http.user_agent': req.headers['user-agent'] || '',
        'net.host.ip': req.ip || '',
        // Liftoff-specific attributes
        'liftoff.tenant_id': telemetryCtx.tenantId,
        ...(telemetryCtx.agentId && { 'liftoff.agent_id': telemetryCtx.agentId }),
        ...(telemetryCtx.workflowId && { 'liftoff.workflow_id': telemetryCtx.workflowId }),
        ...(telemetryCtx.taskId && { 'liftoff.task_id': telemetryCtx.taskId }),
        ...(telemetryCtx.actionId && { 'liftoff.action_id': telemetryCtx.actionId }),
        ...(telemetryCtx.traceId && { 'liftoff.trace_id': telemetryCtx.traceId }),
      },
    },
    parentContext
  );

  return span;
}

/**
 * Main trace context middleware
 * Extracts trace context, creates spans, and propagates through the request lifecycle
 */
export function traceContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Extract trace context from headers
  const telemetryCtx = extractTraceContext(req);

  // Create the root span for this request
  const span = createRequestSpan(req, telemetryCtx);

  // Attach to request for use in handlers
  req.traceContext = telemetryCtx;
  req.span = span;

  // Set response headers for trace correlation
  const spanContext = span.spanContext();
  res.setHeader(HEADERS.TRACE_ID, telemetryCtx.traceId || spanContext.traceId);
  res.setHeader('x-span-id', spanContext.spanId);

  // Capture response details
  const startTime = Date.now();

  // Override res.end to capture response status and end span
  const originalEnd = res.end.bind(res);
  res.end = function (
    this: Response,
    chunk?: any,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void
  ): Response {
    const duration = Date.now() - startTime;

    // Add response attributes
    span.setAttribute('http.status_code', res.statusCode);
    span.setAttribute('http.response_content_length', res.get('content-length') || 0);
    span.setAttribute('http.duration_ms', duration);

    // Set span status based on HTTP status code
    if (res.statusCode >= 500) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${res.statusCode}`,
      });
    } else if (res.statusCode >= 400) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${res.statusCode}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    // End the span
    span.end();

    // Call original end
    if (typeof encoding === 'function') {
      return originalEnd(chunk, encoding);
    }
    return originalEnd(chunk, encoding as BufferEncoding, callback);
  };

  // Run the rest of the middleware chain within the span context
  // and with logging trace context propagation
  const loggingTraceCtx: TraceContext = {
    tenantId: telemetryCtx.tenantId,
    agentId: telemetryCtx.agentId,
    workflowId: telemetryCtx.workflowId,
    taskId: telemetryCtx.taskId,
    actionId: telemetryCtx.actionId,
    traceId: telemetryCtx.traceId,
  };

  // Run within both OpenTelemetry context and logging trace context
  context.with(trace.setSpan(context.active(), span), () => {
    withTraceContext(loggingTraceCtx, () => {
      next();
    });
  });
}

/**
 * Create a child span for a specific operation
 * Use this in route handlers and services for fine-grained tracing
 */
export function createOperationSpan(
  req: Request,
  operationName: string,
  attributes?: Record<string, string | number | boolean>
): Span {
  const tracer = getTracer('operation');
  const span = tracer.startSpan(operationName, {
    kind: SpanKind.INTERNAL,
    attributes: {
      // Include context from request
      'liftoff.tenant_id': req.traceContext?.tenantId || 'unknown',
      ...(req.traceContext?.agentId && { 'liftoff.agent_id': req.traceContext.agentId }),
      ...(req.traceContext?.workflowId && { 'liftoff.workflow_id': req.traceContext.workflowId }),
      ...(req.traceContext?.taskId && { 'liftoff.task_id': req.traceContext.taskId }),
      ...(req.traceContext?.actionId && { 'liftoff.action_id': req.traceContext.actionId }),
      ...attributes,
    },
  });

  return span;
}

/**
 * Wrapper for async route handlers with automatic span creation
 */
export function withOperationSpan<T>(
  req: Request,
  operationName: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const span = createOperationSpan(req, operationName, attributes);

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      span.recordException(error as Error);
      span.end();
      throw error;
    }
  });
}

/**
 * Middleware to add child span for database operations
 */
export function databaseSpanMiddleware(operationName: string) {
  return async function (
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> {
    const span = createOperationSpan(req, `db.${operationName}`, {
      'db.system': 'postgresql',
      'db.operation': operationName,
    });

    // Store span for use in handler
    (req as any).dbSpan = span;

    try {
      next();
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (error as Error).message,
      });
      span.recordException(error as Error);
      span.end();
      throw error;
    }
  };
}

/**
 * Middleware to add child span for external service calls
 */
export function externalServiceSpanMiddleware(serviceName: string) {
  return function (
    req: Request,
    _res: Response,
    next: NextFunction
  ): void {
    const span = createOperationSpan(req, `external.${serviceName}`, {
      'peer.service': serviceName,
    });

    // Store span for use in handler
    (req as any).externalSpan = span;

    next();
  };
}

/**
 * Inject trace context into outgoing request headers
 * Use this when making calls to other services
 */
export function injectTraceContext(
  req: Request,
  outgoingHeaders: Record<string, string>
): void {
  // Inject W3C Trace Context headers
  propagation.inject(context.active(), outgoingHeaders);

  // Also inject Liftoff-specific headers
  if (req.traceContext) {
    outgoingHeaders[HEADERS.TENANT_ID] = req.traceContext.tenantId;
    if (req.traceContext.agentId) {
      outgoingHeaders[HEADERS.AGENT_ID] = req.traceContext.agentId;
    }
    if (req.traceContext.workflowId) {
      outgoingHeaders[HEADERS.WORKFLOW_ID] = req.traceContext.workflowId;
    }
    if (req.traceContext.taskId) {
      outgoingHeaders[HEADERS.TASK_ID] = req.traceContext.taskId;
    }
    if (req.traceContext.actionId) {
      outgoingHeaders[HEADERS.ACTION_ID] = req.traceContext.actionId;
    }
    if (req.traceContext.traceId) {
      outgoingHeaders[HEADERS.TRACE_ID] = req.traceContext.traceId;
    }
  }
}

/**
 * Get trace context for logging from the current request
 */
export function getRequestTraceContext(req: Request): TraceContext {
  return {
    tenantId: req.traceContext?.tenantId,
    agentId: req.traceContext?.agentId,
    workflowId: req.traceContext?.workflowId,
    taskId: req.traceContext?.taskId,
    actionId: req.traceContext?.actionId,
    traceId: req.traceContext?.traceId,
  };
}
