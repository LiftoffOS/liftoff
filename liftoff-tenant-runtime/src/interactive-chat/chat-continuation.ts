// The continuation of a chat turn a bound closed.
//
// A chat turn is bounded like a platform turn: its turn budget (the engine
// reports `limit_reached`) or this service's hard timeout. When the closing
// reply of such a turn says work the person asked for is still to do, the
// work goes on as a RUN on the same thread: a run is already a job here,
// background and resumable, with a queued state, a claim and a Cloud Task.
// The run reads the thread (the conversation so far, the closing reply
// included), the continuation note as its objective and the datasets kept
// for the conversation (the run's prompt lists them), runs as the person
// whose message started the work, and posts its reply into the thread as a
// continued run's reply is posted today. A run that ends `limit_reached`
// with the closing reply still saying [continue] schedules the next, up to
// MAX_CHAT_CONTINUATIONS_PER_MESSAGE for one person's message.
//
// Rides the run-continuation rails (agent-execution/handlers/run-continuation-handler.ts):
// the same agent_scheduled_invocations row, the same Cloud Task, the same
// /api/tasks/resume-execution receiver, keyed by `kind: 'chat-continuation'`
// on the row's payload — on a queue of its own, because a continuation's
// retries are waiting for a busy conversation rather than recovering from a
// failure (twenty attempts with backoff, where agent-tasks gives five).
//
// The handoff, in order, because a claim is not the turn and a person's turn
// can start at any moment (the same order the platform assistants' worker
// keeps):
//
//   1. CLAIM the row (pending → resume_inflight under a fenced lease); no
//      row to claim → cancelled or taken, end.
//   2. The THREAD must be free: the per-thread chat turn lock the chat turn
//      handler takes. Held by a person's turn → hand the row back to pending
//      and answer a retryable status so Cloud Tasks re-drives it, or on the
//      queue's last delivery mark the row errored (lock_busy) and 200, so no
//      row is left pending after the queue has given up.
//   3. RECHECK under the lock: the row still ours (else end), and no person
//      message on the thread newer than this continuation (else cancelled,
//      superseded: the person moved on). Only then fired.
//   4. RUN, deliver the reply, and chain the next when the run's closing
//      reply says the work is still to do.
//
// A new person message cancels a queued (pending) continuation before it is
// claimed (`cancelChatContinuations`, called by the chat turn handler); one
// claimed but not yet running is caught by the recheck; a running one hears
// the message as a mid-run message, as any active run on the thread does.

import { v4 as uuidv4 } from 'uuid';
import { appendAssistantMessage } from './chat-event-relay';
import { enqueueAgentExecution } from '../infrastructure/cloud-tasks';
import { agentScheduledInvocationsRepo } from '../scheduling/agent-scheduled-invocations-repo';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { agentExecutionService } from '../agent-execution/service';
import { resolveTerminalState } from '../agent-execution/terminal-state';
import type { TaskExecutionResult, TerminalState } from '../agent-execution/types';
import { invocationsService } from '../invocations/service';
import { tryAcquireLock, releaseLock, LockServiceUnavailableError } from './locks';
import { requestClosingReplyWithVerdict, trimActivityDigest } from './closing-reply';

/** How many times the work may go on for one person's message. The same
 *  cap the platform assistants keep. */
export const MAX_CHAT_CONTINUATIONS_PER_MESSAGE = 5;

/** What the continuation run reads as its objective. Model-only: it is
 *  never persisted as a message and never shown to a person. The same words
 *  the platform assistants give their continuations. */
export const CHAT_CONTINUATION_NOTE =
  'Continue the work in progress in this conversation. The datasets kept for it are listed. '
  + 'Write the reply when the work is done, or when you must stop again.';

/** The queue that carries a continuation: its own, because what makes one
 *  retry is the conversation's turn lock being BUSY rather than a failure,
 *  and that has to be re-delivered with backoff until the conversation is
 *  free. A run that throws must not be re-run twenty times. */
