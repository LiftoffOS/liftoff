// External Agents REST API Router
// Follows internal-agents/router.ts patterns
//
// Auth: every endpoint is gated by `tenantAuthMiddleware('manageConnectors')`
// for writes / `viewDashboard` for reads. The middleware sets
// `req.ctx.tenantId` + `(req as any).actorAccountId`, both of which
// `auditCtx(req)` reads so the audit row's `tenant_id` and `user_id`
// columns hold UUIDs (not firebase UIDs, which would be NULLed by the
// flush's UUID validation and hidden from the workspace feed).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { externalAgentService } from './service';
import { log, logAudit } from '../infrastructure/logging';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { auditCtx } from '../infrastructure/audit-context';
import type { ExternalAgent, ExternalAgentStatus } from './types';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';
import { STORED_EFFECT_CLASSES, type StoredEffectClass } from '../mcp/tool-classifier';

export const externalAgentRouter = Router();

// Audit-payload picker used for create/update/status_changed audits. Trims
// the agent to a stable, bounded set of identity + configuration fields.
function pickExternalAgentAuditFields(agent: ExternalAgent): Record<string, unknown> {
  return {
    name: agent.name,
    endpointUrl: agent.endpointUrl,
    transportType: agent.transportType,
    tunnelRouteId: agent.tunnelRouteId,
    authType: agent.authType,
    collaborationMode: agent.collaborationMode,
    connectionType: agent.connectionType,
  };
}

// Removal audit captures the full forensic picture: status at time of
// removal, permission set (allowedInternalAgentIds + requestRules length),
// current version, and description. Cost / capability metadata is omitted
// to keep the row bounded.
function pickExternalAgentRemovedFields(agent: ExternalAgent): Record<string, unknown> {
  return {
    ...pickExternalAgentAuditFields(agent),
    status: agent.status,
    description: agent.description,
    summary: agent.summary,
    allowedInternalAgentIds: agent.allowedInternalAgentIds,
    requestRulesCount: Array.isArray(agent.requestRules) ? agent.requestRules.length : 0,
    currentVersion: agent.currentVersion,
    lastCheckedAt: agent.lastCheckedAt instanceof Date
      ? agent.lastCheckedAt.toISOString()
      : agent.lastCheckedAt,
  };
}

// Custom header schema for custom_headers auth type
const customHeaderSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(1000),
});

// Internal agent request rule schema
const internalAgentRequestRuleSchema = z.object({
  internalAgentId: z.string().uuid(),
  internalAgentName: z.string().max(255),
  permissions: z.object({
    read_summaries: z.enum(['allowed', 'approval_required', 'blocked']),
    run_analysis: z.enum(['allowed', 'approval_required', 'blocked']),
    draft_outputs: z.enum(['allowed', 'approval_required', 'blocked']),
    propose_updates: z.enum(['allowed', 'approval_required', 'blocked']),
  }),
});

// Detected capability schema
const detectedCapabilitySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(10000),
  rawToolName: z.string().max(255),
});

// Detected resource schema
const detectedResourceSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(10000),
  rawUri: z.string().max(2000),
});

// MCP tool definition schema
const mcpToolDefinitionSchema = z.object({
  name: z.string().max(255),
  description: z.string().max(10000).optional(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()).optional(),
    required: z.array(z.string()).optional(),
  }),
});

// MCP resource definition schema
const mcpResourceDefinitionSchema = z.object({
  uri: z.string().max(2000),
  name: z.string().max(255),
  description: z.string().max(10000).optional(),
  mimeType: z.string().max(100).optional(),
});

