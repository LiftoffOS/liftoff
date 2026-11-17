// Redistill-accept worker (the background half of accepting a routine).
//
// POST /api/internal/chat-turns/redistill-accept — Cloud Tasks delivery
// target, enqueued by acceptSuggestion the moment the guidance line has
// landed. The person already got their acknowledgement in the turn; this runs
// the redistill that turns the prose into an actual trigger, then tells them
// it is live, in the thread where they said yes.
//
// Same response-code contract as the chat-turn worker: 200 for success AND for
// permanently-malformed payloads (Cloud Tasks must never retry poison); 5xx
// only for failures a retry can fix. The queue retries up to 4 attempts; on
// the last one this stops pretending and posts an honest failure note instead.
// Either way the suggestion STAYS accepted — the guidance line is durable, and
// any later redistill folds it in.
//
// Idempotent by construction: a redelivery after a successful append hits the
// unique external_ref (`suggestion-live:<id>`, migration 414's index) and is
// answered 200 without a second message; re-running the redistill itself just
// lands another ordinary version.
//
// Auth: the shared worker OIDC guard (queue SA, local-dev secret fallback).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { parseCadence } from '../internal-agents/cadence-parse';
import { redistillAgent } from '../internal-agents/redistill-service';
import * as chatRepo from './chat-repository';
import { LEARNING_CONFIRMATION_MESSAGE_TYPE } from './chat-learning-service';
import { pushOutOfTurnMessage } from './out-of-turn-delivery';
import { verifyWorkerOidc } from './worker-oidc';

export const redistillAcceptWorkerRouter = Router();

// The notify trio travels together: a confirmation needs a thread to land in,
// a proposal to dedupe on, and the routine line for its wording. The CAIO
// update path sends none of them — its person was told in-conversation — so
// the worker then redistills and posts nothing.
const taskSchema = z
  .object({
    tenantId: z.string().uuid(),
    agentId: z.string().uuid(),
    suggestionId: z.string().uuid().optional(),
    threadId: z.string().uuid().optional(),
    routineProse: z.string().min(1).optional(),
    action: z.enum(['start', 'change', 'stop']).default('start'),
    targetLabel: z.string().optional(),
    replacesProse: z.string().optional(),
  })
  .refine(
    (t) =>
      (t.suggestionId === undefined && t.threadId === undefined && t.routineProse === undefined)
      || (t.suggestionId !== undefined && t.threadId !== undefined && t.routineProse !== undefined),
    { message: 'suggestionId, threadId and routineProse travel together' },
  );

/** The queue is configured with maxAttempts 4, so retry count 3 is the last
 *  delivery this task will ever get. */
const LAST_RETRY_COUNT = 3;

const UNIQUE_VIOLATION = '23505';

function confirmationText(
  action: 'start' | 'change' | 'stop',
  routineProse: string,
  targetLabel?: string,
): string {
  if (action === 'stop') {
    return (
      `The ${targetLabel ?? 'named'} routine is stopped and removed from my schedule. `
      + 'You can restore an earlier setup from my settings page.'
    );
  }
  if (action === 'change') {
    return (
      `The routine is updated: ${routineProse} `
      + 'You can change or remove it on my settings page.'
    );
  }
  return (
    `The routine is live: ${routineProse} `
    + 'You can change or remove it on my settings page.'
  );
}

const FAILURE_TEXT =
  'I could not finish folding that routine into my schedule. The instruction is '
  + 'saved in my standing guidance, so it will be included the next time my setup '
  + 'is updated; you can apply it now with Optimize on my settings page, or ask me '
  + 'again later.';

/** Post one message to the thread exactly once across retries, and push it to
 *  Slack/Teams only when this delivery was the one that inserted it. */
async function postOnce(params: {
  tenantId: string;
  threadId: string;
  agentId: string;
  text: string;
  externalRef: string;
}): Promise<void> {
  try {
    await chatRepo.appendMessage(
      params.tenantId,
      params.threadId,
      'assistant',
      params.text,
      params.agentId,
      undefined,
      undefined,
      undefined,
      LEARNING_CONFIRMATION_MESSAGE_TYPE,
      undefined,
      undefined,
      undefined,
      params.externalRef,
    );
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      // A retry after the message already landed. Delivered is delivered.
      return;
    }
    throw err;
  }
  // The transcript row is delivery for web; Slack and Teams stream one turn
  // reply and stop listening, so without this push those channels are never
  // told what became of their yes.
  await pushOutOfTurnMessage({
    tenantId: params.tenantId,
    threadId: params.threadId,
    agentId: params.agentId,
    text: params.text,
  });
}

