// MCP chat-run worker (plan v6.1 Phase 5b)
//
// POST /api/internal/mcp-chat-runs/execute — Cloud Tasks delivery target.
// Runs INSIDE its own request, so it always has CPU regardless of the
// service's cpu-throttling setting (the entire reason the durable-run +
// queue design exists).
//
// Claim WITHOUT reclaim (v6): only status='queued' rows are claimable.
// Every 0-row case — terminal, or running under any lease — is a 200 no-op:
// duplicate deliveries and post-crash retries are acknowledged and dropped.
// Chat turns are non-idempotent (half-executed tool calls must never
// re-run); a crashed worker's row is swept to failed('worker_lost') at
// lease expiry by the cleanup job, and the human retries deliberately.
//
// Terminal mapping consumes the runAgentChatTurn GENERATOR directly (NOT
// runAgentChatTurnAsync, which drops hitl_required/error events) with
// hitl_required-WINS precedence: once seen, the run's terminal status is
// waiting_on_human; a subsequent complete still persists its message id but
// does not override the status.
//
// Auth: OIDC from the mcp-chat-runs queue SA (audience = this backend).
//
// POST /api/internal/mcp-chat-runs/continue — the second task kind this
// worker serves: a CONTINUATION of a platform-assistant turn a bound closed
// with work still to do (chat-continuations, migration 517), delivered from
// its own queue (chat-continuations-{env}, twenty attempts with backoff; see
// chat-continuations/dispatch.ts). Its handoff, in order, because a claim is
// not the lock and a person's turn can take the lock at any moment:
//   1. CLAIM the row (queued → claimed); no row → cancelled or taken, end.
//   2. LOCK the thread through the same lock a turn uses. Busy → on the last
//      delivery mark the row failed and 200 so the queue stops; otherwise put
//      the row back to queued and answer a retryable status.
//   3. RECHECK under the lock: the row still claimed by this worker (else
//      end), and no person message newer than the origin (else cancelled).
//      Only then running.
//   4. RUN the same turn loop as a continuation, on the origin message's
//      account and id; done, or failed with the reason in the log.

import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { withTenantScope, pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { guardWholeText } from '../common/guarded-stream';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { runAgentChatTurn } from '../agent-chat/chat-service';
import { touchThreadOnClient } from '../agent-chat/chat-repository';
import { resolveContributors } from '../agent-chat/contributors';
import { mirrorDelegatedReplyToLiftoff } from '../liftoff/delegated-continuation';
import type { ChatAttachment } from '../chat-attachments';
import { runAssistantTurn } from '../agent-chat/assistant-turn';
import { isAssistantKind } from '../agent-chat/assistant-targets';
import { readAnchorIdentity, resolveMcpActor, type McpActor } from './actor';
import type { ActorOrigin } from '../workspace-actions/actor';
import {
  newTurnId as newLiftoffTurnId,
  releaseTurnLock as releaseLiftoffTurnLock,
  tryAcquireTurnLock as tryAcquireLiftoffTurnLock,
  TurnLockUnavailableError as LiftoffTurnLockUnavailableError,
} from '../liftoff/turn-control';
import {
  newTurnId as newInsightsTurnId,
  releaseTurnLock as releaseInsightsTurnLock,
  tryAcquireTurnLock as tryAcquireInsightsTurnLock,
  TurnLockUnavailableError as InsightsTurnLockUnavailableError,
} from '../insights/turn-control';
import { getCallerRole as getLiftoffCallerRole } from '../liftoff/chat-repository';
import { getCallerRole as getInsightsCallerRole } from '../insights/chat-repository';
import { AccountService } from '../accounts/service';
import { accountDisplayName } from '../accounts/display-name';
import {
  claimContinuation,
  finishContinuation,
  hasNewerPersonMessage,
  markContinuationRunning,
  recheckClaimedContinuation,
  requeueContinuation,
} from '../chat-continuations/store';
import {
  CLOUD_TASKS_RETRY_COUNT_HEADER,
  CONTINUATION_DISPATCH_DEADLINE_SECONDS,
  isLastDelivery,
} from '../chat-continuations/dispatch';

export const mcpChatRunWorkerRouter = Router();

const oidcClient = new OAuth2Client();
const accountService = new AccountService();

/** The task's dispatch deadline (chat-run-dispatch.ts sets 600 s), less the
 *  room an assistant turn needs for the call in flight when the deadline
 *  passes and for the closing call that writes the reply: the same reserve
 *  the stream routers keep under their 10-minute cutoff. */
const TASK_DISPATCH_DEADLINE_MS = 600_000;
const REPLY_CLOSING_RESERVE_MS = 90_000;

async function verifyWorkerOidc(req: Request): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // Local dev fallback: shared internal secret.
    return req.headers['x-internal-secret'] === process.env.INTERNAL_SERVICE_SECRET
      && Boolean(process.env.INTERNAL_SERVICE_SECRET);
  }
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: authHeader.slice(7),
      audience: getBackendUrl(),
    });
    const email = ticket.getPayload()?.email ?? '';
    const expected = process.env.MCP_CHAT_RUNS_INVOKER_SA;
    return Boolean(expected) && email === expected;
  } catch {
    return false;
  }
}

