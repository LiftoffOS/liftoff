// The output guard for workforce-service.
//
// The Chief AI Officer runs in workforce-service, and its words reach a
// person under the same rule as everyone else's: nothing of the platform's
// inner workings. The guard is one implementation (common/output-guard.ts),
// with one rubric, one switch and one audit shape, so that service reads
// through this route rather than carrying a second copy that drifts.
//
// Whole text in, guarded text out, exactly what a streamed reply here goes
// through paragraph by paragraph (common/guarded-stream.ts): the scrub, then
// the reader, fences passed through. Fail-open is the caller's: a transport
// error there leaves its own scrubbed text standing, the same way the guard
// here fails open on its own.
//
// Mounted BEFORE authMiddleware behind workforceServiceAuth, on a prefix of
// its own: the caller is a service and carries no Firebase token.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { guardWholeText } from '../common/guarded-stream';

export const outputGuardRouter = Router();

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  /** Who is speaking, for the audit row: 'caio' for the Chief AI Officer. */
  speaker: z.string().min(1).max(64),
  threadId: z.string().uuid().optional(),
  /** One model text block. The cap is what a turn can produce, not a
   *  product limit. */
  text: z.string().max(64_000),
  /** The exact tool names the turn was offered, removed by the scrub. */
  toolNames: z.array(z.string().min(1).max(120)).max(200).optional(),
});

outputGuardRouter.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const { tenantId, speaker, threadId, text, toolNames } = parsed.data;

  try {
    const shown = await guardWholeText(
      text,
      { tenantId, speaker, ...(threadId ? { threadId } : {}) },
      { ...(toolNames ? { toolNames } : {}) },
    );
    return res.json({ text: shown, changed: shown !== text });
  } catch (err) {
    // guardWholeText does not throw, so reaching here means something under
    // it did. The caller keeps its own scrubbed text on a 500.
    log.error({ tenantId, speaker, error: (err as Error).message }, 'output guard route failed');
    return res.status(500).json({ error: 'Could not read the text' });
  }
});
