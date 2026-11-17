// Insights Chat Stream Router
//
// POST /api/insights/chat-stream — Server-Sent Events endpoint for the
// insights chat. Wraps runInsightsChatTurn() as an HTTP stream.
//
// Request body:
//   {
//     "tenantId": "<uuid>",
//     "threadId": "<uuid>",
//     "content":  "<1-4000 chars>"
//   }
//
// Response: SSE stream with these event types (one per line pair):
//
//   event: thinking            — sent immediately
//   event: tool_call           — { tool: "get_cost_breakdown" }
//   event: text_delta          — { text: "..." }
//   event: content_block       — { block: VisualizationBlock }
//   event: delegation_started  — { author: "...", authorLabel: "..." } the turn
//                                was handed to a colleague (the Chief AI
//                                Officer or Liftoff), and everything from here
//                                on is theirs. Sent once, before any of their
//                                own events, so the reply can be attributed
//                                while it streams. No closing frame follows it:
//                                `complete`, `delegation_paused` or `error`
//                                ends the delegated segment as well as the turn
//   event: delegation_paused   — { author, authorLabel, delegateThreadId,
//                                reason, message } terminal, not a failure:
//                                the colleague stopped to wait on a person
//   event: complete            — { message: InsightsChatMessage }
//   event: interrupt_delivered — {} — the message was folded into the turn
//                                already running on this thread; no new turn
//   event: error               — { code: "...", message: "..." }
//   event: done                — {} the LAST frame of every shape of this
//                                stream, the acknowledgment included. EOF on its
//                                own is byte-identical to a socket that died
//                                mid-turn, so its absence is what the client
//                                reports as a dropped connection. Written by
//                                src/common/chat-stream.ts, never here.
//
// Streams every 30 seconds send a SSE comment line (`: heartbeat\n\n`) so
// stale connections are detected by the client and any proxies in between.
//
// Hard limits:
//   - Stream max duration: 10 minutes
//   - Body size: 50KB (same as the main insights router)
//   - Message content: 4000 chars (enforced by Zod)

import { Router, type Request, type Response, json as expressJson } from 'express';
import { z } from 'zod';
import { log, logAudit } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { accountDisplayName } from '../accounts/display-name';
import { appendMessage, getCallerRole, getThread } from './chat-repository';
import { BROWSER_HANDBACK_MESSAGE_TYPE, BROWSER_POINT_MESSAGE_TYPE } from '../agent-chat/hitl-status-message';
import {
  BROWSER_EVENT_NOT_PENDING,
  browserEventBodySchema,
  browserEventOf,
  browserEventStatusLine,
  verifyBrowserEvent,
  type VerifiedBrowserEvent,
} from '../browser-sessions/handback';
import { openChatStream, type ChatStream } from '../common/chat-stream';
import { checkAndIncrementInsightsRateLimit } from './rate-limiter';
import { checkAssistantAdmission } from '../agent-chat/admission';
import { runInsightsChatTurn, type ChatServiceEvent } from './chat-service';
// The attachment contract, shared with Liftoff and the Chief AI Officer. The
// schema's bounds are set so a message at the cap still fits the 50KB body
// limit below: 8 attachments x 4000 characters plus a 4000-character message is
// roughly 36KB, so no limit change is needed here.
import {
  attachmentsSchema,
  composeTurnText,
  toMessageMedia,
  sanitizeAttachments,
  toMessageAttachments,
} from '../chat-attachments';
import { claimInboundMedia } from '../media/inbound';
import {
  findActiveTurnId,
  insertTurnSignal,
  newTurnId,
  releaseTurnLock,
  tryAcquireTurnLock,
  TurnLockUnavailableError,
} from './turn-control';
import { cancelThreadContinuations } from '../chat-continuations/store';
import { toolActivityLabel } from '../common/tool-activity-label';
import { refusedAsViewer } from '../common/agent-conversation-gate';

export const streamRouter = Router();
const accountService = new AccountService();

// Same 50KB body limit as the main insights router.
streamRouter.use(expressJson({ limit: '50kb' }));

const MAX_STREAM_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_INTERVAL_MS = 30_000;
// The turn is told to close its reply this long before the stream ends: room
// for the model call in flight when the deadline passes and for the closing
// call that writes the reply. The same reserve the Chief AI Officer's stream
// keeps.
const REPLY_CLOSING_RESERVE_MS = 90_000;