redistillAcceptWorkerRouter.post('/redistill-accept', async (req: Request, res: Response) => {
  if (!(await verifyWorkerOidc(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const raw = typeof req.body === 'string'
    ? JSON.parse(Buffer.from(req.body, 'base64').toString())
    : req.body;
  const parsed = taskSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // Permanent — 200 so Cloud Tasks does not retry a malformed task.
    log.error({ issues: parsed.error.issues }, 'redistill-accept: malformed task dropped');
    return res.status(200).json({ dropped: true });
  }
  const task = parsed.data;
  const retryCount = Number(req.header('X-CloudTasks-TaskRetryCount') ?? '0');

  // Derive-then-verify: when the routine states an exact cadence this grammar
  // can read, the distiller is REQUIRED to emit it (analyzer rule
  // expected_cadence_missing, retried with feedback). An unparseable phrasing
  // skips verification rather than guessing one.
  //
  // A stop is the inverse: its guidance line was REMOVED, so the distiller is
  // told what was stopped (a removed line cannot instruct anyone) and the
  // analyzer REQUIRES the cadence to be absent (stopped_cadence_present).
  // The removed line states the cadence more faithfully than the stop
  // sentence, so it is preferred when the accept had one to remove.
  let options:
    | {
        expectedCadences?: Array<{ prose: string; cronExpr: string }>;
        stoppedCadences?: Array<{ prose: string; cronExpr?: string }>;
      }
    | undefined;
  if (task.action === 'stop' && task.routineProse) {
    const stoppedProse = task.replacesProse ?? task.routineProse;
    const parsedStopped = parseCadence(stoppedProse);
    options = {
      stoppedCadences: [
        { prose: stoppedProse, ...(parsedStopped ? { cronExpr: parsedStopped.cronExpr } : {}) },
      ],
    };
  } else if (task.action !== 'stop' && task.routineProse) {
    const parsedCadence = parseCadence(task.routineProse);
    options = parsedCadence
      ? { expectedCadences: [{ prose: task.routineProse, cronExpr: parsedCadence.cronExpr }] }
      : undefined;
  }

  // Scoped is ONLY for the suggestion rail, whose accept touched nothing but
  // a routine line — there, regenerating just the trigger is sound. A task
  // without routineProse is the CAIO prose-update path: the person rewrote
  // responsibilities or guidance, and pinning the old prompts against a new
  // trigger is exactly the drift this system exists to prevent. Those always
  // run the full redistill.
  const scopedEligible = Boolean(task.routineProse);

  try {
    // Scoped first when eligible; ANY scoped failure falls back to the full
    // redistill (the same call the Optimize button and the synchronous accept
    // make) — correctness never depends on the optimisation.
    if (scopedEligible) {
      try {
        await redistillAgent(task.agentId, task.tenantId, undefined, {
          ...options,
          scope: 'triggers',
        });
      } catch (scopedErr) {
        log.warn(
          {
            tenantId: task.tenantId, agentId: task.agentId,
            suggestionId: task.suggestionId, error: (scopedErr as Error).message,
          },
          'redistill-accept: scoped rebuild failed; running the full redistill',
        );
        await redistillAgent(task.agentId, task.tenantId, undefined, options);
      }
    } else {
      await redistillAgent(task.agentId, task.tenantId, undefined, options);
    }
  } catch (err) {
    log.error(
      {
        tenantId: task.tenantId, agentId: task.agentId,
        suggestionId: task.suggestionId, retryCount, error: (err as Error).message,
      },
      'redistill-accept: redistill failed',
    );
    if (retryCount >= LAST_RETRY_COUNT) {
      // Out of retries. Say so where the person is, once, and stop the queue.
      // A task with no thread has nobody waiting; the error log above is its
      // only witness, which is why it is written at error severity.
      if (task.threadId && task.suggestionId) {
        try {
          await postOnce({
            tenantId: task.tenantId,
            threadId: task.threadId,
            agentId: task.agentId,
            text: FAILURE_TEXT,
            externalRef: `suggestion-failed:${task.suggestionId}`,
          });
        } catch (postErr) {
          log.error(
            { suggestionId: task.suggestionId, error: (postErr as Error).message },
            'redistill-accept: could not deliver the failure note',
          );
        }
      }
      return res.status(200).json({ gaveUp: true });
    }
    return res.status(500).json({ error: 'redistill failed' });
  }

  if (!task.threadId || !task.suggestionId || !task.routineProse) {
    // Nothing to post: the CAIO update path informs its person in-conversation.
    log.info(
      { tenantId: task.tenantId, agentId: task.agentId },
      'redistill-accept: redistill complete (no notification requested)',
    );
    return res.status(200).json({ ok: true });
  }

  try {
    await postOnce({
      tenantId: task.tenantId,
      threadId: task.threadId,
      agentId: task.agentId,
      text: confirmationText(task.action, task.routineProse, task.targetLabel),
      externalRef: `suggestion-live:${task.suggestionId}`,
    });
  } catch (err) {
    // The routine IS live; only the telling failed. Retry the telling.
    log.error(
      { suggestionId: task.suggestionId, error: (err as Error).message },
      'redistill-accept: confirmation delivery failed',
    );
    if (retryCount >= LAST_RETRY_COUNT) return res.status(200).json({ liveButUntold: true });
    return res.status(500).json({ error: 'confirmation delivery failed' });
  }

  log.info(
    { tenantId: task.tenantId, agentId: task.agentId, suggestionId: task.suggestionId },
    'redistill-accept: routine live and confirmed',
  );
  return res.status(200).json({ ok: true });
});
