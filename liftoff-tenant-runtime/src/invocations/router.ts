// Invocations and Threads Router
// Per implementation plan: Phase 3.4 API Endpoints

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { invocationsService } from './service';
import { log } from '../infrastructure/logging';
import { scrubLogger } from '../observability/scrub-logger';
import { CreateThreadInput, CreateMessageInput, InvocationOutcome } from './types';

// WS-6.4 — 503 + Retry-After contract for cross-service feed endpoints. The
// ingester back-off contract treats 503 as "expected; retry later"; 500 is
// "real error; alert". Same shape as usage-ledger/router.ts.
function handleFeedError(err: unknown, res: Response, endpoint: string, poolName = 'default'): void {
  const msg = (err as Error).message;
  if (msg.includes('statement_timeout')) {
    scrubLogger.warn({ event: 'pool_saturation_503', endpoint, pool_name: poolName });
    res.set('Retry-After', '30');
    res.status(503).json({ error: 'feed query timed out; retry with smaller window' });
    return;
  }
  if (msg.includes('Pool') || msg.includes('connection') || msg.includes('timeout')) {
    scrubLogger.warn({ event: 'pool_saturation_503', endpoint, pool_name: poolName });
    res.set('Retry-After', '5');
    res.status(503).json({ error: 'pool saturation; retry' });
    return;
  }
  res.status(500).json({ error: msg });
}
import { agentStatusService } from '../agent-status/service';
import { formatAsText } from '../agent-status/text-formatter';

export const invocationsRouter = Router();
export const threadsRouter = Router();

// Validation schemas
const createThreadSchema = z.object({
  agentId: z.string().uuid(),
  initiatedByUser: z.string().max(255).optional(),
  initiatedByType: z.enum(['human', 'agent', 'system']).optional(),
  title: z.string().max(500).optional(),
});

const addMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(100000),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.unknown().optional(),
    error: z.string().optional(),
  })).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
});

// ==== Threads Routes ====

// POST /api/threads
// Create a new thread
threadsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const parseResult = createThreadSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const thread = await invocationsService.createThread({
      tenantId,
      agentId: parseResult.data.agentId,
      initiatedByUser: parseResult.data.initiatedByUser,
      initiatedByType: parseResult.data.initiatedByType,
      title: parseResult.data.title,
    } as CreateThreadInput);

    res.status(201).json(thread);
  } catch (error) {
    log.error({ error }, 'Failed to create thread');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/threads/:threadId
// Get a specific thread
threadsRouter.get('/:threadId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { threadId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const thread = await invocationsService.getThread(threadId, tenantId);

    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    res.json(thread);
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get thread');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/threads/:threadId/messages
// Get messages in a thread
threadsRouter.get('/:threadId/messages', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { threadId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const beforeId = req.query.beforeId as string | undefined;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const messages = await invocationsService.getMessages(threadId, tenantId, { limit, beforeId });

    res.json({ messages });
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get messages');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/threads/:threadId/messages
// Add message to a thread
threadsRouter.post('/:threadId/messages', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { threadId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const parseResult = addMessageSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const message = await invocationsService.addMessage({
      tenantId,
      threadId,
      role: parseResult.data.role,
      content: parseResult.data.content,
      toolCalls: parseResult.data.toolCalls,
      inputTokens: parseResult.data.inputTokens,
      outputTokens: parseResult.data.outputTokens,
    } as CreateMessageInput);

    res.status(201).json(message);
  } catch (error) {
    log.error({ error }, 'Failed to add message');
    res.status(500).json({ error: (error as Error).message });
  }
});

// ==== Invocations Routes ====

// GET /api/invocations
// List invocations with filters
invocationsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const agentId = req.query.agentId as string | undefined;
    const outcome = req.query.outcome as InvocationOutcome | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const result = await invocationsService.listInvocations(tenantId, {
      agentId,
      outcome,
      cursor,
      limit,
    });

    res.json({
      invocations: result.invocations,
      nextCursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    });
  } catch (error) {
    log.error({ error }, 'Failed to list invocations');
    res.status(500).json({ error: (error as Error).message });
  }
});

// Specific routes MUST be defined before the parameterized /:invocationId route,
// otherwise Express matches "stats", "agent-costs", etc. as invocationId params.

