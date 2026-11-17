// Agent Chat Router
//
// Thread CRUD + message listing + feedback for the agent chat surface.
// Standard REST router — JSON in, JSON out. The SSE streaming endpoint lives
// in stream-router.ts.
//
// Permission model: any tenant member can chat with any active agent in their
// tenant. Thread visibility is scoped to tenant_id (simpler than insights,
// which has role-based visibility). Cross-tenant lookups are indistinguishable
// from "not found".

import { Router, json as expressJson, type Request, type Response } from 'express';
import { z } from 'zod';
import { log, logAudit } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import { TenantRuntimeClient } from '../connectors/tenant-runtime-client';
import * as chatRepo from './chat-repository';
import { describeApprovalRoute } from './approval-route-description';
import { canApproveHitl } from '../tenant-members/permissions';
import * as presenceRepo from './presence-repository';
import * as turnEventsRepo from './turn-events-repository';
import { refusedAsViewer } from '../common/agent-conversation-gate';
import type { TenantMemberRole } from '../tenant-members/types';

export const agentChatRouter = Router();
const accountService = new AccountService();

// 50KB body limit — consistent with other chat surfaces.
agentChatRouter.use(expressJson({ limit: '50kb' }));

// ── Input validation schemas ────────────────────────────────────────────

const tenantIdQuerySchema = z.object({
  tenantId: z.string().uuid(),
});

const threadCreateBodySchema = z.object({
  tenantId: z.string().uuid(),
  channel: z.enum(['web', 'slack', 'teams']).optional().default('web'),
  title: z.string().max(500).optional(),
});

const threadListQuerySchema = z.object({
  tenantId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const messageListQuerySchema = z.object({
  tenantId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const turnEventsQuerySchema = z.object({
  tenantId: z.string().uuid(),
  turnId: z.string().uuid(),
  after: z.coerce.number().int().min(0).optional(),
});

const presenceBodySchema = z.object({
  tenantId: z.string().uuid(),
  state: z.enum(['viewing', 'typing']),
});

const markReadBodySchema = z.object({
  tenantId: z.string().uuid(),
});

const feedbackBodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  messageId: z.string().uuid(),
  feedbackType: z.enum(['thumbs_up', 'thumbs_down', 'text', 'correction', 'positive', 'preference']),
  content: z.string().max(2000).optional().default(''),
});

/**
 * Map frontend feedback types to the tenant runtime's vocabulary.
 * The frontend sends thumbs_up/thumbs_down/text; the tenant runtime
 * expects correction/positive/preference for proper memory type tagging.
 */
function mapFeedbackType(frontendType: string): string {
  switch (frontendType) {
    case 'thumbs_up': return 'positive';
    case 'thumbs_down': return 'correction';
    case 'text': return 'preference';
    default: return frontendType; // Already in runtime format (correction/positive/preference)
  }
}

// ── Helper: resolve caller's account + tenant membership ────────────────
//
// Every endpoint needs the caller's accountId (mapped from Firebase UID)
// and confirmation they're a member of the tenant. Returning a
// discriminated union so handlers can early-return on errors in one line.

interface CallerContext {
  accountId: string;
  tenantId: string;
  displayName: string;
  /** Workspace role. Needed wherever authority matters and not just membership,
   *  e.g. deciding whether a paused thread is this reader's to clear, or
   *  whether this seat may start a turn at all. */
  role: TenantMemberRole;
}

type CallerResolution =
  | { ok: true; caller: CallerContext }
  | { ok: false; status: number; error: string };

async function resolveCaller(
  firebaseUid: string | undefined,
  tenantId: string,
): Promise<CallerResolution> {
  if (!firebaseUid) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    return { ok: false, status: 401, error: 'Account not found' };
  }

  const membership = await tenantMembersService.getMembership(
    tenantId,
    account.id,
  );
  if (!membership) {
    // Don't confirm tenant existence to non-members.
    return { ok: false, status: 404, error: 'Tenant not found' };
  }

  const displayName =
    [account.firstName, account.lastName].filter(Boolean).join(' ') || 'User';

  return {
    ok: true,
    caller: { accountId: account.id, tenantId, displayName, role: membership.role },
  };
}

// ── GET /unread-counts — threads with an unread reply, per team ──────────
//
// One call answers the badge on every team at once, for this caller across the
// whole tenant. The teams list would otherwise ask per row, and the chat page
// would ask again for the team it is on: same question, three granularities,
// one query.
//
// KEEP THIS REGISTERED FIRST. It is a single-segment path, so a `GET /:agentId`
// added above it would swallow it and answer with that handler instead. No such
// route exists today (every route here is `/:agentId/stop`, `/:agentId/threads`
// or deeper), and this comment is what stops one being added in front of it.

agentChatRouter.get(
  '/unread-counts',
  async (req: Request, res: Response) => {
    try {
      const parseResult = tenantIdQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId } = parseResult.data;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      const counts = await chatRepo.getUnreadCountsByAgent(
        tenantId,
        resolution.caller.accountId,
      );
      return res.json({ counts });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to get agent chat unread counts',
      );
      return res.status(500).json({ error: 'Failed to get unread counts' });
    }
  },
);

