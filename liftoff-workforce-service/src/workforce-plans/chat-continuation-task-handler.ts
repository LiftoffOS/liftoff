// Cloud Tasks delivery handler for a Chief AI Officer continuation.
//
// Cloud Tasks → POST /api/tasks/chat-continuation with an OIDC token from the
// workforce SA (as the HRBP fan-out arrives). The handoff, in order, because
// a claim is not the turn and a person's turn can start at any moment:
//
//   1. CLAIM the row (queued → claimed); no row → cancelled or taken, end.
//   2. The THREAD must be free: a live turn (the one that queued this, still
//      finishing, or a person's) → on the last delivery mark the row failed
//      (lock_busy) and 200 so the queue stops; otherwise put the row back to
//      queued and answer a retryable status.
//   3. RECHECK: the row still claimed by this worker (else end), and no
//      person message newer than the origin (else cancelled, superseded).
//      Only then running.
//   4. RUN the same turn loop as a continuation (runCAIOChatTurn claims the
//      turn as every turn does), as the person whose message started the
//      work, with their live tenant role; done, or failed with the reason
//      in the log.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { log } from '../infrastructure/logging.js';
import { runCAIOChatTurn } from './chat-service.js';
import { findLiveTurnId } from './turn-signal-repository.js';
import { getAccountProfiles } from './account-profiles.js';
import type { TenantMemberRole } from './chat-repository.js';
import {
  claimContinuation,
  CLOUD_TASKS_RETRY_COUNT_HEADER,
  CONTINUATION_DISPATCH_DEADLINE_SECONDS,
  finishContinuation,
  hasNewerPersonMessage,
  isLastDelivery,
  markContinuationRunning,
  recheckClaimedContinuation,
  requeueContinuation,
} from './chat-continuations.js';

const oidcClient = new OAuth2Client();

/** The room a turn keeps under the task's deadline for the call in flight
 *  when the deadline passes and for the closing call: the same reserve the
 *  stream router keeps under its 10-minute cutoff. */
const REPLY_CLOSING_RESERVE_MS = 90_000;

const VALID_ROLES: readonly TenantMemberRole[] = ['owner', 'admin', 'member', 'viewer'];

async function verifyOidc(req: FastifyRequest): Promise<{ ok: true } | { ok: false; reason: string }> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing OIDC token' };
  }
  const audience = process.env['WORKFORCE_SERVICE_URL'] ?? '';
  const expectedSa = process.env['WORKFORCE_SERVICE_ACCOUNT_EMAIL'] ?? '';
  try {
    const ticket = await oidcClient.verifyIdToken({ idToken: authHeader.slice(7), audience });
    if (ticket.getPayload()?.email !== expectedSa) {
      return { ok: false, reason: 'OIDC token from unexpected SA' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `OIDC verification failed: ${(err as Error).message}` };
  }
}

