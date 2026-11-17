// Memory Router
// Per implementation plan: Phase 2.6 API Endpoints

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { memoryService } from './service';
import { log } from '../infrastructure/logging';
import { SaveMemoryOptions, RetrieveMemoryOptions } from './types';
import * as provenanceService from './provenance-service';
import { redactCredentials } from './redactor';
import {
  resolveRuntimeAgentId,
  resolveRuntimeAgentIdStrict,
} from '../agent-lifecycle/resolve-runtime-agent-id';
import { requireServiceAuth } from '../security/service-auth';

export const memoryRouter = Router();

// Every route here reads or writes tenant memories, and the only callers are
// control-plane services. Guard at the router so a new route cannot be added
// without it.
memoryRouter.use(requireServiceAuth());

/** `memories.scope_key` is NOT NULL, but a caller writing a tenant-wide memory
 *  has no natural key to supply. Group those under one stable key rather than
 *  inventing a per-request one, which would scatter shared memories across
 *  scopes that nothing can enumerate. Satisfies the column's
 *  `^[a-zA-Z0-9_-]+$` CHECK. */
const SHARED_SCOPE_KEY = 'shared';

// Validation schemas
const saveMemorySchema = z.object({
  layer: z.enum(['global', 'role', 'individual']),
  // Optional: defaults below to the agent for an individual memory and to
  // SHARED_SCOPE_KEY otherwise.
  scopeKey: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  content: z.string().min(1).max(102400),
  contentClassification: z.enum(['public', 'internal', 'pii', 'sensitive']).optional(),
  agentId: z.string().uuid().optional(),
  // Control-plane id space. Resolved to `agentId` below; the two are mutually
  // exclusive in practice because a caller knows only one of them.
  internalAgentId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  expiresAt: z.string().datetime().optional(),
  source: z.object({
    nodeType: z.enum(['connector_event', 'agent_action', 'system_event', 'hitl_event', 'chat_feedback', 'memory', 'instruction_amendment']),
    refId: z.string().min(1),
    connectorId: z.string().uuid().nullable().optional(),
    agentId: z.string().uuid().nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

const retrieveMemorySchema = z.object({
  query: z.string().min(1).max(10000),
  agentId: z.string().uuid().optional(),
  // Control-plane id space; resolved to `agentId` before the query runs.
  internalAgentId: z.string().uuid().optional(),
  // Conversation-layer memories are returned automatically when threadId
  // is supplied (see retrieveMemories in service.ts). Passing
  // 'conversation' here was previously accepted but silently stripped,
  // and a layers:['conversation'] request would devolve into "search
  // all layers" because buildMemoryFilters omits the WHERE clause on an
  // empty array. Drop from the enum to reject at validation time.
  layers: z.array(z.enum(['global', 'role', 'individual'])).optional(),
  scopeKeys: z.array(z.string().max(255)).optional(),
  topK: z.number().int().min(1).max(100).optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().max(100)).optional(),
  invocationId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
});

// GET /api/memory
// List memories with pagination
memoryRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const layer = req.query.layer as string | undefined;
    const scopeKey = req.query.scopeKey as string | undefined;
    const cursor = req.query.cursor as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    const result = await memoryService.listMemories(tenantId, {
      layer: layer as 'global' | 'role' | 'individual' | undefined,
      scopeKey,
      cursor,
      limit,
    });

    res.json({
      memories: result.memories,
      nextCursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    });
  } catch (error) {
    log.error({ error }, 'Failed to list memories');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/memory
// Save new memory
memoryRouter.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    // Validate input
    const parseResult = saveMemorySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    // `memories.agent_id` is FK'd to the runtime's agents(id). A caller in the
    // control plane knows only internal_agents.id, and the two are disjoint
    // (INV-TR-010). Translate, and refuse when no mapping exists rather than
    // letting the FK reject it as an opaque 500.
    let agentId = parseResult.data.agentId;
    if (parseResult.data.internalAgentId) {
      const resolved = await resolveRuntimeAgentIdStrict(
        tenantId,
        parseResult.data.internalAgentId,
        'memoryRouter.saveMemory',
      );
      if (!resolved) {
        return res.status(409).json({ error: 'agent_not_provisioned' });
      }
      agentId = resolved;
    }

    // An individual-layer memory is retrieved by `agent_id`, so its scope key
    // is the agent by default. A role-layer memory is retrieved by the role,
    // so its key is the agent's role when an agent is supplied, and must be
    // given explicitly otherwise. Global falls back to the shared key.
    const scopeKey = parseResult.data.scopeKey
      ?? (parseResult.data.layer === 'individual'
        ? agentId
        : parseResult.data.layer === 'role'
          ? (agentId ? await memoryService.resolveRoleScopeKey(tenantId, agentId) : undefined)
          : SHARED_SCOPE_KEY);
    if (!scopeKey) {
      return res.status(400).json({
        error: parseResult.data.layer === 'role'
          ? 'scopeKey (the role) is required for a role memory when no agent with a recorded role is supplied'
          : 'scopeKey is required for an individual memory when no agent is supplied',
      });
    }

    const { memoryId } = await memoryService.saveMemory({
      tenantId,
      layer: parseResult.data.layer,
      scopeKey,
      content: parseResult.data.content,
      contentClassification: parseResult.data.contentClassification,
      agentId,
      workflowId: parseResult.data.workflowId,
      tags: parseResult.data.tags,
      expiresAt: parseResult.data.expiresAt ? new Date(parseResult.data.expiresAt) : undefined,
      source: parseResult.data.source,
    } as SaveMemoryOptions);

    res.status(201).json({ id: memoryId });
  } catch (error) {
    const message = (error as Error).message;

    if (message.includes('Content exceeds') || message.includes('Scope key')) {
      return res.status(400).json({ error: message });
    }

    log.error({ error }, 'Failed to save memory');
    res.status(500).json({ error: message });
  }
});

