// Insights Router
// REST endpoints for insights report and thread management

import { Router, json as expressJson } from 'express';
import { z } from 'zod';
import { generateReport } from './report-service';
import { getInsightsCounts } from './counts-service';
import {
  appendMessage,
  createThread,
  deleteThread,
  getThread,
  getUnreadThreadCount,
  listMessages,
  listThreads,
  markAllThreadsRead,
  markThreadRead,
} from './chat-repository';
import { checkAndIncrementInsightsRateLimit } from './rate-limiter';
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
// Per implementation plan: insights chat endpoints get a dedicated 50KB body
// size limit (not the global 5MB). Anything larger than that is either an
// abuse attempt or a misuse of the API — chat messages are capped at 4000
// characters, the rest of the JSON envelope is small. This middleware
// applies ONLY to insights routes mounted under /api/insights.
const insightsJson = expressJson({ limit: '50kb' });
router.use(insightsJson);

// ── Input validation schemas ────────────────────────────────────────────

const reportQuerySchema = z.object({
  tenantId: z.string().uuid(),
  period: z.enum([
    'today', 'yesterday', 'this_week', 'last_week',
    'this_month', 'last_month',
    'this_quarter', 'last_quarter',
    'this_year',
  ]).optional().default('this_week'),
  start: z.string().optional(),
  end: z.string().optional(),
});

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
  // Per implementation plan: 4000 character cap, server-side enforced
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
// src/common/chat-input-sanitize.ts so the insights and team-plan chat
// routers share one implementation. Imported at the top of this file
// under its original name to keep the call sites below unchanged.

// ── GET /api/insights/report ────────────────────────────────────────────

router.get('/report', async (req, res) => {
  try {
    const parseResult = reportQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const { tenantId, period, start, end } = parseResult.data;

    // The workspace is named by the caller, so membership in it has to be
    // established before anything is read. Same call the /threads route below
    // makes; this route was reading straight from the parsed query, so any
    // signed-in person could name another workspace and receive its costs,
    // Operating Units and activity.
    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }

    // Build TimeRangeInput from query params
    const timeRangeInput = start && end
      ? { start, end }
      : { preset: period as 'this_week' };

    const blocks = await generateReport(tenantId, timeRangeInput);

    logAudit('insights.report_generated', req.ctx || { tenantId }, {
      period,
      blockCount: blocks.length,
    });

    return res.json({ blocks });
  } catch (error) {
    log.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to generate insights report');
    return res.status(500).json({ error: 'Failed to generate report' });
  }
});

// ── GET /api/insights/counts ────────────────────────────────────────────
//
// Lightweight all-time count probe (~tens of ms). The frontend hits this on
// /insights mount to decide whether to even fire the heavy /report fetch —
// brand-new workspaces render the empty-state instantly with no skeleton.
// No period param: empty-state is an onboarding signal, not a period filter.
router.get('/counts', async (req, res) => {
  try {
    const parseResult = z.object({ tenantId: z.string().uuid() }).safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const counts = await getInsightsCounts(parseResult.data.tenantId);

    return res.json(counts);
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to fetch insights counts',
    );
    return res.status(500).json({ error: 'Failed to fetch counts' });
  }
});

// ── GET /api/insights/threads ──────────────────────────────────────────
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
    // per-thread `unread` flag consults (migration 434).
    const result = await listThreads(tenantId, resolution.caller.accountId, { cursor, limit });

    return res.json({
      threads: result.threads,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to list insights threads',
    );
    return res.status(500).json({ error: 'Failed to list threads' });
  }
});

// ── GET /api/insights/threads/unread-count ─────────────────────────────
//
// How many threads carry an unread Insights Manager reply for this caller.
// One number for the whole surface: it backs the dot on the sidebar's
// Insights icon, and the history modal's row dots read the same predicate
// from the list above, so the two cannot disagree.
//
// KEEP THIS REGISTERED BEFORE `GET /threads/:threadId`. `unread-count` is a
// valid value for that path segment, so the param route would swallow this
// one and answer 400 (not a UUID) instead. Same rule agent chat's
// /unread-counts route documents.
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
      'Failed to get insights unread count',
    );
    return res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// ── POST /api/insights/threads/read-all ────────────────────────────────