const CHAT_CONTINUATION_QUEUE = 'chat-continuations' as const;
/** `max_attempts` on chat-continuations-{env} (Liftoff-Infrastructure-GCP,
 *  terraform/modules/cloud-tasks: 20 attempts, 5 s to 60 s with four
 *  doublings, about fifteen minutes). Cloud Tasks does not tell a receiver
 *  how many attempts it has; the count on the delivery is read against this
 *  so the last one can mark the row instead of handing it back to a queue
 *  that will not call again. */
export const CHAT_CONTINUATION_MAX_DELIVERIES = 20;
export const CLOUD_TASKS_RETRY_COUNT_HEADER = 'x-cloudtasks-taskretrycount';

/** A short wait before the task is delivered: the turn that queues it is
 *  still holding the thread's lock while it finishes; a delivery inside that
 *  window would only find the lock busy and burn an attempt. */
const CHAT_CONTINUATION_DELAY_MS = 5_000;

/** What the origin message is trimmed to on the payload: the closing reply
 *  of a continuation run answers "what they asked" from it. */
const ORIGIN_MESSAGE_MAX_CHARS = 2_000;

/** Everything the continuation run needs, on the scheduled row's payload. */
export interface ChatContinuationPayload {
  kind: 'chat-continuation';
  threadId: string;
  /** The runtime agent (agents.id here) the run executes as. */
  runtimeAgentId: string;
  /** The control plane's internal_agents.id the thread belongs to, for the
   *  closing reply's attribution, as the chat turn attributes it. */
  internalAgentId: string;
  /** The person's turn this work belongs to (the control plane's turn id,
   *  else the turn's invocation id). Every continuation of one message
   *  carries the same one. */
  originTurnId: string;
  /** The person's message, trimmed, for the closing reply of a continuation
   *  run to answer. */
  originMessage: string;
  /** 1..MAX_CHAT_CONTINUATIONS_PER_MESSAGE for the origin message. */
  ordinal: number;
  /** The person whose message started the work: the run is theirs. */
  senderUserId: string | null;
  senderAccountId: string | null;
  /** The bound that closed the turn this continues. */
  reason: 'limit_reached' | 'deadline';
  /** When the row was scheduled, after the origin turn persisted its rows:
   *  a person message on the thread newer than this supersedes the row. */
  scheduledAt: string;
}

/**
 * Work an agent started in this conversation and is not waiting for.
 *
 * The SAME rails as a continuation, because a continuation already is what
 * this needs: a durable row, a Cloud Task, the thread's own lock, and a
 * reply posted into the thread when it is done. The differences are three,
 * and each matters.
 *
 *   THE OBJECTIVE is the team's own brief rather than "carry on with what
 *   you were doing", because nothing was in progress: the team decided a job
 *   was long and set it going.
 *
 *   A PERSON WRITING DOES NOT CANCEL IT. A continuation is superseded by the
 *   next thing the person says, and rightly: they moved on. Background work
 *   is the opposite — they asked for it and then carried on talking, and
 *   cancelling it because they spoke again would throw away the thing they
 *   asked for. Its context_ref is deliberately outside the continuation
 *   prefix so `cancelChatContinuations` cannot reach it.
 *
 *   IT DOES NOT CHAIN. A continuation that runs out of room queues the next;
 *   this reports what it got and stops, because nobody asked for a second
 *   helping and the person can ask again.
 *
 * Delivery is a push and it cannot interrupt: the run takes the thread's
 * chat lock like any other, so it waits for the conversation to be free and
 * then speaks. A person mid-sentence never has an answer land on top of
 * them.
 */
export interface BackgroundWorkPayload {
  kind: 'background-work';
  threadId: string;
  runtimeAgentId: string;
  internalAgentId: string;
  /** The whole job, in the team's own words. Stands on its own. */
  brief: string;
  senderUserId: string | null;
  senderAccountId: string | null;
  scheduledAt: string;
}

/** The context_ref of background work. Outside the continuation prefix on
 *  purpose: a person writing on the thread must not cancel the work they
 *  asked for. */
export function backgroundWorkContextRef(threadId: string, workId?: string): string {
  const prefix = `background-work:${threadId}:`;
  return workId === undefined ? prefix : `${prefix}${workId}`;
}

