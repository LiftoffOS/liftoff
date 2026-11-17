// Team Plan Chat Stream Router (Fastify SSE)
//
// POST /team-plan/chat-stream — Server-Sent Events endpoint for the CAIO
// workforce planning chat. Wraps runCAIOChatTurn() as an HTTP stream.
//
// Request body:
//   {
//     "threadId": "<uuid>",          // optional: omit for a threadless greeting
//     "content":  "<1-32000 chars>"  // optional: omit to trigger greeting mode
//   }
//
// Response: SSE stream with these event types:
//
//   event: thinking         - sent immediately
//   event: tool_call        - { tool: "workforce_plan__draft", label: "Drafting the plan" }
//                             the name is for the model; the label is what a
//                             person reads beside the activity pulse
//   event: text_delta       - { text: "..." }
//   event: content_block    - { block: VisualizationBlock }
//   event: delegation_started - { author: "...", authorLabel: "..." } the turn
//                             was handed to a colleague (the Insights Manager
//                             or Liftoff), and everything from here on is
//                             theirs. Sent once, before any of their own
//                             events, so the reply can be attributed while it
//                             streams. No closing frame follows it: `complete`,
//                             `delegation_paused` or `error` ends the
//                             delegated segment as well as the turn
//   event: delegation_paused - { author, authorLabel, delegateThreadId,
//                             reason, message } terminal, not a failure: the
//                             colleague stopped to wait on a person
//   event: complete         - { message: TeamPlanChatMessage }
//   event: interrupt_delivered - {} the message was folded into the turn
//                             already running on this thread; no new turn
//   event: error            - { code: "...", message: "..." }
//
// Heartbeat (`: heartbeat\n\n`) every 30 seconds keeps stale connections
// detectable by the client and any proxies in between.
//
// Greeting mode: when content is absent, runCAIOChatTurn enters greeting mode.
// It pre-fetches workspace context and produces a contextual greeting with
// no user message persisted.
//
// The plan page asks for that greeting with no threadId, and then nothing at
// all is persisted: a greeting nobody answered is not a conversation, so it
// does not get a thread. Whoever replies is what starts one. A greeting asked
// for WITH a threadId still behaves exactly as it did, for callers holding a
// transcript. Content without a threadId is refused — a turn that speaks needs
// somewhere to be written down.
//
// Auth via trusted headers: x-tenant-id, x-account-id, x-tenant-role.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { log } from '../infrastructure/logging.js';
import { writeAuditLog } from './audit-log.js';
import { appendMessage, getThread, type TenantMemberRole } from './chat-repository.js';
import { runCAIOChatTurn, verifyBrowserEvent, type CAIOChatServiceEvent, type VerifiedBrowserEvent } from './chat-service.js';
import {
  CALLER_NAME_HEADER,
  LIFTOFF_ORIGIN_HEADER,
  parseCallerNameHeader,
  parseOriginHeader,
} from './caller-context.js';
import { MAX_CHAT_MESSAGE_CHARS } from './context-budget.js';
import { describeChatValidationFailure } from './chat-validation.js';
import { deliverUserMessage, findLiveTurnId } from './turn-signal-repository.js';
import { checkAndIncrementTeamPlanRateLimit } from './rate-limiter.js';
// The attachment contract, published from platform-backend so this service and
// it run one implementation rather than two that drift. The schema's bounds are
// set so a message at the cap still fits a 50KB body.
import {
  attachmentsSchema,
  composeTurnText,
  sanitizeAttachments,
  toMessageMedia,
  toMessageAttachments,
} from '@liftoffos/chat-attachments';
import { claimInboundMedia } from './chat-media.js';
import { toolActivityLabel } from '@liftoffos/shared-types';

// The table name that used to sit here as `_TEAM_PLAN_RATE_LIMIT_TABLE`, unused
// since the extraction from platform-backend, now lives with the limiter that
// actually queries it (./rate-limiter.ts).
const MAX_STREAM_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_INTERVAL_MS = 30_000;
// The turn is told to close its reply this long before the stream ends: room
// for the model call in flight when the deadline passes and for the closing
// call that writes the reply.
const REPLY_CLOSING_RESERVE_MS = 90_000;