// ── POST /:agentId/stop — stop the run active on a thread ───────────────

const stopBodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
});

agentChatRouter.post(
  '/:agentId/stop',
  async (req: Request, res: Response) => {
    try {
      const parseResult = stopBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, threadId } = parseResult.data;
      const caller = await resolveCaller(req.ctx?.userId, tenantId);
      if (!caller.ok) {
        return res.status(caller.status).json({ error: caller.error });
      }
      const runtime = new TenantRuntimeClient();
      const result = await runtime.signalStopChatTurn(tenantId, {
        agentId: req.params.agentId,
        threadId,
        senderAccountId: caller.caller.accountId,
        userDisplayName: caller.caller.displayName,
      });
      logAudit(
        'agent_chat.stop_requested',
        { tenantId, userId: caller.caller.accountId },
        { threadId, agentId: req.params.agentId, deliveredAs: result.deliveredAs },
      );
      return res.json(result);
    } catch (err) {
      log.error(
        { error: (err as Error).message, agentId: req.params.agentId },
        'agent chat stop failed',
      );
      return res.status(502).json({ error: 'Could not reach your agent right now. Please try again.' });
    }
  },
);

// ── POST /:agentId/threads — Create thread ──────────────────────────────

agentChatRouter.post(
  '/:agentId/threads',
  async (req: Request, res: Response) => {
    try {
      const parseResult = threadCreateBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, channel, title } = parseResult.data;
      const { agentId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }
      const { caller } = resolution;

      // A view-only seat reads every conversation and starts no turn.
      if (refusedAsViewer(caller.role, res)) return;

      // Create thread and add the agent as the initial participant.
      const thread = await chatRepo.createThread(
        tenantId,
        caller.accountId,
        channel,
        undefined,
        title,
      );
      await chatRepo.addParticipant(thread.id, agentId, caller.accountId, 'lead');

      logAudit(
        'agent_chat.thread_created',
        { tenantId, userId: caller.accountId },
        { threadId: thread.id, agentId },
      );

      // Note: `tenant.internal_agent.chat_started` is deliberately not published
      // here: the tenant runtime has no handler, so the event would fall through
      // to the subscriber switch's `default:` case and emit "Unknown event type"
      // warnings on every chat thread creation while costing one Pub/Sub
      // message per turn. If a future
      // observability use-case needs it, re-add WITH a matching handler in
      // liftoff-tenant-runtime/src/events/subscriber.ts (and ensure the
      // stale-after-delete gate covers it — see EVENT_PUBLISHING_CHECKLIST.md).

      return res.status(201).json({ thread, messages: [] });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to create agent chat thread',
      );
      return res.status(500).json({ error: 'Failed to create thread' });
    }
  },
);

