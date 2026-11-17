// Team Plan Chat Router (Fastify)
//
// REST endpoints for the /team-plan chat - thread management + message CRUD.
// The streaming SSE endpoint lives in chat-stream-router.ts.
//
// Auth: trusted headers x-tenant-id, x-account-id, x-tenant-role (no Firebase).
//
// Endpoints:
//   GET    /team-plan/threads
//   GET    /team-plan/threads/unread-count
//   POST   /team-plan/threads/read-all
//   POST   /team-plan/threads
//   GET    /team-plan/threads/:threadId
//   DELETE /team-plan/threads/:threadId
//   GET    /team-plan/threads/:threadId/messages
//   POST   /team-plan/threads/:threadId/messages
//   POST   /team-plan/threads/:threadId/read
//   GET    /team-plan/export?kind=threads|messages   (the workspace export)
//
// Adapted from platform-backend src/workforce-plans/chat-router.ts.
// Key differences:
//   - Fastify instead of Express
//   - Auth from trusted headers instead of Firebase
//   - Import paths use .js extensions

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sanitizeChatMessageContent } from '@liftoffos/service-runtime';
import {
  appendMessage,
  createThread,
  deleteThread,
  exportMessages,
  exportThreads,
  EXPORT_FEED_MAX_LIMIT,
  getThread,
  getUnreadThreadCount,
  listMessages,
  listThreads,
  markAllThreadsRead,
  markThreadRead,
} from './chat-repository.js';
import { log } from '../infrastructure/logging.js';
import { writeAuditLog } from './audit-log.js';
import { resolveCallerFromHeaders } from './caller-context.js';
import { MAX_CHAT_MESSAGE_CHARS } from './context-budget.js';
import { describeChatValidationFailure } from './chat-validation.js';

// ── Input validation schemas ────────────────────────────────────────────

const threadListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Title search, as platform-backend's conversation listing asks for it.
  query: z.string().max(200).optional(),
});

const threadCreateBodySchema = z.object({
  title: z.string().max(500).optional(),
});

const threadIdParamSchema = z.object({
  threadId: z.string().uuid(),
});

const messageListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const messageCreateBodySchema = z.object({
  content: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARS),
});

// The export feed's query. `tenantId` is deliberately absent: the caller's
// tenant travels in the headers, as it does for every other team-plan route,
// and a second source for it would be a second thing to get wrong. Strict, so
// a `tenantId` sent anyway is a 400 rather than silently ignored.
const exportQuerySchema = z.object({
  kind: z.enum(['threads', 'messages']),
  asOf: z.string().datetime({ offset: true }),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(EXPORT_FEED_MAX_LIMIT).optional(),
}).strict();