// `content` is optional only beside a browser event: the person's hand-back
// or point is a turn of its own, and a send while they were driving carries
// both. A body with neither is refused below.
const chatStreamBodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  content: z.string().min(1).max(4000).optional(),
  attachments: attachmentsSchema.optional(),
  browserHandback: browserEventBodySchema.optional(),
});

/** Translate a chat-service domain event to an SSE frame. Centralized so the
 *  mapping is obvious and unit-testable.
 *
 *  Takes the ChatStream rather than the response, because the response is not
 *  this router's to hold any more — a stream that can be ended without its
 *  terminal `done` frame is indistinguishable, to the client, from a socket that
 *  died mid-turn. See src/common/chat-stream.ts. */
export function writeChatEventAsSse(stream: ChatStream, event: ChatServiceEvent): void {
  switch (event.type) {
    case 'thinking':
      stream.send('thinking', {});
      return;
    case 'tool_call':
      // The name is for the model; `label` is the phrase the person reads.
      stream.send('tool_call', { tool: event.tool, label: toolActivityLabel(event.tool) });
      return;
    case 'text_delta':
      stream.send('text_delta', { text: event.text });
      return;
    case 'content_block':
      stream.send('content_block', { block: event.block });
      return;
    case 'delegation_started':
      stream.send('delegation_started', {
        author: event.author,
        authorLabel: event.authorLabel,
      });
      return;
    case 'delegation_paused':
      stream.send('delegation_paused', {
        author: event.author,
        authorLabel: event.authorLabel,
        delegateThreadId: event.delegateThreadId,
        reason: event.reason,
        message: event.message,
      });
      return;
    case 'complete':
      stream.send('complete', { message: event.message });
      return;
    case 'error':
      stream.send('error', { code: event.code, message: event.message });
      return;
  }
}

