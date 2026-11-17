// HyDE: Hypothetical Document Embeddings
//
// Instead of embedding the raw query, we ask the LLM to write a short
// hypothetical document that would answer the query, then embed that.
// The hypothetical document occupies the same semantic space as real
// answers, yielding better nearest-neighbour recall than the query alone.

import { llmClient } from '../llm/client';
import { logger } from '../infrastructure/logging';
import { getEntitlementsClient } from '../entitlements-client/service';
import type { LLMProvider } from '../llm/types';

/**
 * HyDE sits on the critical path of every run that retrieves memories: the
 * run does not start until retrieval returns. Without a bound of its own the
 * call inherited the provider's defaults — ten minutes per attempt, four
 * attempts — and a request on a dead pooled connection waits for exactly that.
 *
 * Eight seconds is several times a normal 256-token completion on a small
 * model; one retry absorbs a single transient failure. Worst case ~16s, after
 * which the raw query is embedded instead (the fallback below), which costs
 * recall, not the run. Env-overridable for tests and emergencies.
 */
export function hydeCallBounds(): { timeoutMs: number; maxRetries: number } {
  const timeoutMs = Number.parseInt(process.env.MEM_HYDE_TIMEOUT_MS ?? '', 10);
  const maxRetries = Number.parseInt(process.env.MEM_HYDE_MAX_RETRIES ?? '', 10);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 1,
  };
}

/**
 * Generate a short hypothetical document for the given query.
 * Used as the embedding input for HyDE-augmented retrieval.
 *
 * Falls back to the original query string if the LLM call fails so
 * retrieval still works, just without the HyDE quality boost.
 */
export async function generateHypotheticalDocument(
  query: string,
  tenantId: string,
  agentId?: string,
  /** Owning invocation. `llm_usage_log.invocation_id` is populated straight
   *  from this context (usage-tracker), so omitting it files a real LLM charge
   *  against the tenant with no run to attribute it to — the row exists, the
   *  spend is real, and nothing can say which run caused it. */
  invocationId?: string,
): Promise<string> {
  try {
    const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'retrieval_hyde');
    const response = await llmClient.complete(
      {
        maxTokens: 256,
        ...hydeCallBounds(),
        messages: [
          {
            role: 'user',
            content: `Write a short document (2–4 sentences) that directly answers this question: "${query}". Write the document itself, not an explanation of the answer.`,
          },
        ],
      },
      llmClient.modelSelectionFor(taskConfig),
      {
        tenantId,
        ...(agentId ? { agentId } : {}),
        ...(invocationId ? { invocationId } : {}),
        purpose: 'retrieval_hyde',
      },
    );

    return response.content || query;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, query: query.slice(0, 80) },
      'HyDE generation failed — falling back to raw query',
    );
    return query;
  }
}
