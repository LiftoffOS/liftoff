// POST /api/internal/assistants/handover-stream
//
// The Chief AI Officer brings a colleague into one of its conversations. Its
// own turn runs in workforce-service, against a thread in that service's
// database; the colleagues it can bring in (Liftoff and the Insights Manager)
// run HERE, on their own tables and their own locks. So the rail that hands
// a turn over (agent-chat/handover.ts) runs here on the Chief AI Officer's
// behalf, and what it produces streams back to workforce-service as SSE in
// the same frames the dashboard reads: `delegation_started`, `thinking`,
// `tool_call`, `text_delta`, `content_block`, then one terminal frame.
//
// What this route does NOT do is persist the colleague's reply on the Chief
// AI Officer's thread: that thread is workforce-service's, so `complete`
// carries the text, the blocks and the token counts for workforce-service to
// write down, attributed to the colleague. The pairing between the Chief AI
// Officer's thread and the colleague's own lives here (migration 495), keyed
// on the workforce thread id, so a second hand-over in the same conversation
// lands in the thread the first one opened: that is what lets a preview the
// colleague made be applied on the next "yes".
//
// A STOP IS THE REQUEST CLOSING. The Chief AI Officer's stop is a row in
// workforce-service's database that this process cannot read, and a stop
// endpoint here would have to find the instance holding the hand-over. The
// connection already does: workforce-service holds it open for the whole
// hand-over and aborts it only on a stop of its own turn. So a close before
// the terminal frame is claimed as the person's stop, and the rail delivers
// it through the colleague's own control plane rather than dropping the
// colleague's stream. The colleague finishes cleanly on its own thread;
// workforce-service keeps what had streamed, exactly as Liftoff keeps a
// half-written answer.
//
// Trust shape: workforceServiceAuth at the mount, same as the other routes
// workforce-service calls. The caller is a service; the person it acts for
// is named in the body and their tenant role is forwarded as given, never
// widened, because every colleague makes its own permission decisions from
// it. Where the Chief AI Officer's turn came from (a coding tool, a Slack DM)
// travels as the same x-origin header workforce-service already
// receives, read back here so the colleague's actions say so too.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { runHandover, type HandoverAsker } from '../agent-chat/handover';
import {
  getAssistantThreadDelegation,
  pairAssistantThreadDelegation,
} from '../agent-chat/assistant-delegations';
import {
  CAIO_DELEGATION_TARGET,
  INSIGHTS_DELEGATION_TARGET,
  LIFTOFF_DELEGATION_TARGET,
  type DelegationTarget,
} from '../liftoff/delegation-targets';
import { LIFTOFF_ORIGIN_HEADER, parseLiftoffOriginHeader } from '../workspace-actions/origin-header';
import { toolActivityLabel } from '../common/tool-activity-label';

export const assistantHandoverRouter = Router();

const HEARTBEAT_INTERVAL_MS = 30_000;
/** The same ceiling every chat stream on this service has. */
const MAX_STREAM_DURATION_MS = 10 * 60 * 1000;

/** Who the Chief AI Officer can bring in, by the name workforce passes. */
const CAIO_HANDOVER_TARGETS: Readonly<Record<'liftoff' | 'insights', DelegationTarget>> = Object.freeze({
  liftoff: LIFTOFF_DELEGATION_TARGET,
  insights: INSIGHTS_DELEGATION_TARGET,
});

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  /** The person the Chief AI Officer is speaking with; the hand-over runs as
   *  them, on their tenant role. */
  accountId: z.string().min(1).max(200),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  /** The person's name, for surfaces that attribute the sender. */
  displayName: z.string().max(200).optional(),
  /** Which conversation table `threadId` names. Only the Chief AI Officer's
   *  today; named so the row it pairs is unambiguous. */
  surface: z.literal('caio'),
  /** The Chief AI Officer's thread in the workforce database. */
  threadId: z.string().uuid(),
  colleague: z.enum(['liftoff', 'insights']),
  /** The person's own words this turn, forwarded unchanged. */
  content: z.string().min(1).max(4000),
  /** What the Chief AI Officer wrote for the colleague: the background it
   *  would otherwise not know. Becomes the forwarded-context note. */
  request: z.string().max(8000).default(''),
});

function sendSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

