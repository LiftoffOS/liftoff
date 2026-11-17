// Team Plan Presence Router (Fastify)
//
// Multiplayer for the CAIO chat, reached through platform-backend's existing
// /api/team-plan proxy mount:
//
//   POST   /team-plan/threads/:threadId/presence     — heartbeat + roster
//   DELETE /team-plan/threads/:threadId/presence     — leave
//   GET    /team-plan/threads/:threadId/turn-events  — follow a live turn
//   POST   /team-plan/threads/:threadId/stop         — stop the live turn
//
// The response shapes match platform-backend's /api/agent-chat equivalents
// exactly, so the frontend runs one set of components and hooks over both
// chat surfaces.
//
// Auth: trusted headers x-tenant-id, x-account-id, x-tenant-role.
//
// And one SERVICE route, outside the customer /team-plan proxy surface:
//
//   GET /internal/team-plan/threads/:threadId/presence/:accountId?tenantId=
//
// The control plane's stale-driver sweep asks whether a browser session's
// recorded driver is still present in the Chief AI Officer thread, over the
// same 45-second window the other three chat surfaces read from their own
// tables. It checks `X-Service-Auth` against WORKFORCE_SERVICE_TOKEN, timing
// safe, BEFORE parsing or reading anything, and it trusts no caller identity
// header: it is a service query about the recorded driver, not an
// impersonated user request. A missing server token fails closed.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getThread } from './chat-repository.js';
import { resolveCallerFromHeaders } from './caller-context.js';
import { getAccountProfiles } from './account-profiles.js';
import {
  clearPresence,
  heartbeatAndListPresence,
  isAccountRecentlyPresent,
} from './presence-repository.js';
import { listTurnEventsAfter } from './turn-events-repository.js';
import { requestStop } from './active-turn-repository.js';

const presenceBodySchema = z.object({
  state: z.enum(['viewing', 'typing']).default('viewing'),
});

const turnEventsQuerySchema = z.object({
  turnId: z.string().uuid(),
  after: z.coerce.number().int().min(0).optional(),
});

const threadParamsSchema = z.object({
  threadId: z.string().uuid(),
});

const driverPresenceParamsSchema = z.object({
  threadId: z.string().uuid(),
  accountId: z.string().uuid(),
});

const driverPresenceQuerySchema = z.object({
  tenantId: z.string().uuid(),
});

/** Whether the request carries the shared service token, timing safe. A
 *  server with no token configured accepts nothing. */
