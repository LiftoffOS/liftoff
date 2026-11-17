// Four colleagues, four runtimes, one shape.
//
// A platform assistant can hand a turn to the Chief AI Officer, the Insights
// Manager, Liftoff, or (from Liftoff) any active agent, and the four could
// hardly be less alike underneath:
//
//   caio      an HTTP SSE stream in workforce-service, against a thread in that
//             service's own database.
//   insights  an async generator in THIS process, against insights_chat_threads,
//             whose stop is a row in insights_turn_signals.
//   liftoff   an async generator in this process, against liftoff_chat_threads,
//             whose stop is a row in liftoff_turn_signals.
//   team      an async generator in this process that is itself a wrapper around
//             an HTTP stream to Liftoff-Tenant-Runtime, against
//             agent_chat_threads, whose stop is an RPC into that runtime.
//
// The relay in agent-chat/handover.ts must not know any of that, or it forks
// four ways and the copies drift. So each one is wrapped as a DelegateRuntime
// with the same three verbs, and everything they emit is normalised to one
// event union. The differences that DO matter to the person, a colleague that
// is already busy or one that has paused for an approval, are named in that
// union rather than flattened away.
//
// Only the CAIO goes over HTTP from here. The other three are called
// in-process, which is why nothing in this file re-implements them as service
// calls.

import { log } from '../infrastructure/logging';
import { checkChatAdmission } from '../agent-chat/admission';
import { colleagueAnsweredBy } from '../agent-chat/colleague-message-type';
import { runAgentChatTurn } from '../agent-chat/chat-service';
import {
  addParticipant as addAgentChatParticipant,
  createThread as createAgentChatThread,
} from '../agent-chat/chat-repository';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { createThread as createInsightsThread } from '../insights/chat-repository';
import { runInsightsChatTurn } from '../insights/chat-service';
import {
  insertTurnSignal as insertInsightsTurnSignal,
  newTurnId as newInsightsTurnId,
  releaseTurnLock as releaseInsightsTurnLock,
  tryAcquireTurnLock as tryAcquireInsightsTurnLock,
  type TurnLockHandle as InsightsTurnLockHandle,
} from '../insights/turn-control';
import { createThread as createLiftoffThread } from './chat-repository';
import {
  insertTurnSignal as insertLiftoffTurnSignal,
  newTurnId as newLiftoffTurnId,
  releaseTurnLock as releaseLiftoffTurnLock,
  tryAcquireTurnLock as tryAcquireLiftoffTurnLock,
  type TurnLockHandle as LiftoffTurnLockHandle,
} from './turn-control';
import {
  createPairedTeamPlanThread,
  requestCAIOTurnStop,
  streamCAIOTurn,
} from './caio-delegation';
import type { DelegationTarget } from './delegation-targets';
import type { TenantMemberRole } from './chat-repository';
import type { ActorOrigin } from '../workspace-actions/actor';
import type { ChatAttachment } from '../chat-attachments';

// ── The normalised contract ─────────────────────────────────────────────

/**
 * What any colleague can say, in one shape.
 *
 * `complete`, `paused`, `busy` and `error` are all TERMINAL: the relay stops
 * reading at the first of them. That matters most for `paused`, because the
 * agent-chat runner emits a spurious PROVIDER_ERROR after a pause (its stream
 * ends without a `complete`, which is what a pause looks like from below), and a
 * relay that kept reading would report a failure on top of a legitimate wait.
 */
export type DelegatedEvent =
  | { type: 'thinking' }
  | { type: 'tool_call'; tool: string }
  | { type: 'text_delta'; text: string }
  | { type: 'content_block'; block: unknown }
  /** Finished. `text` and `blocks` are the colleague's own persisted version of
   *  the reply, which is the streamed text with any visualization fences already
   *  lifted out. Null means it persisted nothing, which is what a turn stopped
   *  before it spoke looks like. */
  | {
      type: 'complete';
      text: string | null;
      blocks: unknown[] | null;
      inputTokens: number;
      outputTokens: number;
      /** Who wrote the reply when the colleague, on its own surface, handed
       *  the turn to a colleague of its own: the label on its `colleague`
       *  row. Null when the colleague answered itself, and always null on a
       *  hand-over, where a colleague brought in is offered no colleague.
       *  Read by the surfaces that report `answeredBy` (assistant-turn.ts). */
      answeredBy: string | null;
    }
  /** Stopped and waiting on a person: an approval, or a question it asked. Not a
   *  failure, and not something Liftoff can resolve, so `reason` is written for
   *  the person and says where to go. */
  | { type: 'paused'; reason: string }
  /** A turn was already running on the colleague's own thread, so this message
   *  was folded into it and no reply comes back here. */
  | { type: 'busy' }
  | { type: 'error'; message: string };