//
// Mark every thread with an unread Insights reply read for this caller. Backs
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
      'Failed to mark all insights threads read',
    );
    return res.status(500).json({ error: 'Failed to mark threads read' });
  }
});

// ── POST /api/insights/threads ─────────────────────────────────────────
//
// Create a new thread. Title is optional — chat-service auto-generates one
// from the first user message in Phase 6. Returns the persisted row.
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

    logAudit('insights.thread_created', req.ctx || { tenantId }, {
      threadId: thread.id,
      hasTitle: !!sanitizedTitle,
    });

    return res.status(201).json({ thread });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to create insights thread',
    );
    return res.status(500).json({ error: 'Failed to create thread' });
  }
});

// ── GET /api/insights/threads/:threadId ────────────────────────────────
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
      'Failed to get insights thread',
    );
    return res.status(500).json({ error: 'Failed to get thread' });
  }
});

// ── DELETE /api/insights/threads/:threadId ─────────────────────────────
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

    logAudit('insights.thread_deleted', req.ctx || { tenantId }, { threadId });

    return res.status(204).send();
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to delete insights thread',
    );
    return res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// ── GET /api/insights/threads/:threadId/messages ───────────────────────
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

    // Verify the thread is in this workspace before listing — never leak
    // message content across a tenant boundary.
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
      'Failed to list insights messages',
    );
    return res.status(500).json({ error: 'Failed to list messages' });
  }
});

// ── POST /api/insights/threads/:threadId/messages ──────────────────────
//
// Append a USER message to a thread. Assistant messages are written by
// the chat-service in Phase 6 (via the streaming tool-use loop), NOT
// through this endpoint — there's no role parameter on the request body.
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

    // Two-tier rate limit check (per-tenant + per-user). Configured in
    // src/insights/rate-limiter.ts per the implementation plan: 20/min/tenant,
    // 5/min/user. Phase 6 will also gate the streaming chat endpoint with
    // the same check; in Phase 3 the message-create endpoint is the only
    // user-facing write path so it's the only thing to gate.
    const rateLimitResult = await checkAndIncrementInsightsRateLimit(
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

    logAudit('insights.message_created', req.ctx || { tenantId }, {
      threadId,
      messageId: message.id,
      role: 'user',
      contentLength: sanitized.length,
    });

    return res.status(201).json({ message });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to append insights message',
    );
    return res.status(500).json({ error: 'Failed to append message' });
  }
});

// ── POST /api/insights/threads/:threadId/stop ───────────────────────────
//
// Ask the turn running on this thread to stop (ADR-041). The signal is durable,
// so this does not race the SSE stream: the loop claims it at its next boundary,
// ends the turn, and keeps whatever it had written.
//
// deliveredAs:'noop' means there was nothing to stop — the turn had already
// finished, or the click raced its own reply. Same contract as agent chat and
// the Chief AI Officer chat, so the frontend handles all three identically.
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

    logAudit('insights.chat_turn_stop_requested', req.ctx || { tenantId }, {
      threadId,
      delivered,
    });

    return res.json({ acknowledged: true, deliveredAs: delivered ? 'abort' : 'noop' });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to stop insights chat turn',
    );
    return res.status(500).json({ error: 'Failed to stop the response' });
  }
});

// ── POST /api/insights/threads/:threadId/presence ──────────────────────
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
// It only became worth having in migration 351. While an Insights thread was
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
      'insights',
      tenantId,
      threadId,
      resolution.caller.accountId,
      state,
    );
    return res.json(presence);
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to record insights chat presence',
    );
    return res.status(500).json({ error: 'Failed to record presence' });
  }
});

// ── DELETE /api/insights/threads/:threadId/presence ────────────────────
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

    await clearPresence('insights', tenantId, threadId, resolution.caller.accountId);
    return res.status(204).send();
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to clear insights chat presence',
    );
    return res.status(500).json({ error: 'Failed to clear presence' });
  }
});

// ── POST /api/insights/threads/:threadId/read ──────────────────────────
//
// Mark this thread read. Mirrors the presence routes: same key shape, same
// ownership gate, same "the caller is whoever the request authenticated as"
// rule — the marker is per account, so it can never be set on somebody else's
// behalf. Unlike presence, this is durable (migration 434); presence rows are
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
      'Failed to mark insights thread read',
    );
    return res.status(500).json({ error: 'Failed to mark thread read' });
  }
});