function serviceAuthorized(request: FastifyRequest): boolean {
  const expected = loadConfig().WORKFORCE_SERVICE_TOKEN;
  if (!expected) return false;
  const raw = request.headers['x-service-auth'];
  const presented = Array.isArray(raw) ? raw[0] : raw;
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerPresenceRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /internal/team-plan/threads/:threadId/presence/:accountId ───────
  //
  // Service only. The token is checked first; a caller without it learns
  // nothing, not even whether the thread exists. The thread is read under
  // the named tenant so a thread of another tenant is a miss.
  app.get(
    '/internal/team-plan/threads/:threadId/presence/:accountId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!serviceAuthorized(request)) {
        return reply.status(401).send({ error: 'Invalid service authentication' });
      }
      try {
        const params = driverPresenceParamsSchema.safeParse(request.params);
        const query = driverPresenceQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) {
          return reply.status(400).send({ error: 'Validation failed' });
        }
        const { threadId, accountId } = params.data;
        const { tenantId } = query.data;
        const thread = await getThread(threadId, tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }
        const present = await isAccountRecentlyPresent(tenantId, threadId, accountId);
        return reply.send({ present });
      } catch (error) {
        log.error({ error: (error as Error).message }, 'Failed to read team plan driver presence');
        return reply.status(500).send({ error: 'Failed to read presence' });
      }
    },
  );

  // ── POST /team-plan/threads/:threadId/presence ──────────────────────────
  //
  // One call does both halves of a poll: write my heartbeat, read everyone
  // else's. A viewer costs one request per interval rather than two, and can
  // never read a roster that does not yet contain themselves.
  app.post(
    '/team-plan/threads/:threadId/presence',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const params = threadParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({ error: 'Validation failed' });
        }
        const body = presenceBodySchema.safeParse(request.body ?? {});
        if (!body.success) {
          return reply.status(400).send({ error: 'Validation failed' });
        }
        const { threadId } = params.data;

        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        const presence = await heartbeatAndListPresence(
          caller.tenantId,
          threadId,
          caller.accountId,
          body.data.state,
        );

        // `accounts` lives in platform-backend's database, so names and avatars
        // are fetched rather than joined. Fails soft: an unresolved viewer still
        // appears, just without a name.
        const profiles = await getAccountProfiles(
          caller.tenantId,
          presence.viewers.map((v) => v.accountId),
        );

        return reply.send({
          viewers: presence.viewers.map((v) => {
            const profile = profiles.get(v.accountId);
            return {
              accountId: v.accountId,
              firstName: profile?.firstName ?? null,
              lastName: profile?.lastName ?? null,
              email: profile?.email ?? '',
              avatarUrl: profile?.avatarUrl ?? null,
              typing: v.typing,
            };
          }),
          liveTurnId: presence.liveTurnId,
          latestMessageAt: presence.latestMessageAt,
        });
      } catch (error) {
        log.error(
          { error: (error as Error).message },
          'Failed to record team plan chat presence',
        );
        return reply.status(500).send({ error: 'Failed to record presence' });
      }
    },
  );

  // ── DELETE /team-plan/threads/:threadId/presence ────────────────────────
  //
  // Best effort. Fired when the tab goes away, which is exactly when a request
  // is least likely to land, so the 45s staleness window stays the real
  // guarantee — this only makes departure look instant when it does land.
  app.delete(
    '/team-plan/threads/:threadId/presence',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const params = threadParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({ error: 'Validation failed' });
        }

        await clearPresence(caller.tenantId, params.data.threadId, caller.accountId);
        return reply.status(204).send();
      } catch (error) {
        log.error(
          { error: (error as Error).message },
          'Failed to clear team plan chat presence',
        );
        return reply.status(500).send({ error: 'Failed to clear presence' });
      }
    },
  );

  // ── GET /team-plan/threads/:threadId/turn-events ────────────────────────
  //
  // Execution events for a turn after a cursor, so somebody who is not the
  // sender can watch the work happen rather than waiting for the finished
  // reply. The sender does not use this — they hold the SSE stream.
  app.get(
    '/team-plan/threads/:threadId/turn-events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const params = threadParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({ error: 'Validation failed' });
        }
        const query = turnEventsQuerySchema.safeParse(request.query);
        if (!query.success) {
          return reply.status(400).send({
            error: 'Validation failed',
            details: query.error.errors,
          });
        }
        const { threadId } = params.data;
        const { turnId, after } = query.data;

        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        const events = await listTurnEventsAfter(caller.tenantId, turnId, after ?? 0);
        return reply.send({
          turnId,
          events,
          // The follower stops here rather than polling a finished turn; the
          // persisted message is what it reconciles against.
          done: events.some((e) => e.kind === 'done'),
        });
      } catch (error) {
        log.error(
          { error: (error as Error).message },
          'Failed to list team plan turn events',
        );
        return reply.status(500).send({ error: 'Failed to list turn events' });
      }
    },
  );

  // ── POST /team-plan/threads/:threadId/stop ──────────────────────────────
  //
  // Stop the turn running on this thread. The turn is an async generator inside
  // somebody else's request, on an instance this one cannot address, so the stop
  // is written down and the loop reads it between iterations.
  //
  // Open to anybody who can read the thread. Stopping is the least destructive
  // thing you can do to a run in flight, and on a shared thread the person who
  // needs to stop it is often not the person who started it.
  //
  // Response shape matches platform-backend's /api/agent-chat/:agentId/stop so
  // the frontend handles both surfaces identically.
  app.post(
    '/team-plan/threads/:threadId/stop',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolution = resolveCallerFromHeaders(request);
        if (!resolution.ok) {
          return reply.status(resolution.status).send({ error: resolution.error });
        }
        const { caller } = resolution;

        const params = threadParamsSchema.safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({ error: 'Validation failed' });
        }
        const { threadId } = params.data;

        const thread = await getThread(threadId, caller.tenantId);
        if (!thread) {
          return reply.status(404).send({ error: 'Thread not found' });
        }

        const delivered = await requestStop(caller.tenantId, threadId, caller.accountId);
        return reply.send({
          acknowledged: true,
          deliveredAs: delivered ? 'abort' : 'noop',
        });
      } catch (error) {
        log.error(
          { error: (error as Error).message },
          'Failed to stop the team plan chat turn',
        );
        return reply.status(500).send({ error: 'Failed to stop the turn' });
      }
    },
  );
}
