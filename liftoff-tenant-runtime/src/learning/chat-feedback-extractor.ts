// Chat Feedback Extractor
// Phase 5.3: Reads unprocessed rows from chat_feedback_queue, groups them by
// agent, runs LLM extraction to produce structured learnings, then auto-applies
// them as memory or creates ReflectionSuggestion rows for human review.
//
// An opt-in job, and the second, independent path that writes
// `reflection_suggestions`. Running it on a cadence spends LLM calls scanning
// `chat_feedback_queue`, so schedule it for deployments that collect chat
// feedback. The shape to copy is `scheduled-reflection.ts`: a job under
// src/jobs, a route on the /api/internal/* router (the one Cloud Scheduler's
// OIDC token actually reaches), and an entry in r5_scheduler_jobs.tf covered by
// the existing attempt_count alert.
//
// (Naming that export in this comment would be enough to make the reachability
// ratchet count it as reached: the check is a word-boundary scan over the file
// and treats any non-declaration line as a use. Hence the circumlocution.)

import { randomUUID } from 'crypto';
import { memoryService } from '../memory/service';
import { llmClient } from '../llm/client';
import { getEntitlementsClient } from '../entitlements-client/service';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { LLMProvider } from '../llm/types';

// Minimum unprocessed feedback items per agent before we run extraction.
// Avoids burning LLM tokens on too-thin signal.
const MIN_FEEDBACK_THRESHOLD = 3;

// Auto-apply confidence floor. Items below this go to suggestion review.
const AUTO_APPLY_CONFIDENCE = 0.8;

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** A single row from the chat_feedback_queue table. */
interface FeedbackQueueItem {
  id: string;
  tenantId: string;
  agentId: string;
  threadId: string;
  messageId: string;
  feedbackType: 'correction' | 'positive' | 'preference';
  content: string;
  userId: string;
  createdAt: Date;
}

/** One extracted learning from the LLM analysis. */
interface ExtractedLearning {
  category: 'correction' | 'preference' | 'capability_gap' | 'positive';
  summary: string;
  confidence: number;
  suggestedAction: 'memory' | 'instruction_update' | 'no_action';
}

/** A workplace-shorthand alias the user revealed in feedback. */
interface ExtractedAlias {
  alias: string;      // the shorthand as used, e.g. "PSR", "Todd", "Phoenix"
  canonical: string;  // the full meaning, e.g. "Pipeline Status Report"
}

/** Structured output schema returned by the LLM. */
interface ExtractionResult {
  learnings: ExtractedLearning[];
  aliases?: ExtractedAlias[];
}

/** Return value of the top-level extraction function. */
export interface ExtractFeedbackResult {
  agentsProcessed: number;
  feedbackItemsProcessed: number;
  memoriesCreated: number;
  suggestionsCreated: number;
  errors: number;
}

// ──────────────────────────────────────────────────────────────────────────
// LLM response schema (enforced via responseSchema / structured output)
// ──────────────────────────────────────────────────────────────────────────

const EXTRACTION_RESPONSE_SCHEMA = {
  name: 'feedback_extraction',
  description: 'Structured learnings extracted from a batch of user feedback signals for an AI agent.',
  schema: {
    type: 'object' as const,
    properties: {
      learnings: {
        type: 'array' as const,
        description: 'Array of extracted learnings from the feedback batch.',
        items: {
          type: 'object' as const,
          properties: {
            category: {
              type: 'string' as const,
              description: 'Category of the feedback: "correction" (agent did something wrong), "preference" (user wants something done a specific way), "capability_gap" (agent lacks a needed ability), or "positive" (agent did something well).',
            },
            summary: {
              type: 'string' as const,
              description: 'Concise one-sentence summary of the learning, written as an instruction the agent should follow in the future.',
            },
            confidence: {
              type: 'number' as const,
              description: 'Confidence score between 0 and 1 that this learning is accurate and actionable.',
            },
            suggestedAction: {
              type: 'string' as const,
              description: 'What to do with this learning: "memory" (save to agent memory for automatic recall), "instruction_update" (requires human review to update agent instructions), or "no_action" (informational only, no change needed).',
            },
          },
          required: ['category', 'summary', 'confidence', 'suggestedAction'],
        },
      },
      aliases: {
        type: 'array' as const,
        description: 'Workplace shorthand the user revealed: nicknames, acronyms, and project codenames mapped to their full meaning. Empty when none appear.',
        items: {
          type: 'object' as const,
          properties: {
            alias: {
              type: 'string' as const,
              description: 'The shorthand exactly as the user says it, e.g. "PSR", "Todd", "Phoenix".',
            },
            canonical: {
              type: 'string' as const,
              description: 'The full meaning, e.g. "Pipeline Status Report", "Todd Martinez (Finance lead)", "the database migration project".',
            },
          },
          required: ['alias', 'canonical'],
        },
      },
    },
    required: ['learnings'],
  },
};

