// Embeddings for other services.
//
// This exists so the Chief AI Officer's conversation search, which runs in
// workforce-service against that service's own `team_plan_turns`, can use THIS
// process's embedding client instead of configuring a second one.
//
// TWO REASONS IT IS A HOP RATHER THAN A DEPENDENCY, and both are load-bearing:
//
//   Attribution. `llm_usage_log` and `cost_attribution_events` live in this
//   database. Every model call the CAIO makes already comes through here with a
//   `purpose` for exactly that reason (llm/client.ts routes them all), and an
//   embed is a charged model call like any other. A client configured over there
//   would spend money this side could not see — INV-PB-017.
//
//   One embedding space. Retrieval is space-gated: a vector is comparable only
//   with vectors from the same provider AND model, which is why every turns table
//   stores both beside the vector. Two independently configured clients can
//   default to two different spaces, and the failure is silent — a search simply
//   returns nothing, for as long as nobody checks.
//
// The caller stores the vector in its own column; this route holds nothing. It is
// deliberately not a general-purpose text endpoint either: `purpose` must name a
// registered one, so a caller cannot spend here anonymously.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { embeddingClient } from '@liftoffos/embedding';
import { log } from '../infrastructure/logging';
import { STORAGE_DIMENSIONS } from '../agent-chat/turn-embedding-service';
import { assistantForPurpose } from '../insights/platform-assistants';
import { workforceServiceAuth } from './workforce-service-auth';

export const embeddingInternalRouter = Router();

embeddingInternalRouter.use(workforceServiceAuth);

/** The repo-wide embed input budget (knowledge/embedding-service.ts). Longer
 *  input is the caller's to trim: silently truncating here would embed something
 *  the caller does not know it stored. */
const MAX_INPUT_CHARS = 4000;

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  input: z.string().min(1).max(MAX_INPUT_CHARS),
  /** A document is embedded to be found; a query to do the finding. The two use
   *  different task types and are not interchangeable. */
  taskType: z.enum(['retrieval_document', 'retrieval_query']),
  /** Whose line the cost lands on. Must be a purpose this process already maps
   *  to an assistant, so a caller cannot spend anonymously. */
  purpose: z.string().min(1).max(64),
  /** The row the cost is attributed to, when the caller has one. */
  itemId: z.string().max(200).optional(),
});

embeddingInternalRouter.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const { tenantId, input, taskType, purpose, itemId } = parsed.data;

  if (assistantForPurpose(purpose) === null) {
    log.warn({ purpose }, 'internal embedding: unregistered purpose refused');
    return res.status(400).json({
      error: 'purpose is not a registered platform-assistant purpose',
    });
  }

  try {
    const response = await embeddingClient.embed({
      input,
      dimensions: STORAGE_DIMENSIONS,
      taskType,
      context: { tenantId, purpose, ...(itemId ? { itemId } : {}) },
    });
    // The space travels with the vector: the caller stores all three, because a
    // vector without them cannot be told apart from one of another space.
    return res.json({
      vector: response.embeddings[0],
      provider: response.provider,
      model: response.model,
      dimensions: STORAGE_DIMENSIONS,
    });
  } catch (err) {
    log.error({ tenantId, purpose, error: (err as Error).message }, 'internal embedding failed');
    return res.status(502).json({ error: 'embedding failed' });
  }
});