// Validation schemas
const createSchema = z.object({
  name: z.string().min(1).max(255),
  endpointUrl: z.string().url().max(2000),
  transportType: z.enum(['streamable-http', 'sse']).optional(),
  description: z.string().max(10000).optional(),
  connectionType: z.enum(['automatic', 'custom']),
  authType: z.enum(['none', 'api_key', 'bearer_token', 'custom_headers']),
  apiKey: z.string().max(1000).optional(),
  bearerToken: z.string().max(2000).optional(),
  customHeaders: z.array(customHeaderSchema).max(10).optional(),
  collaborationMode: z.enum(['request_help', 'receive_delegated', 'two_way', 'observe_only']),
  allowedInternalAgentIds: z.array(z.string().uuid()).max(100).default([]),
  requestRules: z.array(internalAgentRequestRuleSchema).max(100).default([]),
  summary: z.string().max(10000).optional(),
  collaborationHints: z.string().max(10000).optional(),
  detectedCapabilities: z.array(detectedCapabilitySchema).max(500).optional(),
  detectedResources: z.array(detectedResourceSchema).max(500).optional(),
  toolClassifications: z.record(z.array(z.enum([
    'customerCommunication',
    'financialActions',
    'dataChanges',
    'externalPublishing',
    'hiringDecisions',
  ]))).optional(),
  // 1b: echoed from the discovery result beside the categories; stored with
  // the tool's classification and read by the runtime's gate on every call.
  toolEffectClasses: z.record(z.enum(STORED_EFFECT_CLASSES as [StoredEffectClass, ...StoredEffectClass[]])).optional(),
  toolClassificationVersions: z.record(z.number().int().nonnegative()).optional(),
  rawMcpTools: z.array(mcpToolDefinitionSchema).max(500).optional(),
  rawMcpResources: z.array(mcpResourceDefinitionSchema).max(500).optional(),
  capabilitySource: z.enum(['mcp_discovery', 'manual']).optional(),
  discoveryCorrelationId: z.string().uuid().optional(),
  tunnelRouteId: z.string().uuid().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(10000).optional(),
  collaborationMode: z.enum(['request_help', 'receive_delegated', 'two_way', 'observe_only']).optional(),
  allowedInternalAgentIds: z.array(z.string().uuid()).max(100).optional(),
  requestRules: z.array(internalAgentRequestRuleSchema).max(100).optional(),
  costAmount: z.number().min(0).nullable().optional(),
  costType: z.enum(['per_task', 'per_month']).nullable().optional(),
});