// ── Route registration ─────────────────────────────────────────────────

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /team-plan/threads ────────────────────────────────────────────
  app.get('/team-plan/threads', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolution = resolveCallerFromHeaders(request);
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.error });
      }
      const { caller } = resolution;

      const parseResult = threadListQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { cursor, limit, query } = parseResult.data;

      const result = await listThreads(caller.tenantId, caller.accountId, caller.role, {
        cursor,
        limit,
        titleQuery: query,
      });

      return reply.send({
        threads: result.threads,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to list team plan threads',
      );
      return reply.status(500).send({ error: 'Failed to list threads' });
    }
  });

  // ── GET /team-plan/export?kind=&asOf=&cursor=&limit= ──────────────────
  //
  // The control plane's workspace export reads this surface here: threads and
  // messages as two independently bounded feeds, each one ordered pass keyed
  // on (created_at, id) up to `asOf`. Owner or admin only, matching the
  // export's own permission; tenant from the caller headers only.
  //
  // A static sibling of /threads/:threadId, registered ahead of the param
  // routes for the same reason unread-count is.
  app.get('/team-plan/export', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolution = resolveCallerFromHeaders(request);
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.error });
      }
      const { caller } = resolution;
      if (caller.role !== 'owner' && caller.role !== 'admin') {
        return reply.status(403).send({ error: 'Owner or admin role required' });
      }

      const parseResult = exportQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { kind, asOf, cursor, limit } = parseResult.data;
      const options = { asOf: new Date(asOf), cursor, limit };

      if (kind === 'threads') {
        const result = await exportThreads(caller.tenantId, options);
        return reply.send({ threads: result.threads, nextCursor: result.nextCursor });
      }
      const result = await exportMessages(caller.tenantId, options);
      return reply.send({ messages: result.messages, nextCursor: result.nextCursor });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to serve the team plan export feed',
      );
      return reply.status(500).send({ error: 'Failed to export' });
    }
  });

  // ── GET /team-plan/threads/unread-count ───────────────────────────────
  //
  // How many threads carry an unread Chief AI Officer reply for this caller,
  // under the same visibility rule as the list above. One number for the
  // whole surface: it backs the dot on the teams page's Plan Workforce
  // button, and the history modal's row dots read the same predicate from the
  // list, so the two cannot disagree.
  //
  // A static sibling of /threads/:threadId. find-my-way matches static
  // segments before parametric ones, and registering it here (ahead of the
  // param routes) keeps that true by construction as well.
  app.get('/team-plan/threads/unread-count', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolution = resolveCallerFromHeaders(request);
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.error });
      }
      const { caller } = resolution;

      const count = await getUnreadThreadCount(caller.tenantId, caller.accountId, caller.role);
      return reply.send({ count });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to get team plan unread count',
      );
      return reply.status(500).send({ error: 'Failed to get unread count' });
    }
  });

  // ── POST /team-plan/threads/read-all ──────────────────────────────────
  //
  // Mark every thread with an unread Chief AI Officer reply read for this
  // caller, under the list's visibility rule. Backs the history modal's
  // "Mark All Read". Read state is per account, so this never changes what a
  // colleague sees. A static sibling of /threads/:threadId/read, registered
  // ahead of the param routes like unread-count above.
  app.post('/team-plan/threads/read-all', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolution = resolveCallerFromHeaders(request);
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.error });
      }
      const { caller } = resolution;

      await markAllThreadsRead(caller.tenantId, caller.accountId, caller.role);
      return reply.status(204).send();
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to mark all team plan threads read',
      );
      return reply.status(500).send({ error: 'Failed to mark threads read' });
    }
  });

  // ── POST /team-plan/threads ────────────────────────────────────────────
  //
  // Creates a new thread. The CAIO greeting is streamed via
  // POST /team-plan/chat-stream (with no content) immediately after thread
  // creation. This gives the user real typing indicators and tool call hints
  // while the CAIO runs its assessment tools.
  app.post('/team-plan/threads', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolution = resolveCallerFromHeaders(request);
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.error });
      }
      const { caller } = resolution;

      const parseResult = threadCreateBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { title } = parseResult.data;

      const sanitizedTitle = title ? sanitizeChatMessageContent(title) : null;
      const thread = await createThread({
        tenantId: caller.tenantId,
        accountId: caller.accountId,
        title: sanitizedTitle,
      });

      void writeAuditLog('workforce_plans.thread_created', { tenantId: caller.tenantId, userId: caller.accountId }, {
        threadId: thread.id,
        hasTitle: !!sanitizedTitle,
      });

      return reply.status(201).send({ thread });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to create team plan thread',
      );
      return reply.status(500).send({ error: 'Failed to create thread' });
    }
  });

  // ── GET /team-plan/threads/:threadId ──────────────────────────────────
  app.get(
    '/team-plan/threads/:threadId',
    async (request: FastifyRequest<{ Params: { threadId: string } }>, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const paramsResult = threadIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: paramsResult.error.errors,
          });
        }
        const { threadId } = paramsResult.data;

        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        // The work queued to continue an earlier turn on this thread, so a
        // finished-looking thread about to change reads as still working.
        const { threadContinuationStatus } = await import('./chat-continuations.js');
        const continuation = await threadContinuationStatus(caller.tenantId, threadId);
        return reply.send({ thread, continuation: continuation ? { status: continuation } : null });
      } catch (error) {
        log.error(
          { error: (error as Error).message, stack: (error as Error).stack },
          'Failed to get team plan thread',
        );
        return reply.status(500).send({ error: 'Failed to get thread' });
      }
    },
  );

  // ── DELETE /team-plan/threads/:threadId ───────────────────────────────
  app.delete(
    '/team-plan/threads/:threadId',
    async (request: FastifyRequest<{ Params: { threadId: string } }>, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const paramsResult = threadIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: paramsResult.error.errors,
          });
        }
        const { threadId } = paramsResult.data;

        const deleted = await deleteThread(threadId, caller.tenantId, caller.accountId, caller.role);
        if (!deleted) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        void writeAuditLog('workforce_plans.thread_deleted', { tenantId: caller.tenantId, userId: caller.accountId }, {
          threadId,
        });

        return reply.status(204).send();
      } catch (error) {
        log.error(
          { error: (error as Error).message, stack: (error as Error).stack },
          'Failed to delete team plan thread',
        );
        return reply.status(500).send({ error: 'Failed to delete thread' });
      }
    },
  );

  // ── GET /team-plan/threads/:threadId/messages ─────────────────────────
  app.get(
    '/team-plan/threads/:threadId/messages',
    async (request: FastifyRequest<{ Params: { threadId: string } }>, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const paramsResult = threadIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: paramsResult.error.errors,
          });
        }
        const { threadId } = paramsResult.data;

        const queryResult = messageListQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: queryResult.error.errors,
          });
        }
        const { cursor, limit } = queryResult.data;

        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        const result = await listMessages(threadId, caller.tenantId, { cursor, limit });

        return reply.send({
          messages: result.messages,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        });
      } catch (error) {
        log.error(
          { error: (error as Error).message, stack: (error as Error).stack },
          'Failed to list team plan messages',
        );
        return reply.status(500).send({ error: 'Failed to list messages' });
      }
    },
  );

  // ── POST /team-plan/threads/:threadId/messages ────────────────────────
  //
  // Append a USER message to a thread. Assistant messages are written by
  // the chat service via the streaming tool-use loop, not through this
  // endpoint.
  app.post(
    '/team-plan/threads/:threadId/messages',
    async (request: FastifyRequest<{ Params: { threadId: string } }>, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const paramsResult = threadIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: paramsResult.error.errors,
          });
        }
        const { threadId } = paramsResult.data;

        const bodyResult = messageCreateBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
          return reply.status(400).send({
            error: describeChatValidationFailure(bodyResult.error),
            details: bodyResult.error.errors,
          });
        }
        const { content } = bodyResult.data;

        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        const sanitized = sanitizeChatMessageContent(content);
        if (sanitized.length === 0) {
          return reply.status(400).send({
            error: 'Message content is empty after sanitization',
          });
        }

        const message = await appendMessage({
          threadId,
          tenantId: caller.tenantId,
          role: 'user',
          senderAccountId: caller.accountId,
          content: sanitized,
        });

        void writeAuditLog('workforce_plans.message_created', { tenantId: caller.tenantId, userId: caller.accountId }, {
          threadId,
          messageId: message.id,
          role: 'user',
          contentLength: sanitized.length,
        });

        return reply.status(201).send({ message });
      } catch (error) {
        log.error(
          { error: (error as Error).message, stack: (error as Error).stack },
          'Failed to append team plan message',
        );
        return reply.status(500).send({ error: 'Failed to append message' });
      }
    },
  );

  // ── POST /team-plan/threads/:threadId/read ────────────────────────────
  //
  // Mark this thread read. The marker is per account and the caller is
  // whoever the trusted headers authenticated, so it can never be set on
  // somebody else's behalf. Unlike presence, this is durable (migration 024);
  // presence rows are deleted on leave, which is exactly why read state
  // cannot live there.
  app.post(
    '/team-plan/threads/:threadId/read',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const paramsResult = threadIdParamSchema.safeParse(request.params);
        if (!paramsResult.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: paramsResult.error.errors,
          });
        }
        const { threadId } = paramsResult.data;

        // Same gate as the message list: a thread in another workspace must
        // be indistinguishable from one that does not exist.
        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        await markThreadRead(caller.tenantId, caller.accountId, threadId);
        return reply.status(204).send();
      } catch (error) {
        log.error(
          { error: (error as Error).message, stack: (error as Error).stack },
          'Failed to mark team plan thread read',
        );
        return reply.status(500).send({ error: 'Failed to mark thread read' });
      }
    },
  );
}
