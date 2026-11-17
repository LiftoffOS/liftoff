// Agent Chat Stream Router
//
// POST /api/agent-chat/:agentId/chat-stream — Server-Sent Events endpoint for
// the agent chat web UI. Wraps runAgentChatTurn() as an HTTP stream.
//
// Request body:
//   {
//     "tenantId": "<uuid>",
//     "threadId": "<uuid>",      // optional: omit for a threadless greeting
//     "content":  "<1-4000 chars>"  // optional: omit to ask for the greeting
//   }
//
// Omitting both is how a chat page opens: the greeting is streamed and nothing
// is written down, so a visit nobody typed into leaves no thread behind. The
// first message the person sends is what creates the conversation. Content
// without a threadId is a 400 — a turn that speaks needs somewhere to be
// recorded.
//
// Response: SSE stream with these event types (one per line pair):
//
//   event: thinking         — sent immediately
//   event: tool_call        — { tool: "some_tool_name" }
//   event: text_delta       — { text: "..." }
//   event: text_break       — {} (one assistant message ended)
//   event: hitl_required    — { approvalId: "...", reason: "..." }
//   event: complete         — { message: AgentChatMessage }
//   event: error            — { code: "...", message: "..." }
//   event: done             — {} the LAST frame of every shape of this stream,
//                             the greeting included. EOF on its own is
//                             byte-identical to a socket that died mid-turn, so
//                             its absence is what the client reports as a
//                             dropped connection. Written by
//                             src/common/chat-stream.ts, never here.
//
// Streams every 30 seconds send a SSE comment line (`: heartbeat\n\n`) so
// stale connections are detected by the client and any proxies in between.
//
// Hard limits:
//   - Stream max duration: 5 minutes
//   - Body size: 50KB
//   - Message content: 4000 chars (enforced by Zod)

import { Router, type Request, type Response, json as expressJson } from 'express';
import { z } from 'zod';
import { attachmentsSchema, sanitizeAttachments } from '../chat-attachments';
import { log, logAudit } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import { checkChatAdmission } from './admission';
import { type AgentChatEvent } from './chat-service';
import { runMultiAgentChatTurn, extractMentionedAgentIds, type MultiAgentChatEvent as _MultiAgentChatEvent } from './multi-agent-service';
import { liftoffifyString } from '../branding/registry';
import * as chatRepo from './chat-repository';
import { timeOfDayGreeting } from './greeting';
import { accountDisplayName } from '../accounts/display-name';
import { BROWSER_HANDBACK_MESSAGE_TYPE, BROWSER_POINT_MESSAGE_TYPE } from './hitl-status-message';
import { openChatStream, type ChatStream } from '../common/chat-stream';
import { toolActivityLabel } from '../common/tool-activity-label';
import {
  BROWSER_EVENT_NOT_PENDING,
  browserEventBodySchema,
  browserEventExternalRef,
  browserEventOf,
  browserEventStatusLine,
  verifyBrowserEvent,
  type VerifiedBrowserEvent,
} from '../browser-sessions/handback';
import { refusedAsViewer } from '../common/agent-conversation-gate';

export const agentChatStreamRouter = Router();
const accountService = new AccountService();

// Same 50KB body limit as other chat surfaces.
agentChatStreamRouter.use(expressJson({ limit: '50kb' }));

// Outermost application-level cap, sized to sit just inside platform-backend's
// own 900s Cloud Run request timeout and just outside the TR-facing abort
// (870s) so the inner, result-preserving timeouts fire first.
const MAX_STREAM_DURATION_MS = 880 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;

// `threadId` is optional because a greeting has no home yet. Opening a team's
// chat page asks for the greeting before any thread exists, and the answer is
// not persisted, so the first thing the person actually sends is what creates
// the conversation. `content` without a `threadId` is refused below: a real
// turn always has somewhere to be written down.
const chatStreamBodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
  content: z.string().min(1).max(4000).optional(),
  // The client has sent this field since attachments existed. This schema did
  // not declare it, and zod strips what it does not declare — so every file
  // and every connector reference attached on a TEAM chat was dropped at the
  // door, silently, while the composer showed a chip and the person watched
  // their document be accepted. The other two chat surfaces have always
  // declared it; this one never did.
  attachments: attachmentsSchema.optional(),
  // The person's browser event, beside `content` (a send while they were
  // driving) or instead of it (the hand-back button, a point). Verified
  // against the runtime's record below before anything is written.
  browserHandback: browserEventBodySchema.optional(),
});

/** Translate an agent chat domain event to an SSE frame.
 *
 *  Takes the ChatStream rather than the response. Unlike Liftoff and Insights,
 *  this router never lost the terminal frame: its `interrupt_delivered` is a
 *  domain event that reaches the `finally` below rather than an early exit of its
 *  own. That is luck, not design — nothing held it there — and adopting the
 *  wrapper is what stops it being luck. See src/common/chat-stream.ts. */