export interface DelegationCaller {
  tenantId: string;
  accountId: string;
  /** The caller's REAL tenant role, as getCallerRole resolved it. Forwarded
   *  into every colleague, which makes its own permission decisions from it, so
   *  it is never defaulted or widened here. */
  role: TenantMemberRole;
  /** The person's name, for surfaces that attribute the sender. */
  displayName: string;
  /** Present when the Liftoff turn itself came through a coding tool (the
   *  MCP chat worker), so a colleague that acts on the workspace can record
   *  where the request came from. Carried to workforce-service as the
   *  x-origin header. */
  origin?: ActorOrigin;
  /** 'answer' when an agent brought the colleague in for a question and
   *  nobody is present to confirm anything. Honoured by the Insights Manager's
   *  runtime; the Chief AI Officer is never brought in for an answer. */
  toolMode?: 'answer';
  /** True on every in-turn hand-over: the colleague is brought in, so it is
   *  offered no colleague of its own and depth stays at one. Every runtime
   *  honours it: Liftoff and the Insights Manager withhold their bring-in
   *  tool, the Chief AI Officer is told on the wire. */
  asColleague?: boolean;
}

/**
 * One colleague, reduced to the three things the relay needs.
 *
 * `requestStop` is deliberately separate from abandoning the stream, because on
 * all three surfaces abandoning the stream stops nothing: every one of them
 * treats a lost reader as "the person walked away, finish and persist", which is
 * the same rule Liftoff applies to itself.
 */
export interface DelegateRuntime {
  /** Create the paired thread on this colleague's surface, returning its id. */
  createThread(): Promise<string>;
  /** Run one turn there. Terminates on the first terminal event.
   *
   *  `content` is the person's own words and nothing else. `forwardedContext`
   *  is the brief the asker wrote for this colleague, already framed for the
   *  colleague's MODEL (see forwarded-context.ts): read this turn, in front of
   *  the message, and never persisted. They travel separately because the
   *  colleague stores the first as the person's turn and nothing of the
   *  second: joined into one string, as they used to be, the colleague's
   *  thread showed Liftoff's paragraph as something the person had typed, and
   *  stored as its own row it showed the person a note meant for a model.
   *  Null when there is nothing worth forwarding, which is the ordinary case
   *  for a first request. */
  runTurn(args: {
    delegateThreadId: string;
    content: string;
    forwardedContext: string | null;
    /** Who forwarded it. The colleague's thread keeps one status row naming
     *  them, attributed to them; that row is all a person sees of the
     *  hand-over. Null with a null brief. */
    forwardedBy?: { id: string; label: string } | null;
    /** What the person handed over with the message, when the turn came with
     *  attachments of its own (the MCP chat worker's); a Liftoff delegation
     *  forwards none, its own attachments stay on Liftoff's thread. */
    attachments?: ChatAttachment[];
    /** When the reply must be on its way (epoch ms), for a caller whose own
     *  request has a cutoff (the MCP chat worker's task). The in-process
     *  runtimes hand it to the loop; the Chief AI Officer's stream sets its
     *  own from its stream's lifetime. */
    deadlineAt?: number;
    /** Present when the turn continues work a bound closed (the continuation
     *  worker's): the loop writes no user row and keeps the origin message.
     *  Only the in-process runtimes take one; the Chief AI Officer runs its
     *  own continuations in the workforce service. */
    continuation?: { originMessageId: string; ordinal: number };
  }): AsyncIterable<DelegatedEvent>;
  /** Ask the turn running there to stop. Best effort and never throws: the
   *  Liftoff turn is already ending, and there is nothing useful to say. */
  requestStop(args: { delegateThreadId: string }): Promise<void>;
}

const UNAVAILABLE = 'That colleague could not be reached just now. Please try again in a moment.';

// ── Chief AI Officer: workforce-service over HTTP ───────────────────────

