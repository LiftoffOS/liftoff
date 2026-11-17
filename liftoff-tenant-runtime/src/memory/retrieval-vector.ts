// Shared HyDE + embedding for retrieval.
//
// Semantic retrieval on this platform costs an LLM call (HyDE writes a short
// hypothetical answer) plus an embedding of that answer. Memory retrieval and
// connector-content retrieval each pay that pair independently, which is
// correct when they are called separately and wasteful when one tool searches
// both: two hypothetical documents get written for one question, and only one
// of them can be the better vector.
//
// This builds the pair once. A caller searching several sources computes the
// vector here and hands it to each of them.

import { logger } from '../infrastructure/logging';
import { generateEmbedding } from './embedding';
import { generateHypotheticalDocument } from './hyde';

export interface RetrievalVector {
  /** The embedding as a plain array, for query builders that bind it directly.
   *  Null when the provider could not be reached. */
  embedding: number[] | null;
  /** The same vector serialized for the `$1::vector` cast. Null on failure. */
  embeddingJson: string | null;
  /** True when the embedding provider could not be reached.
   *
   *  Load-bearing, and the reason this never throws. A caller that sees a
   *  thrown error has no way to distinguish "I did not ask for one" from "the
   *  provider is down", so it hands each source a blank and every source tries
   *  again — turning one failed provider call into one per source, per search,
   *  for as long as the outage lasts. This flag lets the caller say "skip the
   *  semantic arm" instead, so each source degrades to lexical retrieval
   *  without a second failed call. */
  unavailable: boolean;
}

/**
 * Write a hypothetical answer for `query` and embed it.
 *
 * NEVER THROWS. HyDE failure falls back to embedding the raw query — the same
 * behaviour the individual retrieval paths already have, so a degraded LLM
 * costs recall rather than the whole search. An embedding failure returns
 * `unavailable: true` rather than raising, so the caller can tell its sources
 * to go lexical instead of each of them re-attempting a provider that is down.
 */
export async function buildRetrievalVector(args: {
  query: string;
  tenantId: string;
  agentId?: string;
  /** Owning invocation, so the HyDE LLM charge and the embedding both attribute
   *  to the run that caused them rather than only to the tenant and agent. */
  invocationId?: string;
}): Promise<RetrievalVector> {
  const hypotheticalDoc = await generateHypotheticalDocument(
    args.query,
    args.tenantId,
    args.agentId,
    args.invocationId,
  ).catch(() => args.query);

  try {
    const embedding = await generateEmbedding(hypotheticalDoc, {
      tenantId: args.tenantId,
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.invocationId ? { invocationId: args.invocationId } : {}),
      purpose: 'embedding_retrieval',
      taskType: 'retrieval_query',
    });
    return { embedding, embeddingJson: JSON.stringify(embedding), unavailable: false };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: args.tenantId, agentId: args.agentId },
      'retrieval_vector_unavailable — sources will fall back to lexical retrieval',
    );
    return { embedding: null, embeddingJson: null, unavailable: true };
  }
}