// GET /api/external-agents
externalAgentRouter.get('/', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const result = await externalAgentService.list(tenantId, {
      cursor: req.query.cursor as string,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      status: req.query.status as ExternalAgentStatus | undefined,
    });

    res.json(result);
  } catch (error) {
    log.error({ error }, 'Failed to list external agents');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/external-agents/:externalAgentId
externalAgentRouter.get('/:externalAgentId', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const agent = await externalAgentService.get(req.params.externalAgentId, tenantId);
    if (!agent) {
      return res.status(404).json({ error: 'External agent not found' });
    }

    res.json(agent);
  } catch (error) {
    log.error({ error }, 'Failed to get external agent');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/external-agents
externalAgentRouter.post('/', tenantAuthMiddleware('manageConnectors'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Idempotency-Key header required' });
    }

    const parseResult = createSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    // Validate auth credentials based on auth type
    const input = parseResult.data;

    // E1: this endpoint is dialled by the runtime on every delegation AND
    // polled by the health checker, so an unvalidated one is an SSRF primitive
    // that fires repeatedly. Guarding only the health check (as this originally
    // did) protects the observer and leaves the actor open.
    try {
      await assertPublicUrl(input.endpointUrl, { context: 'external-agents.create' });
    } catch (err) {
      if (err instanceof BlockedUrlError) {
        return res.status(400).json({ error: 'Endpoint URL is not reachable from the platform', reason: err.reason });
      }
      throw err;
    }
    if (input.authType === 'api_key' && !input.apiKey) {
      return res.status(400).json({ error: 'API key required for api_key auth type' });
    }
    if (input.authType === 'bearer_token' && !input.bearerToken) {
      return res.status(400).json({ error: 'Bearer token required for bearer_token auth type' });
    }
    if (input.authType === 'custom_headers' && (!input.customHeaders || input.customHeaders.length === 0)) {
      return res.status(400).json({ error: 'Custom headers required for custom_headers auth type' });
    }

    const agent = await externalAgentService.create(tenantId, input, idempotencyKey);
    logAudit('external_agent.added', auditCtx(req), {
      resourceType: 'external_agent',
      resourceId: agent.id,
      newState: pickExternalAgentAuditFields(agent),
    });
    // Separate audit row when an external agent is created WITH credentials
    // (api_key / bearer_token / custom_headers). The secret payload itself
    // is never included — only the auth shape — to match the plan's "skip
    // it from the payload entirely for clarity" guidance.
    if (input.authType && input.authType !== 'none') {
      logAudit('external_agent.credentials_stored', auditCtx(req), {
        resourceType: 'external_agent',
        resourceId: agent.id,
        newState: { authType: input.authType },
      });
    }
    res.status(201).json(agent);
  } catch (error) {
    const err = error as Error & { code?: string; detail?: string };
    log.error({
      error,
      errorMessage: err.message,
      errorStack: err.stack,
      errorCode: err.code,
      errorDetail: err.detail,
    }, 'Failed to create external agent');
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

// PUT /api/external-agents/:externalAgentId
externalAgentRouter.put('/:externalAgentId', tenantAuthMiddleware('manageConnectors'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const parseResult = updateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const prior = await externalAgentService.get(req.params.externalAgentId, tenantId);
    const agent = await externalAgentService.update(req.params.externalAgentId, tenantId, parseResult.data);
    if (!agent) {
      return res.status(404).json({ error: 'External agent not found' });
    }

    logAudit('external_agent.updated', auditCtx(req), {
      resourceType: 'external_agent',
      resourceId: req.params.externalAgentId,
      previousState: prior ? pickExternalAgentAuditFields(prior) : undefined,
      newState: pickExternalAgentAuditFields(agent),
    });

    res.json(agent);
  } catch (error) {
    log.error({ error }, 'Failed to update external agent');
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/external-agents/:externalAgentId/status
externalAgentRouter.patch('/:externalAgentId/status', tenantAuthMiddleware('manageConnectors'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const { status } = req.body;
    // Migration 228 dropped the 'error' enum value; the API still accepts it
    // for backward-compat with older clients but no producer should emit it.
    if (!['connected', 'disconnected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const prior = await externalAgentService.get(req.params.externalAgentId, tenantId);
    const agent = await externalAgentService.updateStatus(req.params.externalAgentId, tenantId, status);
    if (!agent) {
      return res.status(404).json({ error: 'External agent not found' });
    }

    logAudit('external_agent.status_changed', auditCtx(req), {
      resourceType: 'external_agent',
      resourceId: req.params.externalAgentId,
      previousState: { status: prior?.status ?? null },
      newState: { status: agent.status },
    });

    res.json(agent);
  } catch (error) {
    log.error({ error }, 'Failed to update external agent status');
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/external-agents/:externalAgentId
externalAgentRouter.delete('/:externalAgentId', tenantAuthMiddleware('manageConnectors'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const prior = await externalAgentService.get(req.params.externalAgentId, tenantId);
    const deleted = await externalAgentService.delete(req.params.externalAgentId, tenantId);
    if (!deleted) {
      return res.status(404).json({ error: 'External agent not found' });
    }

    logAudit('external_agent.removed', auditCtx(req), {
      resourceType: 'external_agent',
      resourceId: req.params.externalAgentId,
      previousState: prior ? pickExternalAgentRemovedFields(prior) : undefined,
    });

    res.status(204).send();
  } catch (error) {
    log.error({ error }, 'Failed to delete external agent');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/external-agents/:externalAgentId/versions
externalAgentRouter.get('/:externalAgentId/versions', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const versions = await externalAgentService.getVersions(req.params.externalAgentId, tenantId);
    res.json({ versions });
  } catch (error) {
    log.error({ error }, 'Failed to get external agent versions');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/external-agents/:externalAgentId/rollback
externalAgentRouter.post('/:externalAgentId/rollback', tenantAuthMiddleware('manageConnectors'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const { version } = req.body;
    if (typeof version !== 'number') {
      return res.status(400).json({ error: 'version required' });
    }

    const agent = await externalAgentService.rollback(req.params.externalAgentId, tenantId, version);
    if (!agent) {
      return res.status(404).json({ error: 'External agent or version not found' });
    }

    logAudit('external_agent.rollback', auditCtx(req), {
      resourceType: 'external_agent',
      resourceId: req.params.externalAgentId,
      newState: { rolledBackToVersion: version },
    });

    res.json(agent);
  } catch (error) {
    log.error({ error }, 'Failed to rollback external agent');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/external-agents/for-internal-agent
// Returns external agents that:
//   1. Internal agent selected as external_agent (in integrations with type='external_agent')
//   2. External agent allows this internal agent (internalAgentId in allowed_internal_agent_ids)
externalAgentRouter.get('/for-internal-agent', tenantAuthMiddleware('viewDashboard'), async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx!.tenantId!;
    const internalAgentId = req.query.internalAgentId as string;

    if (!internalAgentId) {
      return res.status(400).json({ error: 'internalAgentId is required' });
    }

    const agents = await externalAgentService.getForInternalAgent(tenantId, internalAgentId);
    res.json({ agents });
  } catch (error) {
    log.error({ error }, 'Failed to get external agents for internal agent');
    res.status(500).json({ error: (error as Error).message });
  }
});