const chatStreamBodySchema = z.object({
  // Optional: absent for the greeting the plan page opens with, which has no
  // thread yet and creates none.
  threadId: z.string().uuid().optional(),
  // Optional: when absent or empty, triggers greeting mode in runCAIOChatTurn.
  content: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARS).optional(),
  // Background Liftoff wrote for this turn when it brought the CAIO into one of
  // its conversations, already framed as the note to persist. Sent only by
  // platform-backend's delegation path, and only when there is something worth
  // forwarding, so it is absent for a person typing on the CAIO page and for a
  // first request. Budgeted like `content` rather than left unbounded: it is
  // model-written prose arriving over the wire and it lands in a row somebody
  // reads.
  forwardedContext: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARS).optional(),
  // Who forwarded it: Liftoff or the Insights Manager, as the contributor the
  // note is stored with so the row is attributed to whoever wrote it. Sent
  // only beside `forwardedContext`.
  forwardedBy: z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(120) }).optional(),
  // True when this turn IS a hand-over from a colleague: the Chief AI Officer
  // is offered no colleague of its own, so a hand-over is one deep on every
  // surface. Sent only by platform-backend's delegation path.
  handover: z.boolean().optional(),
  // Files and connector references the person staged in the composer. The plan
  // page has sent this since it gained the upload button; this schema is where
  // it used to be dropped, because zod strips what it does not declare.
  attachments: attachmentsSchema.optional(),
  // The person's browser event, beside `content` (a send while they were
  // driving) or instead of it (the hand-back button, a point), naming the
  // hold the runtime recorded. Verified through platform-backend below before
  // anything is written; a claim that fails is a 409 the client treats as
  // quiet.
  browserHandback: z.object({ holdId: z.string().uuid() }).optional(),
  browserPoint: z.object({ holdId: z.string().uuid() }).optional(),
});

function sendSseEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Translate a chat-service domain event to an SSE frame. */
export function writeCAIOChatEventAsSse(
  reply: FastifyReply,
  event: CAIOChatServiceEvent,
): void {
  switch (event.type) {
    case 'thinking':
      sendSseEvent(reply, 'thinking', {});
      return;
    case 'tool_call':
      // The label is authored in @liftoffos/shared-types, the same map
      // platform-backend reads, because this stream reaches the browser
      // through a transparent proxy that cannot add one on the way past.
      sendSseEvent(reply, 'tool_call', { tool: event.tool, label: toolActivityLabel(event.tool) });
      return;
    case 'text_delta':
      sendSseEvent(reply, 'text_delta', { text: event.text });
      return;
    case 'content_block':
      sendSseEvent(reply, 'content_block', { block: event.block });
      return;
    case 'delegation_started':
      sendSseEvent(reply, 'delegation_started', {
        author: event.author,
        authorLabel: event.authorLabel,
      });
      return;
    case 'delegation_paused':
      sendSseEvent(reply, 'delegation_paused', {
        author: event.author,
        authorLabel: event.authorLabel,
        delegateThreadId: event.delegateThreadId,
        reason: event.reason,
        message: event.message,
      });
      return;
    case 'complete':
      sendSseEvent(reply, 'complete', { message: event.message });
      return;
    case 'error':
      sendSseEvent(reply, 'error', { code: event.code, message: event.message });
      return;
  }
}