// ── GET /:agentId/threads — List threads ─────────────────────────────────

agentChatRouter.get(
  '/:agentId/threads',
  async (req: Request, res: Response) => {
    try {
      const parseResult = threadListQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, cursor, limit } = parseResult.data;
      const { agentId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }
      const { caller } = resolution;

      const result = await chatRepo.listThreads(tenantId, caller.accountId, {
        agentId,
        cursor,
        limit,
      });

      return res.json({
        threads: result.threads,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to list agent chat threads',
      );
      return res.status(500).json({ error: 'Failed to list threads' });
    }
  },
);

// ── GET /:agentId/threads/:threadId — Get single thread ──────────────────

agentChatRouter.get(
  '/:agentId/threads/:threadId',
  async (req: Request, res: Response) => {
    try {
      const queryParse = tenantIdQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: queryParse.error.errors,
        });
      }
      const { tenantId } = queryParse.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      return res.json(thread);
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to get agent chat thread',
      );
      return res.status(500).json({ error: 'Failed to get thread' });
    }
  },
);

// ── DELETE /:agentId/threads/:threadId — Soft delete ─────────────────────

agentChatRouter.delete(
  '/:agentId/threads/:threadId',
  async (req: Request, res: Response) => {
    try {
      const queryParse = tenantIdQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: queryParse.error.errors,
        });
      }
      const { tenantId } = queryParse.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      const deleted = await chatRepo.deleteThread(threadId, tenantId);
      if (!deleted) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      logAudit(
        'agent_chat.thread_deleted',
        { tenantId, userId: resolution.caller.accountId },
        { threadId },
      );

      return res.json({ deleted: true });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to delete agent chat thread',
      );
      return res.status(500).json({ error: 'Failed to delete thread' });
    }
  },
);

// ── GET /:agentId/threads/:threadId/messages — List messages ─────────────

agentChatRouter.get(
  '/:agentId/threads/:threadId/messages',
  async (req: Request, res: Response) => {
    try {
      const parseResult = messageListQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, cursor, limit } = parseResult.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      // Verify the thread exists in this tenant before listing messages.
      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const result = await chatRepo.listMessages(threadId, tenantId, {
        cursor,
        limit,
      });

      return res.json({
        messages: result.messages,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to list agent chat messages',
      );
      return res.status(500).json({ error: 'Failed to list messages' });
    }
  },
);

// ── POST /:agentId/threads/:threadId/presence — Heartbeat + roster ───────
//
// One call per poll: records that the caller is on this thread, then returns
// everyone currently on it plus the newest message timestamp. Combining the
// write and the read halves the request count for a surface that polls every
// few seconds, and means a viewer can never read a roster that does not yet
// contain themselves.
//
// `latestMessageAt` rides along so a second viewer notices somebody else's
// message landed. Without it the message list would need its own poll: it has
// no refetchInterval and window-focus refetching is off globally, so today a
// second person sees a stale thread until they reload.

agentChatRouter.post(
  '/:agentId/threads/:threadId/presence',
  async (req: Request, res: Response) => {
    try {
      const parseResult = presenceBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, state } = parseResult.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      // Same ownership gate as the message list: presence must not reveal that
      // a thread exists in another tenant.
      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const presence = await presenceRepo.heartbeatAndListPresence(
        tenantId,
        threadId,
        resolution.caller.accountId,
        state,
      );
      return res.json(presence);
    } catch (error) {
      log.error('Failed to record chat presence', {
        error: (error as Error).message,
      });
      return res.status(500).json({ error: 'Failed to record presence' });
    }
  },
);

// ── POST /:agentId/threads/read-all — Mark this team's threads read ──────
//
// Backs the history modal's "Mark All Read" on one agent's chat. Read state
// is per account, so this never changes what a colleague sees. An agentId
// from another workspace matches no thread, so it marks nothing.