// GET /api/memory/:id/provenance
memoryRouter.get('/:id/provenance', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'Tenant ID required' });

    const parsed = z.object({
      depth: z.coerce.number().int().min(1).max(20).default(10),
    }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

    const chain = await provenanceService.getProvenanceChain(tenantId, req.params.id, parsed.data.depth);
    res.json({ memoryId: req.params.id, maxDepth: parsed.data.depth, ...chain });
  } catch (error) {
    log.error({ error }, 'Failed to get provenance chain');
    res.status(500).json({ error: (error as Error).message });
  }
});

// POST /api/memory/retrieve
// Retrieve memories with semantic search
memoryRouter.post('/retrieve', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    // Validate input
    const parseResult = retrieveMemorySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    // Read path, so the lenient resolver: an agent that is not provisioned yet
    // has nothing to return, and the caller sees an empty list that fills in
    // once provisioning completes (INV-TR-010).
    const agentId = parseResult.data.internalAgentId
      ? await resolveRuntimeAgentId(
          tenantId,
          parseResult.data.internalAgentId,
          'memoryRouter.retrieveMemories',
        )
      : parseResult.data.agentId;

    const memories = await memoryService.retrieveMemories({
      tenantId,
      query: parseResult.data.query,
      agentId,
      layers: parseResult.data.layers,
      scopeKeys: parseResult.data.scopeKeys,
      topK: parseResult.data.topK,
      minSimilarity: parseResult.data.minSimilarity,
      tags: parseResult.data.tags,
      // contextTags forwarded for re-ranker tag-boost scoring
      contextTags: (req.body as { contextTags?: string[] }).contextTags,
      invocationId: parseResult.data.invocationId,
      threadId: parseResult.data.threadId,
    } as RetrieveMemoryOptions);

    res.json({ memories });
  } catch (error) {
    log.error({ error }, 'Failed to retrieve memories');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/memory/:id
// Get a specific memory
memoryRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const memory = await memoryService.getMemory(id, tenantId);

    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    // WS-8.4 Layer 4 — view-time re-redaction defends against L1 regressions.
    if (memory && typeof (memory as { content?: unknown }).content === 'string') {
      const { redacted } = redactCredentials((memory as { content: string }).content);
      (memory as { content: string }).content = redacted;
    }

    res.json(memory);
  } catch (error) {
    log.error({ error }, 'Failed to get memory');
    res.status(500).json({ error: (error as Error).message });
  }
});

// DELETE /api/memory/:id
// Soft delete (set expires_at = NOW())
memoryRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const deleted = await memoryService.deleteMemory(id, tenantId);

    if (!deleted) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    res.status(204).send();
  } catch (error) {
    log.error({ error }, 'Failed to delete memory');
    res.status(500).json({ error: (error as Error).message });
  }
});

// PATCH /api/memory/:id
// Update content of a memory
memoryRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { id } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const parsed = z.object({ content: z.string().min(1).max(102400) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'content is required and must be a non-empty string (max 100KB)' });
    }

    const updated = await memoryService.updateMemoryContent(id, tenantId, parsed.data.content);

    if (!updated) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    res.json(updated);
  } catch (error) {
    log.error({ error }, 'Failed to update memory');
    res.status(500).json({ error: (error as Error).message });
  }
});