export interface ScheduleBackgroundWorkInput {
  tenantId: string;
  runtimeAgentId: string;
  internalAgentId: string;
  threadId: string;
  brief: string;
  senderUserId?: string | null;
  senderAccountId?: string | null;
  /** The turn that set it going. */
  scheduledByInvocationId: string;
}

/** How soon background work starts. Not immediately: the turn that started
 *  it is still speaking, and the thread's lock is held until it stops. */
const BACKGROUND_WORK_DELAY_MS = 5_000;

/**
 * Queue a piece of background work: the row, then the task.
 *
 * Answers the row's id, or null when it could not be queued, which is
 * reported and never thrown — the turn that called this has a reply to
 * write, and work that was not queued must not also fail the turn.
 */
export async function scheduleBackgroundWork(input: ScheduleBackgroundWorkInput): Promise<string | null> {
  const now = new Date();
  const firesAt = new Date(now.getTime() + BACKGROUND_WORK_DELAY_MS);
  const workId = uuidv4();
  const payload: BackgroundWorkPayload = {
    kind: 'background-work',
    threadId: input.threadId,
    runtimeAgentId: input.runtimeAgentId,
    internalAgentId: input.internalAgentId,
    brief: input.brief.slice(0, ORIGIN_MESSAGE_MAX_CHARS),
    senderUserId: input.senderUserId ?? null,
    senderAccountId: input.senderAccountId ?? null,
    scheduledAt: now.toISOString(),
  };
  try {
    const row = await agentScheduledInvocationsRepo.insert({
      tenantId: input.tenantId,
      agentId: input.runtimeAgentId,
      threadId: input.threadId,
      contextRef: backgroundWorkContextRef(input.threadId, workId),
      scheduleKey: firesAt.toISOString().slice(0, 16),
      firesAt,
      objective: 'background-work',
      scheduledByInvocationId: input.scheduledByInvocationId,
      workflowResume: payload as unknown as Record<string, unknown>,
    });
    const enqueued = await enqueueAgentExecution(input.tenantId, input.runtimeAgentId, {
      objective: 'background-work',
      threadId: input.threadId,
      triggeredBy: 'human',
      triggeredByLabel: 'background_work',
      ...(input.senderUserId ? { triggeredByUserId: input.senderUserId } : {}),
      scheduleKey: firesAt.toISOString().slice(0, 16),
      scheduleTime: firesAt,
      contextRef: backgroundWorkContextRef(input.threadId, workId),
      queue: CHAT_CONTINUATION_QUEUE,
      taskIdentity: row.id,
      receiverPath: '/api/tasks/resume-execution',
      receiverBody: {
        tenantId: input.tenantId,
        agentId: input.runtimeAgentId,
        invocationId: input.scheduledByInvocationId,
        workflowResume: { scheduledInvocationId: row.id, kind: 'background-work' },
      },
    });
    await agentScheduledInvocationsRepo.updateCloudTaskName(row.id, enqueued.taskName);
    logger.info(
      { event: 'background_work_queued', tenantId: input.tenantId, threadId: input.threadId, scheduledInvocationId: row.id },
      'an agent set a long job going and carried on talking',
    );
    return row.id;
  } catch (err) {
    logger.error(
      { event: 'background_work_not_queued', tenantId: input.tenantId, threadId: input.threadId, error: (err as Error).message },
      'could not queue the background work a team asked for',
    );
    return null;
  }
}

/** The context_ref of every continuation of a thread starts with the thread's
 *  prefix, so one prefix cancels them all. */
export function chatContinuationContextRef(threadId: string, originTurnId?: string, ordinal?: number): string {
  const prefix = `chat-continuation:${threadId}:`;
  if (originTurnId === undefined) return prefix;
  return ordinal === undefined ? `${prefix}${originTurnId}:` : `${prefix}${originTurnId}:${ordinal}`;
}

