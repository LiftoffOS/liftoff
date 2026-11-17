// Consolidating repeated preferences into permanent instructions (P1.2).
//
// `DistillInput.recurringPreferences` and `buildPreferenceContractSection` have
// existed for a while and were never fed by anything: no code populated the
// field, so the "LEARNED PREFERENCES" section never appeared in a single
// distilled instruction. This module is the missing producer.
//
// The rule it implements is a judgement about durability, not a threshold for
// its own sake: saying something once is a correction, and runtime memory
// recall already handles that. Saying the same thing three times is a standing
// expectation, and standing expectations belong in the permanent instructions
// where they apply even when recall does not fire.
//
// Cost is bounded by construction: one embedding batch, and one small LLM call
// only when a cluster actually reaches the threshold — which is rare.

import { embeddingClient } from '@liftoffos/embedding';
import { log } from '../infrastructure/logging';
import { llmClient } from '../llm';
import type { JSONSchema, LLMToolDefinition } from '../llm/types';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { PREFERENCE_MEMORY_TAG } from '../agent-chat/chat-learning-service';
import { PREFERENCE_MIN_RECURRENCE, type RecurringPreference } from './distill-preference-injection';

// Matches skill-similarity: the same provider and dimensionality, so the
// similarity numbers here mean the same thing they do there.
const EMBED_PROVIDER = 'google' as const;
const EMBED_DIMENSIONS = 768;

/** Two statements above this cosine are treated as the same preference said
 *  again. Set high: merging two genuinely different preferences would bake a
 *  blend of them into permanent instructions, which is worse than missing one. */
const SAME_PREFERENCE_THRESHOLD = 0.88;

/** How many preference memories to consider. Well above what any real agent
 *  accumulates, and the retrieval is a single call. */
const MAX_PREFERENCE_MEMORIES = 60;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const RENDER_TOOL_NAME = 'render_preferences';

function buildRenderTool(): LLMToolDefinition {
  const schema: JSONSchema = {
    type: 'object',
    properties: {
      preferences: {
        type: 'array',
        description: 'One entry per group, in the same order as the input groups.',
        items: {
          type: 'object',
          properties: {
            preferred: { type: 'string', description: 'The behaviour to adopt, stated positively and concretely.' },
            rejected: { type: 'string', description: 'The behaviour to avoid — the thing the person kept correcting.' },
            reason: { type: 'string', description: 'Why, in a short clause. Empty when the person never said why.' },
          },
          required: ['preferred', 'rejected', 'reason'],
        },
      },
    },
    required: ['preferences'],
  };
  return {
    name: RENDER_TOOL_NAME,
    description: 'Turn each group of repeated preference statements into a contrastive pair.',
    input_schema: schema,
  };
}

/**
 * Build the recurring preferences for an agent, ready to hand to the distiller.
 *
 * Returns an empty array on any failure or when nothing recurs often enough —
 * both meaning "add no LEARNED PREFERENCES section", which is exactly the
 * behaviour that existed before this module.
 */
export async function collectRecurringPreferences(
  tenantId: string,
  agentId: string,
): Promise<RecurringPreference[]> {
  try {
    // Tag-filtered, but retrieved semantically because the memory API exposes
    // tags only on this path. The broad query is a net, not a ranking.
    const memories = await tenantRuntimeClient.retrieveAgentMemories(
      tenantId,
      agentId,
      'how this person prefers work to be done, formatted, or communicated',
      MAX_PREFERENCE_MEMORIES,
    );
    const statements = memories
      .filter((m) => (m.tags ?? []).includes(PREFERENCE_MEMORY_TAG))
      .map((m) => m.content.trim())
      .filter((c) => c.length > 0);

    // Nothing can reach the threshold, so do not pay for an embedding call.
    if (statements.length < PREFERENCE_MIN_RECURRENCE) return [];

    const response = await embeddingClient.embed({
      provider: EMBED_PROVIDER,
      input: statements,
      dimensions: EMBED_DIMENSIONS,
      taskType: 'retrieval_document',
      context: { tenantId, agentId, purpose: 'preference_aggregation' },
    });
    const vectors = response.embeddings;

    // Greedy single-pass clustering. Good enough here: clusters are small, and
    // the alternative (proper agglomerative clustering) would add complexity
    // for a decision that already needs three independent occurrences.
    const clusters: Array<{ statements: string[]; centroidIndex: number }> = [];
    for (let i = 0; i < statements.length; i++) {
      let placed = false;
      for (const cluster of clusters) {
        if (cosine(vectors[i], vectors[cluster.centroidIndex]) >= SAME_PREFERENCE_THRESHOLD) {
          cluster.statements.push(statements[i]);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ statements: [statements[i]], centroidIndex: i });
    }

    const qualifying = clusters
      .filter((c) => c.statements.length >= PREFERENCE_MIN_RECURRENCE)
      .sort((a, b) => b.statements.length - a.statements.length);

    if (qualifying.length === 0) return [];

    // Render only what qualifies. selectInjectablePreferences caps the injected
    // set at 8 downstream, so there is no need to render more than that.
    const groups = qualifying.slice(0, 8);
    const rendered = await llmClient.complete(
      {
        messages: [
          {
            role: 'user',
            content: `A person has repeated the same expectations to their agent member. Turn each group into one contrastive pair: what to do, and what to stop doing.

Keep the person's own meaning. Do not invent a reason they never gave — leave the reason empty instead. Do not use contractions.

${groups.map((g, i) => `Group ${i + 1} (said ${g.statements.length} times):\n${g.statements.map((s) => `- ${s}`).join('\n')}`).join('\n\n')}`,
          },
        ],
        tier: 'small',
        maxTokens: 2048,
        temperature: 0,
        tools: [buildRenderTool()],
        toolChoice: { name: RENDER_TOOL_NAME },
      },
      undefined,
      { tenantId, agentId, purpose: 'preference_aggregation' },
    );

    const call = rendered.toolCalls?.find((c) => c.name === RENDER_TOOL_NAME);
    if (!call) return [];
    const out = call.input as unknown as {
      preferences?: Array<{ preferred?: string; rejected?: string; reason?: string }>;
    };

    const result: RecurringPreference[] = (out.preferences ?? [])
      .map((p, i) => ({
        preferred: (p.preferred ?? '').trim(),
        rejected: (p.rejected ?? '').trim(),
        reason: (p.reason ?? '').trim(),
        recurrence: groups[i]?.statements.length ?? 0,
      }))
      .filter((p) => p.preferred && p.rejected && p.recurrence >= PREFERENCE_MIN_RECURRENCE);

    log.info(
      { tenantId, agentId, statements: statements.length, clusters: clusters.length, injected: result.length },
      'preference-aggregation: recurring preferences resolved',
    );
    return result;
  } catch (err) {
    log.warn(
      { tenantId, agentId, error: (err as Error).message },
      'preference-aggregation: failed — distilling without a learned-preferences section',
    );
    return [];
  }
}