// GET /api/invocations/stats
// Get cost statistics
invocationsRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    // Default to last 30 days
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const startParam = req.query.start as string | undefined;
    const endParam = req.query.end as string | undefined;
    const agentId = req.query.agentId as string | undefined;

    const stats = await invocationsService.getCostStats(
      tenantId,
      startParam ? new Date(startParam) : startDate,
      endParam ? new Date(endParam) : endDate,
      agentId
    );

    res.json(stats);
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get stats');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/invocations/agent-costs
// Get per-agent cost aggregation for the current month (or specified date range)
invocationsRouter.get('/agent-costs', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    // Default to current month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const startParam = req.query.start as string | undefined;
    const endParam = req.query.end as string | undefined;

    const costs = await invocationsService.getAgentCosts(
      tenantId,
      startParam ? new Date(startParam) : monthStart,
      endParam ? new Date(endParam) : now,
    );

    res.json(costs);
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get agent costs');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/invocations/hitl-decision-counts
// Get HITL decision counts (approvals + rejections) per account from
// hitl_approval_requests for the given date range. Used by Platform Backend
// to populate the Tasks column for human rows on the /teams page.
invocationsRouter.get('/hitl-decision-counts', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const startParam = req.query.start as string | undefined;
    const endParam = req.query.end as string | undefined;

    const counts = await invocationsService.getHitlDecisionCounts(
      tenantId,
      startParam ? new Date(startParam) : monthStart,
      endParam ? new Date(endParam) : now,
    );

    res.json(counts);
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get HITL decision counts');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/invocations/external-agent-tasks
// Get task counts for external agents from audit_logs (current month or specified range)
invocationsRouter.get('/external-agent-tasks', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const startParam = req.query.start as string | undefined;
    const endParam = req.query.end as string | undefined;

    const counts = await invocationsService.getExternalAgentTaskCounts(
      tenantId,
      startParam ? new Date(startParam) : monthStart,
      endParam ? new Date(endParam) : now,
    );

    res.json(counts);
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get external agent task counts');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/invocations/ingestion-feed
// Cursor-based feed for cost attribution ingestion (platform-backend polls this).
// Requires service auth (X-Service-Auth header).
// Query params: since (ISO timestamp, required), limit (default 500, max 1000)
invocationsRouter.get('/ingestion-feed', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const sinceParam = req.query.since as string | undefined;
    if (!sinceParam) {
      return res.status(400).json({ error: 'since parameter required (ISO timestamp)' });
    }
    const since = new Date(sinceParam);
    if (isNaN(since.getTime())) {
      return res.status(400).json({ error: 'since must be a valid ISO timestamp' });
    }

    const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const limit = Math.min(Math.max(1, limitParam), 1000);

    const rows = await invocationsService.listInvocationsForIngestion(tenantId, since, limit);

    res.json({
      rows,
      hasMore: rows.length === limit,
      nextSince: rows.length > 0 ? rows[rows.length - 1].startedAt.toISOString() : sinceParam,
    });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get invocation ingestion feed');
    handleFeedError(error, res, '/api/invocations/ingestion-feed');
  }
});

// GET /api/invocations/sandbox-feed
// Cursor-based feed of sandbox usage log rows for cost attribution ingestion.
// Platform-backend polls this per tenant to ingest sandbox compute costs.
// Query params: since (ISO timestamp, required), limit (default 500, max 1000)
invocationsRouter.get('/sandbox-feed', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const sinceParam = req.query.since as string | undefined;
    if (!sinceParam) {
      return res.status(400).json({ error: 'since parameter required (ISO timestamp)' });
    }
    const since = new Date(sinceParam);
    if (isNaN(since.getTime())) {
      return res.status(400).json({ error: 'since must be a valid ISO timestamp' });
    }

    const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const limit = Math.min(Math.max(1, limitParam), 1000);

    const rows = await invocationsService.listSandboxUsageForIngestion(tenantId, since, limit);

    res.json({
      rows,
      hasMore: rows.length === limit,
      nextSince: rows.length > 0 ? rows[rows.length - 1].timestamp.toISOString() : sinceParam,
    });
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get sandbox usage feed');
    handleFeedError(error, res, '/api/invocations/sandbox-feed');
  }
});

// GET /api/invocations/:invocationId
// Get a specific invocation — MUST be after specific routes
invocationsRouter.get('/:invocationId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { invocationId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const invocation = await invocationsService.getInvocation(invocationId, tenantId);

    if (!invocation) {
      return res.status(404).json({ error: 'Invocation not found' });
    }

    res.json(invocation);
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to get invocation');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/invocations/:invocationId/status?format=json|text
// Internal: read-only live status for an invocation. Used by platform-backend
// (for liftoff-react admin views) and by operator break-glass via service-auth.
//
// Tenant isolation: lookup is by globally-unique invocation_id. Caller is
// responsible for any tenant filtering at the proxy layer (platform-backend).
invocationsRouter.get('/:invocationId/status', async (req: Request, res: Response) => {
  try {
    const { invocationId } = req.params;
    const format = (req.query.format as string) || 'json';
    // Optional defense-in-depth: caller (platform-backend proxy) can pass the
    // expected tenant via header; we 404 if the invocation actually belongs to
    // a different tenant. Direct service-auth callers omit this.
    const expectedTenantId = req.header('X-Liftoff-Expected-Tenant') ?? undefined;

    const status = await agentStatusService.getStatus(invocationId, expectedTenantId);
    if (!status) {
      return res.status(404).json({ error: 'Invocation not found' });
    }

    if (format === 'text') {
      const useColor = req.query.color === '1';
      res.set('Content-Type', 'text/plain; charset=utf-8');
      return res.send(formatAsText(status, useColor));
    }

    res.json(status);
  } catch (error) {
    log.error({ error: (error as Error).message }, 'Failed to get agent status');
    res.status(500).json({ error: (error as Error).message });
  }
});
