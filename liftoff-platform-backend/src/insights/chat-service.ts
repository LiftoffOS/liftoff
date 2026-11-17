// Insights Chat Service — tool-use loop orchestrator
//
// Runs a single chat turn end-to-end as an async generator of typed events.
// The stream-router (Phase 6 commit 6) wraps these events as SSE frames; the
// frontend consumes them to render a streaming assistant response.
//
// A single turn:
//
//   1. Persist the user message to the thread
//   2. Load up to 20 prior turns + the rolling conversation summary (if any)
//   3. Build a context-budgeted prompt (system prompt + user ctx + summary +
//      recent turns + current message) capped at 8000 input tokens
//   4. Run the agentic tool-use loop:
//        - Call llmClient.completeStream() with the filtered tool set
//        - Stream text deltas to the caller via a StreamingVisualizationParser
//          that emits typed text vs content_block events
//        - When the model requests tools, dispatch them via dispatchToolCall,
//          append the assistant turn (with tool_use blocks) and a user turn
//          (with tool_result blocks) to the conversation, loop again
//        - Bounds: 50 iterations, the model's context window (a call whose
//          prompt is past seven tenths of it closes the reply), and the
//          caller's deadline; each closes the reply with one tool-less call
//   5. One-shot-parse the accumulated text to recover any blocks the streaming
//      parser missed (unterminated fences, etc.), persist the assistant
//      message with the clean text + blocks
//   6. Audit-log the turn
//   7. Fire-and-forget: check if the rolling summary needs refreshing
//   8. Yield a final `complete` event with the persisted message
//
// One tool is not dispatched: `bring_in_colleague`. When the model calls it,
// the rest of the turn is the Chief AI Officer's or Liftoff's, on the same
// rail Liftoff hands a turn over on (agent-chat/handover.ts). Whatever the
// Insights Manager said before the call is persisted as its own row; the
// colleague's reply is persisted on this thread attributed to the colleague
// (`colleague` rows, `contributors`); and the turn ends there, because
// looping back to the model would have it summarise what the person just
// read. The pairing between this thread and the colleague's own is
// assistant_thread_delegations (migration 495).

import { log, logAudit } from '../infrastructure/logging';
import type { ActorOrigin } from '../workspace-actions/actor';
import {
  FORWARDED_CONTEXT_MESSAGE_TYPE,
  forwardedContextStatus,
  withForwardedContext,
} from '../liftoff/forwarded-context';
// The same markers the other surfaces stamp on the same facts, so one
// frontend renderer and one export rule cover every surface.
import {
  BROWSER_HANDBACK_MESSAGE_TYPE,
  BROWSER_POINT_MESSAGE_TYPE,
  HITL_STATUS_MESSAGE_TYPE,
} from '../agent-chat/hitl-status-message';
import { BROWSER_HANDBACK_TURN_TEXT } from '@liftoffos/browser-record';
import { executeBrowserAssistantToolDetailed, isBrowserAssistantTool } from '../browser-sessions/assistant-tools';
import { buildAssistantBrowserState } from '../browser-sessions/browser-state';
import { COLLEAGUE_MESSAGE_TYPE } from '../agent-chat/colleague-message-type';
import { runHandover, type HandoverAsker } from '../agent-chat/handover';
import {
  getAssistantThreadDelegation,
  pairAssistantThreadDelegation,
} from '../agent-chat/assistant-delegations';
import { INSIGHTS_DELEGATION_TARGET } from '../liftoff/delegation-targets';
import { decideTurnBound } from '@liftoffos/turn-bounds';
import { llmClient } from '../llm';
import { isDatasetTool, runDatasetTool } from '../datasets/tools';
import { isChatRecallTool, runChatRecallTool } from '../chat-recall/tools';
import { createTurn } from './chat-repository';
import { embedPlatformTurn } from '../chat-recall/turn-embedding';
import { isGeneratedFileTool, runGeneratedFileTool } from '../generated-files/assistant-tools';
import { parkOversizedToolResults } from '../datasets/park';
import { GuardedOutput } from '../common/guarded-stream';
import { readClosingVerdict } from '../common/closing-verdict';
import { openAssistantMessage } from '../common/assistant-message-boundary';
import { enqueueContinuation, MAX_CONTINUATIONS_PER_MESSAGE } from '../chat-continuations/store';
import { enqueueContinuationTask } from '../chat-continuations/dispatch';
import { fireAndForget } from '../shared/fire-and-forget';
import { COMPLETED_WITHOUT_REPLY } from '../shared/completed-without-reply';
import type {
  LLMMessage,
  LLMStopReason,
  LLMToolCall,
  LLMToolResult,
} from '../llm/types';
import {
  appendMessage,
  getThreadRollingSummary,
  lastAssistantReplyAt,
  listMessages,
  updateThreadRollingSummary,
  updateThreadTitleInternal,
  type InsightsChatMessage,
  type TenantMemberRole,
} from './chat-repository';
import { maybeGenerateThreadTitle } from '../shared/thread-title-generation';
import { buildBudgetedPrompt, DEFAULT_INSIGHTS_BUDGET, type BudgetConfig } from './context-budget';
// The attachment contract, shared with Liftoff and the Chief AI Officer: one
// projection decides what is persisted, one wrapper decides what the model
// reads. See src/chat-attachments/.
import {
  ATTACHMENT_ALLOWANCE_TOKENS,
  IMAGE_ALLOWANCE_TOKENS,
  MEDIA_NOTICE_ALLOWANCE_TOKENS,
  composeTurnText,
  toMessageAttachments,
  toMessageMedia,
  type ChatAttachment,
  type Contributor,
} from '../chat-attachments';
import { prepareTurnMedia } from '../llm/vision';
import { claimInboundMedia } from '../media/inbound';
import {
  formatSummaryForPrompt,
  generateRollingSummary,
  shouldSummarize,
  type SummarizationMessage,
} from './conversation-summarization';
import {
  BRING_IN_COLLEAGUE_TOOL,
  buildInsightsSystemPrompt,
  dispatchToolCall,
  getToolDefinitionsForRole,
  resolveInsightsHandoverTarget,
} from './tools';
import type { InsightsToolContext, InsightsToolResult } from './tools/types';
import {
  StreamingVisualizationParser,
  parseVisualizationBlocks,
  type StreamingParseEvent,
} from './visualization-parser';
import { WEB_SERVER_TOOLS } from '../llm/web-tools';
import {
  claimAbortSignal,
  claimUserMessageSignal,
  frameInterrupt,
  newTurnId,
} from './turn-control';
import { notifyPlatformChatReply } from '../notifications';

// ── Event shape ─────────────────────────────────────────────────────────

export type ChatErrorCode =
  | 'PROVIDER_ERROR'
  | 'MAX_ITERATIONS'
  /** The prompt the last call carried was past the guarded share of the
   *  model's context window; the reply was closed with one more call. */
  | 'CONTEXT_FULL'
  /** The caller's deadline for the reply passed between two calls; the reply
   *  was closed with one more call. */
  | 'DEADLINE'
  /** A colleague was brought in and could not answer. Its own code, as on
   *  Liftoff: "the provider failed" and "the colleague we handed this to could
   *  not finish" are different things to look at in a log. A colleague that
   *  PAUSED to wait on a person is not one of these; a pause has its own
   *  terminal frame. */
  | 'DELEGATION_ERROR'
  | 'INTERNAL';