agentChatRouter.post(
  '/:agentId/threads/read-all',
  async (req: Request, res: Response) => {
    try {
      const parseResult = markReadBodySchema.safeParse(req.body);
      const paramsResult = z.object({ agentId: z.string().uuid() }).safeParse(req.params);
      if (!parseResult.success || !paramsResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: [
            ...(parseResult.success ? [] : parseResult.error.errors),
            ...(paramsResult.success ? [] : paramsResult.error.errors),
          ],
        });
      }
      const { tenantId } = parseResult.data;
      const { agentId } = paramsResult.data;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      await chatRepo.markAllThreadsRead(tenantId, resolution.caller.accountId, agentId);
      return res.status(204).send();
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to mark all agent chat threads read',
      );
      return res.status(500).json({ error: 'Failed to mark threads read' });
    }
  },
);

// ── POST /:agentId/threads/:threadId/read — Mark this thread read ────────
//
// Mirrors the presence routes: same key shape, same ownership gate, same
// "the caller is whoever the request authenticated as" rule — the marker is
// per account, so it can never be set on somebody else's behalf.
//
// Unlike presence, this is durable. Presence rows are deleted on leave, which
// is exactly why read state could not live there.

agentChatRouter.post(
  '/:agentId/threads/:threadId/read',
  async (req: Request, res: Response) => {
    try {
      const parseResult = markReadBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId } = parseResult.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      // Same ownership gate as the message list: a thread in another tenant
      // must be indistinguishable from one that does not exist.
      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      await chatRepo.markThreadRead(tenantId, resolution.caller.accountId, threadId);
      return res.status(204).send();
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to mark agent chat thread read',
      );
      return res.status(500).json({ error: 'Failed to mark thread read' });
    }
  },
);

// ── GET /:agentId/threads/:threadId/pending-approval — Is this mine to clear? ──
//
// Drives the chat banner, which is a call to action and so must render only for
// people who can actually act. The persisted status message already tells
// everyone else that the thread is blocked and who it is waiting on.
//
// This exists because the banner used to be fed solely by the `hitl_required`
// SSE event, which reaches exactly one client: the person whose turn tripped the
// gate. An assignee who simply opened the thread got nothing, and a reload wiped
// it even for the person who did trigger it. Outstanding state, not an event, is
// the right source for "you still owe someone a decision".
agentChatRouter.get(
  '/:agentId/threads/:threadId/pending-approval',
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      if (!tenantId) {
        return res.status(400).json({ error: 'tenantId query parameter required' });
      }
      const { agentId, threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const runtime = new TenantRuntimeClient();

      // Asked for by thread, not found by scanning the queue. This used to read
      // the first hundred queue items and look for a match: for a tenant with a
      // long queue the approval blocking this very conversation sat past that
      // page, and the reader whose turn was stalled saw no banner at all.
      //
      // Approvals only started carrying a thread in tenant-runtime migration
      // 327, so anything older simply never matches — acceptable, since
      // approvals expire in 24 hours.
      const mine = await runtime.getApprovalForThread(tenantId, threadId, agentId);
      if (!mine) {
        return res.json({ approval: null });
      }

      const hitlLevel = (mine.hitlLevel || 2) as 1 | 2;
      const route = await describeApprovalRoute(tenantId, agentId, hitlLevel);
      const canApprove = canApproveHitl(resolution.caller.role, hitlLevel);
      const isForYou = route.accountIds.includes(resolution.caller.accountId);

      // Only surface it when the reader has something to do. Being able to
      // approve is not enough on its own: an admin in a large workspace would
      // otherwise get a banner for every team, which is how a call to action
      // becomes wallpaper. Being asked, or nobody being asked, is what counts.
      if (!canApprove || !(isForYou || route.unassigned)) {
        return res.json({ approval: null });
      }

      return res.json({
        approval: {
          approvalId: mine.id,
          hitlLevel,
          isForYou,
          canApprove,
          routedTo: route.names,
          routedToAdmins: route.toAdmins,
          unassigned: route.unassigned,
        },
      });
    } catch (error) {
      // A banner that cannot be resolved is not worth a 500 to the chat page;
      // the status message still explains the stall.
      log.warn('Failed to resolve pending approval for thread', {
        error: (error as Error).message,
      });
      return res.json({ approval: null });
    }
  },
);

