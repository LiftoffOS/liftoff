// POST /api/internal/preview
//
// The INVERSE edge of the deliverable-first loop. The shipped direction runs
// work-first: a person does the job with Liftoff, then Liftoff delegates to
// the Chief AI Officer, which reads the source conversation back and absorbs
// it. This route serves the person who arrived at the Chief AI Officer COLD
// and wants the deliverable demonstrated before anything is built: the CAIO
// (in workforce-service) asks for a Liftoff conversation seeded with the
// task, the person does it once over there, and the RETURN trip needs zero
// new machinery — the pairing row written here is exactly what
// /api/internal/source-conversation resolves.
//
// Trust shape: workforceServiceAuth at the mount, same as the other
// /api/internal/liftoff* routes. The caller owns the team-plan thread id it
// names (it lives in workforce's database); the thread created here is read
// under the tenant the caller supplies, like every Liftoff thread.
//
// The seeded message's text is AUTHORED BY THE CALLER (the CAIO's own words
// about the task) and stored verbatim with its colleague attribution — this
// route writes no user-facing prose of its own.
//
// IDEMPOTENT on the team-plan thread: a repeat call answers with the
// conversation that already exists for this pairing instead of creating a
// second one — a duplicate would split the person's work in two, and the
// model calling the tool twice must not be able to cause that.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import {
  appendMessage,
  createThread,
  getDelegationByDelegateThread,
  getThread,
  pairThreadDelegation,
} from '../liftoff/chat-repository';

export const liftoffPreviewRouter = Router();

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  /** The person's account id — the thread must belong to someone real so the
   *  dashboard lists it for them. */
  accountId: z.string().min(1).max(200),
  /** The CAIO-side thread this preview belongs to; the pairing key the
   *  return trip resolves. */
  teamPlanThreadId: z.string().uuid(),
  /** The task, in the caller's own words. Stored verbatim as the seed. */
  taskContext: z.string().min(1).max(8000),
  /** The colleague label the person has been seeing in the CAIO surface;
   *  stored with the seed so attribution survives renames. */
  colleagueLabel: z.string().min(1).max(120),
});

liftoffPreviewRouter.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const { tenantId, accountId, teamPlanThreadId, taskContext, colleagueLabel } = parsed.data;
  try {
    // Idempotency: a pairing that already exists wins. Verified under the
    // caller's tenant, so a stale or cross-tenant pairing creates a fresh
    // conversation rather than handing back someone else's.
    const existing = await getDelegationByDelegateThread(teamPlanThreadId, 'caio');
    if (existing) {
      const existingThread = await getThread(tenantId, existing.liftoffThreadId).catch(() => null);
      if (existingThread) {
        return res.json({ liftoffThreadId: existingThread.id, existing: true });
      }
    }

    const thread = await createThread({ tenantId, accountId, title: null });
    await pairThreadDelegation({
      threadId: thread.id,
      targetKind: 'caio',
      targetId: null,
      delegateThreadId: teamPlanThreadId,
    });
    await appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: taskContext,
      author: 'caio',
      authorLabel: colleagueLabel,
    });
    return res.json({ liftoffThreadId: thread.id });
  } catch (error) {
    log.error({ error, tenantId, teamPlanThreadId }, 'liftoff preview thread creation failed');
    return res.status(500).json({ error: 'could not create the preview conversation' });
  }
});
