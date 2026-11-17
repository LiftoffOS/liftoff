// Liftoff mirror for a Chief AI Officer notice that arrives after the turn.
//
// The CAIO runs in workforce-service, and an approved workforce plan provisions
// on a Cloud Tasks path that finishes minutes after the Liftoff turn ended. That
// service can write the notice into the CAIO's own team-plan thread, which it
// owns, but the pairing that says which Liftoff conversation asked for the plan
// lives in `liftoff_thread_delegations` in THIS database. Without this route the
// notice lands in a thread the person has never opened, not the Liftoff thread
// they are reading.
//
// Deliberately thin. All it does is hand a resolved pairing to
// mirrorCAIONoticeToLiftoff, which is the same module the HITL resume uses, so
// the copy is attributed with the author/author_label columns the live
// delegation writes and the person reads one conversation with two voices in it.
//
// Mounted BEFORE authMiddleware behind workforceServiceAuth: the caller is a
// service and carries no Firebase token. The tenant id is taken from the body
// and used only for logging; the pairing is keyed on the delegate thread id,
// which workforce-service can only know because it owns that thread.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { mirrorCAIONoticeToLiftoff } from '../liftoff/delegated-continuation';

export const liftoffMirrorRouter = Router();

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  delegateThreadId: z.string().uuid(),
  // Composed in workforce-service, not generated, so it is short and bounded.
  // The cap is a guard against a caller bug, not a product limit.
  content: z.string().min(1).max(8000),
});

liftoffMirrorRouter.post('/mirror-caio-notice', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { tenantId, delegateThreadId, content } = parsed.data;

  try {
    const message = await mirrorCAIONoticeToLiftoff({ tenantId, delegateThreadId, content });

    // `mirrored: false` is a normal answer, not a failure: most team-plan threads
    // are people using the CAIO surface directly and have no Liftoff pairing.
    // They have already been told in the thread they are reading.
    return res.json({ mirrored: message !== null });
  } catch (err) {
    // mirrorCAIONoticeToLiftoff does not throw, so reaching here means something
    // above it did. Answer 500 so the caller logs it, but the caller treats a
    // failed mirror as a lost copy rather than a lost notice.
    log.error(
      { tenantId, delegateThreadId, error: (err as Error).message },
      'liftoff mirror route failed',
    );
    return res.status(500).json({ error: 'Could not mirror the notice' });
  }
});