export type ChatServiceEvent =
  /** Sent immediately when a turn starts, before any LLM call. */
  | { type: 'thinking' }
  /** Sent when the LLM requests a specific tool (one per call). */
  | { type: 'tool_call'; tool: string }
  /** Incremental text outside of visualization fences. */
  | { type: 'text_delta'; text: string }
  /** A complete visualization block parsed from a closed fence. On a
   *  hand-over the block is the colleague's, in whatever shape its own parser
   *  delivers it. */
  | { type: 'content_block'; block: unknown }
  /** The turn has been handed to a colleague, named here so the reply can be
   *  attributed WHILE it streams. Same payload and same rule as Liftoff's:
   *  sent once, before any of the colleague's own events, and with no closing
   *  counterpart, because the segment ends where the turn ends. `author` and
   *  `authorLabel` are what the stored reply's `contributors` carry. */
  | { type: 'delegation_started'; author: string; authorLabel: string }
  /** Terminal, and NOT a failure: the colleague stopped to wait on a person.
   *  `message` is the status row the pause wrote into the transcript;
   *  `delegateThreadId` is the conversation the decision is waiting in. */
  | {
      type: 'delegation_paused';
      author: string;
      authorLabel: string;
      delegateThreadId: string | null;
      reason: string;
      message: InsightsChatMessage | null;
    }
  /** Terminal success — the final persisted assistant message. Null when the
   *  turn was stopped before it said anything: there is no reply to persist
   *  and none is invented. */
  | { type: 'complete'; message: InsightsChatMessage | null }
  /** Terminal failure — the turn could not complete. */
  | { type: 'error'; code: ChatErrorCode; message: string };

// ── Input shape ─────────────────────────────────────────────────────────

export interface RunChatTurnInput {
  threadId: string;
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
  userMessage: string;
  /** The brief a colleague wrote when it brought the Insights Manager into
   *  one of its conversations, already framed for the model (see
   *  liftoff/forwarded-context.ts). Read this turn, in front of the person's
   *  message, and never persisted. Absent for a person typing on the Insights
   *  page, who can see the thread they are in. */
  forwardedContext?: string | null;
  /** Who forwarded that background. The thread keeps one status row naming
   *  them, attributed to them. Null or absent with a null brief. */
  forwardedBy?: Contributor | null;
  /** Files and connector references attached to this message. Uploads are read
   *  by the model this turn; only the metadata (see toMessageAttachments) is
   *  persisted with the message, never the upload's text. */
  attachments?: ChatAttachment[];
  /** Optional caller display name for the userContext section of the prompt. */
  callerName?: string;
  /** Present when the turn came through a coding tool; carried to every
   *  workspace action this turn performs. */
  origin?: ActorOrigin;
  /** 'answer' when an agent brought this assistant in for a question: the
   *  turn is offered no mutating workspace action and no browser, because
   *  nobody is present to confirm a change and the browser is the person's. */
  toolMode?: 'answer';
  /** True when a colleague handed this turn to the Insights Manager in front
   *  of the person (Liftoff's or the Chief AI Officer's hand-over): everything
   *  stays on offer except a colleague of its own, so a hand-over is one deep
   *  on every surface. */
  asColleague?: boolean;
  /** This turn's id — the address its mid-run signals are written to
   *  (ADR-041). The stream-router mints it when it takes the thread lock, so
   *  the turn is stoppable from the instant it starts. Absent only for callers
   *  that run a turn without a lock. */
  turnId?: string;
  /** Fired when a stop is claimed, cancelling the in-flight model call. Owned
   *  by the lock handle so a lost lock aborts the turn the same way. */
  abortController?: AbortController;
  /** The person's browser event this turn carries, verified by the stream
   *  router against the runtime's record: they handed the browser back, or
   *  pointed at something in it. With an empty `userMessage` the turn is the
   *  event alone: no user row is written (the router's status line is what
   *  the thread shows) and the model reads the shared event text. */
  browserEvent?: { kind: 'handback'; holdId: string };
  /** When the reply must be on its way (epoch ms). The stream that carries it
   *  to the person has a fixed lifetime, and a background task a dispatch
   *  deadline, so the turn closes the reply inside it rather than finishing
   *  after the person was told it failed. Read between calls: a call already
   *  running when it passes is not shortened by it, and the caller chooses
   *  the margin so that the usual call fits. Absent for a caller with no
   *  cutoff. */
  deadlineAt?: number;
  /** Present when this turn continues work a bound closed (chat-continuations,
   *  migration 517). The turn then writes NO user row — the continuation
   *  note is supplied to the model as the turn's current message only, the
   *  way an injected mid-run message is a model-only entry — and keeps the
   *  origin message's id for the audit row and the next continuation, while
   *  `accountId` stays the person whose message started the work. Everything
   *  else runs unchanged: the tools, the closing round and the same trigger,
   *  up to the cap. */
  continuation?: { originMessageId: string; ordinal: number };
}

// ── Constants ───────────────────────────────────────────────────────────

/** Rounds of tools one reply may take: the runtime's order of magnitude for
 *  a run, not a number of prompts. */
const MAX_ITERATIONS = 50;
// The share of the window a prompt may reach, the conservative window for a
// model the registry has not sized, and the precedence between the three
// bounds all live in @liftoffos/turn-bounds. This loop reads what it can
// measure — the prompt the call carried, the model's recorded window, its own
// clock — and acts on the answer.

// A reply is closed, not abandoned. When a bound trips (the rounds are spent,
// the model's window is nearly full, or the caller's deadline has passed) the
// loop used to leave with the last round's results appended and never read,
// and the row said "Done." after paid work. Now one more model call is made
// with no tools, framed so the model answers from what it has. The note is the
// framing; the forbidden tools are the guarantee.
//
// The note tells the model what to do and names no mechanic for it to relay:
// an earlier wording ("the reading budget for one reply has been used") reached
// a person as "I ran out of reading budget". The last line it asks for is the
// verdict the loop reads to decide whether the work goes on after this turn
// (the continuation below); it is removed before the text reaches anyone.
const CLOSING_NOTE =
  'You must write the reply now, without calling a tool. Say what you did, what you found, and what is still '
  + 'to do, in plain words; do not mention limits, budgets or rounds. Then end with exactly one line on its own: '
  + '[continue] if work you were asked for is still to do, or [done] if it is finished.';
/** The closing note when no further continuation can be queued (the cap for
 *  the person's message is reached, or the turn has no message to continue
 *  from): the reply says what remains and that the person can ask it to go
 *  on. No verdict line is asked for, because nothing would read it. */
const CLOSING_NOTE_FINAL =
  'You must write the reply now, without calling a tool. Say what you did, what you found, and what is still '
  + 'to do, in plain words; do not mention limits, budgets or rounds. If work you were asked for is still to do, '
  + 'say that the person can ask you to go on in their next message.';
/** What a continuation turn reads as its current message. Model-only: it
 *  is never written as a row. */
const CONTINUATION_NOTE =
  'Continue the work in progress in this conversation. The datasets kept for it are listed. Write the reply when the '
  + 'work is done, or when you must stop again.';
/** Why the reply is being closed, for the audit row. */
type ClosingReason = 'rounds' | 'context' | 'deadline';
/** Handed back for a tool call the loop did not run because a bound tripped
 *  while the model was asking for it. */
const NOT_RUN = JSON.stringify({ error: 'Not run: answer now from what you have.' });
const MAX_HISTORY_MESSAGES = 20;
const MAX_TURN_OUTPUT_TOKENS = 4000;
// When generating the rolling summary we load more history so we can see
// everything that's accumulated since the last summary. 200 is well above
// any realistic thread length; short threads just see the whole thing.
const MAX_SUMMARIZATION_HISTORY = 200;
// ADR-041's spacing for mid-run signal polls, the same floor the conversational
// loop in Tenant-Runtime uses at its own boundaries.
const SIGNAL_POLL_MIN_INTERVAL_MS = 2_000;
// A message that lands after the last tool call would otherwise be claimed with
// no model turn left to answer it. The loop polls once more at the break and
// continues instead, bounded so a stream of messages cannot run the turn
// forever.
const MAX_INJECTION_CONTINUATIONS = 2;

/** The streaming parser's output as this service's events: text outside a
 *  fence as deltas, each closed fence as a block. */
function* parsedAsEvents(parsed: StreamingParseEvent[]): Generator<ChatServiceEvent> {
  for (const chunk of parsed) {
    if (chunk.type === 'text') {
      yield { type: 'text_delta', text: chunk.content };
    } else {
      for (const block of chunk.blocks) {
        yield { type: 'content_block', block };
      }
    }
  }
}