assistantHandoverRouter.post('/handover-stream', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const body = parsed.data;
  const target = CAIO_HANDOVER_TARGETS[body.colleague];
  const origin = parseLiftoffOriginHeader(req.headers[LIFTOFF_ORIGIN_HEADER]);

  // The request's lifetime is the hand-over's. One controller for the whole
  // of it: a close before the terminal frame aborts it as a claimed stop.
  const abortController = new AbortController();
  let finished = false;

  const asker: HandoverAsker = {
    id: CAIO_DELEGATION_TARGET.id as HandoverAsker['id'],
    label: CAIO_DELEGATION_TARGET.label,
    tenantId: body.tenantId,
    accountId: body.accountId,
    role: body.role,
    displayName: body.displayName ?? '',
    ...(origin ? { origin } : {}),
    threadId: body.threadId,
    abortController,
    userMessage: body.content,
    pairing: {
      async get(t) {
        const existing = await getAssistantThreadDelegation(
          body.tenantId, body.surface, body.threadId, t.kind, t.kind === 'team' ? t.id : null,
        );
        return existing?.delegateThreadId ?? null;
      },
      pair(t, delegateThreadId) {
        return pairAssistantThreadDelegation({
          tenantId: body.tenantId,
          surface: body.surface,
          threadId: body.threadId,
          targetKind: t.kind,
          targetId: t.kind === 'team' ? t.id : null,
          delegateThreadId,
        });
      },
    },
    // The stop is the caller closing the request. Claimed here, so the rail
    // reads the abort as the person's stop rather than as a lost lock, and
    // hands it on to the colleague through the colleague's own control plane.
    //
    // Watched on the RESPONSE. The request's own 'close' fires once its body
    // has been read, which the JSON parser did before this handler ran, so a
    // listener here would never hear the socket go. The response closes when
    // the socket does, or when this handler ends it; `writableFinished` tells
    // the two apart.
    startAbortWatcher(controller, onClaimed) {
      let armed = true;
      const onClose = (): void => {
        if (!armed || finished || res.writableFinished) return;
        armed = false;
        log.info(
          { tenantId: body.tenantId, threadId: body.threadId, target: target.id },
          'hand-over: workforce closed the stream; stopping the colleague',
        );
        onClaimed();
        controller.abort(new Error('user_stop'));
      };
      res.on('close', onClose);
      return {
        stop: () => {
          armed = false;
          res.off('close', onClose);
        },
      };
    },
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': heartbeat\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  const hardTimeout = setTimeout(() => {
    if (res.writableEnded) return;
    log.warn(
      { tenantId: body.tenantId, threadId: body.threadId, target: target.id, limitMs: MAX_STREAM_DURATION_MS },
      'hand-over stream hit max duration; terminating',
    );
    sendSseEvent(res, 'error', {
      code: 'TIMEOUT',
      message: 'Response took too long and was cut off. Please try again.',
    });
    res.end();
  }, MAX_STREAM_DURATION_MS);

  try {
    const segment = runHandover(asker, target, body.request);
    let next = await segment.next();
    while (!next.done) {
      const event = next.value;
      // Keep consuming after the socket is gone, so the colleague reaches its
      // own terminal event and persists cleanly; only the writes stop.
      if (!res.writableEnded) {
        switch (event.type) {
          case 'thinking':
            sendSseEvent(res, 'thinking', {});
            break;
          case 'tool_call':
            // The name is for the model; `label` is the phrase the person reads.
            sendSseEvent(res, 'tool_call', { tool: event.tool, label: toolActivityLabel(event.tool) });
            break;
          case 'text_delta':
            sendSseEvent(res, 'text_delta', { text: event.text });
            break;
          case 'content_block':
            sendSseEvent(res, 'content_block', { block: event.block });
            break;
          case 'delegation_started':
            sendSseEvent(res, 'delegation_started', { author: event.author, authorLabel: event.authorLabel });
            break;
          case 'error':
            sendSseEvent(res, 'error', { code: event.code, message: event.message });
            break;
        }
      }
      next = await segment.next();
    }
    const outcome = next.value;
    finished = true;

    if (!res.writableEnded) {
      if (outcome.failed) {
        // The error frame is already on the wire and is terminal.
      } else if (outcome.paused) {
        sendSseEvent(res, 'delegation_paused', {
          author: target.id,
          authorLabel: target.label,
          delegateThreadId: outcome.delegateThreadId,
          reason: outcome.paused,
          // The status row is workforce-service's to write; there is none here.
          message: null,
          // What the colleague said before it stopped, for workforce to keep.
          text: outcome.text,
          blocks: outcome.blocks,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
        });
      } else {
        sendSseEvent(res, 'complete', {
          text: outcome.text,
          blocks: outcome.blocks,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          delegateThreadId: outcome.delegateThreadId,
          stopped: outcome.stopped,
        });
      }
    }
  } catch (err) {
    finished = true;
    log.error(
      { tenantId: body.tenantId, threadId: body.threadId, target: target.id, error: (err as Error).message, stack: (err as Error).stack },
      'hand-over stream failed with an uncaught error',
    );
    if (!res.writableEnded) {
      sendSseEvent(res, 'error', {
        code: 'INTERNAL',
        message: 'Something went wrong processing your message. Please try again.',
      });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(hardTimeout);
    if (!res.writableEnded) res.end();
  }
});