export function writeAgentChatEventAsSse(stream: ChatStream, event: AgentChatEvent): void {
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
    case 'text_break':
      stream.send('text_break', {});
      return;
    case 'hitl_required':
      stream.send('hitl_required', {
        approvalId: event.approvalId,
        reason: event.reason,
        routedTo: event.routedTo ?? [],
        routedToAccountIds: event.routedToAccountIds ?? [],
        routedToAdmins: event.routedToAdmins ?? false,
        unassigned: event.unassigned ?? false,
        hitlLevel: event.hitlLevel ?? 2,
      });
      return;
    case 'host_delivered':
      // Straight to the browser, unpersisted. The values never entered model
      // context and must not enter the transcript either — see chat-service.
      stream.send('host_delivered', { tool: event.tool, fields: event.fields });
      return;
    case 'delegation_started':
      // The same frame Liftoff sends for a hand-over, so the client attributes
      // a live reply through one handler on every surface: a chip for the
      // teammate on the bubble, and "Working with <name>" on the activity line
      // until the parent's own text resumes.
      stream.send('delegation_started', { author: event.author, authorLabel: event.authorLabel });
      return;
    case 'delegation_paused':
      // Not terminal and not an error: the parent's turn keeps streaming after
      // this. The client uses it to refresh the transcript (the status row
      // naming the waiting team was just persisted) and to surface the way to
      // the review queue, where the decision is waiting.
      stream.send('delegation_paused', {
        agentName: event.agentName,
        approvalId: event.approvalId,
        reason: liftoffifyString(event.reason),
      });
      return;
    case 'awaiting_input':
      stream.send('awaiting_input', {
        question: event.question,
        sessionId: event.sessionId,
      });
      return;
    case 'complete':
      stream.send('complete', { message: event.message });
      return;
    case 'interrupt_delivered':
      stream.send('interrupt_delivered', {});
      return;
    case 'clarification_accepted':
      stream.send('clarification_accepted', {});
      return;
    case 'stop_acknowledged':
      stream.send('stop_acknowledged', {});
      return;
    case 'error':
      stream.send('error', {
        code: liftoffifyString(event.code),
        message: liftoffifyString(event.message),
      });
      return;
  }
}