/**
 * A row as the model should read it: a colleague's reply in the colleague's
 * name.
 *
 * A colleague's reply in this chat is stored verbatim and attributed through
 * `contributors`, which every page draws as a chip. The two sinks that have
 * no chip to look at are the model's own history and the rolling summary,
 * and in both a colleague row read as the Insights Manager's own turn has it
 * remember offering what a colleague offered: on the first live hand-over it
 * answered the follow-up with "I presented the change as my own work". The
 * speaker is put back here, for both sinks, the way team chat's summary
 * already does.
 */
function inSpeakersVoice(m: Pick<InsightsChatMessage, 'messageType' | 'contributors' | 'content'>): string {
  return m.messageType === COLLEAGUE_MESSAGE_TYPE && m.contributors.length > 0
    ? `${m.contributors.map((c) => c.label).join(', ')}: ${m.content}`
    : m.content;
}

// ── Handing the turn to a colleague ─────────────────────────────────────

/**
 * The Insights Manager as the asker on the shared hand-over rail
 * (agent-chat/handover.ts): its own pairing table, its own stop watcher, and
 * its name on the note the colleague is handed. Everything else about a
 * hand-over is the rail's.
 */
function insightsAsker(input: RunChatTurnInput): HandoverAsker {
  return {
    id: INSIGHTS_DELEGATION_TARGET.id as HandoverAsker['id'],
    label: INSIGHTS_DELEGATION_TARGET.label,
    tenantId: input.tenantId,
    accountId: input.accountId,
    // The caller's REAL role, exactly as the route resolved it. Every
    // colleague makes its own permission decisions from it, so it is
    // forwarded rather than defaulted or widened.
    role: input.role,
    displayName: input.callerName ?? '',
    ...(input.origin ? { origin: input.origin } : {}),
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.abortController ? { abortController: input.abortController } : {}),
    userMessage: input.userMessage,
    pairing: {
      async get(target) {
        const existing = await getAssistantThreadDelegation(
          input.tenantId,
          'insights',
          input.threadId,
          target.kind,
          target.kind === 'team' ? target.id : null,
        );
        return existing?.delegateThreadId ?? null;
      },
      pair(target, delegateThreadId) {
        return pairAssistantThreadDelegation({
          tenantId: input.tenantId,
          surface: 'insights',
          threadId: input.threadId,
          targetKind: target.kind,
          targetId: target.kind === 'team' ? target.id : null,
          delegateThreadId,
        });
      },
    },
    // Stops are claimed on this side while the colleague streams, on the same
    // 2s spacing the model call uses. A turn without an id has no lock and
    // cannot be stopped, so there is nothing to watch.
    startAbortWatcher(abortController, onClaimed) {
      return input.turnId
        ? startAbortWatcher(input.tenantId, input.turnId, abortController, onClaimed)
        : null;
    },
  };
}

/**
 * Watch for a stop while a model call is streaming.
 *
 * Polling only at iteration boundaries would leave Stop waiting out the rest of
 * the model's output — which for a long answer is the whole point of pressing
 * it. This polls on the same 2s spacing while the call is outstanding and
 * aborts the controller the call was handed. Claims are atomic, so whichever
 * poll sees the signal first is the one that consumes it.
 */
function startAbortWatcher(
  tenantId: string,
  turnId: string,
  abortController: AbortController,
  onClaimed: () => void,
): { stop: () => void } {
  let finished = false;
  const timer = setInterval(() => {
    void claimAbortSignal(tenantId, turnId)
      .then((claimed) => {
        if (!claimed || finished) return;
        finished = true;
        clearInterval(timer);
        onClaimed();
        abortController.abort(new Error('user_stop'));
      })
      .catch(() => undefined);
  }, SIGNAL_POLL_MIN_INTERVAL_MS);
  // A poll timer must never be the reason the process stays alive.
  timer.unref?.();
  return {
    stop: () => {
      finished = true;
      clearInterval(timer);
    },
  };
}

/**
 * The default allocation with one change: the current-message section grows by
 * everything the route will accept in attachments.
 *
 * Without this the section caps at 1000 tokens — 4000 characters — and
 * `truncateToTokenBudget` keeps the TAIL, so a single 4000-character upload
 * plus the question overflows and the head of the document is dropped before
 * the model reads a word of it. No error is raised; the answer is simply about
 * a fragment. Liftoff hit exactly this and carries the same allowance, from the
 * same shared constant so the two cannot drift.
 */
const INSIGHTS_ATTACHMENT_BUDGET: BudgetConfig = {
  totalBudget:
    DEFAULT_INSIGHTS_BUDGET.totalBudget
    + ATTACHMENT_ALLOWANCE_TOKENS
    + IMAGE_ALLOWANCE_TOKENS
    + MEDIA_NOTICE_ALLOWANCE_TOKENS,
  sections: {
    ...DEFAULT_INSIGHTS_BUDGET.sections,
    // Images and the notices about them ride the same section, so the same
    // truncation that would have eaten a document's head would otherwise eat
    // the sentence explaining a clip the model cannot watch.
    currentMessage:
      DEFAULT_INSIGHTS_BUDGET.sections.currentMessage
      + ATTACHMENT_ALLOWANCE_TOKENS
      + IMAGE_ALLOWANCE_TOKENS
      + MEDIA_NOTICE_ALLOWANCE_TOKENS,
  },
};

// ── Main entry point ────────────────────────────────────────────────────

