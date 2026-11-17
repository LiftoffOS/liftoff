// Liftoff Router
// REST endpoints for Liftoff chat thread management

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import {
  appendMessage,
  createThread,
  deleteThread,
  getThread,
  getUnreadThreadCount,
  listMessages,
  listThreadDelegations,
  listThreads,
  markAllThreadsRead,
  markThreadRead,
} from './chat-repository';
import { checkAndIncrementLiftoffRateLimit } from './rate-limiter';
import { clearPresence, heartbeatAndListPresence } from '../common/chat-presence-repository';
import { log, logAudit } from '../infrastructure/logging';
import { threadContinuationStatus } from '../chat-continuations/store';
import { sanitizeChatMessageContent as sanitizeMessageContent } from '../common/chat-input-sanitize';
import { resolveCaller } from '../auth/resolve-caller';
import { tryInsertAbortSignal } from './turn-control';
import { refusedAsViewer } from '../common/agent-conversation-gate';

export const router = Router();

// ── Body size limit ────────────────────────────────────────────────────
//
// Chat endpoints get a dedicated 50KB body size limit (not the global 5MB).
// Anything larger is either an abuse attempt or a misuse of the API: messages
// are capped at 4000 characters and the rest of the JSON envelope is small.
// This middleware applies ONLY to routes mounted under /api/liftoff.
const liftoffJson = expressJson({ limit: '50kb' });
router.use(liftoffJson);

// ── Input validation schemas ────────────────────────────────────────────

const threadListQuerySchema = z.object({
  tenantId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const threadCreateBodySchema = z.object({
  tenantId: z.string().uuid(),
  title: z.string().max(500).optional(),
});

const threadIdParamSchema = z.object({
  threadId: z.string().uuid(),
});

const messageListQuerySchema = z.object({
  tenantId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const messageCreateBodySchema = z.object({
  tenantId: z.string().uuid(),
  content: z.string().min(1).max(4000),
});

// 'typing' is what the composer reports while somebody is mid-sentence; it
// decays back to 'viewing' on read a few seconds later, so a client that dies
// mid-compose does not appear to type forever.
const presenceBodySchema = z.object({
  tenantId: z.string().uuid(),
  state: z.enum(['viewing', 'typing']),
});

// Chat input sanitization (strip control chars + HTML escape) lives in
// src/common/chat-input-sanitize.ts so every chat router shares one
// implementation. Imported at the top of this file under its original name to
// keep the call sites below unchanged.

// ── GET /api/liftoff/threads ───────────────────────────────────────────
//
// Every non-deleted thread in the workspace, whoever started it (migration
// 351). Membership is the only gate, which resolveCaller has already applied.
// Forward-paginated by updated_at DESC (newest activity first), default 20 per
// page.
router.get('/threads', async (req, res) => {
  try {
    const parseResult = threadListQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    const { tenantId, cursor, limit } = parseResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    // The caller is the READER, not a filter: visibility stays workspace-wide
    // (migration 351), and the account only decides whose read markers the
    // per-thread `unread` flag consults (migration 433).
    const result = await listThreads(tenantId, resolution.caller.accountId, { cursor, limit });

    return res.json({
      threads: result.threads,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to list Liftoff threads',
    );
    return res.status(500).json({ error: 'Failed to list threads' });
  }
});

// ── GET /api/liftoff/threads/unread-count ──────────────────────────────
//
// How many threads carry an unread Liftoff reply for this caller. One number
// for the whole surface: it backs the dot on the home page's Resume button,
// and the history modal's row dots read the same predicate from the list
// above, so the two cannot disagree.
//
// KEEP THIS REGISTERED BEFORE `GET /threads/:threadId`. `unread-count` is a
// valid value for that path segment, so the param route would swallow this one
// and answer 400 (not a UUID) instead. Same rule agent chat's /unread-counts
// route documents.
router.get('/threads/unread-count', async (req, res) => {
  try {
    const parseResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    const { tenantId } = parseResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    const count = await getUnreadThreadCount(tenantId, resolution.caller.accountId);
    return res.json({ count });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to get Liftoff unread count',
    );
    return res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// ── POST /api/liftoff/threads/read-all ─────────────────────────────────
//
// Mark every thread with an unread Liftoff reply read for this caller. Backs
// the history modal's "Mark All Read". Read state is per account, so this
// never changes what a colleague sees.
router.post('/threads/read-all', async (req, res) => {
  try {
    const bodyResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: bodyResult.error.errors });
    }
    const { tenantId } = bodyResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    await markAllThreadsRead(tenantId, resolution.caller.accountId);
    return res.status(204).send();
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to mark all Liftoff threads read',
    );
    return res.status(500).json({ error: 'Failed to mark threads read' });
  }
});

// ── POST /api/liftoff/threads ──────────────────────────────────────────
//
// Create a new thread. Title is optional: the chat service auto-generates one
// from the first user message. Returns the persisted row.
router.post('/threads', async (req, res) => {
  try {
    const parseResult = threadCreateBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    const { tenantId, title } = parseResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }
    const { caller } = resolution;

    // A view-only seat reads every conversation and starts no turn.
    if (refusedAsViewer(caller.role, res)) return;

    const sanitizedTitle = title ? sanitizeMessageContent(title) : null;
    const thread = await createThread({
      tenantId,
      accountId: caller.accountId,
      title: sanitizedTitle,
    });

    logAudit('liftoff.thread_created', req.ctx || { tenantId }, {
      threadId: thread.id,
      hasTitle: !!sanitizedTitle,
    });

    return res.status(201).json({ thread });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to create Liftoff thread',
    );
    return res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ── GET /api/liftoff/threads/:threadId ─────────────────────────────────
//
// Any thread in the caller's workspace. Cross-tenant returns 404, never 403, to
// avoid existence leaks.
router.get('/threads/:threadId', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const queryResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: queryResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId } = queryResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // The work queued to continue an earlier turn on this thread, so a
    // finished-looking thread that is about to change is shown as still
    // working (the mcp_chat_runs status read is the model). Null when none.
    const continuation = await threadContinuationStatus(tenantId, threadId);
    return res.json({ thread, continuation: continuation ? { status: continuation } : null });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to get Liftoff thread',
    );
    return res.status(500).json({ error: 'Failed to get thread' });
  }
});