function createCAIORuntime(caller: DelegationCaller): DelegateRuntime {
  const workforceCaller = {
    tenantId: caller.tenantId,
    accountId: caller.accountId,
    role: caller.role,
    // The person's name, so the Chief AI Officer knows who it is speaking
    // with and a colleague it brings in attributes the message to them.
    displayName: caller.displayName,
  };
  const origin = caller.origin ?? null;

  return {
    createThread: () => createPairedTeamPlanThread({ caller: workforceCaller }),

    async *runTurn({ delegateThreadId, content, forwardedContext, forwardedBy, attachments }) {
      for await (const event of streamCAIOTurn({
        caller: workforceCaller,
        origin,
        workforceThreadId: delegateThreadId,
        content,
        forwardedContext,
        forwardedBy: forwardedBy ?? null,
        attachments,
        handover: caller.asColleague === true,
      })) {
        switch (event.type) {
          case 'thinking':
          case 'tool_call':
          case 'text_delta':
          case 'content_block':
            yield event;
            break;
          case 'delegation_started':
            // The Chief AI Officer, on its own surface, handed the turn on.
            // Who answered is read off the persisted row at `complete`; the
            // live frame has no counterpart in this union because a hand-over
            // is one deep and this runtime's caller is never watching a chip.
            break;
          case 'delegation_paused':
            yield { type: 'paused', reason: event.reason };
            return;
          case 'complete':
            yield {
              type: 'complete',
              text: event.message?.content ?? null,
              blocks: event.message?.visualizationBlocks ?? null,
              inputTokens: event.message?.inputTokens ?? 0,
              outputTokens: event.message?.outputTokens ?? 0,
              answeredBy: colleagueAnsweredBy(event.message),
            };
            return;
          case 'busy':
            yield { type: 'busy' };
            return;
          case 'error':
            yield { type: 'error', message: event.message };
            return;
        }
      }
    },

    requestStop: ({ delegateThreadId }) =>
      requestCAIOTurnStop({ caller: workforceCaller, workforceThreadId: delegateThreadId }),
  };
}

// ── Insights Manager: in-process, on its own lock ───────────────────────

/**
 * The insights turn takes the INSIGHTS thread's lock, not Liftoff's.
 *
 * Its runner does not lock itself: whoever starts a turn owns that, exactly as
 * Liftoff's stream-router owns Liftoff's. So this runtime acquires the lock, and
 * that lock is also what makes the turn stoppable, because the stop is a row
 * addressed to the turn id the lock minted. Handing the runner nothing would
 * leave it unstoppable, and handing it Liftoff's turn id would point its claims
 * at a signal table that knows nothing about it.
 *
 * The stop is a SIGNAL, never a direct abort of the handle's controller. The
 * runner distinguishes the two: a claimed signal is a clean stop that keeps
 * whatever it had written, an unclaimed abort is a lost lock and reports itself
 * as an interruption.
 */