agentChatStreamRouter.post(
  '/:agentId/chat-stream',
  async (req: Request, res: Response) => {
    // 1. Validate body.
    const parseResult = chatStreamBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }
    const { tenantId, threadId, content } = parseResult.data;
    // Sanitized on the same shared path as every other surface: one answer to
    // what a control character is, so two chat surfaces cannot start
    // disagreeing about the same file name.
    const attachments = sanitizeAttachments(parseResult.data.attachments);
    const { agentId } = req.params;
    const browserEvent = browserEventOf(parseResult.data);

    // A turn that says something has to have somewhere to say it. Only the
    // greeting is allowed to arrive without a thread.
    if ((content || browserEvent) && !threadId) {
      return res.status(400).json({
        error: 'Validation failed',
        details: [{ path: ['threadId'], message: 'Required when content is present' }],
      });
    }

    // 2. Resolve caller (auth + tenant membership).
    const firebaseUid = req.ctx?.userId;
    if (!firebaseUid) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const account = await accountService.getByFirebaseUid(firebaseUid);
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    // 3. Verify tenant membership.
    const membership = await tenantMembersService.getMembership(
      tenantId,
      account.id,
    );
    if (!membership) {
      // Don't confirm tenant existence to non-members.
      return res.status(404).json({ error: 'Tenant not found' });
    }

    // A view-only seat reads every conversation and starts no turn.
    if (refusedAsViewer(membership.role, res)) return;

    // 4-6. Shared admission (plan v6.1 Phase 5a): agent existence, durable
    // rate limit, execution guard — extracted to agent-chat/admission.ts so
    // the MCP chat path runs the IDENTICAL checks. Response codes preserved.
    const admission = await checkChatAdmission({ tenantId, accountId: account.id, agentId });
    if (!admission.allowed) {
      if (admission.retryAfter != null) {
        res.setHeader('Retry-After', String(admission.retryAfter));
      }
      return res.status(admission.httpStatus).json({
        error: admission.error,
        ...(admission.retryAfter != null ? { retryAfter: admission.retryAfter } : {}),
        ...(admission.reason != null ? { reason: admission.reason } : {}),
      });
    }

    const isGreetingMode = (!content || content.trim().length === 0) && !browserEvent;

    // 7. A browser event is verified against the runtime's record BEFORE the
    //    stream opens, so a claim that fails is a plain 409 the client treats
    //    as quiet: no row, no turn. What checks out is written once as a
    //    status line (idempotent on the hold, so a replay adds nothing) and
    //    then rides the turn to the runtime.
    let verifiedEvent: VerifiedBrowserEvent | null = null;
    if (browserEvent) {
      verifiedEvent = await verifyBrowserEvent(tenantId, threadId!, browserEvent.kind, browserEvent.holdId);
      if (!verifiedEvent) {
        return res.status(409).json({ error: BROWSER_EVENT_NOT_PENDING });
      }
      const displayName = accountDisplayName(account);
      await chatRepo.appendStatusRowOnce(
        tenantId,
        threadId!,
        browserEventStatusLine(displayName, verifiedEvent),
        BROWSER_HANDBACK_MESSAGE_TYPE,
        browserEventExternalRef(verifiedEvent),
      );
    }

    // 8. Open the stream. Headers and the terminal-frame guarantee both live in
    //    src/common/chat-stream.ts, so no exit below can end the socket silently.
    const stream = openChatStream(res);

    // 9. Track client disconnect and enforce max stream duration.
    let aborted = false;
    const onClose = () => {
      aborted = true;
      log.info({ threadId, tenantId, agentId }, 'Agent chat stream client disconnected');
    };
    req.on('close', onClose);

    const heartbeat = setInterval(() => {
      if (aborted || stream.ended) return;
      // SSE comment line — clients ignore it but proxies see traffic and
      // keep the connection alive.
      stream.comment('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    const hardTimeout = setTimeout(() => {
      if (aborted || stream.ended) return;
      log.warn(
        { threadId, tenantId, agentId, limitMs: MAX_STREAM_DURATION_MS },
        'Agent chat stream hit max duration — terminating',
      );
      aborted = true;
      stream.send('error', {
        code: 'TIMEOUT',
        message: 'Response took too long and was cut off. Please try again.',
      });
      stream.end();
    }, MAX_STREAM_DURATION_MS);

    try {
      if (isGreetingMode) {
        logAudit(
          'agent_chat.greeting_requested',
          { tenantId, userId: account.id },
          { threadId, agentId },
        );

        const greetingText = timeOfDayGreeting(account.timezone);

        // A greeting nobody answered is not a conversation, so a threadless
        // one is not written down. It is said, and if the person leaves
        // without replying there is nothing behind them: no row, no
        // "Untitled chat" in Chat History, no unread badge with nothing to
        // open. A greeting asked for on an existing thread still persists —
        // that caller (MCP, and any non-web surface) has a transcript to
        // append to and expects the message back.
        const message = threadId
          ? await chatRepo.appendMessage(
              tenantId,
              threadId,
              'assistant',
              greetingText,
              agentId,
            )
          : null;

        stream.send('text_delta', { text: greetingText });
        stream.send('complete', { message });
      } else {
        // Normal chat turn: extract mentions and run the agent.
        logAudit(
          'agent_chat.message_received',
          { tenantId, userId: account.id },
          { threadId, agentId, messageLength: content?.length ?? 0, ...(verifiedEvent ? { browserEvent: verifiedEvent.kind } : {}) },
        );

        const userDisplayName = [account.firstName, account.lastName]
          .filter(Boolean)
          .join(' ') || 'User';

        // Extract @mentions from the message for multi-agent routing.
        // Load thread participants to cross-reference mentions against known agents.
        // Non-null by the validation above: this branch has content, and
        // content without a threadId was refused with a 400.
        const participants = await chatRepo.getParticipants(threadId!);
        const participantAgentIds = participants.map(p => p.agentId);
        const mentionedAgentIds = extractMentionedAgentIds(content ?? '', participantAgentIds);

        for await (const event of runMultiAgentChatTurn({
          tenantId,
          agentId,
          threadId: threadId!,
          userId: account.id,
          senderAccountId: account.id,
          // The only chat entry point that can be delegated. Slack, Teams and
          // MCP are service paths with no operator behind them. The turn is
          // still attributed to the customer everywhere it is rendered; this
          // records, internally, that support was the one typing.
          impersonatedBy: req.delegation?.actorAccountId ?? null,
          userDisplayName,
          userRole: membership.role,
          content: content ?? '',
          attachments,
          channelHint: 'web',
          mentionedAgentIds,
          ...(verifiedEvent ? { browserEvent: { kind: verifiedEvent.kind, holdId: verifiedEvent.holdId } } : {}),
        })) {
          if (aborted || stream.ended) break;
          writeAgentChatEventAsSse(stream, event as AgentChatEvent & { agentId?: string; type: string });
        }
      }
    } catch (err) {
      log.error(
        {
          threadId,
          tenantId,
          agentId,
          error: (err as Error).message,
          stack: (err as Error).stack,
        },
        'Agent chat stream iterator threw unexpectedly',
      );
      if (!aborted && !stream.ended) {
        stream.send('error', {
          code: 'INTERNAL',
          message: 'Something went wrong. Please try again.',
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(hardTimeout);
      req.off('close', onClose);
      // The terminal `done` frame, so the client knows the stream ended cleanly
      // rather than under it. `end()` is idempotent and writes nothing into a
      // socket that is already gone, so this is unconditional.
      stream.end();
    }
  },
);