streamRouter.post('/chat-stream', async (req: Request, res: Response) => {
  // 1. Validate body.
  const parseResult = chatStreamBodySchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.errors,
    });
  }
  const { tenantId, threadId } = parseResult.data;
  const content = parseResult.data.content ?? '';
  const attachments = sanitizeAttachments(parseResult.data.attachments);
  const browserEvent = browserEventOf(parseResult.data);
  if (!content && !browserEvent) {
    return res.status(400).json({
      error: 'Validation failed',
      details: [{ path: ['content'], message: 'Required' }],
    });
  }

  // 2. Resolve caller (auth + tenant role).
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    return res.status(401).json({ error: 'Account not found' });
  }
  const role = await getCallerRole(tenantId, account.id);
  if (!role) {
    // Don't confirm tenant existence to non-members.
    return res.status(404).json({ error: 'Tenant not found' });
  }

  // A view-only seat reads every conversation and starts no turn.
  if (refusedAsViewer(role, res)) return;

  // 3. Verify the thread exists and is in the caller's workspace.
  // Membership is the whole check since migration 351: an Insights thread is
  // visible to everyone in the tenant, so anybody here can carry on anybody
  // else's conversation. `role` is still resolved above because the turn itself
  // is run with it.
  const thread = await getThread(threadId, tenantId);
  if (!thread) {
    return res.status(404).json({ error: 'Thread not found' });
  }

  // 3b. A browser event is verified against the runtime's record before
  //     anything is written: the hold must be this thread's, of the claimed
  //     kind, released (a hand-back) or just made (a point), and recent. A
  //     claim that fails is a 409 the client treats as quiet: no row, no
  //     turn. What checks out is written as one status line, the person's,
  //     and rides the turn.
  let verifiedEvent: VerifiedBrowserEvent | null = null;
  if (browserEvent) {
    verifiedEvent = await verifyBrowserEvent(tenantId, threadId, browserEvent.kind, browserEvent.holdId);
    if (!verifiedEvent) {
      return res.status(409).json({ error: BROWSER_EVENT_NOT_PENDING });
    }
    await appendMessage({
      threadId,
      role: 'assistant',
      content: browserEventStatusLine(accountDisplayName(account), verifiedEvent),
      messageType: BROWSER_HANDBACK_MESSAGE_TYPE,
    });
  }

  // 4. Rate limit check.
  const rateLimit = await checkAndIncrementInsightsRateLimit(tenantId, account.id);
  if (!rateLimit.allowed) {
    if (rateLimit.retryAfter != null) {
      res.setHeader('Retry-After', String(rateLimit.retryAfter));
    }
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: rateLimit.retryAfter,
    });
  }

  // 4a. Payment gate. An assistant that can browse, read data sources and run
  //     a sandbox is running something, so it needs what running anything
  //     needs: an active plan, or a prepaid balance above the reload floor.
  //     `checkExecutionAllowed` is the one place that decides, and it fails
  //     open on a database error so a control-plane blip degrades to "allow".
  //     402 is the signal the dashboard's PlanGate modal keys on.
  const admission = await checkAssistantAdmission({ tenantId });
  if (!admission.allowed) {
    return res.status(admission.httpStatus).json({
      error: admission.error,
      ...(admission.reason ? { message: admission.reason } : {}),
    });
  }

  // 4b. A person's message cancels the work queued to continue an earlier
  //     one: every continuation still waiting for the thread (queued, and
  //     claimed but not yet under the lock). The thread lock cancels nothing
  //     on its own — a queued task simply waits for it — and a continuation
  //     already running holds the lock, so this message reaches it below as
  //     a mid-run message (ADR-041). Before the live-turn check, so the
  //     cancellation lands whichever path the message takes.
  await cancelThreadContinuations(tenantId, threadId);

  // 5. Is a turn already running on this thread?
  //
  // ORDER IS LOAD-BEARING: this check must come BEFORE the lock, or a message
  // typed mid-stream would lose the race for the lock and come back as a 409
  // instead of being delivered to the turn the person is watching.
  // An event turn without words has nothing to deliver to a running turn:
  // the next turn's Browser section carries the hand-back or the point.
  const activeTurnId = content ? await findActiveTurnId(tenantId, threadId) : null;
  if (activeTurnId) {
    const delivery = await insertTurnSignal(tenantId, activeTurnId, 'user_message', {
      // The running turn gets the attachment text too, so a file attached
      // mid-stream is read rather than quietly dropped along with the message
      // it came with.
      // A running turn reads its interrupts as text at the next loop boundary,
      // so a picture attached mid-stream is NAMED to it rather than shown. The
      // reason is stated plainly, because it is not the vision one: the model
      // may well be able to see, and there is simply no image channel here.
      text: composeTurnText(content, attachments, {
        describedMedia: toMessageMedia(attachments),
        unavailableBecause:
          'This arrived while you were already working, and a message delivered mid-run carries no image.',
      }),
      senderAccountId: account.id,
      senderDisplayName: null,
      sentAt: new Date().toISOString(),
    });
    if (delivery === 'delivered') {
      // Persist what the person said, exactly as the normal turn does, down to
      // the attachment metadata. Otherwise the message they watched being
      // accepted is missing from the transcript when the thread reloads, or
      // comes back stripped of the file it was sent with.
      const interruptMedia = toMessageMedia(attachments);
      await appendMessage({
        threadId,
        role: 'user',
        senderAccountId: account.id,
        content,
        attachments: toMessageAttachments(attachments),
        ...(interruptMedia.length > 0 ? { media: interruptMedia } : {}),
      });
      if (interruptMedia.length > 0) {
        await claimInboundMedia(
          tenantId,
          interruptMedia.map(m => m.mediaId),
          threadId,
          'insights',
        ).catch(() => {
          // Best effort, exactly as on the normal turn: a failed claim costs
          // the picture a day from now, failing the message costs it now.
        });
      }
      logAudit(
        'insights.chat_message_interrupt_delivered',
        { tenantId, userId: account.id },
        {
          threadId,
          turnId: activeTurnId,
          messageLength: content.length,
          attachmentCount: attachments.length,
        },
      );
      // Answered as an SSE frame rather than plain JSON so every chat surface
      // keeps ONE client code path for acknowledgments (ADR-041).
      //
      // This exit is why src/common/chat-stream.ts exists. `interrupt_delivered`
      // is not in the client's terminal set, and this path ended the socket
      // above the `try` whose `finally` writes `done` — so steering a running
      // turn raised "The connection dropped before the reply finished arriving."
      // every single time, on a message that HAD been delivered. The stream can
      // no longer be closed without its terminal frame.
      const ack = openChatStream(res);
      ack.send('interrupt_delivered', {});
      ack.end();
      return;
    }
    // Not delivered, so nothing is persisted here — the message falls through
    // to the normal path below and is persisted by the turn that answers it.
    // 'no_turn' means the run ended in the moment between the lookup and the
    // write, which is exactly what starting a fresh turn is for; anything else
    // lets the lock decide, and a genuinely concurrent turn still 409s.
    log.info(
      { threadId, tenantId, turnId: activeTurnId, delivery },
      'Insights mid-run message not delivered — falling through to a new turn',
    );
  }

  // 6. Take the thread. The lock row IS the in-flight registry, and it is the
  //    first act of the turn, so the turn is stoppable from this instant on.
  const turnId = newTurnId();
  let lock;
  try {
    lock = await tryAcquireTurnLock(tenantId, threadId, turnId);
  } catch (err) {
    if (err instanceof TurnLockUnavailableError) {
      log.error({ threadId, tenantId, error: err.message }, 'Insights turn lock unavailable');
      return res.status(503).json({
        error: 'Could not start a response right now. Please try again.',
      });
    }
    throw err;
  }
  if (!lock) {
    // Genuinely rare now: the interrupt path above absorbs the common case.
    return res.status(409).json({
      error: 'A response is already in progress on this conversation. Please wait for it to finish.',
    });
  }

  // 7. Open the stream. Headers and the terminal-frame guarantee both live in
  //    src/common/chat-stream.ts, so no exit below can end the socket silently.
  const stream = openChatStream(res);

  // 8. Note a client disconnect and enforce max stream duration.
  //
  // A disconnect does NOT abort the turn (ADR-041). The reply is what the turn
  // is FOR; losing the socket must not throw away work the person already paid
  // for. The loop runs to completion and persists, and the thread shows the
  // reply on the next load. Only an explicit stop aborts.
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    log.info(
      { threadId, tenantId, turnId },
      'Chat stream client disconnected — the turn continues and will persist',
    );
  };
  req.on('close', onClose);

  const heartbeat = setInterval(() => {
    if (stream.ended) return;
    // SSE comment line — clients ignore it but proxies see traffic and
    // keep the connection alive.
    stream.comment('heartbeat');
  }, HEARTBEAT_INTERVAL_MS);

  const streamOpenedAt = Date.now();
  const hardTimeout = setTimeout(() => {
    if (stream.ended) return;
    log.warn(
      { threadId, tenantId, limitMs: MAX_STREAM_DURATION_MS },
      'Chat stream hit max duration — terminating',
    );
    stream.send('error', {
      code: 'TIMEOUT',
      message: 'Response took too long and was cut off. Please try again.',
    });
    stream.end();
  }, MAX_STREAM_DURATION_MS);

  // 9. Audit log — message length only, never full content (PII).
  logAudit(
    'insights.chat_message_received',
    { tenantId, userId: account.id },
    {
      threadId,
      turnId,
      messageLength: content.length,
      attachmentCount: attachments.length,
    },
  );

  // 10. Run the chat turn and forward every event as an SSE frame.
  try {
    for await (const event of runInsightsChatTurn({
      threadId,
      tenantId,
      accountId: account.id,
      role,
      userMessage: content,
      attachments,
      // The person's name, which a hand-over forwards as the sender to
      // whichever colleague answers, exactly as Liftoff's turn does. Without
      // it a colleague brought in from here answered "A teammate".
      callerName: accountDisplayName(account),
      turnId,
      abortController: lock.abortController,
      ...(verifiedEvent ? { browserEvent: { kind: verifiedEvent.kind, holdId: verifiedEvent.holdId } } : {}),
      // The reply has to be on its way before the stream's own cutoff.
      deadlineAt: streamOpenedAt + MAX_STREAM_DURATION_MS - REPLY_CLOSING_RESERVE_MS,
    })) {
      // Keep consuming after the socket is gone — only the writes stop.
      if (stream.ended) continue;
      writeChatEventAsSse(stream, event);
    }
  } catch (err) {
    log.error(
      {
        threadId,
        tenantId,
        turnId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      'Chat stream iterator threw unexpectedly',
    );
    if (!stream.ended) {
      stream.send('error', {
        code: 'INTERNAL',
        message: 'Something went wrong. Please try again.',
      });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(hardTimeout);
    req.off('close', onClose);
    // Dropping the lock takes this turn's signals with it (foreign key,
    // ON DELETE CASCADE), so a late message cannot be picked up by whatever
    // runs next on the thread.
    await releaseTurnLock(lock);
    // The terminal `done` frame.
    //
    // Without it, EOF is the ONLY thing the client sees at the end of a stream,
    // and EOF is what it also sees when the socket is dropped underneath it.
    // `streamChatSse` cannot tell "the server finished writing" from "the
    // connection died mid-turn", so a truncated stream resolves as success and
    // the person is told nothing.
    //
    // `end()` is idempotent and writes nothing into a socket that is already
    // gone, so this is unconditional: the hard timeout above may have closed
    // first, and a `finally` that had to remember to check is exactly the shape
    // that lost the frame on the interrupt exit.
    stream.end();
    if (clientGone) {
      log.info({ threadId, tenantId, turnId }, 'Insights chat turn finished after the client left');
    }
  }
});