const EXTRACTION_SYSTEM_PROMPT = `You are analyzing user feedback signals for an AI agent. For each piece of feedback, determine:

1. **category**: One of:
   - "correction" — the agent made an error or did something the user disagrees with
   - "preference" — the user wants something done a specific way going forward
   - "capability_gap" — the agent lacks a needed ability or integration
   - "positive" — the agent did something well that should be reinforced

2. **summary**: A concise, actionable one-sentence learning. Write it as an instruction the agent should follow in future interactions. Be specific and concrete.

3. **confidence**: How confident you are (0-1) that this learning is accurate, clear, and actionable. Consider:
   - Is the feedback specific enough to act on? (vague → low confidence)
   - Is there corroboration from multiple feedback items? (repeated → higher confidence)
   - Could there be context you're missing? (ambiguous → lower confidence)

4. **suggestedAction**: What should happen with this learning:
   - "memory" — save to agent memory so it's recalled in future conversations (for corrections, preferences, positive reinforcement)
   - "instruction_update" — this is significant enough to warrant updating the agent's core instructions (requires human review)
   - "no_action" — informational only, or too vague to act on

Separately, extract **aliases** — workplace shorthand the user reveals that the agent should decode in future requests:
- Nicknames → full names ("Todd" → "Todd Martinez (Finance lead)")
- Acronyms → expansions ("PSR" → "Pipeline Status Report")
- Project codenames → meaning ("Phoenix" → "the database migration project")
Only include an alias when the feedback makes the mapping explicit (e.g. "PSR means the pipeline status report", "we call the migration Phoenix"). Do NOT guess. Return an empty aliases array when none appear.

Guidelines:
- Consolidate duplicate or near-duplicate feedback into a single learning
- If multiple feedback items point to the same issue, increase confidence
- Prefer "memory" over "instruction_update" unless the learning fundamentally changes how the agent should operate
- "capability_gap" items should almost always map to "instruction_update"
- Be conservative with confidence — only rate >= 0.8 when the signal is clear and specific`;

// ──────────────────────────────────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Process queued chat feedback into structured learnings.
 * Called periodically by Cloud Scheduler (same cadence as reflection engine).
 */