export interface ScheduleChatContinuationInput {
  tenantId: string;
  runtimeAgentId: string;
  internalAgentId: string;
  threadId: string;
  originTurnId: string;
  originMessage: string;
  ordinal: number;
  senderUserId?: string | null;
  senderAccountId?: string | null;
  /** The invocation that closed and queued this: the turn's, or the previous
   *  continuation run's. */
  scheduledByInvocationId: string;
  reason: 'limit_reached' | 'deadline';
}

/**
 * Queue the continuation of a thread's work: the row, then the task.
 *
 * Answers with the row's id, or null when nothing was queued: an ordinal past
 * the cap (the closing reply already said what remains), or a failure to
 * schedule, which is reported and never thrown, because the turn that calls
 * this has already persisted its reply and a continuation that was not queued
 * must not also fail the turn.
 */
export async function scheduleChatContinuation(input: ScheduleChatContinuationInput): Promise<string | null> {
  if (input.ordinal > MAX_CHAT_CONTINUATIONS_PER_MESSAGE) return null;
  const now = new Date();
  const firesAt = new Date(now.getTime() + CHAT_CONTINUATION_DELAY_MS);
  const scheduleKey = firesAt.toISOString().slice(0, 16);
  const contextRef = chatContinuationContextRef(input.threadId, input.originTurnId, input.ordinal);
  const payload: ChatContinuationPayload = {
    kind: 'chat-continuation',
    threadId: input.threadId,
    runtimeAgentId: input.runtimeAgentId,
    internalAgentId: input.internalAgentId,
    originTurnId: input.originTurnId,
    originMessage: input.originMessage.slice(0, ORIGIN_MESSAGE_MAX_CHARS),
    ordinal: input.ordinal,
    senderUserId: input.senderUserId ?? null,
    senderAccountId: input.senderAccountId ?? null,
    reason: input.reason,
    scheduledAt: now.toISOString(),
  };
  try {
    const row = await agentScheduledInvocationsRepo.insert({
      tenantId: input.tenantId,
      agentId: input.runtimeAgentId,
      threadId: input.threadId,
      contextRef,
      scheduleKey,
      firesAt,
      objective: 'chat-continuation',
      scheduledByInvocationId: input.scheduledByInvocationId,
      workflowResume: payload as unknown as Record<string, unknown>,
    });
    const enqueued = await enqueueAgentExecution(input.tenantId, input.runtimeAgentId, {
      objective: 'chat-continuation',
      threadId: input.threadId,
      triggeredBy: 'human',
      triggeredByLabel: `chat_continuation:${input.ordinal}`,
      ...(input.senderUserId ? { triggeredByUserId: input.senderUserId } : {}),
      scheduleKey,
      scheduleTime: firesAt,
      contextRef,
      queue: CHAT_CONTINUATION_QUEUE,
      // Named after the row, so Cloud Tasks itself keeps one live task per
      // continuation.
      taskIdentity: row.id,
      receiverPath: '/api/tasks/resume-execution',
      receiverBody: {
        tenantId: input.tenantId,
        agentId: input.runtimeAgentId,
        invocationId: input.scheduledByInvocationId,
        workflowResume: { scheduledInvocationId: row.id, kind: 'chat-continuation' },
      },
    });
    await agentScheduledInvocationsRepo.updateCloudTaskName(row.id, enqueued.taskName);
    logger.info({
      event: 'chat_continuation_queued',
      tenantId: input.tenantId,
      threadId: input.threadId,
      scheduledInvocationId: row.id,
      originTurnId: input.originTurnId,
      ordinal: input.ordinal,
      reason: input.reason,
    }, 'chat turn closed by a bound with work still to do; continuation queued');
    return row.id;
  } catch (err) {
    logger.error({
      event: 'chat_continuation_not_queued',
      tenantId: input.tenantId,
      threadId: input.threadId,
      originTurnId: input.originTurnId,
      ordinal: input.ordinal,
      error: (err as Error).message,
    }, 'could not queue the continuation of a chat turn');
    return null;
  }
}

/** A person's message on the thread: every continuation still queued for it
 *  is cancelled. Answers with how many were. */
