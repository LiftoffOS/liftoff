// Interactive Chat — Tool Proxy Router
//
// Exposes agent memory and feedback as HTTP endpoints callable by
// the platform backend. Memory retrieval/save and feedback processing
// are used by the platform backend's LLM conversation loop for
// interactive chat.
//
// Auth: OIDC identity token + X-Service-Auth header (same pattern as
// existing cross-service endpoints called by TenantRuntimeClient).
//
// Part of Phase 1 of the Interactive Mode implementation plan.
//
// Note: GET /:agentId/tools and POST /:agentId/tool-call were removed
// in Phase 4 cleanup — those legacy LLM loop proxy endpoints are no
// longer called by the Platform Backend.

import { randomUUID } from 'crypto';
import { normalizeMemoryScope } from '../memory/scope';
import { Router, Request, Response } from 'express';
import { requireServiceAuth } from '../security/service-auth';
import { memoryService } from '../memory/service';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { resolveRuntimeAgentId, resolveRuntimeAgentIdStrict } from '../agent-lifecycle/resolve-runtime-agent-id';

const router = Router();

// Service auth — uses the centralised requireServiceAuth() middleware from
// security/service-auth.ts so this router is visible to the boot-time
// route-annotation scan. All routes in this router inherit auth via the
// router-level use() call below.
router.use(requireServiceAuth());

/**
 * The tenant for this request, from whichever place the caller put it.
 *
 * Every platform-backend call already carries the tenant as `x-tenant-id`
 * (`buildRuntimeHeaders`), which the app-level middleware turns into
 * `req.ctx.tenantId`. The GET / DELETE / PATCH routes below always read that
 * fallback; the three POST routes did not, and read the body alone.
 *
 * Nothing made that split deliberate, and it breaks two features outright.
 * `retrieveAgentMemories` posts `{query, topK}` and `saveAgentMemory` posts
 * `{layer, content, tags}` — neither sends `tenantId` — so a body-only read
 * answers 400 on every call, naming a body field the caller does not know to
 * send. The client's breaker falls back to `[]`, so interactive chat and
 * distillation run with NO memory context and log only a WARN. Reading one field two ways in one file is what
 * hid it, so read it one way, in one place.
 */
function tenantIdFor(req: Request): string | undefined {
  return (req.body?.tenantId as string)
    || (req.query?.tenantId as string)
    || req.ctx?.tenantId;
}

// ============================================================================
// POST /api/interactive-chat/:agentId/memory-retrieve
// Retrieves memories relevant to the interactive chat context.
// ============================================================================

router.post('/:agentId/memory-retrieve', async (req: Request, res: Response) => {
  const { agentId } = req.params;
  const { query, topK, tags, invocationId } = req.body;
  const tenantId = tenantIdFor(req);

  if (!tenantId || !query) {
    return res.status(400).json({ error: 'Missing tenantId or query' });
  }

  try {
    // PB addresses agents by internal_agent_id; runtime tables are keyed by
    // the runtime agent_id. Translate before touching memory storage.
    const runtimeAgentId = await resolveRuntimeAgentId(tenantId, agentId, 'tool-proxy-router:memory-retrieve');
    const memoryScope = await loadAgentMemoryScope(tenantId, runtimeAgentId);
    const explicitLayers = memoryScope.readableLayers && memoryScope.readableLayers.length > 0
      ? memoryScope.readableLayers as any[]
      : undefined;

    const memories = await memoryService.retrieveMemories({
      query,
      tenantId,
      agentId: runtimeAgentId,
      topK: topK || 10,
      layers: explicitLayers,
      scopeKeys: memoryScope.scopeKeys,
      tags,
      invocationId,
    });

    return res.json({ memories });
  } catch (error) {
    logger.error({
      event: 'interactive_chat_memory_retrieve_error',
      tenantId,
      agentId,
      error: (error as Error).message,
    });
    return res.status(500).json({ error: 'Memory retrieval failed' });
  }
});

// ============================================================================
// POST /api/interactive-chat/:agentId/memory-save
// Saves a memory from the interactive chat session.
// ============================================================================

