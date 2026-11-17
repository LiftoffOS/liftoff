// Write-time embedding generation for agent_skills rows, with retries.
//
// The instruction-compiler calls this for every skill it INSERTs. On
// transient failure (network blip, brief Vertex unavailability) the retry
// resolves and the row gets a real embedding. On persistent failure (auth,
// quota, provider outage) we log ERROR and return null — the row inserts
// with NULL embedding and the skill-embedding-sweeper, armed for it here,
// recovers it within ~25 minutes.
//
// Why fail-open instead of throw: throwing would block agent activation when
// the embedding subsystem flakes briefly, which is worse for the user than
// having a few skills temporarily un-retrievable. The sweeper closes the
// gap automatically.

import { generateEmbedding } from '../memory/embedding';
import { logger } from '../infrastructure/logging';
import { armWatch, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';

export const EMBED_MAX_ATTEMPTS = 3;
export const EMBED_BACKOFF_MS: readonly number[] = [0, 250, 750];

export interface SkillEmbedAttribution {
  tenantId: string;
  agentId: string;
  skillName: string;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateSkillEmbeddingWithRetry(
  text: string,
  ctx: SkillEmbedAttribution,
  // Injectable for tests; defaults to setTimeout-backed sleep.
  deps: { delay?: (ms: number) => Promise<void> } = {},
): Promise<number[] | null> {
  const delay = deps.delay ?? defaultDelay;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < EMBED_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(EMBED_BACKOFF_MS[attempt]);
    try {
      return await generateEmbedding(text, {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        purpose: 'embedding_skill',
        taskType: 'retrieval_document',
      });
    } catch (err) {
      lastErr = err as Error;
    }
  }

  logger.error(
    {
      agentId: ctx.agentId,
      tenantId: ctx.tenantId,
      skillName: ctx.skillName,
      err: lastErr?.message,
      attempts: EMBED_MAX_ATTEMPTS,
    },
    'Failed to generate skill embedding after retries — INSERT with NULL embedding; skill-embedding-sweeper will recover',
  );
  // The row is about to land with a NULL embedding; arm the sweeper for it.
  armWatch('skill-embedding', MAINTENANCE_PATHS.skillEmbeddingSweeper, { delayMs: 15 * 60 * 1000 });
  return null;
}