export async function registerChatStreamRoutes(app: FastifyInstance): Promise<void> {
  app.post('/team-plan/chat-stream', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Validate body.
    const parseResult = chatStreamBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: describeChatValidationFailure(parseResult.error),
        details: parseResult.error.errors,
      });
    }
    const { threadId, content, forwardedContext, forwardedBy, handover } = parseResult.data;
    // Cleaned here, at the boundary, exactly as Liftoff and the Insights
    // Manager clean theirs, and by the same function. A name that can carry a
    // newline can close the `<attachment name="...">` wrapper and open another
    // one, and the wrapper's quote-escaping does not address that.
    const attachments = sanitizeAttachments(parseResult.data.attachments);
    const { browserHandback, browserPoint } = parseResult.data;
    if (browserHandback && browserPoint) {
      return reply.status(400).send({
        error: 'One browser event per turn.',
        details: [{ path: ['browserPoint'], message: 'One browser event per turn' }],
      });
    }
    const browserEvent = browserHandback
      ? { kind: 'handback' as const, holdId: browserHandback.holdId }
      : browserPoint
        ? { kind: 'point' as const, holdId: browserPoint.holdId }
        : null;
    const isGreetingMode = !content && !browserEvent;

    // A turn that says something has to have somewhere to say it. Only the
    // greeting is allowed to arrive without a thread; a browser event stands
    // in for the words and needs the thread all the same.
    if ((content || browserEvent) && !threadId) {
      return reply.status(400).send({
        error: 'A message needs a conversation to belong to.',
        details: [{ path: ['threadId'], message: 'Required when content is present' }],
      });
    }

    // 2. Resolve caller from trusted headers.
    const tenantId = request.headers['x-tenant-id'] as string | undefined;
    const accountId = request.headers['x-account-id'] as string | undefined;
    const tenantRole = request.headers['x-tenant-role'] as string | undefined;

    if (!tenantId || !accountId || !tenantRole) {
      return reply.status(401).send({
        error: 'Missing required auth headers: x-tenant-id, x-account-id, x-tenant-role',
      });
    }

    const validRoles: TenantMemberRole[] = ['owner', 'admin', 'member', 'viewer'];
    if (!validRoles.includes(tenantRole as TenantMemberRole)) {
      return reply.status(401).send({ error: `Invalid tenant role: ${tenantRole}` });
    }
    const role = tenantRole as TenantMemberRole;
    const origin = parseOriginHeader(request.headers[LIFTOFF_ORIGIN_HEADER]);
    const callerName = parseCallerNameHeader(request.headers[CALLER_NAME_HEADER]);

    // 3. Verify the thread exists and the caller can see it. A threadless
    //    greeting has nothing to check: it reads no transcript and writes to
    //    none, so the only thing it is scoped by is the tenant the headers
    //    already established.
    if (threadId) {
      const thread = await getThread(threadId, tenantId);
      if (!thread) {
        return reply.status(404).send({ error: 'Thread not found' });
      }
    }

    // 3a. A browser event is verified against the runtime's record, through
    //     platform-backend, before anything is written and before any header
    //     is flushed: the hold must be this thread's, of the claimed kind,
    //     released (a hand-back) or just made (a point), and recent. A claim
    //     that fails is a plain 409 the client treats as quiet: no row, no
    //     turn. The turn writes the status line and reads the event.
    let verifiedEvent: VerifiedBrowserEvent | undefined;
    if (browserEvent && threadId) {
      const verification = await verifyBrowserEvent({ tenantId, threadId }, browserEvent.kind, browserEvent.holdId);
      if (!verification.ok) {
        return verification.status === 409
          ? reply.status(409).send({ error: 'handback_not_pending' })
          : reply.status(503).send({ error: 'The browser record could not be read right now.' });
      }
      verifiedEvent = verification.event;
    }

    // 3b. Rate limit.
    //
    // ORDER IS LOAD-BEARING, on both sides. After the thread check, so a
    // request for a thread the caller cannot see is refused before it spends a
    // slot. Before the live-turn check and before any header is flushed, so a
    // refusal can still be a plain JSON 429 rather than an SSE error frame the
    // client has to parse out of a stream.
    //
    // Greeting mode is metered too. It sends no user message, but it still
    // runs a full CAIO turn, and a surface that is free to open is exactly the
    // one worth metering.
    //
    // Mirrors platform-backend's Liftoff chat: 429 with Retry-After.
    const rateLimit = await checkAndIncrementTeamPlanRateLimit(tenantId, accountId);
    if (!rateLimit.allowed) {
      if (rateLimit.retryAfter != null) {
        reply.header('Retry-After', String(rateLimit.retryAfter));
      }
      return reply.status(429).send({
        error: 'Rate limit exceeded',
        retryAfter: rateLimit.retryAfter,
      });
    }

    // 3c. A person's message cancels the work queued to continue an earlier
    //     one: every continuation still waiting for the thread (queued, and
    //     claimed but not yet running). A running one holds the turn, and
    //     this message reaches it below as a mid-run message.
    if (threadId && content) {
      const { cancelThreadContinuations } = await import('./chat-continuations.js');
      await cancelThreadContinuations(tenantId, threadId);
    }

    // 4. Is a turn already running on this thread?
    //
    // ORDER IS LOAD-BEARING: this runs BEFORE anything starts a second turn.
    // A message typed while the reply is streaming belongs to the reply the
    // person is watching; starting another turn would have two of them
    // appending to one transcript, arguing with each other.
    //
    // A threadless greeting cannot collide with anything: there is no
    // transcript for a second turn to append to, and it claims no turn of its
    // own. The `threadId &&` below is also what narrows the type for the
    // delivery path, which only exists when there is a thread.
    const liveTurnId = threadId ? await findLiveTurnId(tenantId, threadId) : null;
    if (threadId && liveTurnId) {
      if (!content) {
        // Greeting mode has nothing to deliver, so there is nothing to do but
        // wait for the turn in flight.
        return reply.status(409).send({
          error: 'A response is already in progress on this conversation. Please wait for it to finish.',
        });
      }
      const delivery = await deliverUserMessage(tenantId, liveTurnId, {
        // The running turn gets the attachment text too, so a file attached
        // mid-stream is read rather than quietly dropped along with the message
        // it came with.
        // A running turn reads its interrupts as text at the next loop
        // boundary, so a picture attached mid-stream is NAMED to it rather than
        // shown. The reason is stated plainly, because it is not the vision
        // one: the model may well be able to see, and there is simply no image
        // channel on this path. Saying nothing would let it answer about a
        // screenshot it never received.
        text: composeTurnText(content, attachments, {
          describedMedia: toMessageMedia(attachments),
          unavailableBecause:
            'This arrived while you were already working, and a message delivered mid-run carries no image.',
        }),
        senderAccountId: accountId,
        senderDisplayName: null,
      });
      if (delivery === 'delivered') {
        // Persisted here rather than by the turn, exactly as the normal path
        // does it, down to the attachment metadata: otherwise the message the
        // person watched being accepted is missing from the transcript when the
        // thread reloads, or comes back stripped of the file it was sent with.
        const interruptMedia = toMessageMedia(attachments);
        await appendMessage({
          threadId,
          tenantId,
          role: 'user',
          senderAccountId: accountId,
          content,
          attachments: toMessageAttachments(attachments),
          ...(interruptMedia.length > 0 ? { media: interruptMedia } : {}),
        });
        if (interruptMedia.length > 0) {
          // Best effort, exactly as on the normal turn: a failed claim costs
          // the picture a day from now, failing the message costs it now.
          void claimInboundMedia(tenantId, threadId, interruptMedia.map(m => m.mediaId));
        }
        void writeAuditLog(
          'workforce_plans.chat_message_interrupt_delivered',
          { tenantId, userId: accountId },
          {
            threadId,
            turnId: liveTurnId,
            messageLength: content.length,
            attachmentCount: attachments.length,
          },
        );
        // Answered as an SSE frame rather than plain JSON so every chat surface
        // keeps ONE client code path for acknowledgments (ADR-041).
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');
        reply.raw.setHeader('Content-Encoding', 'identity');
        reply.raw.flushHeaders();
        sendSseEvent(reply, 'interrupt_delivered', {});
        reply.raw.end();
        return reply;
      }
      // Nothing was delivered and nothing was persisted. 'no_turn' means the
      // run ended in the moment between the lookup and the write, which is
      // exactly what a fresh turn is for, so fall through and answer normally.
      log.info(
        { threadId, tenantId, turnId: liveTurnId, delivery },
        'CAIO mid-run message not delivered - falling through to a new turn',
      );
    }

    // 5. SSE response headers.
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('Content-Encoding', 'identity');
    reply.raw.flushHeaders();

    // 6. Note a client disconnect and enforce max duration.
    //
    // A disconnect does NOT end the turn (ADR-041). The reply is what the turn
    // is FOR; losing the socket must not throw away work the person already
    // paid for, and the assistant message is persisted after the loop. The turn
    // runs to completion and the thread shows the reply on the next load. Only
    // an explicit stop ends it early.
    let clientGone = false;
    const onClose = () => {
      clientGone = true;
      log.info(
        { threadId, tenantId },
        'CAIO chat stream client disconnected - the turn continues and will persist',
      );
    };
    request.raw.on('close', onClose);

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(': heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    const streamOpenedAt = Date.now();
    const hardTimeout = setTimeout(() => {
      if (reply.raw.writableEnded) return;
      log.warn(
        { threadId, tenantId, limitMs: MAX_STREAM_DURATION_MS },
        'CAIO chat stream hit max duration - terminating',
      );
      sendSseEvent(reply, 'error', {
        code: 'TIMEOUT',
        message: 'Response took too long and was cut off. Please try again.',
      });
      reply.raw.end();
    }, MAX_STREAM_DURATION_MS);

    // 7. Audit log.
    void writeAuditLog(
      isGreetingMode
        ? 'workforce_plans.greeting_stream_started'
        : 'workforce_plans.chat_message_received',
      { tenantId, userId: accountId },
      {
        threadId,
        messageLength: content?.length ?? 0,
        attachmentCount: attachments.length,
      },
    );

    // 8. Run the CAIO chat turn and forward every event as an SSE frame.
    try {
      for await (const event of runCAIOChatTurn({
        threadId: threadId ?? null,
        tenantId,
        accountId,
        role,
        userMessage: content,
        attachments,
        forwardedContext: forwardedContext ?? null,
        // The forwarder rides with the note and nowhere else.
        forwardedBy: forwardedContext && forwardedBy ? forwardedBy : null,
        ...(handover ? { handover: true } : {}),
        ...(origin ? { origin } : {}),
        // The person's name, for the prompt's caller line and for a colleague
        // the Chief AI Officer brings in, which attributes the message to it.
        ...(callerName ? { callerName } : {}),
        ...(verifiedEvent ? { browserEvent: verifiedEvent } : {}),
        replyDeadlineAt: streamOpenedAt + MAX_STREAM_DURATION_MS - REPLY_CLOSING_RESERVE_MS,
      })) {
        // Keep consuming after the socket is gone - only the writes stop.
        if (reply.raw.writableEnded) continue;
        writeCAIOChatEventAsSse(reply, event);
      }
    } catch (err) {
      log.error(
        {
          threadId,
          tenantId,
          error: (err as Error).message,
          stack: (err as Error).stack,
        },
        'CAIO chat stream iterator threw unexpectedly',
      );
      if (!reply.raw.writableEnded) {
        sendSseEvent(reply, 'error', {
          code: 'INTERNAL',
          message: 'Something went wrong. Please try again.',
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(hardTimeout);
      request.raw.off('close', onClose);
      // A final `done` frame, the same one every other chat surface sends.
      //
      // Without it, EOF is the ONLY end-of-stream signal the client gets, and
      // EOF is byte-identical to a socket dropped mid-turn. The shared client
      // (liftoff-react services/chatSse.ts) cannot then tell "the server
      // finished writing" from "the connection died", so a truncated stream
      // resolves as a success and the person is told nothing.
      if (!reply.raw.writableEnded) {
        reply.raw.write('event: done\ndata: {}\n\n');
        reply.raw.end();
      }
      if (clientGone) {
        log.info({ threadId, tenantId }, 'CAIO chat turn finished after the client left');
      }
    }

    return reply;
  });
}