router.post('/:agentId/memory-save', async (req: Request, res: Response) => {
  const { agentId } = req.params;
  const { layer, content, tags, scopeKey, contentClassification, expiresAt } = req.body;
  const tenantId = tenantIdFor(req);

  if (!tenantId || !content) {
    return res.status(400).json({ error: 'Missing tenantId or content' });
  }

  try {
    // PB addresses agents by internal_agent_id; runtime tables are keyed by
    // the runtime agent_id. Translate before touching memory storage.
    const runtimeAgentId = await resolveRuntimeAgentId(tenantId, agentId, 'tool-proxy-router:memory-save');
    const memoryScope = await loadAgentMemoryScope(tenantId, runtimeAgentId);
    const targetLayer = layer || 'individual';

    // Validate writable layer access
    const writableLayers = memoryScope.writableLayers || ['individual'];
    if (!writableLayers.includes(targetLayer)) {
      return res.status(403).json({ error: `Agent cannot write to layer: ${targetLayer}` });
    }

    const result = await memoryService.saveMemory({
      tenantId,
      agentId: runtimeAgentId,
      layer: targetLayer,
      scopeKey: scopeKey || `chat-${runtimeAgentId}`,
      content,
      tags: tags || [],
      contentClassification: contentClassification || 'internal',
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      source: {
        nodeType: 'agent_action' as const,
        refId: (req.body.invocationId as string) ?? (req.body.threadId as string) ?? randomUUID(),
        agentId: runtimeAgentId,
        metadata: {
          threadId: (req.body.threadId as string) ?? null,
          invocationId: (req.body.invocationId as string) ?? null,
          origin: 'chat-memory-save',
        },
      },
    });

    return res.json({ memoryId: result.memoryId, deduplicated: result.deduplicated });
  } catch (error) {
    logger.error({
      event: 'interactive_chat_memory_save_error',
      tenantId,
      agentId,
      error: (error as Error).message,
    });
    return res.status(500).json({ error: 'Memory save failed' });
  }
});

// ============================================================================
// POST /api/interactive-chat/:agentId/feedback
// Processes an explicit feedback signal from a chat session.
// Saves immediate memory + queues for async extraction.
// ============================================================================

