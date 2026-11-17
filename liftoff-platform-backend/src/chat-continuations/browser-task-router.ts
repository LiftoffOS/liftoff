// POST /api/internal/browser-tasks/finished
//
// The tenant runtime telling this service that a browser task belonging to one
// of the three assistants has finished, so the conversation is woken and the
// person is given what it produced.
//
// A browser task that turns out to be a long one hands the turn back and keeps
// going. Its result was parked for whoever next spoke, which made the person
// the delivery mechanism: they were told to send a message so the work could
// be picked up, and a file they never came back for was never delivered at
// all. A task finishing is an event, so it wakes the thread.
//
// The runtime can watch the task but cannot wake these conversations: the
// assistants' threads are in this database. The agents' half needs no
// callback, because their threads are the runtime's own.
//
// Auth: X-Service-Auth === PLATFORM_CALLBACK_TOKEN, the same TR→PB shared
// secret every other platform callback uses.

import { Router, type Request, type Response, json as expressJson } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { enqueueBackgroundWork, threadOriginFor } from './store';
import { enqueueContinuationTask } from './dispatch';

export const browserTaskInternalRouter = Router();
browserTaskInternalRouter.use(expressJson({ limit: '64kb' }));

/** What the runtime calls each assistant, and the surface it is here. The
 *  Chief AI Officer is deliberately absent: its conversation lives in the
 *  workforce service, the continuation worker treats a row of that surface as
 *  a defect, and a task of its own falls back to being collected. */
const SURFACE_OF: Record<string, 'liftoff' | 'insights'> = {
  liftoff: 'liftoff',
  insights: 'insights',
};

const schema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  assistant: z.string().min(1).max(40),
  brief: z.string().min(1).max(4000),
  /** Who opened the browser. Used when the thread cannot name an owner. */
  senderAccountId: z.string().uuid().optional(),
});

browserTaskInternalRouter.post('/finished', async (req: Request, res: Response) => {
  if (!process.env.PLATFORM_CALLBACK_TOKEN
    || req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { tenantId, threadId, assistant, brief, senderAccountId } = parsed.data;

  const surface = SURFACE_OF[assistant];
  if (!surface) {
    // Answered rather than refused: there is nothing for the runtime to retry,
    // and the collect tool still gives the person the result when they speak.
    log.info(
      { tenantId, threadId, assistant, event: 'browser_task_push_no_surface' },
      'a finished browser task belongs to an assistant with no continuation rail here; it will be collected',
    );
    return res.json({ woken: false, reason: 'surface_not_supported' });
  }

  try {
    // The row hangs off the person's last message in the thread, the way a
    // continuation the assistant started itself does: it is what supersession
    // and cancellation are measured against.
    const origin = await threadOriginFor(tenantId, surface, threadId);
    const accountId = origin?.accountId ?? senderAccountId;
    if (!origin?.originMessageId || !accountId) {
      log.info(
        { tenantId, threadId, surface, event: 'browser_task_push_no_origin' },
        'a finished browser task named a thread with nothing of the person to hang a wake off; it will be collected',
      );
      return res.json({ woken: false, reason: 'no_origin_message' });
    }
    const row = await enqueueBackgroundWork({
      tenantId, surface, threadId, accountId, originMessageId: origin.originMessageId, brief,
    });
    await enqueueContinuationTask(row.id, tenantId);
    log.info(
      { tenantId, threadId, surface, continuationId: row.id, event: 'browser_task_push_queued' },
      'a finished browser task woke its conversation to deliver',
    );
    return res.json({ woken: true, continuationId: row.id });
  } catch (err) {
    log.error(
      { err: (err as Error).message, tenantId, threadId, surface },
      'a finished browser task could not wake its conversation',
    );
    // 500 so the runtime's retry gets another go; it gives up after three and
    // the result is still on the session for the collect tool to find.
    return res.status(500).json({ error: 'could not wake the conversation' });
  }
});