// ── DELETE /api/liftoff/threads/:threadId ──────────────────────────────
//
// Soft delete. Anyone can delete their own thread; owner/admin can
// additionally delete any thread in the tenant. This is the one rule migration
// 351 did NOT widen: reading a colleague's thread is now open to the whole
// workspace, removing it is not. A member who asks to delete somebody else's
// thread gets the same 404 as one who names a thread that does not exist, so the
// refusal leaks nothing either way.
router.delete('/threads/:threadId', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const queryResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: queryResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId } = queryResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }
    const { caller } = resolution;

    const deleted = await deleteThread(threadId, tenantId, caller.accountId, caller.role);
    if (!deleted) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    logAudit('liftoff.thread_deleted', req.ctx || { tenantId }, { threadId });

    return res.status(204).send();
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to delete Liftoff thread',
    );
    return res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// ── GET /api/liftoff/threads/:threadId/messages ────────────────────────
//
// Reverse-paginated message list (newest first). Resolves the parent thread
// first, so a thread in another workspace is indistinguishable from one that
// does not exist.
router.get('/threads/:threadId/messages', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const queryResult = messageListQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: queryResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId, cursor, limit } = queryResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    // Verify the thread is in this workspace before listing: never leak message
    // content across a tenant boundary.
    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const result = await listMessages(threadId, { cursor, limit });

    return res.json({
      messages: result.messages,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to list Liftoff messages',
    );
    return res.status(500).json({ error: 'Failed to list messages' });
  }
});

// ── POST /api/liftoff/threads/:threadId/messages ───────────────────────
//
// Append a USER message to a thread. Assistant messages are written by the
// chat-service via the streaming tool-use loop, NOT through this endpoint:
// there's no role parameter on the request body.
router.post('/threads/:threadId/messages', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const bodyResult = messageCreateBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: bodyResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId, content } = bodyResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }
    const { caller } = resolution;

    // A view-only seat reads every conversation and starts no turn.
    if (refusedAsViewer(caller.role, res)) return;

    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // Sanitize: strip control chars + HTML-escape. Empty after sanitization
    // means the user submitted only control characters; reject with 400.
    const sanitized = sanitizeMessageContent(content);
    if (sanitized.length === 0) {
      return res.status(400).json({ error: 'Message content is empty after sanitization' });
    }

    // Two-tier rate limit check (per-tenant + per-user) against Liftoff's own
    // ledger, so this surface's limits are independent of every other chat.
    const rateLimitResult = await checkAndIncrementLiftoffRateLimit(
      tenantId,
      caller.accountId,
    );
    if (!rateLimitResult.allowed) {
      if (rateLimitResult.retryAfter !== undefined) {
        res.setHeader('Retry-After', String(rateLimitResult.retryAfter));
      }
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: rateLimitResult.retryAfter,
        remaining: rateLimitResult.remaining,
      });
    }

    const message = await appendMessage({
      threadId,
      role: 'user',
      senderAccountId: caller.accountId,
      content: sanitized,
    });

    logAudit('liftoff.message_created', req.ctx || { tenantId }, {
      threadId,
      messageId: message.id,
      role: 'user',
      contentLength: sanitized.length,
    });

    return res.status(201).json({ message });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to append Liftoff message',
    );
    return res.status(500).json({ error: 'Failed to append message' });
  }
});

