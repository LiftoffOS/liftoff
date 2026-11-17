// Addresses: SE-001, SE-002, SE-004, BE-003, SE-007, TE-011
// Per Phase 0.4: SE-005 - Fix timing attack vulnerability in service token comparison

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { agentAuditLogsService } from './service';
import { TenantRepository } from '../tenants/repository';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { authedWithDelegation } from '../support-delegation/authed';
import { log } from '../infrastructure/logging';
import { attachAdminStatus } from '../branding/admin-status-middleware';
import { brandingResponseMiddleware } from '../branding/middleware';

const tenantsRepository = new TenantRepository();

export const agentAuditLogsRouter = Router();

// [SE-007] Strict triggered_by validation
// human: accepts Firebase UIDs (28-char alphanumeric, no hyphens), UUID hex
//   strings, AND provider-namespaced ids like `human:slack:C01ABCD2EFG` — the
//   runtime attributes Slack-triggered runs with a `<provider>:<id>` suffix, so
//   the suffix must permit `:` and `.` alongside letters/digits/hyphens/
//   underscores. (Before this, the bare `[A-Za-z0-9_-]` suffix silently dropped
//   every Slack-attributed invocation audit row.) Kept to id-safe characters —
//   nothing exotic like whitespace or `@`; the runtime's outbox coerces anything
//   still non-conforming to a safe fallback rather than dropping it.
// agent: remains strict (lowercase hex UUID only)
// event: accepts dotted topics (e.g. `event:gmail.new_message`,
//   `event:tenant.oversight.updated`) — Composio webhooks, Pub/Sub topics,
//   and our own event-topic registry all use dotted notation, so the suffix
//   must permit `.` alongside letters/digits/hyphens/underscores.
// system: accepts an optional subsystem suffix (e.g. `system:hybrid_loop`,
//   `system:scheduler`, `system:retry`) so internal automation can attribute
//   the action to the specific subsystem. Dotted system suffixes are
//   accepted for symmetry with event topics (`system:reconciler.poll`).
//   Bare `system` continues to accept catch-all platform-internal events.
// Exported for focused unit testing of the SE-007 format contract.
export const triggeredBySchema = z.string().regex(
  /^(human:[A-Za-z0-9_.:-]+|agent(:[a-f0-9-]+)?|cron|event:[a-zA-Z0-9_.-]+|system(:[a-zA-Z0-9_.-]+)?)$/,
  'Invalid triggeredBy format. Must be human:<uid>, agent, agent:<uuid>, cron, event:<topic>, system, or system:<subsystem>'
);

// [TE-011] durationMs validation with edge cases
const durationMsSchema = z.number().int().min(0).max(86400000).optional(); // Max 24 hours

const insertAuditLogSchema = z.object({
  tenantId: z.string().uuid(),
  internalAgentId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  invocationId: z.string().uuid().optional(),
  // Per-dispatch id from the runtime (its audit row's idempotency_key);
  // equals cost_attribution_events.action_id for tool charges — the
  // per-call cost↔audit join key (migration 445).
  toolCallId: z.string().uuid().optional(),
  externalAgentId: z.string().uuid().optional(),
  proxyKeyId: z.string().uuid().optional(),  // developer proxy/Claude Code proxy key UUID
  action: z.string().min(1).max(255),
  inputArgs: z.record(z.unknown()).default({}).refine(
    obj => JSON.stringify(obj).length <= 65536,
    'inputArgs exceeds 64KB limit'
  ),
  outputSummary: z.string().max(4096).optional(),
  outcome: z.enum(['success', 'error', 'gated']),
  errorCode: z.string().max(100).optional(),
  triggeredBy: triggeredBySchema,
  durationMs: durationMsSchema,
  correctionOf: z.string().uuid().optional(),  // Links to original action this corrects
  preActionSnapshot: z.record(z.unknown()).nullable().optional(),
  postActionSnapshot: z.record(z.unknown()).nullable().optional(),
  externalResponse: z.record(z.unknown()).nullable().optional(),
  snapshotStatus: z.string().optional(),
  // Strict accounts.id, same treatment as userId above: the column is UUID, so
  // a synthetic slack:<uid> form would 400 and drop the whole audit row.
  // Present only on runs a support delegation session set in motion.
  impersonatedBy: z.string().uuid().optional(),
});