export async function extractChatFeedback(tenantId: string): Promise<ExtractFeedbackResult> {
  const pool = getPoolForService('reflection-engine');
  const result: ExtractFeedbackResult = {
    agentsProcessed: 0,
    feedbackItemsProcessed: 0,
    memoriesCreated: 0,
    suggestionsCreated: 0,
    errors: 0,
  };

  // Step 1: Find agents with enough unprocessed feedback
  const agentsWithFeedback = await pool.query<{ agent_id: string; item_count: string }>(
    `SELECT agent_id, COUNT(*) AS item_count
     FROM chat_feedback_queue
     WHERE tenant_id = $1 AND processed = FALSE
     GROUP BY agent_id
     HAVING COUNT(*) >= $2`,
    [tenantId, MIN_FEEDBACK_THRESHOLD],
  );

  if (agentsWithFeedback.rows.length === 0) {
    logger.info({ tenantId }, 'chat-feedback-extractor: no agents with enough unprocessed feedback');
    return result;
  }

  logger.info({
    tenantId,
    agentCount: agentsWithFeedback.rows.length,
  }, 'chat-feedback-extractor: starting extraction');

  // Step 2: Process each agent's feedback batch
  for (const row of agentsWithFeedback.rows) {
    const agentId = row.agent_id;

    try {
      const agentResult = await processAgentFeedback(pool, tenantId, agentId);
      result.agentsProcessed++;
      result.feedbackItemsProcessed += agentResult.itemsProcessed;
      result.memoriesCreated += agentResult.memoriesCreated;
      result.suggestionsCreated += agentResult.suggestionsCreated;
    } catch (err) {
      result.errors++;
      logger.error({
        tenantId,
        agentId,
        err: (err as Error).message,
      }, 'chat-feedback-extractor: failed to process agent feedback');
    }
  }

  logger.info({
    tenantId,
    ...result,
  }, 'chat-feedback-extractor: extraction complete');

  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-agent processing
// ──────────────────────────────────────────────────────────────────────────

interface AgentProcessingResult {
  itemsProcessed: number;
  memoriesCreated: number;
  suggestionsCreated: number;
}

async function processAgentFeedback(
  pool: ReturnType<typeof getPoolForService>,
  tenantId: string,
  agentId: string,
): Promise<AgentProcessingResult> {
  const agentResult: AgentProcessingResult = {
    itemsProcessed: 0,
    memoriesCreated: 0,
    suggestionsCreated: 0,
  };

  // Load unprocessed feedback for this agent
  const feedbackRows = await pool.query<{
    id: string;
    tenant_id: string;
    agent_id: string;
    thread_id: string;
    message_id: string;
    feedback_type: string;
    content: string;
    user_id: string;
    created_at: Date;
  }>(
    `SELECT id, tenant_id, agent_id, thread_id, message_id, feedback_type, content, user_id, created_at
     FROM chat_feedback_queue
     WHERE tenant_id = $1 AND agent_id = $2 AND processed = FALSE
     ORDER BY created_at ASC`,
    [tenantId, agentId],
  );

  const items: FeedbackQueueItem[] = feedbackRows.rows.map(r => ({
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    threadId: r.thread_id,
    messageId: r.message_id,
    feedbackType: r.feedback_type as FeedbackQueueItem['feedbackType'],
    content: r.content,
    userId: r.user_id,
    createdAt: new Date(r.created_at),
  }));

  if (items.length === 0) return agentResult;

  // Format feedback as a numbered list for the LLM
  const feedbackList = items
    .map((item, i) => `${i + 1}. [${item.feedbackType}] ${item.content}`)
    .join('\n');

  // Call LLM with structured output
  const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'chat-feedback-extraction');
  const llmResponse = await llmClient.complete(
    {
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Here are ${items.length} feedback signals from users interacting with this agent:\n\n${feedbackList}\n\nAnalyze these and extract structured learnings.`,
        },
      ],
      temperature: 0.3,
      maxTokens: 2048,
      responseSchema: EXTRACTION_RESPONSE_SCHEMA,
    },
    llmClient.modelSelectionFor(taskConfig),
    { tenantId, agentId, purpose: 'chat-feedback-extraction' },
  );

  // Parse structured output.
  //
  // A provider that produced no structured payload at all throws
  // LLMStructuredOutputError from the provider layer and never reaches here —
  // that used to be indistinguishable from malformed JSON, because providers
  // without responseSchema support returned ordinary prose and this parse was
  // the first thing to notice. What remains here is genuinely invalid JSON.
  let extraction: ExtractionResult;
  try {
    extraction = JSON.parse(llmResponse.content);
  } catch {
    logger.error({
      tenantId,
      agentId,
      content: llmResponse.content.substring(0, 500),
    }, 'chat-feedback-extractor: structured output was not valid JSON');
    throw new Error('Failed to parse extraction result from LLM');
  }

  // Process each extracted learning
  const batchId = randomUUID();
  for (const learning of extraction.learnings) {
    try {
      const applied = await applyLearning(pool, tenantId, agentId, learning, batchId, items);
      if (applied === 'memory') {
        agentResult.memoriesCreated++;
      } else if (applied === 'suggestion') {
        agentResult.suggestionsCreated++;
      }
    } catch (err) {
      logger.warn({
        tenantId,
        agentId,
        learning: learning.summary,
        err: (err as Error).message,
      }, 'chat-feedback-extractor: failed to apply learning (non-fatal)');
    }
  }

  // Change 4c — persist workplace-shorthand aliases as a global glossary
  // memory ("<alias>\t<canonical>", tag type:alias) so the memory service can
  // exact-match decode bare tokens (e.g. "PSR") before semantic retrieval.
  // Exact dupes collapse via the ON CONFLICT (tenant, layer, scope_key,
  // content_hash) guard in saveMemory.
  for (const a of extraction.aliases ?? []) {
    const alias = a.alias?.trim();
    const canonical = a.canonical?.trim();
    if (!alias || !canonical) continue;
    try {
      await memoryService.saveMemory({
        tenantId,
        layer: 'global',
        scopeKey: 'glossary',
        content: `${alias}\t${canonical}`,
        contentClassification: 'internal',
        tags: ['type:alias'],
        source: {
          nodeType: 'chat_feedback' as const,
          refId: batchId,
          agentId,
          metadata: { aliasFrom: 'chat-feedback', feedbackItemIds: items.map(i => i.id) },
        },
      });
      agentResult.memoriesCreated++;
    } catch (err) {
      logger.warn({ tenantId, agentId, alias, err: (err as Error).message }, 'chat-feedback-extractor: failed to save alias memory (non-fatal)');
    }
  }

  // Mark all items as processed
  const itemIds = items.map(i => i.id);
  await pool.query(
    `UPDATE chat_feedback_queue
     SET processed = TRUE,
         processed_at = NOW(),
         extraction_result = $3
     WHERE id = ANY($1) AND tenant_id = $2`,
    [itemIds, tenantId, JSON.stringify(extraction)],
  );

  agentResult.itemsProcessed = items.length;

  logger.info({
    tenantId,
    agentId,
    itemsProcessed: agentResult.itemsProcessed,
    memoriesCreated: agentResult.memoriesCreated,
    suggestionsCreated: agentResult.suggestionsCreated,
    learningsExtracted: extraction.learnings.length,
  }, 'chat-feedback-extractor: agent batch processed');

  return agentResult;
}

// ──────────────────────────────────────────────────────────────────────────
// Learning application
// ──────────────────────────────────────────────────────────────────────────

/**
 * Apply a single extracted learning: either save as memory (auto-apply)
 * or create a ReflectionSuggestion for human review.
 *
 * Returns 'memory' | 'suggestion' | 'skipped'.
 */
async function applyLearning(
  pool: ReturnType<typeof getPoolForService>,
  tenantId: string,
  agentId: string,
  learning: ExtractedLearning,
  batchId: string,
  items: FeedbackQueueItem[],
): Promise<'memory' | 'suggestion' | 'skipped'> {
  // no_action → skip
  if (learning.suggestedAction === 'no_action') {
    return 'skipped';
  }

  // instruction_update or capability_gap → always create suggestion for human review
  if (learning.suggestedAction === 'instruction_update') {
    await createReflectionSuggestion(pool, agentId, learning);
    return 'suggestion';
  }

  // capability_gap category → always create suggestion regardless of suggestedAction
  if (learning.category === 'capability_gap') {
    await createReflectionSuggestion(pool, agentId, learning);
    return 'suggestion';
  }

  // memory action: auto-apply if confidence meets threshold
  if (learning.suggestedAction === 'memory') {
    if (learning.confidence < AUTO_APPLY_CONFIDENCE) {
      // Below confidence threshold → route to suggestion review
      await createReflectionSuggestion(pool, agentId, learning);
      return 'suggestion';
    }

    // Auto-apply with appropriate type tags based on category
    const tags = buildMemoryTags(learning.category);

    await memoryService.saveMemory({
      tenantId,
      layer: 'individual',
      scopeKey: `agent:${agentId}`,
      content: learning.summary,
      contentClassification: 'internal',
      agentId,
      tags,
      semanticDedup: true,
      source: {
        nodeType: 'chat_feedback' as const,
        refId: batchId,
        agentId,
        metadata: {
          feedbackItemIds: items.map((i) => i.id),
          learningCategory: learning.category,
        },
      },
    });

    return 'memory';
  }

  return 'skipped';
}

/**
 * Build memory tags based on feedback category.
 *
 * Per Phase 5.3 auto-apply rules:
 * - corrections → type:gotcha (1.3x retrieval boost)
 * - positive → type:convention (1.1x boost)
 * - preferences → type:preference (1.2x boost)
 */
function buildMemoryTags(category: ExtractedLearning['category']): string[] {
  const baseTags = ['auto-applied', 'from-chat-feedback'];

  switch (category) {
    case 'correction':
      return ['type:gotcha', ...baseTags];
    case 'positive':
      return ['type:convention', ...baseTags];
    case 'preference':
      return ['type:preference', ...baseTags];
    default:
      return baseTags;
  }
}

/**
 * Insert a row into reflection_suggestions for human review.
 *
 * The reflection_suggestions table exists (migration 001) with columns:
 * id, agent_id, suggestion, evidence_refs, confidence_score,
 * recurrence_score, severity, status, created_at, triggered_by.
 */
async function createReflectionSuggestion(
  pool: ReturnType<typeof getPoolForService>,
  agentId: string,
  learning: ExtractedLearning,
): Promise<void> {
  const severity = deriveSeverity(learning);
  const evidenceRefs = [{ type: 'chat_feedback', id: learning.category }];

  await pool.query(
    `INSERT INTO reflection_suggestions
     (agent_id, suggestion, evidence_refs, confidence_score, recurrence_score, severity, status, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'scheduled')`,
    [
      agentId,
      learning.summary,
      JSON.stringify(evidenceRefs),
      learning.confidence,
      0, // recurrence_score: 0 until cross-referenced with future feedback
      severity,
    ],
  );
}

/**
 * Derive severity from learning category and confidence.
 * Instruction updates and capability gaps are at least 'medium'.
 */
function deriveSeverity(learning: ExtractedLearning): 'low' | 'medium' | 'high' {
  if (learning.suggestedAction === 'instruction_update') {
    return learning.confidence >= 0.8 ? 'high' : 'medium';
  }
  if (learning.category === 'capability_gap') {
    return 'medium';
  }
  if (learning.category === 'correction' && learning.confidence >= 0.8) {
    return 'medium';
  }
  return 'low';
}
