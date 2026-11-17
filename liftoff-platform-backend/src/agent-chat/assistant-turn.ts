// Running one turn of a platform assistant from a surface that is not the
// dashboard: a coding tool over MCP, a Slack DM, a Teams chat.
//
// The run executes on the assistant's own surface, through the same runners
// the dashboard uses: runLiftoffChatTurn under Liftoff's own thread lock, and
// the delegate runtimes for the Insights Manager (in-process, on its own
// lock) and the Chief AI Officer (an HTTP stream into workforce-service). A
// turn runs AS the person who asked it — every caller resolves them first —
// so a shared workspace's assistant knows exactly whom it is talking to, and
// anything it does is attributed to that person and to the surface they used.
// Every terminal maps to one outcome; the reply is returned as text so the
// surface can post it however it posts.

import { log } from '../infrastructure/logging';
import { runLiftoffChatTurn } from '../liftoff/chat-service';
import { runInsightsChatTurn } from '../insights/chat-service';
import {
  newTurnId as newLiftoffTurnId,
  releaseTurnLock as releaseLiftoffTurnLock,
  tryAcquireTurnLock as tryAcquireLiftoffTurnLock,
} from '../liftoff/turn-control';
import { createDelegateRuntime } from '../liftoff/delegation-runtimes';
import type { ChatAttachment } from '../chat-attachments';
import {
  CAIO_DELEGATION_TARGET,
  INSIGHTS_DELEGATION_TARGET,
} from '../liftoff/delegation-targets';
import type { TenantMemberRole } from '../liftoff/chat-repository';
import type { ActorOrigin } from '../workspace-actions/actor';
import type { AssistantKind } from './assistant-targets';
import { createThread as createLiftoffThread } from '../liftoff/chat-repository';
import { createThread as createInsightsThread } from '../insights/chat-repository';
import { CAIODelegationError, createPairedTeamPlanThread } from '../liftoff/caio-delegation';

/** Thrown when the Chief AI Officer's service could not open a thread; the
 *  surface tells the person the assistant is unreachable rather than failing
 *  the turn as an unknown error. */
export class AssistantUnreachableError extends Error {
  constructor(kind: AssistantKind) {
    super(`assistant ${kind} is unreachable`);
    this.name = 'AssistantUnreachableError';
  }
}

/** Open a fresh thread on the assistant's own surface, as the person: the
 *  same three creators the dashboard and the MCP surface use. */
export async function createAssistantThread(
  kind: AssistantKind,
  caller: { tenantId: string; accountId: string; role: TenantMemberRole },
): Promise<string> {
  if (kind === 'liftoff') return (await createLiftoffThread({ tenantId: caller.tenantId, accountId: caller.accountId })).id;
  if (kind === 'insights') return (await createInsightsThread({ tenantId: caller.tenantId, accountId: caller.accountId })).id;
  try {
    return await createPairedTeamPlanThread({ caller });
  } catch (err) {
    if (err instanceof CAIODelegationError) throw new AssistantUnreachableError(kind);
    throw err;
  }
}

export interface AssistantTurnOutcome {
  terminal: 'completed' | 'failed';
  replyContent: string | null;
  errorCode: string | null;
  /** The colleague the assistant handed the reply to, by display label: the
   *  author_label a Liftoff turn persisted on the message row, or the first
   *  contributor on the `colleague` row an Insights Manager or Chief AI
   *  Officer turn persisted. Null when the assistant answered itself. */
  answeredBy: string | null;
}