function createInsightsRuntime(caller: DelegationCaller): DelegateRuntime {
  // Minted inside runTurn and read by requestStop, which is why this runtime is
  // an object with state rather than three free functions.
  let liveTurnId: string | null = null;

  return {
    async createThread() {
      const thread = await createInsightsThread({
        tenantId: caller.tenantId,
        accountId: caller.accountId,
      });
      return thread.id;
    },

    async *runTurn({ delegateThreadId, content, forwardedContext, forwardedBy, attachments, deadlineAt, continuation }) {
      const turnId = newInsightsTurnId();
      let lock: InsightsTurnLockHandle | null;
      try {
        lock = await tryAcquireInsightsTurnLock(caller.tenantId, delegateThreadId, turnId);
      } catch (err) {
        log.error(
          { tenantId: caller.tenantId, threadId: delegateThreadId, error: (err as Error).message },
          'Liftoff delegation: could not take the Insights Manager turn lock',
        );
        yield { type: 'error', message: UNAVAILABLE };
        return;
      }
      if (!lock) {
        // Somebody is already talking to the Insights Manager on this thread.
        yield { type: 'busy' };
        return;
      }

      liveTurnId = turnId;
      try {
        for await (const event of runInsightsChatTurn({
          threadId: delegateThreadId,
          tenantId: caller.tenantId,
          accountId: caller.accountId,
          role: caller.role,
          userMessage: content,
          forwardedContext,
          forwardedBy: forwardedBy ?? null,
          callerName: caller.displayName,
          attachments,
          turnId,
          abortController: lock.abortController,
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          ...(continuation ? { continuation } : {}),
          // Where the turn came through, so the Insights Manager's actions are
          // attributed to it and a chat-workspace turn is not notified again.
          ...(caller.origin ? { origin: caller.origin } : {}),
          ...(caller.toolMode ? { toolMode: caller.toolMode } : {}),
          ...(caller.asColleague ? { asColleague: true } : {}),
        })) {
          switch (event.type) {
            case 'thinking':
            case 'tool_call':
            case 'text_delta':
            case 'content_block':
              yield event;
              break;
            case 'delegation_started':
              // The Insights Manager, on its own surface, handed the turn on.
              // Who answered is read off the persisted row at `complete`.
              break;
            case 'delegation_paused':
              yield { type: 'paused', reason: event.reason };
              return;
            case 'complete':
              yield {
                type: 'complete',
                text: event.message?.content ?? null,
                blocks: event.message?.visualizationBlocks ?? null,
                inputTokens: event.message?.inputTokens ?? 0,
                outputTokens: event.message?.outputTokens ?? 0,
                answeredBy: colleagueAnsweredBy(event.message),
              };
              return;
            case 'error':
              yield { type: 'error', message: event.message };
              return;
          }
        }
      } finally {
        liveTurnId = null;
        // Releasing takes this turn's signals with it through the foreign key,
        // so a stop that arrived a moment too late cannot be picked up by
        // whatever runs on that thread next.
        await releaseInsightsTurnLock(lock);
      }
    },

    async requestStop() {
      if (!liveTurnId) return;
      const delivery = await insertInsightsTurnSignal(caller.tenantId, liveTurnId, 'abort', {
        senderAccountId: caller.accountId,
        senderDisplayName: caller.displayName,
        sentAt: new Date().toISOString(),
      });
      log.info(
        { tenantId: caller.tenantId, turnId: liveTurnId, delivery },
        'Liftoff delegation: stop written for the Insights Manager turn',
      );
    },
  };
}

// ── Liftoff: in-process, on its own lock ────────────────────────────────

/**
 * Liftoff as a colleague: what the Chief AI Officer or the Insights Manager
 * hands a turn to when the question is outside their own remit. The same
 * shape as the Insights Manager's runtime, against Liftoff's own tables and
 * its own lock, because Liftoff's stream-router owns Liftoff's lock only for
 * turns that come through it.
 *
 * The turn itself is the generator Liftoff's own page drives, loaded when it
 * is first needed rather than at the top of this file: Liftoff's chat-service
 * imports this module to bring colleagues in, and a static import back would
 * make the two load each other. The caller flag says the turn is a hand-over,
 * which is the one thing Liftoff changes in it: it offers no colleague of its
 * own, so a hand-over is one deep whoever started it.
 */