export async function cancelChatContinuations(tenantId: string, threadId: string): Promise<number> {
  const rows = await agentScheduledInvocationsRepo.cancelByContextRefPrefix(
    tenantId, chatContinuationContextRef(threadId),
  );
  if (rows.length > 0) {
    logger.info({ event: 'chat_continuations_cancelled', tenantId, threadId, count: rows.length },
      'a person wrote on the thread; the continuations queued for it are cancelled');
  }
  return rows.length;
}

/** Whether this delivery is the queue's last: `X-CloudTasks-TaskRetryCount`
 *  counts the retries before it, so the last delivery is the one at
 *  max attempts minus one. */
export function isLastChatContinuationDelivery(retryCountHeader: string | string[] | undefined): boolean {
  const raw = Array.isArray(retryCountHeader) ? retryCountHeader[0] : retryCountHeader;
  const retryCount = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(retryCount)) return false;
  return retryCount + 1 >= CHAT_CONTINUATION_MAX_DELIVERIES;
}

export type ChatContinuationTaskOutcome =
  | { status: 'noop'; reason: string }
  | { status: 'retry'; reason: 'lock_busy' | 'lock_unavailable' }
  | { status: 'cancelled'; reason: 'superseded' }
  | { status: 'failed'; reason: string }
  | { status: 'done'; invocationId: string; continued: boolean };

/**
 * One delivery of a continuation task: the handoff described at the top.
 * `retry` asks the caller for a retryable status; everything else is final
 * for this delivery.
 */