router.post('/:agentId/feedback', async (req: Request, res: Response) => {
  const { agentId } = req.params;
  const { threadId, messageId, feedbackType, content, userId } = req.body;
  const tenantId = tenantIdFor(req);

  if (!tenantId || !feedbackType || !content) {
    return res.status(400).json({ error: 'Missing required feedback fields' });
  }

  const validTypes = ['correction', 'positive', 'preference'];
  if (!validTypes.includes(feedbackType)) {
    return res.status(400).json({ error: `Invalid feedbackType: ${feedbackType}` });
  }

  try {
    // PB addresses agents by internal_agent_id; runtime tables are keyed by
    // the runtime agent_id. Translate before touching memory storage.
    //
    // STRICT (INV-TR-010): this handler writes chat_feedback_queue, which has
    // no FK to agents(id). Falling back to the internal id here would persist a
    // control-plane id into a runtime-keyed column — invisible to the
    // chat-feedback-extractor and to every reader, permanently, even once the
    // mapping appears. Refuse instead; the agent is mid-provisioning and the
    // client can retry.
    const runtimeAgentId = await resolveRuntimeAgentIdStrict(
      tenantId, agentId, 'tool-proxy-router:feedback',
    );
    if (!runtimeAgentId) {
      return res.status(409).json({ error: 'agent_not_provisioned' });
    }

    // Map feedback type to memory type tags for proper retrieval scoring
    const typeTags: Record<string, string> = {
      correction: 'type:gotcha',     // 1.3× boost
      preference: 'type:preference', // 1.2× boost
      positive: 'type:convention',   // 1.1× boost
    };

    // 1. Check for contradictions — if an existing memory with high similarity
    //    exists for this agent's chat feedback, supersede it rather than
    //    creating a duplicate. This handles cases like "I prefer formal tone"
    //    followed later by "I prefer casual tone".
    const existingMemories = await memoryService.retrieveMemories({
      query: content,
      tenantId,
      agentId: runtimeAgentId,
      topK: 1,
      layers: ['individual'],
      scopeKeys: [`chat-feedback-${runtimeAgentId}`],
      tags: ['chat-feedback'],
    });

    let memoryResult: { memoryId: string; deduplicated: boolean };
    const topMatch = existingMemories[0];

    if (topMatch && topMatch.similarity != null && topMatch.similarity > 0.8) {
      // High similarity found — supersede the old memory with the new feedback
      try {
        const newMemoryId = await memoryService.supersedeMemory(
          { memoryId: topMatch.id, newContent: content, reason: `Superseded by newer chat feedback: ${feedbackType}` },
          tenantId,
        );
        memoryResult = { memoryId: newMemoryId, deduplicated: false };
      } catch {
        // Fallback to regular save if supersession fails
        memoryResult = await memoryService.saveMemory({
          tenantId,
          agentId: runtimeAgentId,
          layer: 'individual',
          scopeKey: `chat-feedback-${runtimeAgentId}`,
          content,
          tags: [typeTags[feedbackType], 'chat-feedback', feedbackType],
          contentClassification: 'internal',
          source: {
            nodeType: 'chat_feedback' as const,
            refId: messageId ?? threadId ?? randomUUID(),
            agentId: runtimeAgentId,
            metadata: {
              feedbackType,
              threadId: threadId ?? null,
              userId: userId ?? null,
            },
          },
        });
      }
    } else {
      // No contradiction — save as new memory
      memoryResult = await memoryService.saveMemory({
        tenantId,
        agentId: runtimeAgentId,
        layer: 'individual',
        scopeKey: `chat-feedback-${runtimeAgentId}`,
        content,
        tags: [typeTags[feedbackType], 'chat-feedback', feedbackType],
        contentClassification: 'internal',
        source: {
          nodeType: 'chat_feedback' as const,
          refId: messageId ?? threadId ?? randomUUID(),
          agentId: runtimeAgentId,
          metadata: {
            feedbackType,
            threadId: threadId ?? null,
            userId: userId ?? null,
          },
        },
      });
    }

    // 2. Queue for async extraction. Store the runtime agent_id — the
    // chat-feedback-extractor consumes this column verbatim to key the
    // memories it saves, so it must match the runtime-keyed memory store.
    const pool = getPoolForService('scheduled-execution');
    await pool.query(
      `INSERT INTO chat_feedback_queue (tenant_id, agent_id, thread_id, message_id, feedback_type, content, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, runtimeAgentId, threadId || '', messageId || '', feedbackType, content, userId || ''],
    );

    logger.info({
      event: 'interactive_chat_feedback_saved',
      tenantId,
      agentId,
      feedbackType,
      memoryId: memoryResult.memoryId,
      deduplicated: memoryResult.deduplicated,
    });

    return res.json({
      memoryId: memoryResult.memoryId,
      queued: true,
      deduplicated: memoryResult.deduplicated,
    });
  } catch (error) {
    logger.error({
      event: 'interactive_chat_feedback_error',
      tenantId,
      agentId,
      error: (error as Error).message,
    });
    return res.status(500).json({ error: 'Feedback processing failed' });
  }
});

// ============================================================================
// GET /api/interactive-chat/:agentId/memories
// List runtime memories for an agent (user-facing CRUD API).
// Supports ?limit, ?cursor, ?search query params.
// ============================================================================

router.get('/:agentId/memories', async (req: Request, res: Response) => {
  const { agentId } = req.params;
  const tenantId = tenantIdFor(req);
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  const cursor = req.query.cursor as string | undefined;
  const search = req.query.search as string | undefined;

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenantId' });
  }

  try {
    // PB addresses agents by internal_agent_id; memories.agent_id is keyed by
    // the runtime agent_id. Translate before querying, otherwise every agent's
    // list comes back empty ("No learned context yet") even though memories
    // exist under the runtime id.
    const runtimeAgentId = await resolveRuntimeAgentId(tenantId, agentId, 'tool-proxy-router:memories-list');

    if (search) {
      const memoryScope = await loadAgentMemoryScope(tenantId, runtimeAgentId);
      const memories = await memoryService.retrieveMemories({
        query: search,
        tenantId,
        agentId: runtimeAgentId,
        topK: limit ?? 20,
        layers: memoryScope.readableLayers as any[],
        scopeKeys: memoryScope.scopeKeys,
      });
      return res.json({
        memories: memories.map(m => ({
          id: m.id,
          content: m.content,
          source: m.source ?? 'semantic',
          createdAt: m.createdAt,
        })),
        nextCursor: null,
        total: memories.length,
      });
    }

    const result = await memoryService.listMemories(tenantId, { agentId: runtimeAgentId, limit, cursor });
    return res.json({
      memories: result.memories.map(m => ({
        id: m.id,
        content: m.content,
        source: m.tags?.find(t => t.startsWith('type:'))?.replace('type:', '') ?? 'learned',
        createdAt: m.createdAt,
        usefulnessScore: m.usefulnessScore,
        lastUsedAt: m.lastUsedAt,
        // The memories this one contradicts, as the admission check tagged
        // them (memory/memory-admit.ts): both rows are kept and nothing is
        // resolved automatically. Data the page may render later.
        contradicts: (m.tags ?? []).filter(t => t.startsWith('contradicts:')).map(t => t.slice('contradicts:'.length)),
      })),
      nextCursor: result.nextCursor,
      total: result.total,
    });
  } catch (error) {
    logger.error({ event: 'list_agent_memories_error', tenantId, agentId, error: (error as Error).message });
    return res.status(500).json({ error: 'Failed to list memories' });
  }
});

// ============================================================================
// DELETE /api/interactive-chat/:agentId/memories/:memoryId
// Soft-delete a single runtime memory (sets expires_at = NOW()).
// ============================================================================

router.delete('/:agentId/memories/:memoryId', async (req: Request, res: Response) => {
  const { agentId, memoryId } = req.params;
  const tenantId = tenantIdFor(req);

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenantId' });
  }

  try {
    const deleted = await memoryService.deleteMemory(memoryId, tenantId);
    if (!deleted) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    logger.info({ event: 'delete_agent_memory', tenantId, agentId, memoryId });
    return res.status(204).send();
  } catch (error) {
    logger.error({ event: 'delete_agent_memory_error', tenantId, agentId, memoryId, error: (error as Error).message });
    return res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// ============================================================================
// PATCH /api/interactive-chat/:agentId/memories/:memoryId
// Update the content of a single runtime memory in-place.
// Re-encrypts, recomputes hash and embedding on write.
// ============================================================================

router.patch('/:agentId/memories/:memoryId', async (req: Request, res: Response) => {
  const { agentId, memoryId } = req.params;
  const tenantId = tenantIdFor(req);
  const { content } = req.body as { content?: string };

  if (!tenantId) {
    return res.status(400).json({ error: 'Missing tenantId' });
  }
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'content is required' });
  }

  try {
    const updated = await memoryService.updateMemoryContent(memoryId, tenantId, content);
    if (!updated) {
      return res.status(404).json({ error: 'Memory not found' });
    }
    logger.info({ event: 'update_agent_memory', tenantId, agentId, memoryId });
    return res.json({ id: updated.id, content: updated.content, updatedAt: updated.updatedAt });
  } catch (error) {
    logger.error({ event: 'update_agent_memory_error', tenantId, agentId, memoryId, error: (error as Error).message });
    return res.status(500).json({ error: 'Failed to update memory' });
  }
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load the agent's memory scope from the agents table.
 * Determines which memory layers the agent can read/write.
 */
async function loadAgentMemoryScope(
  tenantId: string,
  runtimeAgentId: string,
): Promise<{ readableLayers?: string[]; writableLayers?: string[]; scopeKeys?: string[] }> {
  const pool = getPoolForService('scheduled-execution');

  // Callers pass the already-resolved runtime agent_id (see
  // resolveRuntimeAgentId). agents.id is keyed by the runtime id.
  const result = await pool.query(
    'SELECT memory_scope FROM agents WHERE id = $1 AND tenant_id = $2',
    [runtimeAgentId, tenantId],
  );

  if (result.rows.length === 0) {
    // Default scope if agent not found (shouldn't happen in normal flow)
    return { readableLayers: ['individual'], writableLayers: ['individual'] };
  }

  // See memory/scope.ts — the column has held two spellings and the handlers
  // read only one of them.
  return normalizeMemoryScope(result.rows[0].memory_scope);
}

export { router as interactiveChatRouter };