function createLiftoffRuntime(caller: DelegationCaller): DelegateRuntime {
  let liveTurnId: string | null = null;

  return {
    async createThread() {
      const thread = await createLiftoffThread({
        tenantId: caller.tenantId,
        accountId: caller.accountId,
      });
      return thread.id;
    },

    async *runTurn({ delegateThreadId, content, forwardedContext, forwardedBy, attachments, deadlineAt }) {
      const turnId = newLiftoffTurnId();
      let lock: LiftoffTurnLockHandle | null;
      try {
        lock = await tryAcquireLiftoffTurnLock(caller.tenantId, delegateThreadId, turnId);
      } catch (err) {
        log.error(
          { tenantId: caller.tenantId, threadId: delegateThreadId, error: (err as Error).message },
          'hand-over: could not take the Liftoff turn lock',
        );
        yield { type: 'error', message: UNAVAILABLE };
        return;
      }
      if (!lock) {
        // Somebody is already talking to Liftoff on this thread.
        yield { type: 'busy' };
        return;
      }

      liveTurnId = turnId;
      try {
        const { runLiftoffChatTurn } = await import('./chat-service');
        for await (const event of runLiftoffChatTurn({
          threadId: delegateThreadId,
          tenantId: caller.tenantId,
          accountId: caller.accountId,
          role: caller.role,
          userMessage: content,
          forwardedContext,
          forwardedBy: forwardedBy ?? null,
          callerName: caller.displayName,
          attachments,
          turnId,
          abortController: lock.abortController,
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          ...(caller.origin ? { origin: caller.origin } : {}),
          ...(caller.toolMode ? { toolMode: caller.toolMode } : {}),
          ...(caller.asColleague ? { asColleague: true } : {}),
        })) {
          switch (event.type) {
            case 'thinking':
            case 'tool_call':
            case 'text_delta':
            case 'content_block':
              yield event;
              break;
            case 'delegation_started':
              // Liftoff, on its own surface, handed the turn on. Unreachable
              // on a hand-over (the flag above withholds its bring-in tool);
              // who answered is read off the persisted row at `complete`.
              break;
            case 'delegation_paused':
              yield { type: 'paused', reason: event.reason };
              return;
            case 'complete':
              yield {
                type: 'complete',
                text: event.message?.content ?? null,
                blocks: event.message?.visualizationBlocks ?? null,
                inputTokens: event.message?.inputTokens ?? 0,
                outputTokens: event.message?.outputTokens ?? 0,
                // Liftoff attributes a colleague's reply through `author`,
                // which its row maps to the same contributors shape.
                answeredBy: event.message?.authorLabel ?? null,
              };
              return;
            case 'error':
              yield { type: 'error', message: event.message };
              return;
          }
        }
      } finally {
        liveTurnId = null;
        // Releasing takes this turn's signals with it through the foreign key,
        // so a stop that arrived a moment too late cannot be picked up by
        // whatever runs on that thread next.
        await releaseLiftoffTurnLock(lock);
      }
    },

    async requestStop() {
      if (!liveTurnId) return;
      const delivery = await insertLiftoffTurnSignal(caller.tenantId, liveTurnId, 'abort', {
        senderAccountId: caller.accountId,
        senderDisplayName: caller.displayName,
        sentAt: new Date().toISOString(),
      });
      log.info(
        { tenantId: caller.tenantId, turnId: liveTurnId, delivery },
        'hand-over: stop written for the Liftoff turn',
      );
    },
  };
}

// ── An agent: in-process agent-chat, which fronts Tenant Runtime ──────

/**
 * A team turn is only "in-process" as far as this service goes: agent-chat is a
 * thin orchestrator over an HTTP stream to Liftoff-Tenant-Runtime, which owns
 * the session, the tools and the lock on the agent-chat thread. Two consequences
 * shape this adapter.
 *
 * First, the admission checks live in agent-chat's HTTP router, not in its turn
 * runner, so calling the runner directly would skip the chat rate limit and the
 * billing execution guard. A delegated turn is a real agent chat turn and pays
 * for itself the same way, so checkChatAdmission is called here. It increments
 * the rate-limit ledger, so it is called exactly once per turn.
 *
 * Second, there is no PB-side abort table for agent chat and the runner takes no
 * abort signal. Stopping is an RPC into the runtime, which writes the abort row
 * its engine reads. Abandoning the stream would leave the turn running and still
 * bill the model call.
 */