// ── GET /api/liftoff/threads/:threadId/delegations ─────────────────────
//
// Which thread this conversation is using with each colleague it has brought in.
//
// Exists for one job: a transcript row that says a colleague is waiting on an
// approval has to be able to TAKE the person to that conversation, and the row
// itself only names the colleague. The pairing is what turns that name into a
// destination, and serving it here is what keeps the destination out of the
// address bar: the client navigates with the id in router state, exactly as the
// share resolver does.
//
// Scoped to the parent thread, which is permission-checked first, so this leaks
// nothing the messages endpoint does not already serve.
router.get('/threads/:threadId/delegations', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const queryResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: queryResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId } = queryResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const delegations = await listThreadDelegations(threadId);
    return res.json({ delegations });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to list Liftoff thread delegations',
    );
    return res.status(500).json({ error: 'Failed to list delegations' });
  }
});

// ── POST /api/liftoff/threads/:threadId/stop ───────────────────────────
//
// Ask the turn running on this thread to stop (ADR-041). The signal is durable,
// so this does not race the SSE stream: the loop claims it at its next boundary,
// ends the turn, and keeps whatever it had written.
//
// deliveredAs:'noop' means there was nothing to stop: the turn had already
// finished, or the click raced its own reply. Same contract as agent chat, the
// insights chat and the Chief AI Officer chat, so the frontend handles them
// identically.
router.post('/threads/:threadId/stop', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const bodyResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: bodyResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId } = bodyResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }
    const { caller } = resolution;

    // Same visibility rule as the stream itself: you can only stop a turn on a
    // thread you are allowed to see, which since migration 351 is any thread in
    // your workspace. Stopping a colleague's runaway turn is a collaboration
    // affordance, the same one team chat has always had.
    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const delivered = await tryInsertAbortSignal({
      tenantId,
      threadId,
      senderAccountId: caller.accountId,
      senderDisplayName: null,
    });

    logAudit('liftoff.chat_turn_stop_requested', req.ctx || { tenantId }, {
      threadId,
      delivered,
    });

    return res.json({ acknowledged: true, deliveredAs: delivered ? 'abort' : 'noop' });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to stop Liftoff chat turn',
    );
    return res.status(500).json({ error: 'Failed to stop the response' });
  }
});

// ── POST /api/liftoff/threads/:threadId/presence ───────────────────────
//
// One call per poll: records that the caller is on this thread, then returns
// everyone currently on it, the newest message timestamp, and the turn in flight
// if there is one. Combining the write and the read halves the request count for
// a surface that polls every few seconds, and means a viewer can never read a
// roster that does not yet contain themselves.
//
// Same request and response shape as agent chat's presence route, deliberately,
// so the frontend drives all three surfaces through one transport interface
// (src/hooks/chatPresenceTransports.ts) rather than one polling implementation
// per surface.
//
// It only became worth having in migration 351. While a Liftoff thread was
// private to whoever started it there was never a second person in it to show.
router.post('/threads/:threadId/presence', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const bodyResult = presenceBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: bodyResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId, state } = bodyResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    // Same gate as the message list: presence must not reveal that a thread
    // exists in another workspace.
    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const presence = await heartbeatAndListPresence(
      'liftoff',
      tenantId,
      threadId,
      resolution.caller.accountId,
      state,
    );
    return res.json(presence);
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to record Liftoff chat presence',
    );
    return res.status(500).json({ error: 'Failed to record presence' });
  }
});

// ── DELETE /api/liftoff/threads/:threadId/presence ─────────────────────
//
// Best effort. Fired when the tab goes away, which is exactly when a request is
// least likely to land, so the 45s staleness window stays the real guarantee.
// This only makes departure look instant when it does land.
//
// No thread lookup: the only row it can touch is the caller's own, on a thread
// in a tenant they are a member of, so there is nothing a 404 would protect.
router.delete('/threads/:threadId/presence', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const queryResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: queryResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId } = queryResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    await clearPresence('liftoff', tenantId, threadId, resolution.caller.accountId);
    return res.status(204).send();
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to clear Liftoff chat presence',
    );
    return res.status(500).json({ error: 'Failed to clear presence' });
  }
});

// ── POST /api/liftoff/threads/:threadId/read ───────────────────────────
//
// Mark this thread read. Mirrors the presence routes: same key shape, same
// ownership gate, same "the caller is whoever the request authenticated as"
// rule — the marker is per account, so it can never be set on somebody else's
// behalf. Unlike presence, this is durable (migration 433); presence rows are
// deleted on leave, which is exactly why read state cannot live there.
router.post('/threads/:threadId/read', async (req, res) => {
  try {
    const paramsResult = threadIdParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: paramsResult.error.errors });
    }
    const bodyResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: bodyResult.error.errors });
    }

    const { threadId } = paramsResult.data;
    const { tenantId } = bodyResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    // Same gate as the message list: a thread in another workspace must be
    // indistinguishable from one that does not exist.
    const thread = await getThread(threadId, tenantId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    await markThreadRead(tenantId, resolution.caller.accountId, threadId);
    return res.status(204).send();
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to mark Liftoff thread read',
    );
    return res.status(500).json({ error: 'Failed to mark thread read' });
  }
});