export async function registerChatContinuationTaskRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/tasks/chat-continuation', async (request, reply) => {
    const auth = await verifyOidc(request);
    if (!auth.ok) {
      log.warn({ reason: auth.reason }, 'chat continuation task handler rejected request');
      return reply.status(auth.reason === 'missing OIDC token' ? 401 : 403).send({ error: auth.reason });
    }
    const deliveredAt = Date.now();
    const lastDelivery = isLastDelivery(request.headers[CLOUD_TASKS_RETRY_COUNT_HEADER] as string | string[] | undefined);

    let body: { continuationId?: string; tenantId?: string };
    try {
      const raw = request.body;
      body = typeof raw === 'string'
        ? (JSON.parse(Buffer.from(raw, 'base64').toString()) as { continuationId?: string; tenantId?: string })
        : (raw as { continuationId?: string; tenantId?: string });
    } catch (err) {
      return reply.status(400).send({ error: `invalid payload: ${(err as Error).message}` });
    }
    const { continuationId, tenantId } = body ?? {};
    if (!continuationId || !tenantId) {
      // Permanent — 200 so Cloud Tasks does not retry a malformed task.
      return reply.status(200).send({ dropped: true });
    }
    const workerId = `${process.env['K_REVISION'] ?? 'local'}:${process.pid}:${deliveredAt}`;

    // 1. CLAIM.
    const row = await claimContinuation(tenantId, continuationId, workerId);
    if (!row) {
      return reply.status(200).send({ noop: true });
    }

    // 2. The thread must be free.
    const liveTurnId = await findLiveTurnId(tenantId, row.threadId);
    if (liveTurnId) {
      if (lastDelivery) {
        await finishContinuation(tenantId, row.id, workerId, 'failed', 'lock_busy');
        return reply.status(200).send({ status: 'failed', reason: 'lock_busy' });
      }
      await requeueContinuation(tenantId, row.id, workerId);
      return reply.status(503).send({ retry: true, reason: 'lock_busy' });
    }

    // 3. RECHECK.
    const claimed = await recheckClaimedContinuation(tenantId, row.id, workerId);
    if (!claimed) {
      return reply.status(200).send({ noop: true, reason: 'not_claimed' });
    }
    let superseded = false;
    try {
      superseded = await hasNewerPersonMessage(tenantId, row.threadId, row.originMessageId);
    } catch (err) {
      log.warn({ continuationId, tenantId, error: (err as Error).message }, 'chat continuation: supersession check failed; running');
    }
    if (superseded) {
      await finishContinuation(tenantId, row.id, workerId, 'cancelled', 'superseded');
      return reply.status(200).send({ status: 'cancelled', reason: 'superseded' });
    }
    if (!(await markContinuationRunning(tenantId, row.id, workerId))) {
      return reply.status(200).send({ noop: true, reason: 'not_claimed' });
    }

    // 4. RUN, as the person whose message started the work, with their live
    //    role (platform-backend's profile read joins tenant_members).
    const profiles = await getAccountProfiles(tenantId, [row.accountId]);
    const profile = profiles.get(row.accountId);
    const role = profile && VALID_ROLES.includes(profile.role as TenantMemberRole) ? (profile.role as TenantMemberRole) : null;
    if (!profile || !role) {
      await finishContinuation(tenantId, row.id, workerId, 'failed', 'caller_unresolved');
      return reply.status(200).send({ status: 'failed', reason: 'caller_unresolved' });
    }
    const callerName = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.email;

    let terminal: 'completed' | 'failed' = 'failed';
    let errorCode: string | null = null;
    try {
      for await (const event of runCAIOChatTurn({
        threadId: row.threadId,
        tenantId,
        accountId: row.accountId,
        role,
        userMessage: '',
        callerName,
        continuation: { originMessageId: row.originMessageId, ordinal: row.ordinal },
        replyDeadlineAt: deliveredAt + CONTINUATION_DISPATCH_DEADLINE_SECONDS * 1000 - REPLY_CLOSING_RESERVE_MS,
      })) {
        if (event.type === 'complete') terminal = 'completed';
        else if (event.type === 'delegation_paused') terminal = 'completed';
        else if (event.type === 'error') errorCode = event.code;
      }
    } catch (err) {
      log.error({ continuationId, tenantId, error: (err as Error).message }, 'chat continuation: turn threw');
      await finishContinuation(tenantId, row.id, workerId, 'failed', `turn_exception: ${(err as Error).message}`);
      return reply.status(200).send({ status: 'failed' });
    }
    if (terminal === 'completed') {
      await finishContinuation(tenantId, row.id, workerId, 'done', 'completed');
      return reply.status(200).send({ status: 'done' });
    }
    await finishContinuation(tenantId, row.id, workerId, 'failed', errorCode ?? 'no_terminal');
    return reply.status(200).send({ status: 'failed', reason: errorCode ?? 'no_terminal' });
  });
}