export async function runChatContinuationTask(input: {
  tenantId: string;
  scheduledInvocationId: string;
  lastDelivery: boolean;
}): Promise<ChatContinuationTaskOutcome> {
  const { tenantId, scheduledInvocationId } = input;

  // 1. CLAIM.
  const claimed = await agentScheduledInvocationsRepo.claimHitlForResume(scheduledInvocationId, tenantId);
  if (!claimed) return { status: 'noop', reason: 'not_pending' };
  const leaseToken = claimed.lease_token as string;
  const payload = claimed.workflow_resume_payload as ChatContinuationPayload | BackgroundWorkPayload | null;
  const isBackgroundWork = payload?.kind === 'background-work';
  if (!payload
    || (payload.kind !== 'chat-continuation' && payload.kind !== 'background-work')
    || !payload.threadId || !payload.runtimeAgentId) {
    await agentScheduledInvocationsRepo.markWakeErrored(scheduledInvocationId, leaseToken, 'no_continuation_payload');
    return { status: 'failed', reason: 'no_continuation_payload' };
  }
  const { threadId } = payload;
  const log = isBackgroundWork
    ? { tenantId, threadId, scheduledInvocationId, kind: 'background-work' }
    : { tenantId, threadId, scheduledInvocationId, originTurnId: payload.originTurnId, ordinal: payload.ordinal };

  // 2. The thread must be free.
  const pool = getPoolForService('scheduled-execution');
  const invocationId = uuidv4();
  let lock: Awaited<ReturnType<typeof tryAcquireLock>> = null;
  try {
    lock = await tryAcquireLock(pool, tenantId, threadId, invocationId);
  } catch (err) {
    if (!(err instanceof LockServiceUnavailableError)) throw err;
    await agentScheduledInvocationsRepo.releaseResumeLease(scheduledInvocationId, leaseToken, 'lock_unavailable', { deferred: true });
    return { status: 'retry', reason: 'lock_unavailable' };
  }
  if (!lock) {
    if (input.lastDelivery) {
      await agentScheduledInvocationsRepo.markWakeErrored(scheduledInvocationId, leaseToken, 'lock_busy');
      logger.warn({ event: 'chat_continuation_failed', ...log, reason: 'lock_busy' },
        'the thread stayed busy for every delivery; the continuation is not run');
      return { status: 'failed', reason: 'lock_busy' };
    }
    await agentScheduledInvocationsRepo.releaseResumeLease(scheduledInvocationId, leaseToken, 'lock_busy', { deferred: true });
    return { status: 'retry', reason: 'lock_busy' };
  }

  try {
    // 3. RECHECK under the lock.
    const row = await agentScheduledInvocationsRepo.getById(scheduledInvocationId);
    if (!row || row.status !== 'resume_inflight') {
      return { status: 'noop', reason: 'not_claimed' };
    }
    // A person writing supersedes a CONTINUATION: they moved on, and
    // carrying on with what they had stopped caring about is noise. It does
    // not supersede background work, which is the opposite case — they asked
    // for it and then carried on talking, and throwing it away because they
    // spoke again would discard the thing they asked for.
    let superseded = false;
    if (!isBackgroundWork) {
      try {
        superseded = await invocationsService.hasUserMessageAfter(threadId, tenantId, new Date(payload.scheduledAt));
      } catch (err) {
        logger.warn({ ...log, error: (err as Error).message }, 'chat continuation: supersession check failed; running');
      }
    }
    if (superseded) {
      await agentScheduledInvocationsRepo.markWakeErrored(scheduledInvocationId, leaseToken, 'superseded');
      logger.info({ event: 'chat_continuation_cancelled', ...log, reason: 'superseded' },
        'a person wrote on the thread after this continuation was queued; it is not run');
      return { status: 'cancelled', reason: 'superseded' };
    }
    if (!(await agentScheduledInvocationsRepo.markFiredUnderLease(scheduledInvocationId, leaseToken))) {
      return { status: 'noop', reason: 'not_claimed' };
    }

    // 4. RUN, as the person whose message started the work.
    logger.info(
      { event: isBackgroundWork ? 'background_work_running' : 'chat_continuation_running', ...log, invocationId },
      isBackgroundWork ? 'background work running' : 'chat continuation running',
    );
    const result = await agentExecutionService.executeTask({
      tenantId,
      agentId: payload.runtimeAgentId,
      workflowId: uuidv4(),
      taskId: invocationId,
      invocationId,
      // Background work has its own brief; a continuation carries on with
      // what was already in progress.
      objective: isBackgroundWork ? payload.brief : CHAT_CONTINUATION_NOTE,
      threadId,
      triggeredBy: 'human',
      triggeredByLabel: isBackgroundWork ? 'background_work' : `chat_continuation:${payload.ordinal}`,
      ...(payload.senderUserId ? { triggeredByUserId: payload.senderUserId } : {}),
      ...(payload.senderAccountId ? { senderAccountId: payload.senderAccountId } : {}),
      // The turn this continues did not queue behind the per-agent execution
      // lock (a chat turn never does: it is serialised by the thread's own
      // lock, held here), and its second half does not either.
      bypassAgentLock: true,
    });
    if (isBackgroundWork) {
      // The reply into the thread IS the delivery: the person asked for this
      // and gets it without asking again. It does not chain — nobody asked
      // for a second helping, and they can ask again.
      const text = typeof result.output === 'string' ? result.output.trim() : '';
      if (!text) {
        logger.warn({ ...log, invocationId }, 'background work produced no reply; nothing is posted');
        return { status: 'done', invocationId, continued: false };
      }
      try {
        const { settleWakeViaCallback } = await import('../platform-callback/client');
        const { listDelegatedAgentIds } = await import('../agent-execution/delegated-agents');
        // The same delivery a continuation uses, keyed by the row: the
        // control plane posts once per key however often this is retried.
        await settleWakeViaCallback({
          tenantId,
          wakeId: scheduledInvocationId,
          threadId,
          agentId: payload.runtimeAgentId,
          replyText: text,
          delegatedTo: await listDelegatedAgentIds(tenantId, invocationId),
        });
      } catch (err) {
        logger.warn(
          { event: 'background_work_reply_not_delivered', ...log, invocationId, error: (err as Error).message },
          'the background work ran; its reply could not be delivered to the thread',
        );
      }
      return { status: 'done', invocationId, continued: false };
    }
    const continued = await deliverChatContinuationReply({ tenantId, scheduledInvocationId, invocationId, payload, result });
    return { status: 'done', invocationId, continued };
  } finally {
    await releaseLock(pool, lock);
  }
}

/** The reply of a continuation run, into the thread, and the next
 *  continuation when the run was closed by its bound with work still to do.
 *  Answers whether a next one was queued. */