export async function* runInsightsChatTurn(
  input: RunChatTurnInput,
): AsyncIterable<ChatServiceEvent> {
  yield { type: 'thinking' };

  const attachments = input.attachments ?? [];
  // A browser event without words is a turn of its own: the person's row is
  // the status line the router wrote, and the model reads the shared text.
  // A continuation is a turn of its own too: no words of the person's, the
  // note as the model's current message.
  const continuation = input.continuation ?? null;
  const eventOnly = continuation === null && input.browserEvent !== undefined && input.userMessage.length === 0;
  const modelMessage = continuation
    ? CONTINUATION_NOTE
    : input.userMessage
      || (input.browserEvent?.kind === 'handback' ? BROWSER_HANDBACK_TURN_TEXT
        : '');

  try {
    // 1. Persist the user message FIRST so a crashed turn still leaves a
    //    visible record of what the user asked. What is stored is what they
    //    typed plus attachment METADATA, so a reloaded thread shows the chips
    //    again; attachment bodies are a one-turn input, not transcript.
    // Media persists to the message's own `media` column, never to
    // `attachments`: that column means the files handed over as text, and the
    // renderer already draws `media` for any role, so a sent picture shows as a
    // picture without a second render path.
    // An event turn writes none: there are no words of the person's to keep,
    // and the model-facing text is not theirs to see.
    const sentMedia = toMessageMedia(attachments);
    // The person's message this work belongs to: the row written here, or the
    // origin a continuation carries. Null for an event turn, which then
    // cannot continue (there is no message to continue from). A continuation
    // writes no row: its message is the origin message, already there.
    let originMessageId: string | null = continuation?.originMessageId ?? null;

    // The turn recall is keyed to (migration 547). `input.turnId` exists for
    // mid-run control and only on the streaming path, so it cannot be the
    // identity here: a turn row that appears for some entry points and not
    // others leaves the rest unrecallable with nothing failing. Minted when the
    // caller brought none, and opened BEFORE the person's row so the message's
    // turn_id has a row to point at.
    //
    // Opened unconditionally, including for an event-only turn or a
    // continuation, which write no user row of their own: the reply still
    // belongs to a turn. Idempotent, so a retry is free.
    const recallTurnId = input.turnId ?? newTurnId();
    await createTurn(input.tenantId, input.threadId, recallTurnId, input.accountId);

    if (!eventOnly && !continuation) {
      const userRow = await appendMessage({
        threadId: input.threadId,
        role: 'user',
        senderAccountId: input.accountId,
        content: input.userMessage,
        attachments: toMessageAttachments(attachments),
        ...(sentMedia.length > 0 ? { media: sentMedia } : {}),
        turnId: recallTurnId,
      });
      originMessageId = userRow?.id ?? null;
    }

    // A message now carries these, so they are no longer provisional and the
    // abandoned-upload sweep must leave them alone. Best effort: a failed claim
    // costs the picture a day from now, failing the turn costs it immediately.
    if (sentMedia.length > 0) {
      await claimInboundMedia(
        input.tenantId,
        sentMedia.map(m => m.mediaId),
        input.threadId,
        'insights',
      ).catch(err => {
        log.warn(
          { error: (err as Error).message, threadId: input.threadId },
          'insights: could not claim inbound media',
        );
      });
    }

    // A colleague brought the Insights Manager in: one status row about the
    // conversation rather than a turn in it, naming who did. Written straight
    // after the person's message so the thread reads in the order it
    // happened, and typed so the UI renders it as a status line and the
    // history below skips it. The brief itself is read this turn, in front of
    // the message, and never stored: it is the colleague's note to the model,
    // not something a person should open.
    //
    // Best effort. It is provenance, not the question itself, so failing to
    // write it must not cost the person a turn.
    if (input.forwardedContext) {
      try {
        await appendMessage({
          threadId: input.threadId,
          role: 'assistant',
          content: forwardedContextStatus(input.forwardedBy?.label ?? 'Liftoff'),
          messageType: FORWARDED_CONTEXT_MESSAGE_TYPE,
          // The row is the colleague's, not the Insights Manager's: the chip
          // on it names whoever brought it in.
          contributors: input.forwardedBy ? [input.forwardedBy] : undefined,
        });
      } catch (err) {
        log.warn(
          { threadId: input.threadId, error: (err as Error).message },
          'insights: could not record the context a colleague forwarded',
        );
      }
    }

    // 2. Load prior turns, the rolling summary, when this assistant last
    //    spoke, and the browser's state in parallel. The Browser section is
    //    built on every turn: the session is looked up even when the thread
    //    has no record yet, and an empty block costs nothing in the prompt.
    const [historyResult, summary, sinceLastReply] = await Promise.all([
      listMessages(input.threadId, { limit: MAX_HISTORY_MESSAGES }),
      getThreadRollingSummary(input.threadId, input.tenantId),
      lastAssistantReplyAt(input.threadId),
    ]);
    const browserContext = await buildAssistantBrowserState({
      tenantId: input.tenantId,
      threadId: input.threadId,
      sinceLastReply,
    });

    // listMessages returns newest-first; reverse to oldest-first for the prompt.
    // The last message is the user message we just persisted, unless this is
    // an event turn, which persisted none.
    // Notes about the conversation are dropped BEFORE the slice below, which
    // assumes the last row is the user turn this call just persisted. A
    // forwarded-context row is written straight after that turn, so leaving it
    // in would make the slice discard the note and keep the user's message in
    // `priorTurns` — putting the same sentence in front of the model twice,
    // once as history and once as `currentMessage`.
    //
    // Status rows are dropped on the same terms Liftoff and team chat drop
    // them: written BY this service ABOUT the conversation (a colleague
    // waiting on an approval), not said by anyone in it.
    // The person's browser events are dropped on the same terms: the segment
    // reaches the model through the Browser section, and the row is the
    // person's, not this assistant's.
    const historyOldestFirst = [...historyResult.messages]
      .reverse()
      .filter(m => m.messageType !== FORWARDED_CONTEXT_MESSAGE_TYPE)
      .filter(m => m.messageType !== HITL_STATUS_MESSAGE_TYPE)
      .filter(m => m.messageType !== BROWSER_HANDBACK_MESSAGE_TYPE)
      .filter(m => m.messageType !== BROWSER_POINT_MESSAGE_TYPE);
    // A continuation persisted nothing either, so every history row is a
    // prior turn; the newest is the closing reply the last turn wrote.
    const priorTurns = eventOnly || continuation ? historyOldestFirst : historyOldestFirst.slice(0, -1);

    // 3. Build the budgeted prompt.
    const availableTools = getToolDefinitionsForRole(input.role, {
      answerOnly: input.toolMode === 'answer',
      asColleague: input.asColleague === true,
    });
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = buildInsightsSystemPrompt({ today, availableTools });

    const userContext = input.callerName
      ? `Caller: ${input.callerName} (${input.role})`
      : `Caller role: ${input.role}`;

    // A row whose payload is not words carries no turn for the model to read.
    // The media rows this surface can now hold have empty content, and an empty
    // message in the history is at best noise and at worst rejected outright by
    // a provider that requires non-empty content blocks. Dropped here rather
    // than at the query, because the transcript still shows them.
    const recentTurnsAsLLM: LLMMessage[] = priorTurns
      .filter(m => m.content.trim().length > 0)
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: inSpeakersVoice(m),
      }));

    // What the model can look at, resolved against the model this turn will
    // actually run on. What it cannot look at comes back in `described` and is
    // named in the prompt in words — never dropped in silence, which would let
    // it answer about a picture it never received.
    // Skipped entirely when the turn carries no media, so a turn without a
    // picture costs exactly what it did before this feature existed: no model
    // resolution, no capability read, no object fetch.
    const turnMedia = sentMedia.length > 0
      ? await prepareTurnMedia(
          input.tenantId,
          sentMedia,
          await llmClient.resolvePlannedModel(
            { messages: [] },
            undefined,
            { tenantId: input.tenantId, purpose: 'insights_chat' },
          ),
          // The provider decides what the request can EXPRESS. Resolved the
          // same way the call itself resolves it, so the gate and the builder
          // cannot disagree about which one is about to run.
          llmClient.resolvePlannedProvider(),
          { surface: 'insights', threadId: input.threadId },
        )
      : { images: [], described: [] };

    const budgeted = buildBudgetedPrompt({
      systemPrompt,
      userContext,
      ...(browserContext ? { browserContext } : {}),
      rollingSummary: summary ? formatSummaryForPrompt(summary) : null,
      recentTurns: recentTurnsAsLLM,
      // Attachment bodies go in front of everything else in the current
      // message: the budget truncates this section from its start, so a turn
      // that overflows loses document body rather than the question being
      // asked about it.
      currentMessage: composeTurnText(
        withForwardedContext(modelMessage, input.forwardedContext ?? null),
        attachments,
        { describedMedia: turnMedia.described },
      ),
      ...(turnMedia.images.length > 0 ? { currentImages: turnMedia.images } : {}),
      // Only widened when there is something to widen it for, so a turn with no
      // attachments budgets exactly as it did before this feature existed.
      ...(attachments.length > 0 ? { config: INSIGHTS_ATTACHMENT_BUDGET } : {}),
    });

    // 4. Run the tool-use loop.
    const toolContext: InsightsToolContext = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      role: input.role,
      threadId: input.threadId,
      // The same signal the tool listing above uses, carried to the actor so a
      // tool reached by name sees it too.
      ...(input.toolMode === 'answer' ? { unattended: true } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    };

    const parser = new StreamingVisualizationParser();
    let conversation: LLMMessage[] = budgeted.messages;
    let accumulatedText = '';
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let iteration = 0;
    let terminatedEarly: ChatErrorCode | null = null;
    const deadlinePassed = (): boolean =>
      input.deadlineAt !== undefined && Date.now() >= input.deadlineAt;
    // Mid-run control state (ADR-041). Inert when the caller ran the turn
    // without a lock, which leaves the loop exactly as it was.
    const turnId = input.turnId;
    const abortController = input.abortController;
    const midRunControl = turnId && abortController
      ? { turnId, abortController }
      : null;
    let userStopped = false;
    // Set once, when the reply must go out: the next model call is the
    // closing one, with no tools, and the turn ends after it.
    let closing: ClosingReason | null = null;
    // Whether a further continuation may follow this turn: there is a message
    // to continue from, and the cap for it is not reached. Decides which
    // closing note the model reads and whether the verdict is read.
    const canContinue = originMessageId !== null && (continuation?.ordinal ?? 0) < MAX_CONTINUATIONS_PER_MESSAGE;
    const closingNote = canContinue ? CLOSING_NOTE : CLOSING_NOTE_FINAL;
    // The closing reply's verdict: whether the model said work it was asked
    // for is still to do. Null until a closing call has been read.
    let closingUnfinished: boolean | null = null;
    // A closing call that failed is an unfinished turn too: the bound closed
    // it, and the cap bounds the cost of a model that never answers.
    let closingCallFailed = false;
    let lastSignalPollAt = 0;
    let injectionContinuations = 0;

    /** Claim a stop at a loop boundary. True means the turn ends here. */
    const claimStopAtBoundary = async (): Promise<boolean> => {
      if (!midRunControl) return false;
      if (!(await claimAbortSignal(input.tenantId, midRunControl.turnId))) return false;
      userStopped = true;
      midRunControl.abortController.abort(new Error('user_stop'));
      return true;
    };

    /** Claim one mid-run message, framed for the model. Framing carries sender
     *  attribution and says the task continues rather than restarts. */
    const claimFramedMessage = async (): Promise<string | null> => {
      if (!midRunControl) return null;
      const pending = await claimUserMessageSignal(input.tenantId, midRunControl.turnId);
      return pending ? frameInterrupt(pending) : null;
    };

    // Every word the person reads passes the output guard first: a paragraph
    // streams once it has been scrubbed and read (common/guarded-stream.ts),
    // and what is persisted is what streamed. It sits BEFORE the visualization
    // parser, so a chart's fence reaches the parser scrubbed and otherwise
    // untouched. The model's own history (`turnText`, `conversation`) keeps
    // its raw words: that is its working memory for the next tool round, not
    // the person's transcript.
    const shown: string[] = [];
    const guardedOutput = new GuardedOutput(
      { tenantId: input.tenantId, speaker: 'insights', threadId: input.threadId },
      { toolNames: availableTools.map(t => t.name), onText: (text) => shown.push(text) },
    );
    /** Whether this round has already shown the person something. Reset at the
     *  top of every round; read to find the message boundary below. */
    let roundHasShownText = false;
    /** Hand what the guard has released to the parser and the person, in order. */
    const drainShown = function* (): Generator<ChatServiceEvent> {
      while (shown.length > 0) {
        const text = shown.shift()!;
        // This round's first words open a new assistant message: the round
        // before it stopped writing to run a tool. Inside a round the guard
        // hands paragraphs over with their own blank lines, so only the round
        // boundary needs one. It is fed to the parser with the text so that
        // what is persisted is what streamed.
        const opened = roundHasShownText
          ? { gap: '', text }
          : openAssistantMessage(accumulatedText, text);
        roundHasShownText = true;
        const piece = opened.gap + opened.text;
        accumulatedText += piece;
        yield* parsedAsEvents(parser.feed(piece));
      }
    };

    toolLoop: while (iteration < MAX_ITERATIONS || closing !== null) {
      iteration++;

      const turnToolCalls: LLMToolCall[] = [];
      let turnText = '';
      roundHasShownText = false;
      let turnInputTokens = 0;
      let turnOutputTokens = 0;
      /** The prompt this call carried, as the provider counts it. */
      let turnContextTokens = 0;
      let turnModel: string | undefined;
      let turnStopReason: LLMStopReason = 'end_turn';
      let turnErrored = false;

      const watcher = midRunControl
        ? startAbortWatcher(
            input.tenantId,
            midRunControl.turnId,
            midRunControl.abortController,
            () => {
              userStopped = true;
            },
          )
        : null;
      // The closing round's text is HELD: its last line is the verdict, which
      // is model-only, and a delta fed to the guard and the stream as it
      // arrived would show the line on screen before it could be removed. The
      // whole reply is read at message_complete, the line stripped, and only
      // then does the clean text go through the normal path — the guard, the
      // parser, the stream, the persisted row — in one piece.
      const holdText = closing !== null;
      try {
        for await (const event of llmClient.completeStream(
          {
            messages: conversation,
            tools: availableTools,
            // The closing call keeps the tools defined — a conversation that
            // carries tool calls and results stays valid on every provider —
            // and forbids their use, so the model writes instead.
            ...(closing ? { toolChoice: 'none' as const } : {}),
            // Provider-executed. Lets this assistant read a page it is asked
            // about instead of saying it cannot.
            serverTools: closing ? [] : WEB_SERVER_TOOLS,
            maxTokens: MAX_TURN_OUTPUT_TOKENS,
            ...(midRunControl ? { abortSignal: midRunControl.abortController.signal } : {}),
          },
          undefined,
          { tenantId: input.tenantId, purpose: 'insights_chat' },
        )) {
          switch (event.type) {
            case 'text_delta': {
              turnText += event.text;
              if (holdText) break;
              guardedOutput.feed(event.text);
              yield* drainShown();
              break;
            }
            case 'tool_use':
              turnToolCalls.push(event.toolCall);
              break;
            case 'message_complete':
              turnStopReason = event.stopReason;
              turnInputTokens = event.usage.inputTokens;
              turnOutputTokens = event.usage.outputTokens;
              // An adapter that predates the field reports the uncached
              // input alone, which under-counts a cached Anthropic turn; it
              // is the closest figure there is.
              turnContextTokens = event.usage.contextTokens ?? event.usage.inputTokens;
              turnModel = event.model;
              break;
            case 'error':
              // A stop cancels the provider call, and some providers report a
              // cancelled call as an error event. That is not a failure.
              if (userStopped) break;
              if (holdText) closingCallFailed = true;
              yield { type: 'error', code: 'PROVIDER_ERROR', message: event.message };
              turnErrored = true;
              break;
          }
          if (turnErrored) break;
        }
        if (turnErrored) {
          // A bound closed this turn and the call that was to write its reply
          // failed: the work is unfinished, and goes on as a continuation.
          if (closingCallFailed && canContinue && originMessageId) {
            await queueContinuation(input, originMessageId, terminatedEarly ?? 'MAX_ITERATIONS');
          }
          return;
        }
        if (holdText) {
          // The whole closing reply, read for its verdict, the line removed,
          // and the clean text sent through the guard as one piece.
          const read = readClosingVerdict(turnText);
          // The verdict is read only when one was asked for; the final note
          // asks for none, and a missing line then means nothing.
          if (canContinue) closingUnfinished = read.verdict !== 'done';
          guardedOutput.feed(read.text);
        }
        // The model's stream has ended: whatever paragraph it was mid-way
        // through is read now, before any tool runs or the row is written.
        await guardedOutput.flush();
        yield* drainShown();
      } catch (err) {
        if (userStopped) {
          // The call did not fail — it was cancelled because the person pressed
          // Stop. Fall through to the persist path with whatever was written,
          // the paragraph in flight included, read like the rest.
          await guardedOutput.flush();
          yield* drainShown();
          break toolLoop;
        }
        if (midRunControl?.abortController.signal.aborted) {
          // Aborted, but not by the person: the turn lost its lock (its
          // heartbeat could not reach the database, or the row was reclaimed
          // after expiry). Say what that means for them rather than leaking the
          // internal abort message.
          log.warn(
            { threadId: input.threadId, tenantId: input.tenantId, turnId: midRunControl.turnId },
            'Insights chat turn lost its lock — ending the turn',
          );
          yield {
            type: 'error',
            code: 'INTERNAL',
            message: 'The response was interrupted. Please try again.',
          };
          return;
        }
        log.error(
          {
            threadId: input.threadId,
            tenantId: input.tenantId,
            error: (err as Error).message,
          },
          'LLM completeStream threw unexpectedly',
        );
        yield { type: 'error', code: 'PROVIDER_ERROR', message: 'LLM provider error' };
        return;
      } finally {
        watcher?.stop();
      }

      cumulativeInputTokens += turnInputTokens;
      cumulativeOutputTokens += turnOutputTokens;

      // A stop claimed while the model was still streaming ends the turn here,
      // keeping the partial answer the person was watching.
      if (userStopped) break toolLoop;

      // The closing call was this one: whatever it wrote is the reply.
      if (closing !== null) break toolLoop;

      // The context guard, and the deadline. Both are read on the call that
      // just returned: the guard on the prompt it carried against the window
      // of the model that served it, the deadline on the clock. A round that
      // asked for tools is answered "not run" and the reply is closed by one
      // more call; a round that wrote its answer already has it.
      // The rounds are this loop's own bound — tested at its head and again at
      // the end of the round below — so they are deliberately not asked about
      // here: a 'rounds' answer at this point would close the turn before
      // running the tools it had just asked for.
      const bound = decideTurnBound({
        contextTokens: turnContextTokens,
        recordedContextWindow: llmClient.recordedContextWindowFor(llmClient.resolvePlannedProvider(), turnModel),
        deadlinePassed: deadlinePassed(),
      });
      const contextFull = bound.close === 'context';
      if (bound.close !== null) {
        log.warn(
          {
            threadId: input.threadId,
            contextTokens: turnContextTokens,
            contextWindow: bound.window.tokens,
            // The provenance travels with the number: a ratio against the
            // conservative fallback is a different claim from one against the
            // model's own recorded window.
            contextWindowSource: bound.window.source,
            contextRatio: bound.ratio,
            model: turnModel,
            deadlinePassed: deadlinePassed(),
          },
          contextFull
            ? 'Chat turn filled the guarded share of the context window — closing the reply'
            : 'Chat turn passed its deadline — closing the reply',
        );
        terminatedEarly = contextFull ? 'CONTEXT_FULL' : 'DEADLINE';
        if (turnStopReason === 'tool_use' && turnToolCalls.length > 0) {
          conversation = [
            ...conversation,
            { role: 'assistant', content: turnText, toolCalls: turnToolCalls },
            { role: 'user', content: '', toolResults: turnToolCalls.map((c) => ({ toolCallId: c.id, content: NOT_RUN })) },
            { role: 'user', content: closingNote },
          ];
          closing = contextFull ? 'context' : 'deadline';
          continue toolLoop;
        }
        break toolLoop;
      }

      // If the turn ended without requesting tools, we're done — unless a
      // message landed after the last tool call. That message has no boundary
      // left to be consumed at, and claiming it anywhere else would mark it
      // delivered and then drop it, so poll once more and run another model
      // turn to actually answer it.
      if (turnStopReason !== 'tool_use' || turnToolCalls.length === 0) {
        if (midRunControl && injectionContinuations < MAX_INJECTION_CONTINUATIONS) {
          lastSignalPollAt = Date.now();
          if (await claimStopAtBoundary()) break toolLoop;
          const trailing = await claimFramedMessage();
          if (trailing) {
            injectionContinuations++;
            conversation = [
              ...conversation,
              ...(turnText ? [{ role: 'assistant' as const, content: turnText }] : []),
              { role: 'user' as const, content: trailing },
            ];
            continue toolLoop;
          }
        }
        break toolLoop;
      }

      // Dispatch each requested tool and collect results for the next round.
      const toolResults: LLMToolResult[] = [];
      // Set when the deadline passes between two tool calls of one round: the
      // rest are answered "not run" and the reply is closed after the round,
      // because a round's calls can each take a minute and the check above
      // alone would let a round that started just before the deadline run
      // every one of them past it.
      let deadlineDuringRound = false;
      for (const toolCall of turnToolCalls) {
        if (deadlineDuringRound || deadlinePassed()) {
          deadlineDuringRound = true;
          toolResults.push({ toolCallId: toolCall.id, content: NOT_RUN });
          continue;
        }

        yield { type: 'tool_call', tool: toolCall.name };

        if (toolCall.name === BRING_IN_COLLEAGUE_TOOL) {
          const target = resolveInsightsHandoverTarget(toolCall.input['colleague']);
          if (!target) {
            // The enum on the tool makes this the model guessing. An ordinary
            // tool result names what does exist, so it can recover in the
            // same turn rather than the turn dying.
            log.info(
              { threadId: input.threadId, tenantId: input.tenantId, requested: toolCall.input['colleague'] },
              'insights: hand-over target did not resolve; answering with the two colleagues',
            );
            toolResults.push({
              toolCallId: toolCall.id,
              content: JSON.stringify({
                error:
                  `No colleague named "${String(toolCall.input['colleague'] ?? '')}" can be brought in from here. `
                  + "Use 'caio' for the Chief AI Officer or 'liftoff' for Liftoff.",
              }),
            });
            continue;
          }

          // Everything from here belongs to the colleague, so the turn ENDS
          // here: looping with a tool result would hand the model the floor
          // again and it would summarise what the person just read.
          //
          // Anything the Insights Manager wrote before calling the tool has
          // already been streamed to the person (a figure it was asked for
          // alongside the change), so it is persisted as its own message
          // rather than dropped: text they watched arrive must still be there
          // on reload. Its fences are lifted out the way a finished turn's
          // are, so a chart it drew survives as a block. The parser is
          // flushed first so anything it was still holding reaches the
          // person before the colleague's first word.
          yield* parsedAsEvents(parser.flush());
          const preamble = parseVisualizationBlocks(accumulatedText);
          if (preamble.cleanedText.trim() || preamble.blocks.length > 0) {
            await appendMessage({
              threadId: input.threadId,
              role: 'assistant',
              content: preamble.cleanedText,
              visualizationBlocks: preamble.blocks.length > 0 ? (preamble.blocks as unknown[]) : null,
              inputTokens: cumulativeInputTokens,
              outputTokens: cumulativeOutputTokens,
              turnId: recallTurnId,
            });
          }

          const request = toolCall.input['request'];
          const delegated = yield* runHandover(
            insightsAsker(input),
            target,
            typeof request === 'string' ? request : '',
          );

          const replyText = delegated.text.trim();
          // Nothing is invented for a hand-over that failed or was stopped
          // before the colleague said anything: no reply exists, and a marker
          // in the content column would read as one.
          const savedMessage =
            delegated.failed || (!replyText && delegated.blocks.length === 0)
              ? null
              : await appendMessage({
                  threadId: input.threadId,
                  role: 'assistant',
                  content: replyText,
                  // The colleague's words, verbatim, attributed through the
                  // same two fields every surface reads: the type says a
                  // colleague spoke, the contributors say which.
                  messageType: COLLEAGUE_MESSAGE_TYPE,
                  contributors: [{ id: target.id, label: target.label }],
                  turnId: recallTurnId,
                  visualizationBlocks: delegated.blocks.length > 0 ? delegated.blocks : null,
                  // The colleague's own spend, as its own surface counted it.
                  // Transcript metadata; nothing reconciles money from it.
                  inputTokens: delegated.inputTokens,
                  outputTokens: delegated.outputTokens,
                });

          logAudit(
            'insights.chat_turn',
            { tenantId: input.tenantId, userId: input.accountId },
            {
              threadId: input.threadId,
              iterations: iteration,
              // The deciding turn plus the delegated one, so the audit line
              // says what the whole turn cost rather than only its first half.
              inputTokens: cumulativeInputTokens + delegated.inputTokens,
              outputTokens: cumulativeOutputTokens + delegated.outputTokens,
              userMessageLength: input.userMessage.length,
              assistantMessageLength: replyText.length,
              terminatedEarly,
              delegatedTo: target.id,
              delegatedToKind: target.kind,
              ...(delegated.paused ? { errorCode: 'delegate_paused' } : {}),
              ...(delegated.stopped ? { errorCode: 'user_stopped' } : {}),
              ...(delegated.failed ? { errorCode: 'delegation_failed' } : {}),
            },
          );

          // A failure already yielded its own error frame, which is terminal.
          if (delegated.failed) return;

          if (savedMessage) {
            // Tell them their answer arrived, if they are not sitting on the
            // thread watching it. The colleague's reply is the answer to
            // their message on this thread, so it is announced as this
            // surface's reply.
            void notifyPlatformChatReply({
              tenantId: input.tenantId,
              surface: 'insights',
              threadId: input.threadId,
              accountId: input.accountId,
              text: savedMessage.content,
              via: input.origin?.via ?? null,
            });
            fireAndForget(
              maybeRefreshRollingSummary(input.threadId, input.tenantId),
              'maybeRefreshRollingSummary',
            );
            // Awaited for the same reason as the non-delegated path: Cloud Run
            // may scale the container away the moment the request completes.
            if (priorTurns.length <= 4) {
              await maybeGenerateThreadTitle({
                threadId: input.threadId,
                tenantId: input.tenantId,
                userMessage: input.userMessage,
                assistantMessage: replyText,
                updateTitle: updateThreadTitleInternal,
              });
            }
          }

          if (delegated.paused) {
            // Whatever it managed to say is already persisted above. What is
            // left to say is that it is waiting on a person, written into the
            // thread as its own status row exactly as Liftoff and team chat
            // do for the same fact: the terminal frame below reaches only the
            // one client whose turn tripped the gate, so without this the
            // pause is lost on reload. Best-effort: a pause is not worth
            // failing an already-finished turn over.
            let statusMessage: InsightsChatMessage | null = null;
            try {
              statusMessage = await appendMessage({
                threadId: input.threadId,
                role: 'assistant',
                content: delegated.paused,
                messageType: HITL_STATUS_MESSAGE_TYPE,
                contributors: [{ id: target.id, label: target.label }],
              });
            } catch (err) {
              log.warn(
                { threadId: input.threadId, tenantId: input.tenantId, target: target.id, error: (err as Error).message },
                'insights: could not post the waiting-on-a-decision status row',
              );
            }
            yield {
              type: 'delegation_paused',
              author: target.id,
              authorLabel: target.label,
              delegateThreadId: delegated.delegateThreadId,
              reason: delegated.paused,
              message: statusMessage,
            };
            return;
          }

          yield { type: 'complete', message: savedMessage };
          return;
        }

        // Answered here rather than through the registry, and the reason is
        // the sanitizer: every registry result has each string value cut at
        // 500 characters, which is right for a tenant-controlled name and
        // fatal for prose the platform wrote and already bounded. Run the way
        // Liftoff runs them, so both assistants read identical words about the
        // same dataset.
        if (isGeneratedFileTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runGeneratedFileTool(toolCall.input, {
              tenantId: input.tenantId,
              surface: 'insights',
              threadId: input.threadId,
            }),
          });
          continue;
        }

        if (isChatRecallTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runChatRecallTool(input.tenantId, toolCall.name, toolCall.input, {
              surface: 'insights',
              // All three come from the turn, never from the model's arguments:
              // a thread id there would name a conversation it is not in, and an
              // account id there would search another person's words.
              threadId: input.threadId,
              accountId: input.accountId,
              turnId: recallTurnId,
            }),
          });
          continue;
        }

        if (isDatasetTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runDatasetTool(input.tenantId, toolCall.name, toolCall.input, {
              scope: { kind: 'insights_thread', id: input.threadId },
              purpose: 'insights_dataset_extract',
            }),
          });
          continue;
        }

        // Answered here rather than through the registry, for the reason the
        // dataset tools above are: the registry cuts every string at 500
        // characters, which is fatal for a page read, and its result shape has
        // nowhere to put a picture. A visual read answers with one.
        if (isBrowserAssistantTool(toolCall.name)) {
          const browserResult = input.threadId
            ? await executeBrowserAssistantToolDetailed(toolCall.name, toolCall.input, {
              tenantId: input.tenantId,
              threadId: input.threadId,
              surface: 'insights',
              ...(input.accountId ? { senderAccountId: input.accountId } : {}),
            })
            : null;
          toolResults.push({
            toolCallId: toolCall.id,
            content: browserResult?.content ?? 'A browser can only be opened inside a conversation.',
            ...(browserResult?.images && browserResult.images.length > 0
              ? { images: browserResult.images }
              : {}),
          });
          continue;
        }

        let result: InsightsToolResult;
        try {
          result = await dispatchToolCall(toolCall.name, toolCall.input, toolContext);
        } catch (err) {
          log.error(
            {
              threadId: input.threadId,
              toolName: toolCall.name,
              error: (err as Error).message,
            },
            'Tool dispatch threw unexpectedly',
          );
          result = {
            toolName: toolCall.name,
            ok: false,
            data: { error: `Tool execution failed: ${(err as Error).message}` },
          };
        }

        toolResults.push({
          toolCallId: toolCall.id,
          content: JSON.stringify(result.data),
        });
      }

      // Mid-run signals are claimed HERE — after a tool result, which is the
      // only boundary where another model turn is guaranteed. Claiming one at
      // the end of an assistant message would mark it delivered with nothing
      // left to answer it. Abort is checked first and wins.
      let injectedMessage: string | null = null;
      if (midRunControl && Date.now() - lastSignalPollAt >= SIGNAL_POLL_MIN_INTERVAL_MS) {
        lastSignalPollAt = Date.now();
        if (await claimStopAtBoundary()) break toolLoop;
        injectedMessage = await claimFramedMessage();
      }

      // THE SEAM. Everything above produced text; this is where it becomes
      // model context, and therefore the one place a size rule can cover every
      // tool this assistant has rather than a chosen few. A result past the
      // bound is parked as a dataset for this conversation and the model gets
      // its view; the three dataset tools it now holds read the records back
      // without any of them passing through the window.
      const boundedToolResults = await parkOversizedToolResults(
        input.tenantId,
        toolResults,
        { kind: 'insights_thread', id: input.threadId },
        (toolCallId) => {
          const name = turnToolCalls.find((c) => c.id === toolCallId)?.name ?? 'tool';
          return { label: `${name} result`, source: 'insights_tool', sourceRef: name };
        },
      );

      // Append the assistant's tool-use turn + the user turn carrying results.
      // The per-message tool fields (Phase 6 commit 4) are what make this
      // round-trip through the LLM provider correctly.
      conversation = [
        ...conversation,
        { role: 'assistant', content: turnText, toolCalls: turnToolCalls },
        { role: 'user', content: '', toolResults: boundedToolResults },
        // Its own entry, appended AFTER the tool-result entry: that entry
        // carries tool results and an empty content string, so folding the
        // message into it would deliver nothing the model can read.
        ...(injectedMessage ? [{ role: 'user' as const, content: injectedMessage }] : []),
      ];

      if (deadlineDuringRound) {
        log.warn(
          { threadId: input.threadId, iteration },
          'Chat turn passed its deadline during a round of tools — closing the reply',
        );
        terminatedEarly = 'DEADLINE';
        conversation = [...conversation, { role: 'user', content: closingNote }];
        closing = 'deadline';
      } else if (iteration >= MAX_ITERATIONS) {
        log.warn(
          { threadId: input.threadId, iteration },
          'Chat turn hit max iterations — closing the reply',
        );
        terminatedEarly = 'MAX_ITERATIONS';
        conversation = [...conversation, { role: 'user', content: closingNote }];
        closing = 'rounds';
      }
    }

    // Flush the streaming parser so any trailing buffered text comes out.
    yield* parsedAsEvents(parser.flush());

    // 5. One-shot parse the full accumulated text. The streaming parser
    // already emitted content_block events for blocks it saw in real time;
    // this second pass gives us the canonical cleaned text + block list
    // for persistence and for the final `complete` event.
    const { cleanedText, blocks } = parseVisualizationBlocks(accumulatedText);

    // A stopped turn keeps what it had written (ADR-041). When it was stopped
    // before writing anything there is nothing to keep, and nothing is
    // invented: writing a marker into the message content would put words in
    // the assistant's mouth, and the transcript would show it saying
    // "(stopped)" — which it never did, and which reads as an answer rather
    // than as the absence of one.
    if (userStopped && !cleanedText.trim()) {
      logAudit(
        'insights.chat_turn',
        { tenantId: input.tenantId, userId: input.accountId },
        {
          threadId: input.threadId,
          iterations: iteration,
          inputTokens: cumulativeInputTokens,
          outputTokens: cumulativeOutputTokens,
          userMessageLength: input.userMessage.length,
          assistantMessageLength: 0,
          terminatedEarly,
          errorCode: 'user_stopped',
        },
      );
      // Terminal all the same, so the composer stops streaming and the thread
      // refetches. The frame simply carries no message, because there is none.
      yield { type: 'complete', message: null };
      return;
    }

    // A FINISHED TURN MUST NEVER LEAVE THE THREAD EMPTY. See the shared module
    // for why an empty row is no better than no row. A turn that answered
    // entirely with a visualization HAS said something, so the fallback is
    // gated on there being neither text nor blocks — and `cleanedText` is
    // passed through untouched whenever there is, because its whitespace is
    // part of the rendered answer.
    const saidSomething = cleanedText.trim().length > 0 || blocks.length > 0;
    const savedMessage = await appendMessage({
      threadId: input.threadId,
      role: 'assistant',
      content: saidSomething ? cleanedText : COMPLETED_WITHOUT_REPLY,
      visualizationBlocks: blocks.length > 0 ? (blocks as unknown[]) : null,
      inputTokens: cumulativeInputTokens,
      outputTokens: cumulativeOutputTokens,
      turnId: recallTurnId,
    });

    // Make this turn searchable. Best-effort ON PURPOSE and never awaited: this
    // process throttles CPU outside a request, so the call may not finish, and
    // the durable path is the embed sweep (scripts/embed-sweep-chat-turns).
    // Correctness never depends on either — an unembedded turn is still found by
    // the keyword arm.
    void embedPlatformTurn('insights', input.tenantId, recallTurnId).catch((err) => {
      log.warn(
        { threadId: input.threadId, turnId: recallTurnId, error: (err as Error).message },
        'insights: inline turn embed failed; the sweep will pick it up',
      );
    });

    // Tell them their answer arrived, if they are not sitting on the thread
    // watching it. Fire-and-forget after the row is committed: a notification
    // is never worth failing a turn that already succeeded.
    void notifyPlatformChatReply({
      tenantId: input.tenantId,
      surface: 'insights',
      threadId: input.threadId,
      accountId: input.accountId,
      text: savedMessage.content,
      via: input.origin?.via ?? null,
    });

    // The continuation: a bound closed this turn AND the closing reply said
    // the work is not finished (or carried no verdict). Queued after the
    // closing reply is persisted, while this turn still holds the thread
    // lock; the worker takes the lock for itself and re-reads the row under
    // it. A turn that ended on its own, a closing reply that said [done], and
    // a turn at the cap start nothing.
    if (terminatedEarly !== null && !userStopped && canContinue && originMessageId && closingUnfinished !== false) {
      await queueContinuation(input, originMessageId, terminatedEarly);
    }

    // 6. Audit log — message length only, never full content (PII).
    logAudit(
      'insights.chat_turn',
      { tenantId: input.tenantId, userId: input.accountId },
      {
        threadId: input.threadId,
        iterations: iteration,
        blockCount: blocks.length,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        userMessageLength: input.userMessage.length,
        assistantMessageLength: cleanedText.length,
        terminatedEarly,
        ...(closingUnfinished !== null ? { closingUnfinished } : {}),
        ...(continuation ? { continuationOf: continuation.originMessageId, continuationOrdinal: continuation.ordinal } : {}),
        // The queryable marker for a turn the person ended (ADR-041). Written
        // alongside a success outcome, never as a failure.
        ...(userStopped ? { errorCode: 'user_stopped' } : {}),
      },
    );

    // 7. Fire-and-forget: maybe refresh the rolling summary.
    fireAndForget(
      maybeRefreshRollingSummary(input.threadId, input.tenantId),
      'maybeRefreshRollingSummary',
    );

    // 8. Generate an AI title on the first few turns. AWAITED (not
    // fire-and-forget) because Cloud Run may scale the container to zero
    // once the HTTP request completes, killing any detached promises
    // mid-flight — the original fire-and-forget approach left Slack-
    // originated threads untitled. maybeGenerateThreadTitle already
    // catches all internal errors, so awaiting can never throw here. Cost:
    // ~500ms added to the completion of the first 3 turns per thread,
    // after the assistant text has already streamed to the user.
    if (priorTurns.length <= 4) {
      await maybeGenerateThreadTitle({
        threadId: input.threadId,
        tenantId: input.tenantId,
        userMessage: input.userMessage,
        assistantMessage: cleanedText,
        updateTitle: updateThreadTitleInternal,
      });
    }

    // 9. Terminal event.
    yield { type: 'complete', message: savedMessage };
  } catch (err) {
    log.error(
      {
        threadId: input.threadId,
        tenantId: input.tenantId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      'Chat turn failed with uncaught error',
    );
    yield {
      type: 'error',
      code: 'INTERNAL',
      message: 'Something went wrong processing your message. Please try again.',
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Queue the next continuation of the work a bound closed: the row (ordinal
 * after the last for this message, or none at the cap) and its Cloud Task.
 * Best effort: a continuation that could not be queued is logged, and the
 * closing reply the person already has stands.
 */
async function queueContinuation(
  input: RunChatTurnInput,
  originMessageId: string,
  reason: string,
): Promise<void> {
  try {
    const row = await enqueueContinuation({
      tenantId: input.tenantId,
      surface: 'insights',
      threadId: input.threadId,
      accountId: input.accountId,
      originMessageId,
      reason,
    });
    if (row) await enqueueContinuationTask(row.id, input.tenantId);
  } catch (err) {
    log.warn(
      { threadId: input.threadId, tenantId: input.tenantId, originMessageId, error: (err as Error).message },
      'insights: could not queue the continuation of this turn',
    );
  }
}

/**
 * Check if the thread needs a fresh rolling summary, and generate one if so.
 * Called fire-and-forget after each turn. Any errors are logged but do not
 * propagate — summarization failing must never affect the user-visible chat.
 */
async function maybeRefreshRollingSummary(
  threadId: string,
  tenantId: string,
): Promise<void> {
  // Load the full thread (up to the summarization cap) oldest-first.
  const historyResult = await listMessages(threadId, { limit: MAX_SUMMARIZATION_HISTORY });
  const allMessages: SummarizationMessage[] = [...historyResult.messages]
    .reverse()
    // A note about what a colleague was told is not part of the conversation
    // being summarised, and it is already a summary of one. A status row is
    // dropped for the reason the turn history drops it.
    .filter(m => m.messageType !== FORWARDED_CONTEXT_MESSAGE_TYPE)
    .filter(m => m.messageType !== HITL_STATUS_MESSAGE_TYPE)
    // The person's browser events are the record's, read from the Browser
    // section each turn, not subject matter.
    .filter(m => m.messageType !== BROWSER_HANDBACK_MESSAGE_TYPE)
    .filter(m => m.messageType !== BROWSER_POINT_MESSAGE_TYPE)
    .map(m => ({
      id: m.id,
      role: m.role,
      content: inSpeakersVoice(m),
      createdAt: m.createdAt,
    }));

  const previousSummary = await getThreadRollingSummary(threadId, tenantId);

  const input = { threadId, tenantId, allMessages, previousSummary };
  if (!shouldSummarize(input)) return;

  const newSummary = await generateRollingSummary(input);
  if (newSummary && newSummary !== previousSummary) {
    await updateThreadRollingSummary(threadId, tenantId, newSummary);
  }
}