mcpChatRunWorkerRouter.post('/execute', async (req: Request, res: Response) => {
  if (!(await verifyWorkerOidc(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Read when the request arrives, before the claim: the queue's deadline
  // runs from the delivery, not from the moment the turn starts.
  const deliveredAt = Date.now();

  const raw = typeof req.body === 'string'
    ? JSON.parse(Buffer.from(req.body, 'base64').toString())
    : req.body;
  const { chatRunId, tenantId } = (raw ?? {}) as { chatRunId?: string; tenantId?: string };
  if (!chatRunId || !tenantId) {
    // Permanent — 200 so Cloud Tasks does not retry a malformed task.
    return res.status(200).json({ dropped: true });
  }

  // Atomic claim: queued only (NO reclaim — see header comment).
  const claim = await withTenantScope(tenantId, (client) => client.query(
    `UPDATE mcp_chat_runs
     SET status = 'running', lease_expires_at = NOW() + INTERVAL '10 minutes'
     WHERE id = $1 AND status = 'queued'
     RETURNING thread_id, agent_id, anchor_token_id, user_message, target_kind, attachments`,
    [chatRunId],
  ));
  if (claim.rows.length === 0) {
    return res.status(200).json({ noop: true });
  }
  const run = claim.rows[0] as {
    thread_id: string; agent_id: string | null; anchor_token_id: string; user_message: string;
    target_kind: string; attachments: ChatAttachment[] | null;
  };
  const attachments = Array.isArray(run.attachments) && run.attachments.length > 0 ? run.attachments : undefined;

  // Worker turn inputs (v6.1): the actor is the grant's account, resolved the
  // way every MCP tool call resolves it — membership re-read, fail closed.
  // A run whose caller cannot be resolved (anchor gone, membership removed,
  // lookup failed) is settled as failed(caller_unresolved) before any turn
  // starts: there is nobody to attribute or authorize the turn as, and a
  // defaulted role would run it with authority the person may no longer hold.
  // channelHint 'web' — both PB and TR enums exclude 'mcp'; the mcp channel
  // exists only on the thread row.
  let actor: McpActor | null = null;
  try {
    const anchor = await readAnchorIdentity(tenantId, run.anchor_token_id);
    if (anchor) {
      actor = await resolveMcpActor({
        tenantId,
        accountId: anchor.accountId,
        keyId: run.anchor_token_id,
        keyType: anchor.keyType,
      }, anchor);
    }
  } catch (err) {
    log.error({ error: (err as Error).message, chatRunId }, 'mcp chat worker: caller resolution failed');
  }
  if (!actor) {
    await withTenantScope(tenantId, (client) => client.query(
      `UPDATE mcp_chat_runs
       SET status = $2, assistant_message_id = $3, approval_id = $4, error_code = $5,
           action_summary = $6, why_summary = $7, detail = $8, reply_content = $9, answered_by = $10, completed_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [chatRunId, 'failed', null, null, 'caller_unresolved', null, null, null, null, null],
    ));
    log.info({ chatRunId, tenantId, terminal: 'failed', errorCode: 'caller_unresolved' }, 'mcp chat run finished');
    return res.status(200).json({ status: 'failed' });
  }
  const userId = actor.accountId;
  const userDisplayName = actor.displayName;
  const userRole = actor.role;
  let tenantName: string | undefined;
  try {
    // tenants is a platform-global (non-RLS) table — default pool.
    const t = await pool.query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    tenantName = t.rows[0]?.name as string | undefined;
  } catch (err) {
    log.warn({ error: (err as Error).message, chatRunId }, 'mcp chat worker: tenant name lookup failed');
  }

  // Consume the generator; hitl_required wins.
  let terminal: 'completed' | 'waiting_on_human' | 'failed' | null = null;
  let assistantMessageId: string | null = null;
  let approvalId: string | null = null;
  let errorCode: string | null = null;
  // Generic HITL card summary (hitl-card-content.ts) carried on the hitl_required
  // frame; denormalized onto the run so liftoff_get_chat_reply can relay it.
  let cardAction: string | null = null;
  let cardWhy: string | null = null;
  let cardDetail: string | null = null;
  // Assistant runs only: the reply, denormalized onto the run row (the CAIO's
  // message row is in workforce-service's database). Team runs keep the
  // assistant_message_id link and leave this null.
  let replyContent: string | null = null;
  // Liftoff runs only: the colleague the turn handed the reply to, so the
  // long-poll can attribute words Liftoff did not write.
  let answeredBy: string | null = null;

  try {
    if (isAssistantKind(run.target_kind)) {
      const outcome = await runAssistantTurn(run.target_kind, {
        tenantId,
        threadId: run.thread_id,
        userMessage: run.user_message,
        accountId: userId,
        displayName: userDisplayName,
        role: userRole,
        origin: { via: 'mcp', client: actor.client, credentialId: actor.keyId },
        attachments,
        // The reply has to be on its way before the queue gives up on this
        // delivery; a turn that finished after that would answer a request
        // that was already retried or abandoned.
        deadlineAt: deliveredAt + TASK_DISPATCH_DEADLINE_MS - REPLY_CLOSING_RESERVE_MS,
      });
      terminal = outcome.terminal;
      replyContent = outcome.replyContent;
      errorCode = outcome.errorCode;
      answeredBy = outcome.answeredBy;
    } else {
      for await (const event of runAgentChatTurn({
        tenantId,
        agentId: run.agent_id as string,
        threadId: run.thread_id,
        userId,
        senderAccountId: userId || undefined,
        userDisplayName,
        userRole,
        tenantName,
        content: run.user_message,
        channelHint: 'web',
        attachments,
      })) {
        switch (event.type) {
          case 'hitl_required':
            terminal = 'waiting_on_human';
            approvalId = event.approvalId;
            cardAction = event.action ?? null;
            cardWhy = event.why ?? null;
            cardDetail = event.detail ?? null;
            break;
          case 'complete':
            assistantMessageId = event.message?.id ?? null;
            if (terminal !== 'waiting_on_human') terminal = 'completed';
            break;
          case 'error':
            if (terminal === null) {
              terminal = 'failed';
              errorCode = event.code;
            }
            break;
          default:
            break;
        }
      }
    }
  } catch (err) {
    log.error({ error: (err as Error).message, chatRunId }, 'mcp chat worker: turn threw');
    if (terminal === null) {
      terminal = 'failed';
      errorCode = 'turn_exception';
    }
  }

  if (terminal === null) {
    terminal = 'failed';
    errorCode = 'no_terminal';
  }

  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE mcp_chat_runs
     SET status = $2, assistant_message_id = $3, approval_id = $4, error_code = $5,
         action_summary = $6, why_summary = $7, detail = $8, reply_content = $9, answered_by = $10, completed_at = NOW()
     WHERE id = $1 AND status = 'running'`,
    [chatRunId, terminal, assistantMessageId, approvalId, errorCode, cardAction, cardWhy, cardDetail, replyContent, answeredBy],
  ));

  log.info({ chatRunId, tenantId, terminal, hasMessage: assistantMessageId !== null }, 'mcp chat run finished');
  return res.status(200).json({ status: terminal });
});

// POST /api/internal/mcp-chat-runs/continue
//
// A continuation task (chat-continuations/dispatch.ts). See the header for
// the handoff; every step is a statement bound to this row and this worker.
mcpChatRunWorkerRouter.post('/continue', async (req: Request, res: Response) => {
  if (!(await verifyWorkerOidc(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const deliveredAt = Date.now();
  const lastDelivery = isLastDelivery(req.headers[CLOUD_TASKS_RETRY_COUNT_HEADER]);

  const raw = typeof req.body === 'string'
    ? JSON.parse(Buffer.from(req.body, 'base64').toString())
    : req.body;
  const { continuationId, tenantId } = (raw ?? {}) as { continuationId?: string; tenantId?: string };
  if (!continuationId || !tenantId) {
    // Permanent — 200 so Cloud Tasks does not retry a malformed task.
    return res.status(200).json({ dropped: true });
  }
  const workerId = `${process.env.K_REVISION ?? 'local'}:${process.pid}:${deliveredAt}`;

  // 1. CLAIM. No row: cancelled by a person's message, or already taken by
  //    another delivery. Nothing runs.
  const row = await claimContinuation(tenantId, continuationId, workerId);
  if (!row) {
    return res.status(200).json({ noop: true });
  }
  if (row.surface === 'caio') {
    // The Chief AI Officer's continuations run in the workforce service; a
    // row of its surface here is a defect, not a task to retry.
    await finishContinuation(tenantId, row.id, workerId, 'failed', 'caio continuation delivered to platform-backend');
    return res.status(200).json({ status: 'failed' });
  }

  // 2. LOCK, through the surface's own turn lock.
  let lock: { turnId: string; abortController: AbortController } | null = null;
  let release: (() => Promise<void>) | null = null;
  try {
    if (row.surface === 'liftoff') {
      const handle = await tryAcquireLiftoffTurnLock(tenantId, row.threadId, newLiftoffTurnId());
      if (handle) {
        lock = handle;
        release = () => releaseLiftoffTurnLock(handle);
      }
    } else {
      const handle = await tryAcquireInsightsTurnLock(tenantId, row.threadId, newInsightsTurnId());
      if (handle) {
        lock = handle;
        release = () => releaseInsightsTurnLock(handle);
      }
    }
  } catch (err) {
    if (!(err instanceof LiftoffTurnLockUnavailableError) && !(err instanceof InsightsTurnLockUnavailableError)) throw err;
    log.warn({ continuationId, tenantId, error: (err as Error).message }, 'chat continuation: turn lock unavailable');
  }
  if (!lock || !release) {
    // Busy: the turn that queued this is still finishing, or a person is
    // talking. The queue's backoff retries; on its last delivery the row is
    // failed here, so it is never left queued once the queue has given up.
    if (lastDelivery) {
      await finishContinuation(tenantId, row.id, workerId, 'failed', 'lock_busy');
      return res.status(200).json({ status: 'failed', reason: 'lock_busy' });
    }
    await requeueContinuation(tenantId, row.id, workerId);
    return res.status(503).json({ retry: true, reason: 'lock_busy' });
  }

  try {
    // 3. RECHECK, with the lock held.
    const claimed = await recheckClaimedContinuation(tenantId, row.id, workerId);
    if (!claimed) {
      // Cancelled between the claim and the lock, or re-queued and taken by
      // another delivery.
      return res.status(200).json({ noop: true, reason: 'not_claimed' });
    }
    // A person writing supersedes a CONTINUATION: they moved on, and
    // carrying on with what they stopped caring about is noise. It does not
    // supersede background work — they asked for that and then carried on
    // talking, and discarding it because they spoke again would throw away
    // the thing they asked for.
    let superseded = false;
    if (row.kind !== 'background_work') {
      try {
        superseded = await hasNewerPersonMessage(tenantId, row.surface, row.threadId, row.originMessageId);
      } catch (err) {
        log.warn({ continuationId, tenantId, error: (err as Error).message }, 'chat continuation: supersession check failed; running');
      }
    }
    if (superseded) {
      // A person's turn ran while this row was claimed, or is what took the
      // lock in the gap: their message is what the thread is about now.
      await finishContinuation(tenantId, row.id, workerId, 'cancelled', 'superseded');
      return res.status(200).json({ status: 'cancelled', reason: 'superseded' });
    }
    if (!(await markContinuationRunning(tenantId, row.id, workerId))) {
      return res.status(200).json({ noop: true, reason: 'not_claimed' });
    }

    // 4. RUN, as the person whose message started the work.
    const account = await accountService.getById(row.accountId);
    const role = account
      ? (row.surface === 'liftoff'
          ? await getLiftoffCallerRole(tenantId, row.accountId)
          : await getInsightsCallerRole(tenantId, row.accountId))
      : null;
    if (!account || !role) {
      await finishContinuation(tenantId, row.id, workerId, 'failed', 'caller_unresolved');
      return res.status(200).json({ status: 'failed', reason: 'caller_unresolved' });
    }
    let outcome;
    try {
      outcome = await runAssistantTurn(row.surface, {
        tenantId,
        threadId: row.threadId,
        // Background work carries its own brief: nothing was in progress, so
        // there is nothing to carry on with. A continuation carries none and
        // picks up where the bound closed the turn.
        userMessage: row.kind === 'background_work' ? row.brief : '',
        accountId: row.accountId,
        displayName: accountDisplayName(account),
        role,
        lock,
        ...(row.kind === 'background_work'
          ? {}
          : { continuation: { originMessageId: row.originMessageId, ordinal: row.ordinal } }),
        deadlineAt: deliveredAt + CONTINUATION_DISPATCH_DEADLINE_SECONDS * 1000 - REPLY_CLOSING_RESERVE_MS,
      });
    } catch (err) {
      log.error({ continuationId, tenantId, error: (err as Error).message }, 'chat continuation: turn threw');
      await finishContinuation(tenantId, row.id, workerId, 'failed', `turn_exception: ${(err as Error).message}`);
      return res.status(200).json({ status: 'failed' });
    }
    if (outcome.terminal === 'completed') {
      await finishContinuation(tenantId, row.id, workerId, 'done', 'completed');
      return res.status(200).json({ status: 'done' });
    }
    await finishContinuation(tenantId, row.id, workerId, 'failed', outcome.errorCode ?? 'failed');
    return res.status(200).json({ status: 'failed', reason: outcome.errorCode ?? 'failed' });
  } finally {
    await release();
  }
});

// POST /api/internal/mcp-chat-runs/settle-by-approval
//
// Durable HITL resume settlement (plan §6 Part C, Option 1). The TR resume /
// expiry path calls this to (a) deliver the resumed continuation to the chat
// thread and (b) settle any durable MCP run that paused on this approval. It
// covers EVERY chat origin, not just MCP:
//   - outcome 'completed' (default): post the resumed continuation as the
//     thread's assistant message (web / Slack / Teams / MCP all have an
//     agent_chat_threads row) so it becomes visible — the web UI's message
//     refetch picks it up. If a durable mcp_chat_runs row matches, also flip it
//     to 'completed' + link the message so liftoff_chat_result returns the reply.
//   - outcome 'failed': the 24h expiry fired with no decision — flip a matching
//     mcp_chat_runs row to 'failed' (error_code) so the client stops polling
//     waiting_on_human (it is in the active-per-thread index).
//
// Idempotent + safe:
//   - `SELECT ... FOR UPDATE` on the still-'waiting_on_human' mcp run serializes
//     concurrent deliveries (a duplicate resume, or the expiry racing a late
//     decision): the loser sees 0 rows post-commit and no-ops.
//   - Non-MCP origins have no run row; the continuation is still posted to the
//     thread. Autonomous / workflow resumes pass a non-chat threadId (or none),
//     so the agent_chat_threads guard skips the post — never polluting non-chat
//     threads.
//
// Auth: X-Service-Auth === PLATFORM_CALLBACK_TOKEN (the TR->PB shared secret,
// same pattern as the reconcile-now / notifications platform callbacks).
mcpChatRunWorkerRouter.post('/settle-by-approval', async (req: Request, res: Response) => {
  if (!process.env.PLATFORM_CALLBACK_TOKEN
    || req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { tenantId, approvalId, agentId, internalAgentId, threadId, outcome, replyText: continuationText, errorCode, delegatedTo } = (req.body ?? {}) as {
    tenantId?: string; approvalId?: string; agentId?: string; internalAgentId?: string | null; threadId?: string;
    outcome?: 'completed' | 'failed'; replyText?: string; errorCode?: string; delegatedTo?: unknown;
  };
  if (!tenantId || !approvalId) {
    return res.status(400).json({ error: 'tenantId and approvalId required' });
  }
  // The team's words, read the way the live stream reads them before a
  // person sees them (common/guarded-stream.ts). Once, here: the row below
  // and the Liftoff mirror after it both carry what came out of that reading.
  const replyText = typeof continuationText === 'string' && continuationText.trim().length > 0
    ? await guardWholeText(continuationText, {
        tenantId,
        speaker: internalAgentId ?? agentId ?? 'team',
        ...(threadId ? { threadId } : {}),
      })
    : continuationText;
  const resolvedOutcome: 'completed' | 'failed' = outcome === 'failed' ? 'failed' : 'completed';
  // Who the resumed run handed work to, as the continuation's contributors.
  // Only the strings — a malformed entry names nobody, and an older runtime
  // that sends nothing reads as nobody rather than as a failed settlement.
  const delegatedToIds = Array.isArray(delegatedTo)
    ? delegatedTo.filter((id): id is string => typeof id === 'string')
    : [];

  const result = await withTenantScope(tenantId, async (client) => {
    // Claim any durable MCP run for this approval. FOR UPDATE + the status guard
    // makes the settle exactly-once under concurrent delivery. `run` is undefined
    // for web / Slack / Teams-origin approvals (they have no durable run).
    const runRes = await client.query(
      `SELECT id, thread_id, agent_id FROM mcp_chat_runs
       WHERE approval_id = $1 AND status = 'waiting_on_human'
       FOR UPDATE`,
      [approvalId],
    );
    const run = runRes.rows[0] as { id: string; thread_id: string; agent_id: string } | undefined;

    // Deliver the resumed continuation to the chat thread (EVERY origin). Prefer
    // the MCP run's thread (authoritative), else the threadId the resume passed.
    // Only on 'completed' with real text; an empty continuation still settles the
    // run so it can never hang.
    const msgThreadId = run?.thread_id ?? threadId ?? null;
    let assistantMessageId: string | null = null;
    let posted = false;
    // The thread the continuation actually reached, carried out so the Liftoff
    // mirror below can ask whether that thread belongs to a conversation
    // somebody is waiting on. Distinct from msgThreadId, which is only a
    // candidate until the chat-origin guard has accepted it.
    let postedToThreadId: string | null = null;
    if (resolvedOutcome === 'completed'
      && typeof replyText === 'string' && replyText.trim().length > 0
      && msgThreadId) {
      // Chat-origin guard: only post to a real (non-deleted) chat thread. An
      // autonomous / workflow resume passes a non-chat threadId (or none), so
      // this skips silently and never pollutes non-chat threads.
      const t = await client.query(
        `SELECT 1 FROM agent_chat_threads WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [msgThreadId, tenantId],
      );
      if (t.rows.length > 0) {
        // Attribute to the run's agent, else the thread's participant agent.
        let agentId: string | null = run?.agent_id ?? null;
        if (!agentId) {
          const p = await client.query(
            `SELECT agent_id FROM agent_chat_thread_participants WHERE thread_id = $1 LIMIT 1`,
            [msgThreadId],
          );
          agentId = (p.rows[0]?.agent_id as string | undefined) ?? null;
        }
        // tenant_id is denormalized onto the message for RLS. `contributors`
        // is the continuation's attribution — the teammates the resumed run
        // brought in, on either side of the approval it waited for — through
        // the same resolver, off the same durable record, as a streamed reply.
        const contributors = await resolveContributors(tenantId, delegatedToIds);
        const msg = await client.query(
          `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, contributors)
           VALUES ($1, $2, $3, 'assistant', $4, $5)
           RETURNING id`,
          [tenantId, msgThreadId, agentId, replyText, JSON.stringify(contributors)],
        );
        assistantMessageId = msg.rows[0].id as string;
        posted = true;
        postedToThreadId = msgThreadId;
        // fromAgent: a resumed continuation is the team replying, so the reply
        // clock moves and the thread reads as unread until somebody opens it.
        await touchThreadOnClient(client, msgThreadId, tenantId, true);
      }
    }

    // Settle the durable MCP run if one is present (the FK to the message above
    // requires the message row to exist first, which it does).
    if (run) {
      if (resolvedOutcome === 'failed') {
        await client.query(
          `UPDATE mcp_chat_runs
           SET status = 'failed', error_code = $2, completed_at = NOW()
           WHERE id = $1 AND status = 'waiting_on_human'`,
          [run.id, errorCode ?? 'approval_expired'],
        );
        return { settled: true, posted, postedToThreadId, chatRunId: run.id, status: 'failed' };
      }
      await client.query(
        `UPDATE mcp_chat_runs
         SET status = 'completed', assistant_message_id = $2, completed_at = NOW()
         WHERE id = $1 AND status = 'waiting_on_human'`,
        [run.id, assistantMessageId],
      );
      return { settled: true, posted, postedToThreadId, chatRunId: run.id, status: 'completed' };
    }

    // No durable run (web / Slack / Teams): posting the continuation IS the outcome.
    return { settled: posted, posted, postedToThreadId };
  });

  // The person may not have been reading the team's thread at all: Liftoff can
  // hand a turn to a team, and when it does, the conversation they are actually
  // in is the Liftoff one. The continuation above reached the team's thread,
  // which stays the system of record; this carries a copy of it to where it was
  // asked for, attributed to the team so the transcript keeps two voices in it.
  //
  // AWAITED rather than detached, for the reason the title generation in
  // agent-chat is: Cloud Run may scale this container away the moment the
  // callback responds, and a mirror that only sometimes lands is worse than one
  // that never does. It never throws, so awaiting cannot cost the settle.
  //
  // No-ops for every thread that is not paired, which is nearly all of them.
  if (result.postedToThreadId && typeof replyText === 'string') {
    await mirrorDelegatedReplyToLiftoff({
      tenantId,
      delegateThreadId: result.postedToThreadId,
      replyText,
    });
  }

  // On expiry (outcome:'failed'), grey out any Slack/Teams review cards so no stale
  // "Approve" button remains. Best-effort, fire-and-forget. The Slack card keys on
  // reviewId; the Teams card also needs agentId (carried on the expiry callback).
  if (resolvedOutcome === 'failed') {
    const footer = 'Expired — no decision within the review window.';
    void import('../agent-chat/slack-adapter/review-dm-notifier')
      .then(({ chatUpdateAllSiblingCards }) => chatUpdateAllSiblingCards({ reviewId: approvalId, tenantId, footer }))
      .catch(() => undefined);
    // updateAllReviewCards resolves the agent's display name from
    // internal_agents, which is keyed by the CONTROL-PLANE id; the raw agentId
    // on this callback is runtime-space (ADR-039) and cannot address it. Prefer
    // the resolved id; keep agentId for the rollout window with older TR
    // revisions.
    const cardAgentId = internalAgentId ?? agentId;
    if (cardAgentId) {
      void import('../agent-chat/teams-adapter/review-card-notifier')
        .then(({ updateAllReviewCards }) => updateAllReviewCards(tenantId, approvalId, cardAgentId, footer))
        .catch(() => undefined);
    }
  }

  log.info({ tenantId, approvalId, outcome: resolvedOutcome, ...result }, 'hitl settle-by-approval');
  return res.status(200).json(result);
});