function createTeamRuntime(caller: DelegationCaller, target: DelegationTarget): DelegateRuntime {
  const agentId = target.id;

  return {
    async createThread() {
      const thread = await createAgentChatThread(
        caller.tenantId,
        caller.accountId,
        'web',
        undefined,
        // Titled at creation rather than left for the title generator. That
        // generator only runs on a turn that COMPLETES, and a turn that paused
        // for an approval is exactly the one people are now sent here to look
        // at, so the thread they arrive in would have read "Untitled chat" in
        // the team's own history. A later successful turn still replaces this
        // with a topical title, since nothing here is user-authored.
        //
        // Says where the thread came from and nothing else. The person who
        // asked is deliberately not named: a title is listed to the whole
        // workspace, which is the same reason the title generator is told never
        // to put a personal name in one.
        'Brought in by Liftoff',
      );
      // A thread has participants rather than an agent_id column, and the runner
      // does not add one: without this the team is not in its own thread.
      await addAgentChatParticipant(thread.id, agentId, caller.accountId, 'lead');
      return thread.id;
    },

    async *runTurn({ delegateThreadId, content, forwardedContext, forwardedBy, attachments }) {
      const admission = await checkChatAdmission({
        tenantId: caller.tenantId,
        accountId: caller.accountId,
        agentId,
      });
      if (!admission.allowed) {
        log.warn(
          { tenantId: caller.tenantId, agentId, httpStatus: admission.httpStatus },
          'Liftoff delegation: the team turn was not admitted',
        );
        yield {
          type: 'error',
          message:
            admission.httpStatus === 429
              ? 'That agent has answered too many messages just now. Please try again in a moment.'
              : admission.httpStatus === 402
                ? 'That agent cannot run right now because of a billing issue on this workspace.'
                : 'That agent is not available right now.',
        };
        return;
      }

      for await (const event of runAgentChatTurn({
        tenantId: caller.tenantId,
        agentId,
        threadId: delegateThreadId,
        userId: caller.accountId,
        senderAccountId: caller.accountId,
        userDisplayName: caller.displayName,
        userRole: caller.role,
        content,
        forwardedContext,
        forwardedBy: forwardedBy ?? null,
        attachments,
        channelHint: 'web',
      })) {
        switch (event.type) {
          case 'thinking':
            yield { type: 'thinking' };
            break;
          case 'tool_call':
            // Trace-mode fields are dropped: this surface shows a tool name.
            yield { type: 'tool_call', tool: event.tool };
            break;
          case 'text_delta':
            yield { type: 'text_delta', text: event.text };
            break;
          case 'text_break':
            // The end of one assistant message inside a multi-message turn. It
            // carries no text, so the boundary has to be written out or two
            // paragraphs arrive joined.
            yield { type: 'text_delta', text: '\n\n' };
            break;
          case 'hitl_required':
            // Third person, and no instruction on where to go: this sentence is
            // persisted into the Liftoff transcript, where it is read by
            // everyone on the thread rather than only by whoever sent the
            // message. The way there is an affordance beside it, not prose.
            yield {
              type: 'paused',
              reason: `${target.label} is waiting on an approval before it can continue.`,
            };
            return;
          case 'awaiting_input':
            yield {
              type: 'paused',
              reason: `${target.label} has a question before it can continue: ${event.question}`,
            };
            return;
          case 'interrupt_delivered':
            yield { type: 'busy' };
            return;
          case 'clarification_accepted':
            yield {
              type: 'paused',
              reason: `${target.label} was waiting on an answer, and this one has been passed to it. It will carry on in its own chat.`,
            };
            return;
          case 'stop_acknowledged':
            // Nothing was produced and nothing is coming. Terminal, with no
            // reply to persist.
            yield {
              type: 'complete', text: null, blocks: null, inputTokens: 0, outputTokens: 0, answeredBy: null,
            };
            return;
          case 'complete':
            yield {
              type: 'complete',
              text: event.message?.content ?? null,
              blocks: null, // agent chat has no visualization blocks
              inputTokens: event.message?.inputTokens ?? 0,
              outputTokens: event.message?.outputTokens ?? 0,
              answeredBy: colleagueAnsweredBy(event.message),
            };
            return;
          case 'error':
            yield {
              type: 'error',
              message:
                event.code === 'AGENT_BUSY'
                  ? 'That agent is busy with another conversation right now. Please try again in a moment.'
                  : event.message,
            };
            return;
          // Trace-mode events. Real chat never sets traceMode, so these never
          // arrive; listing them keeps the switch exhaustive.
          case 'catalog':
          case 'tool_call_finished':
          case 'usage':
            break;
        }
      }
    },

    async requestStop({ delegateThreadId }) {
      try {
        const result = await tenantRuntimeClient.signalStopChatTurn(caller.tenantId, {
          agentId,
          threadId: delegateThreadId,
          senderAccountId: caller.accountId,
          userDisplayName: caller.displayName,
        });
        log.info(
          { tenantId: caller.tenantId, agentId, deliveredAs: result.deliveredAs },
          'Liftoff delegation: stop requested on the team turn',
        );
      } catch (err) {
        log.warn(
          { tenantId: caller.tenantId, agentId, error: (err as Error).message },
          'Liftoff delegation: could not deliver the stop to the team turn',
        );
      }
    },
  };
}

// ── Selection ───────────────────────────────────────────────────────────

/** The runtime for one resolved target. The target has already been checked
 *  against the database by resolveDelegationTarget, so there is no unknown kind
 *  to fall through to. */
export function createDelegateRuntime(
  target: DelegationTarget,
  caller: DelegationCaller,
): DelegateRuntime {
  switch (target.kind) {
    case 'caio':
      return createCAIORuntime(caller);
    case 'insights':
      return createInsightsRuntime(caller);
    case 'liftoff':
      return createLiftoffRuntime(caller);
    case 'team':
      return createTeamRuntime(caller, target);
  }
}