const listFiltersSchema = z.object({
  internalAgentId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  invocationId: z.string().uuid().optional(),
  externalAgentId: z.string().uuid().optional(),
  action: z.string().optional(),
  outcome: z.enum(['success', 'error', 'gated']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  /** Free-text search across agent name, action, input_args, output_summary.
   *  Pushes filtering to the DB so high-volume agents can't bury low-volume
   *  agents' rows past the client's fetched window. Capped at 200 chars to
   *  keep the LIKE pattern bounded. */
  q: z.string().max(200).optional(),
  // Max 1000 supports the dashboard "Hours Saved Last 30 Days" tile which
  // samples up to 500 successful invocations and scales by `total`. Indexed
  // query on (tenant_id, created_at) returns well within request budget.
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  cursor: z.string().uuid().optional(),
});

// [BE-003, SE-004] Rate limiting using express-rate-limit (codebase pattern)
// Per-tenant + per-IP composite limiting
const insertRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute
  keyGenerator: (req) => {
    const tenantId = req.body?.tenantId || 'unknown';
    const ip = ipKeyGenerator(req.ip || 'unknown');
    return `agent-audit:${tenantId}:${ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded', retryAfter: 60 },
});

const readRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100, // 100 read requests per minute per tenant
  keyGenerator: (req) => `agent-audit-read:${req.query.tenantId || req.params.tenantId}`,
  standardHeaders: true,
  legacyHeaders: false,
});

// [SE-001] Service authentication middleware for tenant-runtime calls
// POST endpoint uses service auth (not user auth)
// [SE-005] Uses timing-safe comparison to prevent timing attacks
const serviceAuthMiddleware = async (req: Request, res: Response, next: () => void) => {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  // Accept any of the internal service tokens — this endpoint is written
  // to by tenant-runtime (per-tenant agent executions) and by
  // workforce-service (HRBP provisioning + CAIO chat audit trail). Each
  // service owns its own secret; both are mounted on platform-backend
  // Cloud Run via cloudbuild's --update-secrets step.
  const acceptedTokens = [
    process.env.TENANT_RUNTIME_SERVICE_TOKEN,
    process.env.WORKFORCE_SERVICE_TOKEN,
  ].filter((t): t is string => typeof t === 'string' && t.length > 0);

  if (acceptedTokens.length === 0) {
    return res.status(500).json({ error: 'Service authentication not configured' });
  }

  // Use timing-safe comparison to prevent timing attacks (SE-005). Loop
  // over every accepted token so the comparison time stays constant
  // regardless of which token matched (or whether any did).
  let isValid = false;
  if (serviceToken) {
    const tokenBuf = Buffer.from(serviceToken);
    for (const expected of acceptedTokens) {
      const expectedBuf = Buffer.from(expected);
      if (tokenBuf.length === expectedBuf.length && crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        isValid = true;
      }
    }
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid service authentication' });
  }

  next();
};

// POST /api/agent-audit-logs
// [SE-001] Protected by service auth (for tenant-runtime calls)
agentAuditLogsRouter.post(
  '/',
  serviceAuthMiddleware,
  insertRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const parseResult = insertAuditLogSchema.safeParse(req.body);
      if (!parseResult.success) {
        // [SE-007] Surface rejected payloads so silent audit drops are diagnosable.
        // A triggeredBy (or other field) the runtime emits that this schema doesn't
        // accept returns 400 → the outbox retries then drops the row. Without this
        // line the offending value/action was invisible (e.g. the human:slack:<uid>
        // drop went undetected because only the 5xx catch below logged).
        log.warn(
          {
            tenantId: req.body?.tenantId,
            action: req.body?.action,
            triggeredBy: req.body?.triggeredBy,
            errors: parseResult.error.errors,
          },
          'Rejected agent audit log (validation failed)'
        );
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors
        });
      }

      const auditLog = await agentAuditLogsService.insertAuditLog(parseResult.data);
      res.status(201).json(auditLog);
    } catch (error) {
      if ((error as Error).message.includes('exceeds maximum size')) {
        return res.status(400).json({ error: (error as Error).message });
      }
      // Log the underlying error so future failures aren't invisible.
      // Without this, a constraint violation or any other DB error becomes
      // a generic 500 with no traceability — which is exactly how a CHECK
      // constraint mismatch on triggered_by went undetected long enough to
      // cause every per-tool-call audit-mirror from the runtime to fail.
      log.error(
        {
          error: (error as Error).message,
          stack: (error as Error).stack,
          tenantId: req.body?.tenantId,
          action: req.body?.action,
          triggeredBy: req.body?.triggeredBy,
        },
        'Failed to insert agent audit log'
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Pub/Sub push schema for sandbox egress audit delivery
const pubSubPushSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string(),
});

// Auth middleware for sandbox Pub/Sub push endpoint.
// Accepts SANDBOX_AUDIT_PUSH_TOKEN via Bearer header or ?token= query param.
// If the env var is not set, all requests are allowed (local dev).
const sandboxPushAuthMiddleware = async (req: Request, res: Response, next: () => void) => {
  const expectedToken = process.env.SANDBOX_AUDIT_PUSH_TOKEN;
  if (!expectedToken) {
    return next();
  }

  let provided: string | undefined;
  const authHeader = req.headers['authorization'] as string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    provided = authHeader.slice(7);
  } else if (typeof req.query.token === 'string') {
    provided = req.query.token;
  }

  if (!provided) {
    return res.status(401).json({ error: 'Missing authentication' });
  }

  const isValid =
    Buffer.byteLength(provided) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedToken));

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid authentication' });
  }

  next();
};

// POST /api/agent-audit-logs/sandbox-events
// Pub/Sub push subscription endpoint — receives sandbox egress proxy audit events.
// Returns 204 to acknowledge delivery (Pub/Sub requires 2xx to not redeliver).
agentAuditLogsRouter.post(
  '/sandbox-events',
  sandboxPushAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const parseResult = pubSubPushSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Invalid Pub/Sub push payload',
          details: parseResult.error.errors,
        });
      }

      const { message, subscription } = parseResult.data;

      // Decode and parse the base64-encoded message data
      let event: Record<string, unknown>;
      try {
        const decoded = Buffer.from(message.data, 'base64').toString('utf-8');
        event = JSON.parse(decoded);
      } catch {
        return res.status(400).json({ error: 'Failed to decode message data' });
      }

      // Only process sandbox_egress events; silently ack anything else
      if (event.event_type !== 'sandbox_egress') {
        return res.status(204).send();
      }

      // Extract tenant slug and environment from subscription name.
      // Format: sandbox-egress-audit-push-{tenantSlug}-{dev|staging|prod}
      // The slug may be a direct UUID (future tenants) or a human-readable slug
      // (legacy tenants like "liftoffos"). For slugs, look up via gcp_project_id.
      const match = subscription.match(/sandbox-egress-audit-push-(.+)-(dev|staging|prod)$/);
      if (!match) {
        log.warn({ subscription }, 'sandbox-events: could not extract tenant from subscription name');
        return res.status(204).send(); // Ack so Pub/Sub stops redelivering
      }
      const tenantSlug = match[1];
      const environment = match[2];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let tenantId: string;
      if (uuidRegex.test(tenantSlug)) {
        tenantId = tenantSlug;
      } else {
        // Slug-based tenant — look up UUID via GCP project ID convention: tenant-{slug}-{env}
        const gcpProjectId = `tenant-${tenantSlug}-${environment}`;
        const tenant = await tenantsRepository.findByGcpProjectId(gcpProjectId);
        if (!tenant) {
          log.warn({ subscription, gcpProjectId }, 'sandbox-events: could not find tenant by GCP project ID');
          return res.status(204).send();
        }
        tenantId = tenant.id;
      }

      const method = typeof event.method === 'string' ? event.method : '';
      const domain = typeof event.domain === 'string' ? event.domain : '';
      const path = typeof event.path === 'string' ? event.path : '';
      const status = typeof event.status === 'string' ? event.status : '';
      const latencyMs = typeof event.latency_ms === 'number' ? event.latency_ms : 0;
      const invocationId = typeof event.invocation_id === 'string' ? event.invocation_id : undefined;

      const action = `${method} ${domain}${path}`.substring(0, 255);
      const outcome: 'success' | 'error' = status.startsWith('2') ? 'success' : 'error';
      const outputSummary = `HTTP ${status} (${latencyMs}ms)`;

      // Only pass invocationId if it looks like a UUID
      const validInvocationId = invocationId && uuidRegex.test(invocationId) ? invocationId : undefined;

      let preActionSnapshot: Record<string, unknown> | null = null;
      let snapshotStatus: 'captured' | 'unavailable' = 'unavailable';
      if (typeof event.pre_action_snapshot_raw === 'string' && event.pre_action_snapshot_raw) {
        try {
          preActionSnapshot = JSON.parse(event.pre_action_snapshot_raw);
          snapshotStatus = 'captured';
        } catch {
          snapshotStatus = 'unavailable';
        }
      }

      await agentAuditLogsService.insertAuditLog({
        tenantId,
        action,
        outcome,
        triggeredBy: 'agent',
        invocationId: validInvocationId,
        inputArgs: {
          connector_type: event.connector_type,
          entity_type: event.entity_type,
          entity_id: event.entity_id,
          method: event.method,
          request_body: event.request_body,
        },
        outputSummary,
        preActionSnapshot: preActionSnapshot ?? undefined,
        snapshotStatus,
      });

      return res.status(204).send();
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to process sandbox-events Pub/Sub push'
      );
      // Return 500 so Pub/Sub will redeliver — only ack on success
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/agent-audit-logs
// List audit logs with filtering and pagination
// Auth: Uses authMiddleware for Firebase authentication
agentAuditLogsRouter.get(
  '/',
  ...authedWithDelegation,
  // Identity is not tenancy. These read tenantId from the query and scope the
  // listing to it, so membership has to be proved before the handler runs.
  // Per-route rather than at the mount because this router sits BEFORE the
  // global auth gate to serve service-auth POSTs.
  tenantAuthMiddleware('viewDashboard'),
  attachAdminStatus,
  brandingResponseMiddleware,
  readRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      const parseResult = listFiltersSchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors
        });
      }

      const { limit, cursor, startDate, endDate, ...filters } = parseResult.data;

      const result = await agentAuditLogsService.listAuditLogs(
        tenantId,
        {
          ...filters,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        },
        limit,
        cursor
      );

      res.json(result);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/agent-audit-logs/:id
// Get a single audit log by ID
agentAuditLogsRouter.get(
  '/:id',
  ...authedWithDelegation,
  // Identity is not tenancy. These read tenantId from the query and scope the
  // listing to it, so membership has to be proved before the handler runs.
  // Per-route rather than at the mount because this router sits BEFORE the
  // global auth gate to serve service-auth POSTs.
  tenantAuthMiddleware('viewDashboard'),
  attachAdminStatus,
  brandingResponseMiddleware,
  readRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId is required' });
      }

      const auditLog = await agentAuditLogsService.getAuditLog(tenantId, req.params.id);

      if (!auditLog) {
        return res.status(404).json({ error: 'Audit log not found' });
      }

      res.json(auditLog);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