export async function runAssistantTurn(
  kind: AssistantKind,
  input: {
    tenantId: string;
    threadId: string;
    userMessage: string;
    accountId: string;
    displayName: string;
    role: string;
    /** Where the turn came through — a coding tool, a Slack DM, a Teams chat —
     *  so every workspace action the assistant takes is attributed to it.
     *  Absent for the dashboard's own surfaces, which are the default. */
    origin?: ActorOrigin;
    /** What the message handed over: documents as uploads, pictures as media
     *  references the service already stored. */
    attachments?: ChatAttachment[];
    /** 'answer' when an agent brought the assistant in for a question and
     *  nobody is present to confirm anything: no mutating action, no colleague,
     *  no browser. Liftoff and the Insights Manager honour it; the Chief AI
     *  Officer is never brought in for an answer. */
    toolMode?: 'answer';
    /** The brief the caller wrote for the assistant's model, already framed
     *  (liftoff/forwarded-context.ts): read this turn, in front of the
     *  message, never persisted. A team bringing a colleague in sends its
     *  directives and the team's id this way, so the person-readable row
     *  carries neither. Absent for a direct message from a coding tool or a
     *  chat workspace, which needs no forwarding. */
    forwardedContext?: string | null;
    /** Who wrote that brief: the assistant's thread keeps one status row
     *  naming them. Absent with an absent brief. */
    forwardedBy?: { id: string; label: string } | null;
    /** When the reply must be on its way (epoch ms): the caller's own request
     *  has a cutoff (a Cloud Tasks dispatch deadline), and the loop closes the
     *  reply before it rather than finishing into a request that is gone.
     *  Best effort, read between calls. */
    deadlineAt?: number;
    /** Present when this turn continues work a bound closed (the continuation
     *  worker): `userMessage` is ignored, no user row is written, and the loop
     *  keeps the origin message's id. Liftoff and the Insights Manager only;
     *  the Chief AI Officer continues its own turns in the workforce service. */
    continuation?: { originMessageId: string; ordinal: number };
    /** The thread lock the caller already holds, when it took it itself (the
     *  continuation worker takes the lock BEFORE re-reading its row, so the
     *  lock and the run are two steps of one handoff). With it, a Liftoff or
     *  Insights turn runs its loop directly under that lock; without it,
     *  Liftoff takes its own and the Insights Manager runs through its
     *  delegate runtime, which takes its own. */
    lock?: { turnId: string; abortController: AbortController };
  },
): Promise<AssistantTurnOutcome> {
  // An assistant turn runs AS the anchor's account, on that account's own
  // surface; with no resolvable caller there is nobody to attribute or
  // authorize the turn as, so it fails rather than running anonymously.
  if (!input.accountId) {
    return { terminal: 'failed', replyContent: null, errorCode: 'caller_unresolved', answeredBy: null };
  }
  const role = input.role as TenantMemberRole;

  // The Insights Manager under a lock the caller holds: the same direct run
  // as Liftoff's, on its own loop. Everything the delegate runtime would add
  // (its lock, its stop watcher) is the caller's here.
  if (kind === 'insights' && input.lock) {
    let outcome: AssistantTurnOutcome | null = null;
    for await (const event of runInsightsChatTurn({
      threadId: input.threadId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      role,
      userMessage: input.userMessage,
      callerName: input.displayName,
      origin: input.origin,
      attachments: input.attachments,
      toolMode: input.toolMode,
      forwardedContext: input.forwardedContext ?? null,
      forwardedBy: input.forwardedBy ?? null,
      turnId: input.lock.turnId,
      abortController: input.lock.abortController,
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      ...(input.continuation ? { continuation: input.continuation } : {}),
    })) {
      switch (event.type) {
        case 'complete':
          outcome = {
            terminal: 'completed',
            replyContent: event.message?.content ?? null,
            errorCode: null,
            answeredBy: event.message?.contributors?.[0]?.label ?? null,
          };
          break;
        case 'delegation_paused':
          outcome = { terminal: 'completed', replyContent: event.message?.content ?? event.reason, errorCode: null, answeredBy: null };
          break;
        case 'error':
          outcome = { terminal: 'failed', replyContent: null, errorCode: event.code, answeredBy: null };
          break;
        default:
          break;
      }
    }
    return outcome ?? { terminal: 'failed', replyContent: null, errorCode: 'no_terminal', answeredBy: null };
  }

  if (kind === 'liftoff') {
    let lock;
    if (input.lock) {
      lock = input.lock;
    } else {
      try {
        lock = await tryAcquireLiftoffTurnLock(input.tenantId, input.threadId, newLiftoffTurnId());
      } catch {
        return { terminal: 'failed', replyContent: null, errorCode: 'assistant_unavailable', answeredBy: null };
      }
      if (!lock) {
        // A dashboard turn is running on this thread right now.
        return { terminal: 'failed', replyContent: null, errorCode: 'busy', answeredBy: null };
      }
    }
    try {
      let outcome: AssistantTurnOutcome | null = null;
      for await (const event of runLiftoffChatTurn({
        threadId: input.threadId,
        tenantId: input.tenantId,
        accountId: input.accountId,
        role,
        userMessage: input.userMessage,
        callerName: input.displayName,
        origin: input.origin,
        attachments: input.attachments,
        toolMode: input.toolMode,
        forwardedContext: input.forwardedContext ?? null,
        forwardedBy: input.forwardedBy ?? null,
        turnId: lock.turnId,
        abortController: lock.abortController,
        ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
        ...(input.continuation ? { continuation: input.continuation } : {}),
      })) {
        switch (event.type) {
          case 'complete':
            outcome = {
              terminal: 'completed',
              replyContent: event.message?.content ?? null,
              errorCode: null,
              answeredBy: event.message?.authorLabel ?? null,
            };
            break;
          case 'delegation_paused':
            // Terminal and not a failure: a colleague Liftoff brought in
            // stopped to wait on a person. The pause sentence is the reply;
            // the resumed answer is mirrored into this same conversation
            // later, where the next turn's history carries it.
            outcome = {
              terminal: 'completed',
              replyContent: event.message?.content ?? event.reason,
              errorCode: null,
              answeredBy: null,
            };
            break;
          case 'error':
            outcome = { terminal: 'failed', replyContent: null, errorCode: event.code, answeredBy: null };
            break;
          default:
            break;
        }
      }
      return outcome ?? { terminal: 'failed', replyContent: null, errorCode: 'no_terminal', answeredBy: null };
    } finally {
      // A lock the caller took is the caller's to release.
      if (!input.lock) await releaseLiftoffTurnLock(lock as Parameters<typeof releaseLiftoffTurnLock>[0]);
    }
  }

  // Insights Manager / Chief AI Officer: the delegate runtimes already own
  // each one's lock, transport and event normalization.
  const target = kind === 'caio' ? CAIO_DELEGATION_TARGET : INSIGHTS_DELEGATION_TARGET;
  const runtime = createDelegateRuntime(target, {
    tenantId: input.tenantId,
    accountId: input.accountId,
    role,
    displayName: input.displayName,
    origin: input.origin,
    ...(input.toolMode ? { toolMode: input.toolMode } : {}),
  });
  let outcome: AssistantTurnOutcome | null = null;
  for await (const event of runtime.runTurn({
    delegateThreadId: input.threadId,
    content: input.userMessage,
    forwardedContext: input.forwardedContext ?? null,
    forwardedBy: input.forwardedBy ?? null,
    attachments: input.attachments,
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    ...(input.continuation ? { continuation: input.continuation } : {}),
  })) {
    switch (event.type) {
      case 'complete':
        outcome = { terminal: 'completed', replyContent: event.text, errorCode: null, answeredBy: event.answeredBy };
        break;
      case 'paused':
        outcome = { terminal: 'completed', replyContent: event.reason, errorCode: null, answeredBy: null };
        break;
      case 'busy':
        outcome = { terminal: 'failed', replyContent: null, errorCode: 'busy', answeredBy: null };
        break;
      case 'error':
        outcome = { terminal: 'failed', replyContent: null, errorCode: 'assistant_error', answeredBy: null };
        break;
      default:
        break;
    }
    // All four are terminal per the DelegateRuntime contract; stop reading at
    // the first rather than trusting the generator to end itself.
    if (outcome) break;
  }
  return outcome ?? { terminal: 'failed', replyContent: null, errorCode: 'no_terminal', answeredBy: null };
}