async function deliverChatContinuationReply(args: {
  tenantId: string;
  scheduledInvocationId: string;
  invocationId: string;
  payload: ChatContinuationPayload;
  result: TaskExecutionResult;
}): Promise<boolean> {
  const { tenantId, scheduledInvocationId, invocationId, payload, result } = args;
  const terminal = resolveTerminalState(result, false);
  const outputText = typeof result.output === 'string' ? result.output.trim() : '';
  let replyText = outputText;
  let unfinished = false;

  if (terminal === 'limit_reached') {
    // The bound closed the run: the person gets "what I did, what is left"
    // rather than the last narration, and the verdict decides the next.
    const closed = await requestClosingReplyWithVerdict({
      tenantId,
      agentId: payload.internalAgentId,
      threadId: payload.threadId,
      invocationId,
      userMessage: payload.originMessage,
      activityDigest: outputText || trimActivityDigest(canonicalTail(result)),
    });
    if (closed) {
      replyText = [outputText, closed.text]
        .filter(Boolean)
        .reduce((acc, part) => appendAssistantMessage(acc, part), '');
      unfinished = closed.unfinished;
    } else {
      unfinished = true;
    }
  } else if (terminal === 'paused' || terminal === 'parked') {
    // The run itself will speak when it resumes (a question, an approval, a
    // wall-clock park); nothing to deliver here.
    return false;
  }

  if (!replyText) replyText = outcomeNote(terminal, result);
  try {
    const { settleWakeViaCallback } = await import('../platform-callback/client');
    const { listDelegatedAgentIds } = await import('../agent-execution/delegated-agents');
    // Keyed by the row, as a continued run's delivery is: the control plane
    // delivers once per key however often this callback is retried.
    await settleWakeViaCallback({
      tenantId,
      wakeId: scheduledInvocationId,
      threadId: payload.threadId,
      agentId: payload.runtimeAgentId,
      replyText,
      delegatedTo: await listDelegatedAgentIds(tenantId, invocationId),
    });
  } catch (err) {
    logger.warn({
      event: 'chat_continuation_reply_not_delivered',
      tenantId, threadId: payload.threadId, invocationId, error: (err as Error).message,
    }, 'the continuation ran; its reply could not be delivered to the thread');
  }

  if (terminal !== 'limit_reached' || !unfinished) return false;
  const next = await scheduleChatContinuation({
    tenantId,
    runtimeAgentId: payload.runtimeAgentId,
    internalAgentId: payload.internalAgentId,
    threadId: payload.threadId,
    originTurnId: payload.originTurnId,
    originMessage: payload.originMessage,
    ordinal: payload.ordinal + 1,
    senderUserId: payload.senderUserId,
    senderAccountId: payload.senderAccountId,
    scheduledByInvocationId: invocationId,
    reason: 'limit_reached',
  });
  return next !== null;
}

/** The tail of the run's own record of its conversation, when it wrote no
 *  text: what the closing reply is asked to report from. */
function canonicalTail(result: TaskExecutionResult): string | null {
  const messages = result.canonicalSnapshot?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  try {
    return messages.map((m) => JSON.stringify(m)).join('\n');
  } catch {
    return null;
  }
}

/** One sentence for a run that ended with no text of its own. A person asked
 *  for this work minutes ago; silence is not an ending. */
function outcomeNote(terminal: TerminalState, result: TaskExecutionResult): string {
  const why = typeof result.error === 'string' && result.error.trim() ? ` ${result.error.trim().slice(0, 600)}` : '';
  switch (terminal) {
    case 'escalated':
      return 'This work ran as far as it could on its own and has been handed to a person to look at.' + why;
    case 'gated':
      return 'This work is waiting on an approval before it can finish.' + why;
    case 'limit_reached':
      return 'This work reached its limit before it finished. Anything already saved to your documents or connected systems is still there.';
    case 'stopped':
      return 'This work was stopped before it finished, so there is no result to show.';
    case 'success':
      return 'This work finished without a summary to show here. Anything it produced is saved where it works.' + why;
    default:
      return 'This work stopped before it could finish. Anything already saved to your documents or connected systems is still there.' + why;
  }
}