// ── DELETE /:agentId/threads/:threadId/presence — Leave ──────────────────
//
// Best effort. Fired when the tab goes away, which is exactly when a request
// is least likely to land, so the 45s staleness window stays the real
// guarantee — this only makes departure look instant when it does land.

agentChatRouter.delete(
  '/:agentId/threads/:threadId/presence',
  async (req: Request, res: Response) => {
    try {
      const parseResult = tenantIdQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({ error: 'Validation failed' });
      }
      const { tenantId } = parseResult.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      await presenceRepo.clearPresence(tenantId, threadId, resolution.caller.accountId);
      return res.status(204).send();
    } catch (error) {
      log.error('Failed to clear chat presence', {
        error: (error as Error).message,
      });
      return res.status(500).json({ error: 'Failed to clear presence' });
    }
  },
);

// ── GET /:agentId/threads/:threadId/turn-events — Follow a turn ──────────
//
// Execution events for a turn after a cursor, so somebody who is not the
// sender can watch the agent work rather than waiting for the finished
// reply. The sender does not use this — they hold the SSE stream.
//
// Cursor rather than a live pipe because the stream is the response to the
// sender's POST: it lives in one handler on one instance, and with no session
// affinity there is nothing for a second viewer to attach to. Reading a
// written log also gives replay, which a socket cannot — join halfway through
// a long turn, or reload, and you still see what you missed.

agentChatRouter.get(
  '/:agentId/threads/:threadId/turn-events',
  async (req: Request, res: Response) => {
    try {
      const parseResult = turnEventsQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, turnId, after } = parseResult.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const events = await turnEventsRepo.listTurnEventsAfter(tenantId, turnId, after ?? 0);
      return res.json({
        turnId,
        events,
        // The follower stops here rather than polling a finished turn; the
        // persisted message is what it reconciles against.
        done: events.some((e) => e.kind === 'done'),
      });
    } catch (error) {
      log.error('Failed to list turn events', { error: (error as Error).message });
      return res.status(500).json({ error: 'Failed to list turn events' });
    }
  },
);

// ── POST /:agentId/feedback — Submit feedback ────────────────────────────
//
// Proxies to the tenant runtime, which stores the feedback as a memory and
// may queue it for learning loops. Best-effort: a transient failure should
// not disrupt the chat UX.

agentChatRouter.post(
  '/:agentId/feedback',
  async (req: Request, res: Response) => {
    try {
      const parseResult = feedbackBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, threadId, messageId, feedbackType, content } =
        parseResult.data;
      const { agentId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }
      const { caller } = resolution;

      const tenantRuntimeClient = new TenantRuntimeClient();
      const result = await tenantRuntimeClient.submitChatFeedback(
        tenantId,
        agentId,
        {
          threadId,
          messageId,
          feedbackType: mapFeedbackType(feedbackType),
          content,
          userId: caller.accountId,
        },
      );

      logAudit(
        'agent_chat.feedback_submitted',
        { tenantId, userId: caller.accountId },
        { threadId, messageId, agentId, feedbackType },
      );

      // Note: `tenant.internal_agent.chat_feedback_received` is deliberately
      // not published here; it has no runtime handler — see the matching note
      // on chat_started above.

      return res.json(result);
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to submit agent chat feedback',
      );
      return res.status(500).json({ error: 'Failed to submit feedback' });
    }
  },
);
