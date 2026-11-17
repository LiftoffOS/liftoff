// Liftoff Chat Service, the tool-use loop orchestrator
//
// Runs a single chat turn end-to-end as an async generator of typed events.
// The stream-router wraps these events as SSE frames; the frontend consumes
// them to render a streaming assistant response.
//
// A single turn:
//
//   1. Persist the user message to the thread
//   2. Load up to 20 prior turns + the rolling conversation summary (if any)
//   3. Build a context-budgeted prompt (system prompt + user ctx + summary +
//      recent turns + current message, with any attached file contents riding
//      along in the current message)
//   4. Run the agentic tool-use loop:
//        - Call llmClient.completeStream() with the available tool set
//        - Stream text deltas to the caller
//        - When the model requests tools, dispatch them, append the assistant
//          turn (with tool_use blocks) and a user turn (with tool_result
//          blocks) to the conversation, loop again
//        - Bounds: 50 iterations, the model's context window (a call whose
//          prompt is past seven tenths of it closes the reply), and the
//          caller's deadline; each closes the reply with one tool-less call
//   5. Persist the assistant message
//   6. Audit-log the turn
//   7. Fire-and-forget: check if the rolling summary needs refreshing
//   8. Yield a final `complete` event with the persisted message
//
// Liftoff answers in plain text and has no data tools of its own. It has two
// tools, and the second is not an ordinary one:
//
//   list_colleagues     ordinary. Reads the live roster (the Chief AI Officer,
//                       the Insights Manager, and every active agent) and
//                       hands it back to the model, because that roster changes
//                       while people are mid-conversation and cannot be written
//                       into a prompt.
//   bring_in_colleague  a HANDOVER. When the target resolves, that colleague
//                       takes the rest of the reply, in this thread, with
//                       everything it has on its own surface, and Liftoff says
//                       nothing further. One turn, one voice: a summary written
//                       afterwards would make the person read the same answer
//                       twice. When the target does NOT resolve, it degrades to
//                       an ordinary tool result so the model can say so and
//                       offer what does exist.
//
// delegation-targets.ts owns who can be brought in, delegation-runtimes.ts owns
// the runtimes they run on, and agent-chat/handover.ts owns the relay and the
// reconciliation of two control planes: the same rail the Insights Manager and
// the Chief AI Officer hand a turn over on. What stays here is Liftoff's own
// side of it: its pairing table, its stop watcher, and what it persists when
// the colleague is done.
//
// That is also why this surface can carry visualization blocks even though
// Liftoff itself never emits one: the org charts and tables its colleagues emit
// arrive as their own stream events, and a message persisted as text alone
// would lose them.

import { log, logAudit } from '../infrastructure/logging';
import type { ActorOrigin } from '../workspace-actions/actor';
import {
  BROWSER_ASSISTANT_TOOLS,
  isBrowserAssistantTool,
  executeBrowserAssistantToolDetailed,
} from '../browser-sessions/assistant-tools';
import { recordBrowserActivity } from './browser-activity';
import {
  capabilitySearchTool,
  CAPABILITY_SEARCH_TOOL,
  servedNamesIn,
  runCapabilitySearch,
  runCapability,
  runCapabilityTool,
  RUN_CAPABILITY_TOOL,
} from './capability-tools';
import { datasetTools, isDatasetTool, runDatasetTool } from '../datasets/tools';
import { chatRecallTools, isChatRecallTool, runChatRecallTool } from '../chat-recall/tools';
import { createTurn } from './chat-repository';
import { embedPlatformTurn } from '../chat-recall/turn-embedding';
import { generatedFileTools, isGeneratedFileTool, runGeneratedFileTool } from '../generated-files/assistant-tools';
import { goalsSection, isTrackedGoalTool, runTrackedGoalTool, trackedGoalTools } from '../tracked-goals/assistant-tools';
import {
  backgroundWorkTools, isBackgroundWorkTool, runBackgroundWorkTool, START_BACKGROUND_WORK_TOOL,
} from '../background-work/assistant-tools';
import { listDatasets } from '../datasets/store';
import { parkOversizedToolResults } from '../datasets/park';
import { renderDatasetInventory } from '../datasets/render';
import { decideTurnBound } from '@liftoffos/turn-bounds';
import { llmClient } from '../llm';
import { fireAndForget } from '../shared/fire-and-forget';
import { COMPLETED_WITHOUT_REPLY } from '../shared/completed-without-reply';
import type {
  LLMMessage,
  LLMStopReason,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolResult,
} from '../llm/types';
import {
  appendMessage,
  getThreadDelegation,
  getThreadRollingSummary,
  lastAssistantReplyAt,
  listMessages,
  pairThreadDelegation,
  updateThreadRollingSummary,
  updateThreadTitleInternal,
  type LiftoffChatMessage,
  type LiftoffDelegationKind,
  type TenantMemberRole,
} from './chat-repository';
import { maybeGenerateThreadTitle } from '../shared/thread-title-generation';
// The same marker team chat stamps on the same fact. Imported rather than
// redeclared so the two surfaces cannot drift into two spellings of one
// vocabulary, and so one frontend renderer covers both.
import {
  BROWSER_HANDBACK_MESSAGE_TYPE,
  BROWSER_POINT_MESSAGE_TYPE,
  HITL_STATUS_MESSAGE_TYPE,
} from '../agent-chat/hitl-status-message';
import { BROWSER_HANDBACK_TURN_TEXT } from '@liftoffos/browser-record';
import { buildAssistantBrowserState } from '../browser-sessions/browser-state';
// Both of these are already cross-surface (the Chief AI Officer chat uses them
// too), so Liftoff imports rather than copies them.
import {
  buildBudgetedPrompt,
  DEFAULT_INSIGHTS_BUDGET,
  type BudgetConfig,
} from '../insights/context-budget';
import {
  formatSummaryForPrompt,
  generateRollingSummary,
  shouldSummarize,
  type SummarizationMessage,
} from '../insights/conversation-summarization';
import {
  ATTACHMENT_CONTEXT_ALLOWANCE_TOKENS,
  buildAttachmentContextBlock,
  buildLiftoffSystemPrompt,
} from './system-prompt';
import {
  FORWARDED_CONTEXT_MESSAGE_TYPE,
  forwardedContextStatus,
  withForwardedContext,
} from './forwarded-context';
import {
  claimAbortSignal,
  claimUserMessageSignal,
  frameInterrupt,
  newTurnId,
} from './turn-control';
import {
  bringInColleagueTool,
  BRING_IN_COLLEAGUE_TOOL,
  describeTargetsForModel,
  listColleaguesTool,
  listDelegationTargets,
  LIFTOFF_DELEGATION_TARGET,
  LIST_COLLEAGUES_TOOL,
  resolveDelegationTarget,
  type DelegationTarget,
} from './delegation-targets';
import { runHandover, type HandoverAsker } from '../agent-chat/handover';
import { GuardedOutput } from '../common/guarded-stream';
import { readClosingVerdict } from '../common/closing-verdict';
import { openAssistantMessage } from '../common/assistant-message-boundary';
import { enqueueContinuation, MAX_CONTINUATIONS_PER_MESSAGE } from '../chat-continuations/store';
import { enqueueContinuationTask } from '../chat-continuations/dispatch';

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
  /** A colleague was brought in and could not answer. Its own code, because
   *  "the provider failed" and "the colleague we handed this to could not
   *  finish" are different things to look at in a log.
   *
   *  A colleague that PAUSED to wait on a person is deliberately not one of
   *  these. It used to be, and the client read the error channel literally:
   *  the person's message went back into the composer as though it had failed
   *  to send. A pause has its own terminal frame now. */
  | 'DELEGATION_ERROR'
  | 'INTERNAL';

export type ChatServiceEvent =
  /** Sent immediately when a turn starts, before any LLM call. */
  | { type: 'thinking' }
  /** Sent when the LLM requests a specific tool (one per call). */
  | { type: 'tool_call'; tool: string }
  /** Incremental assistant text. */
  | { type: 'text_delta'; text: string }
  /** A rendered block that belongs beside the text rather than inside it. Only
   *  a delegated turn produces these: a colleague's parser strips its fences out
   *  of the text and delivers them this way. */
  | { type: 'content_block'; block: unknown }
  /** The turn has been handed to a colleague, named here so the reply can be
   *  attributed WHILE it streams. Without it the identity exists only on the
   *  persisted message, so on a long answer the person watches an unattributed
   *  bubble for the whole of it and learns who wrote it once it is over.
   *
   *  Sent once, before any of that colleague's own events. `author` is what the
   *  message will store in its own `author` column, and `authorLabel` what it
   *  will store beside it, so the live bubble and the stored reply say the same
   *  thing in the same words.
   *
   *  There is deliberately NO closing counterpart. Liftoff does not take the
   *  floor back after a handover: the segment ends where the turn ends, so
   *  `complete`, `delegation_paused` and `error` already mark it, and a second
   *  frame would only ever arrive immediately before one of them. */
  | { type: 'delegation_started'; author: string; authorLabel: string }
  /** Terminal, and NOT a failure: the colleague stopped to wait on a person.
   *
   *  This used to travel as an `error` frame, which was wrong in every way that
   *  matters to the person. The client restored their message into the composer
   *  as though the send had failed, and showed a red toast. Nothing failed:
   *  their message is persisted, the run is alive, and it continues the moment
   *  somebody decides.
   *
   *  `message` is the status row the pause wrote into the transcript, so the
   *  same sentence survives a reload and reaches everybody else on the thread.
   *  `delegateThreadId` is the conversation the decision is waiting in, carried
   *  so the client can offer to open it without putting a thread id in the
   *  address bar. Null only when the pairing could not be read back. */
  | {
      type: 'delegation_paused';
      author: string;
      authorLabel: string;
      delegateThreadId: string | null;
      reason: string;
      message: LiftoffChatMessage | null;
    }
  /** Terminal success, the final persisted assistant message. Null when the
   *  turn was stopped before it said anything: there is no reply to persist
   *  and none is invented. */
  | { type: 'complete'; message: LiftoffChatMessage | null }
  /** Terminal failure, the turn could not complete. */
  | { type: 'error'; code: ChatErrorCode; message: string };

// ── Attachments ─────────────────────────────────────────────────────────
//
// The contract itself lives in @liftoffos/chat-attachments (see
// src/chat-attachments/): the Insights Manager and the Chief AI Officer take
// the same attachments and must keep the same caps, the same projection and
// the same <attachment> wrapper, and the CAIO is in another repository, so a
// shared module could not have reached it.
//
// Re-exported under the names Liftoff already used so its callers — the stream
// router, the budget arithmetic below, the tests — are untouched by the move.

import {
  ATTACHMENT_ALLOWANCE_TOKENS,
  IMAGE_ALLOWANCE_TOKENS,
  MEDIA_NOTICE_ALLOWANCE_TOKENS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CONTENT_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  toMessageAttachments,
  toMessageMedia,
  describeAttachment,
  composeTurnText,
} from '../chat-attachments';
import type { ChatAttachment, Contributor } from '../chat-attachments';
import { prepareTurnMedia } from '../llm/vision';
import { claimInboundMedia } from '../media/inbound';
import { WEB_SERVER_TOOLS } from '../llm/web-tools';

export {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_CONTENT_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  toMessageAttachments,
  toMessageMedia,
  describeAttachment,
  composeTurnText,
};

export type {
  ChatUploadAttachment as LiftoffUploadAttachment,
  ChatConnectorAttachment as LiftoffConnectorAttachment,
  ChatAttachment as LiftoffAttachment,
} from '../chat-attachments';
import { notifyPlatformChatReply } from '../notifications';
import type { Actor } from '../workspace-actions/actor';
import { dispatchWorkspaceAction, isWorkspaceActionTool, toolsForActor } from '../workspace-actions/tools';

/** Local alias so this module can name the union it already re-exports. */
type LiftoffAttachment = ChatAttachment;

// ── Input shape ─────────────────────────────────────────────────────────

export interface RunChatTurnInput {
  threadId: string;
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
  userMessage: string;
  /** Files and connector references attached to this message. Uploads are read
   *  by the model this turn; only the metadata (see toMessageAttachments) is
   *  persisted with the message, never the upload's text. */
  attachments?: LiftoffAttachment[];
  /** The brief a colleague wrote when it brought Liftoff into one of its
   *  conversations (the Chief AI Officer's, the Insights Manager's, or an AI
   *  team's), already framed for the model (see forwarded-context.ts). Read
   *  this turn, in front of the person's message, and never persisted.
   *  Absent for a person typing on the Liftoff page, who can see the thread
   *  they are in. */
  forwardedContext?: string | null;
  /** Who forwarded that background. The thread keeps one status row naming
   *  them, written as its author. Null or absent with a null brief. */
  forwardedBy?: Contributor | null;
  /** Optional caller display name for the userContext section of the prompt. */
  callerName?: string;
  /** Present when the turn came through a coding tool (the MCP chat worker):
   *  every workspace action this turn takes is attributed to that tool, and
   *  a colleague brought in inherits it. */
  origin?: ActorOrigin;
  /** 'answer' when an agent brought Liftoff in for a question: the turn
   *  is offered no mutating workspace action, no colleague to bring in and no
   *  browser. Nobody is present to confirm a change, a colleague brought in
   *  from here would ask a person who is not here, and the browser is the
   *  person's. */
  toolMode?: 'answer';
  /** True when a colleague handed this turn to Liftoff in front of the
   *  person: everything stays on offer except a colleague of Liftoff's own,
   *  so a hand-over is one deep on every surface. */
  asColleague?: boolean;
  /** This turn's id, the address its mid-run signals are written to (ADR-041).
   *  The stream-router mints it when it takes the thread lock, so the turn is
   *  stoppable from the instant it starts. Absent only for callers that run a
   *  turn without a lock. */
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
   *  else runs unchanged: the dataset inventory, the tools, the closing round
   *  and the same trigger, up to the cap. */
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

/** Two tools: find out who is available right now, and bring one of them in.
 *  Both are static, because neither carries the roster. The roster is read from
 *  the database when list_colleagues is called and read again when a delegation
 *  actually fires, which is the only way it can be right in a workspace where
 *  teams appear and disappear mid-conversation. */
const AVAILABLE_TOOLS: LLMToolDefinition[] = [
  listColleaguesTool,
  bringInColleagueTool,
  // Capability discovery over the platform's curated surface, and execution
  // of one named vendor tool through the guarded dispatch path. Offered
  // unconditionally like the browser: the dispatch itself refuses (with a
  // reason) when a vendor is unprovisioned, unclassified, or gated.
  capabilitySearchTool,
  runCapabilityTool,
  // A large result of a capability is parked as a dataset for this
  // conversation; these read it back — only what is asked for — so the
  // records never pass through the model's context.
  ...datasetTools,
  ...generatedFileTools,
  // What the person is working towards, held across conversations. These do
  // no work: a goal is what is remembered, and the work still happens where
  // work happens.
  ...trackedGoalTools,
  // Starting something slow without waiting for it, so one long job does not
  // hold the whole conversation. There is exactly one assistant in a thread.
  ...backgroundWorkTools,
  // Reading further back in this conversation than the recent window shows.
  // Offered to every turn: the person is in the thread and their own client
  // already renders the whole scrollback, so this reveals nothing new.
  ...chatRecallTools,
  // The browser is a capability the PRODUCT has, not one the workspace brought,
  // so it is offered unconditionally the way web search is. The runtime decides
  // whether a browser can actually be opened — a workspace's own vendor key, the
  // platform's, or an operator kill-switch — and says so in the tool result.
  // Gating the tool here as well would need this service to duplicate that
  // decision, and two copies of it would disagree.
  ...BROWSER_ASSISTANT_TOOLS,
];

/** What an answer-only turn is not offered: a colleague to bring in (it
 *  would ask a person who is not here) and the browser (the person's). The
 *  mutating workspace actions are withheld by toolsForActor. */
const ANSWER_MODE_WITHHELD = new Set<string>([
  bringInColleagueTool.name,
  ...BROWSER_ASSISTANT_TOOLS.map((t) => t.name),
]);

/** What a turn handed over BY a colleague is not offered: a colleague of its
 *  own, and the roster that exists only to choose one. Everything else stays,
 *  because the person is present. */
const COLLEAGUE_MODE_WITHHELD = new Set<string>([
  listColleaguesTool.name,
  bringInColleagueTool.name,
  // ONE LEVEL. A turn that is itself the background work does not get to
  // start background work: work that can start work is a tree nobody
  // bounded, and the bill for getting it wrong is a workspace's whole model
  // budget. The runner runs the child under this same flag.
  START_BACKGROUND_WORK_TOOL,
]);

/** The insights allocation with one change: the current-message section grows
 *  by everything the route will accept in attachments, so text the person just
 *  attached is never silently cut before the model sees it. */
const LIFTOFF_BUDGET: BudgetConfig = {
  totalBudget:
    DEFAULT_INSIGHTS_BUDGET.totalBudget
    + ATTACHMENT_ALLOWANCE_TOKENS
    + IMAGE_ALLOWANCE_TOKENS
    + MEDIA_NOTICE_ALLOWANCE_TOKENS
    + ATTACHMENT_CONTEXT_ALLOWANCE_TOKENS,
  sections: {
    ...DEFAULT_INSIGHTS_BUDGET.sections,
    // Media rides the current-message slot, so its whole cost lands here: the
    // images themselves when the model can see them, and the notices about
    // them when it cannot. Adding one and not the other would be exactly wrong
    // in the case where the person gets no answer to compensate.
    //
    // The attachment-context block rides the same slot, for the same reason it
    // is on the turn at all: it names THIS message's attachments, so it cannot
    // sit in the system prompt without moving the cached prefix. It is counted
    // here because truncation drops from the front of this slot, so an
    // uncounted block is paid for out of the opening of the first document.
    currentMessage:
      DEFAULT_INSIGHTS_BUDGET.sections.currentMessage
      + ATTACHMENT_ALLOWANCE_TOKENS
      + IMAGE_ALLOWANCE_TOKENS
      + MEDIA_NOTICE_ALLOWANCE_TOKENS
      + ATTACHMENT_CONTEXT_ALLOWANCE_TOKENS,
  },
};

/**
 * Watch for a stop while a model call is streaming.
 *
 * Polling only at iteration boundaries would leave Stop waiting out the rest of
 * the model's output, which for a long answer is the whole point of pressing
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

// ── Handing the turn to a colleague ─────────────────────────────────────

// What the colleague is sent used to be composed here, as one string: the
// summary bracketed in front of the person's words, on the reasoning that a
// bracket "cannot be mistaken for something the person typed". Every delegate
// then persisted that string as the user's row, so it was mistaken for exactly
// that, on every surface, by everyone reading the thread. The two halves travel
// separately now and the framing lives in forwarded-context.ts.

/** The pairing row's target_id: the team, or NULL for a singleton colleague. */
function delegationTargetRowId(target: DelegationTarget): string | null {
  return target.kind === 'team' ? target.id : null;
}

/** liftoff_thread_delegations records the three kinds Liftoff can bring in.
 *  Liftoff never brings in Liftoff (it is not in its roster, so it never
 *  resolves), and the pairing store says so rather than widening its column. */
function liftoffPairingKind(target: DelegationTarget): LiftoffDelegationKind {
  if (target.kind === 'liftoff') {
    throw new Error('Liftoff cannot bring itself in');
  }
  return target.kind;
}

/**
 * Liftoff as the asker on the shared hand-over rail (agent-chat/handover.ts):
 * its own pairing table, its own stop watcher, and its name on the note the
 * colleague is handed. Everything else about a hand-over is the rail's.
 */
function liftoffAsker(input: RunChatTurnInput): HandoverAsker {
  return {
    id: LIFTOFF_DELEGATION_TARGET.id as HandoverAsker['id'],
    label: LIFTOFF_DELEGATION_TARGET.label,
    tenantId: input.tenantId,
    accountId: input.accountId,
    // The caller's REAL role, exactly as getCallerRole resolved it. Every
    // colleague makes its own permission decisions from it, so it is forwarded
    // rather than defaulted or widened.
    role: input.role,
    displayName: input.callerName ?? '',
    ...(input.origin ? { origin: input.origin } : {}),
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.abortController ? { abortController: input.abortController } : {}),
    userMessage: input.userMessage,
    pairing: {
      async get(target) {
        const existing = await getThreadDelegation(
          input.threadId,
          liftoffPairingKind(target),
          delegationTargetRowId(target),
        );
        return existing?.delegateThreadId ?? null;
      },
      pair(target, delegateThreadId) {
        return pairThreadDelegation({
          threadId: input.threadId,
          targetKind: liftoffPairingKind(target),
          targetId: delegationTargetRowId(target),
          delegateThreadId,
        });
      },
    },
    // Stops are claimed on the Liftoff side while the colleague streams, on the
    // same 2s spacing the model call uses. A turn without an id has no lock and
    // cannot be stopped, so there is nothing to watch.
    startAbortWatcher(abortController, onClaimed) {
      return input.turnId
        ? startAbortWatcher(input.tenantId, input.turnId, abortController, onClaimed)
        : null;
    },
  };
}

// ── Main entry point ────────────────────────────────────────────────────

export async function* runLiftoffChatTurn(
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
    // Media goes in the message's own `media` column, not in `attachments`.
    // On this table `attachments` means the files the person handed over as
    // TEXT, and the renderer draws `media` for any role — so a sent picture
    // shows as a picture in the sender's own bubble with no second render path.
    // An event turn writes none: there are no words of the person's to keep,
    // and the model-facing text is not theirs to see. A continuation writes
    // none either: its message is the origin message, already there.
    const sentMedia = toMessageMedia(attachments);
    // The person's message this work belongs to: the row written here, or the
    // origin a continuation carries. Null for an event turn, which then
    // cannot continue (there is no message to continue from).
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

    // The upload is no longer provisional now that a message carries it, so it
    // is exempt from the abandoned-upload sweep. Best effort: a claim that
    // fails costs the person a picture 24 hours from now, and failing their
    // turn over it would cost them the picture immediately.
    if (sentMedia.length > 0) {
      await claimInboundMedia(
        input.tenantId,
        sentMedia.map(m => m.mediaId),
        input.threadId,
        'liftoff',
      ).catch(err => {
        log.warn(
          { error: (err as Error).message, threadId: input.threadId },
          'liftoff: could not claim inbound media',
        );
      });
    }

    // A colleague brought Liftoff in: one status row about the conversation
    // rather than a turn in it, naming who did. Written straight after the
    // person's message so the thread reads in the order it happened, authored
    // by that colleague, and typed so the UI renders it as a status line and
    // the history below skips it. The brief itself is read this turn, in
    // front of the message, and never stored: it is the colleague's note to
    // the model, not something a person should open.
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
          author: input.forwardedBy?.id ?? null,
          authorLabel: input.forwardedBy?.label ?? null,
        });
      } catch (err) {
        log.warn(
          { threadId: input.threadId, error: (err as Error).message },
          'liftoff: could not record the context a colleague forwarded',
        );
      }
    }

    // 2. Load prior turns, the rolling summary, when this assistant last
    //    spoke, and the browser's state in parallel. The Browser section is
    //    built on every turn: the session is looked up even when the thread
    //    has no record yet, and an empty block costs nothing in the prompt.
    const [historyResult, summary, sinceLastReply, datasetsNewestFirst] = await Promise.all([
      listMessages(input.threadId, { limit: MAX_HISTORY_MESSAGES }),
      getThreadRollingSummary(input.threadId, input.tenantId),
      lastAssistantReplyAt(input.threadId),
      // The datasets this conversation's earlier turns parked, newest first:
      // the next turn starts knowing they exist, rather than fetching again
      // or being told only if it happens to call dataset_list.
      listDatasets(input.tenantId, { kind: 'liftoff_thread', id: input.threadId }, { order: 'newest' }),
    ]);
    const browserContext = await buildAssistantBrowserState({
      tenantId: input.tenantId,
      threadId: input.threadId,
      sinceLastReply,
    });
    const datasetContext = renderDatasetInventory(datasetsNewestFirst);

    // listMessages returns newest-first; reverse to oldest-first for the prompt.
    // The last message is the user message we just persisted, unless this is
    // an event turn, which persisted none.
    //
    // Status rows are dropped on the same terms team chat drops them: they are
    // written BY this service ABOUT the conversation, not said by anyone in it,
    // so feeding one back would have the model read "waiting on an approval" as
    // its own previous turn and answer as though it had said it. Forwarded
    // notes are dropped BEFORE the slice below for the reason the Insights
    // Manager gives: the note lands after the user row, so leaving it in
    // would make the slice keep the user's message as history and put the
    // same sentence in front of the model twice. The person's browser events
    // are dropped on the same terms: the segment reaches the model through
    // the Browser section, and the row is the person's, not this assistant's.
    const historyOldestFirst = [...historyResult.messages]
      .reverse()
      .filter(m => m.messageType !== HITL_STATUS_MESSAGE_TYPE)
      .filter(m => m.messageType !== FORWARDED_CONTEXT_MESSAGE_TYPE)
      .filter(m => m.messageType !== BROWSER_HANDBACK_MESSAGE_TYPE)
      .filter(m => m.messageType !== BROWSER_POINT_MESSAGE_TYPE);
    // A continuation persisted nothing either, so every history row is a
    // prior turn; the newest is the closing reply the last turn wrote.
    const priorTurns = eventOnly || continuation ? historyOldestFirst : historyOldestFirst.slice(0, -1);

    // 3. Build the budgeted prompt.
    //
    // The workspace-action tools are listed for the role the turn already
    // carries (getCallerRole at the stream router; the actor the MCP worker
    // resolved). This actor is for LISTING; a mutating execution re-resolves
    // membership and role at the moment it runs (workspace-actions/tools).
    const answerOnly = input.toolMode === 'answer';
    const actor: Actor = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      role: input.role,
      displayName: input.callerName ?? '',
      surface: 'liftoff',
      // Answer mode IS the "nobody is present" signal, and it has to reach the
      // actor rather than stay in the tool LISTING: a mutating tool is not
      // offered here, but it can still be reached by name.
      ...(answerOnly ? { unattended: true } : {}),
      ...(input.origin ?? {}),
    };
    const asColleague = input.asColleague === true;
    const availableTools = [
      ...AVAILABLE_TOOLS
        .filter((t) => !(answerOnly && ANSWER_MODE_WITHHELD.has(t.name)))
        .filter((t) => !(asColleague && COLLEAGUE_MODE_WITHHELD.has(t.name))),
      ...toolsForActor(actor, { answerOnly }).map((t) => t.definition),
    ];
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = buildLiftoffSystemPrompt({ today, availableTools });
    // This turn's attachments ride the user message, not the system prompt. The
    // system prompt is the cache prefix; a per-turn list inside it moves those
    // bytes and there is nothing left to read back.
    const attachmentContext = buildAttachmentContextBlock(
      attachments.length > 0 ? attachments.map(describeAttachment) : undefined,
    );

    const goals = await goalsSection(input.tenantId, input.accountId);
    const userContext = [
      input.callerName ? `Caller: ${input.callerName} (${input.role})` : `Caller role: ${input.role}`,
      // What makes a goal a goal rather than a row: it is here every turn, so
      // the person never has to say it twice.
      ...(goals ? ['', goals] : []),
    ].join('\n');

    // A row whose payload is not words carries no turn for the model to read.
    // The media rows this surface can now hold have empty content, and an empty
    // message in the history is at best noise and at worst rejected outright by
    // a provider that requires non-empty content blocks. Dropped here rather
    // than at the query, because the transcript still shows them.
    const recentTurnsAsLLM: LLMMessage[] = priorTurns
      .filter(m => m.content.trim().length > 0)
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));

    // What the model can actually look at, decided against the model this turn
    // will run on rather than against a hope. Anything it cannot see — a video,
    // an image on a text-only model, an object that has been swept — comes back
    // in `described` and is named in the prompt in words instead. Nothing is
    // dropped in silence, which is the failure this exists to remove.
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
            { tenantId: input.tenantId, purpose: 'liftoff_chat' },
          ),
          // The provider decides what the request can EXPRESS. Resolved the
          // same way the call itself resolves it, so the gate and the builder
          // cannot disagree about which one is about to run.
          llmClient.resolvePlannedProvider(),
          { surface: 'liftoff', threadId: input.threadId },
        )
      : { images: [], described: [] };

    const budgeted = buildBudgetedPrompt({
      systemPrompt,
      userContext,
      ...(browserContext ? { browserContext } : {}),
      ...(datasetContext ? { datasetContext } : {}),
      rollingSummary: summary ? formatSummaryForPrompt(summary) : null,
      recentTurns: recentTurnsAsLLM,
      currentMessage: [
        composeTurnText(
          withForwardedContext(modelMessage, input.forwardedContext ?? null),
          attachments,
          { describedMedia: turnMedia.described },
        ),
        attachmentContext,
      ].filter(Boolean).join('\n\n'),
      ...(turnMedia.images.length > 0 ? { currentImages: turnMedia.images } : {}),
      config: LIFTOFF_BUDGET,
    });

    // 4. Run the tool-use loop.
    //
    // The system prompt is the cache breakpoint: everything up to and including
    // it is read from the provider's cache rather than re-billed, which is only
    // true because nothing per-request is written into it. The history below it
    // is append-only for the whole turn, so each round extends the same prefix.
    let conversation: LLMMessage[] = budgeted.messages.map((m, i) =>
      i === 0 && m.role === 'system'
        ? { ...m, cacheControl: { type: 'ephemeral' as const } }
        : m,
    );
    let accumulatedText = '';
    // Which route this turn actually took, for the audit line below. The
    // catalog and the provider's own web search sit side by side in the tool
    // list and nothing ranks across them, so the only way to learn how often
    // one is reached for over the other is to record it.
    let capabilitySearched = false;
    let capabilityRan = false;
    let webSearchRequests = 0;
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
    let lastSignalPollAt = 0;
    let injectionContinuations = 0;
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
    // and what is persisted is what streamed. The model's own history
    // (`turnText`, `conversation`) keeps its raw words: that is its working
    // memory for the next tool round, not the person's transcript.
    const shown: string[] = [];
    const guardedOutput = new GuardedOutput(
      { tenantId: input.tenantId, speaker: 'liftoff', threadId: input.threadId },
      { toolNames: availableTools.map(t => t.name), onText: (text) => shown.push(text) },
    );

    toolLoop: while (iteration < MAX_ITERATIONS || closing !== null) {
      iteration++;

      const turnToolCalls: LLMToolCall[] = [];
      let turnText = '';
      /** This round's words as the person read them. */
      let shownTurnText = '';
      /** Hand what the guard has released to the person, in order. */
      const drainShown = function* (): Generator<ChatServiceEvent> {
        while (shown.length > 0) {
          const text = shown.shift()!;
          // This round's first words open a new assistant message: the round
          // before it stopped writing to run a tool. Inside a round the guard
          // hands paragraphs over with their own blank lines, so only the
          // round boundary needs one. It goes into the accumulated string AND
          // the stream, because the string is what is persisted and the row is
          // what a reload and a /share link show.
          const opened = shownTurnText === ''
            ? openAssistantMessage(accumulatedText, text)
            : { gap: '', text };
          shownTurnText += opened.text;
          accumulatedText += opened.gap + opened.text;
          if (opened.gap) yield { type: 'text_delta', text: opened.gap };
          yield { type: 'text_delta', text: opened.text };
        }
      };
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
      // stream, the persisted row — in one piece, a few seconds later than a
      // streamed one.
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
            // about instead of saying it cannot. Withheld with the rest on
            // the closing call.
            serverTools: closing ? [] : WEB_SERVER_TOOLS,
            maxTokens: MAX_TURN_OUTPUT_TOKENS,
            ...(midRunControl ? { abortSignal: midRunControl.abortController.signal } : {}),
          },
          undefined,
          { tenantId: input.tenantId, purpose: 'liftoff_chat' },
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
              webSearchRequests += event.usage.webSearchRequests ?? 0;
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
          // The call did not fail, it was cancelled because the person pressed
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
            'Liftoff chat turn lost its lock; ending the turn',
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
            ? 'Chat turn filled the guarded share of the context window; closing the reply'
            : 'Chat turn passed its deadline; closing the reply',
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

      // If the turn ended without requesting tools, we're done, unless a
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

      // Answer each requested tool. `list_colleagues` is ordinary and loops.
      // `bring_in_colleague` is a HANDOVER and ends the turn, unless its target
      // no longer resolves, in which case it degrades to an ordinary result so
      // the model can say what happened and offer what does exist.
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

        if (toolCall.name === CAPABILITY_SEARCH_TOOL) {
          capabilitySearched = true;
          // The person's account rides along, from this turn's own context,
          // so the search judges each vendor on the credential their run
          // would use — the same account run_capability executes on below.
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runCapabilitySearch(input.tenantId, toolCall.input, input.accountId),
          });
          continue;
        }

        if (toolCall.name === RUN_CAPABILITY_TOOL) {
          capabilityRan = true;
          toolResults.push({
            toolCallId: toolCall.id,
            content: (await runCapability(input.tenantId, input.accountId, toolCall.input, {
              scope: { kind: 'liftoff_thread', id: input.threadId },
            })).text,
          });
          continue;
        }

        if (isBackgroundWorkTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runBackgroundWorkTool(toolCall.input, {
              tenantId: input.tenantId,
              threadId: input.threadId,
              surface: 'liftoff',
              accountId: input.accountId,
              // The row hangs off the person's own message, as a
              // continuation's does, so the two are counted and read alike.
              originMessageId: originMessageId ?? '',
            }),
          });
          continue;
        }

        if (isTrackedGoalTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runTrackedGoalTool(toolCall.name, toolCall.input, {
              tenantId: input.tenantId,
              accountId: input.accountId,
            }),
          });
          continue;
        }

        if (isGeneratedFileTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runGeneratedFileTool(toolCall.input, {
              tenantId: input.tenantId,
              surface: 'liftoff',
              threadId: input.threadId,
            }),
          });
          continue;
        }

        if (isChatRecallTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await runChatRecallTool(input.tenantId, toolCall.name, toolCall.input, {
              surface: 'liftoff',
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
              scope: { kind: 'liftoff_thread', id: input.threadId },
              purpose: 'liftoff_dataset_extract',
            }),
          });
          continue;
        }

        if (toolCall.name === LIST_COLLEAGUES_TOOL) {
          const targets = await listDelegationTargets(input.tenantId);
          toolResults.push({
            toolCallId: toolCall.id,
            content: describeTargetsForModel(targets),
          });
          continue;
        }

        if (isWorkspaceActionTool(toolCall.name)) {
          toolResults.push({
            toolCallId: toolCall.id,
            content: await dispatchWorkspaceAction(toolCall.name, toolCall.input, actor),
          });
          continue;
        }

        if (isBrowserAssistantTool(toolCall.name)) {
          // The detailed form: the words for the model AND what the record
          // keeps (the loop's steps, whole, and its own closing line).
          const browserResult = await executeBrowserAssistantToolDetailed(toolCall.name, toolCall.input, {
            tenantId: input.tenantId,
            threadId: input.threadId,
            surface: 'liftoff',
            // Liftoff turns always carry their caller, so a browser can always
            // be spawned here; the runtime still enforces the rule.
            senderAccountId: input.accountId,
          });
          // The runtime is the recorder now. This service writes its own row
          // ONLY when the call came back without the runtime's receipt (an
          // older runtime, or no answer at all), under the call's own id so
          // the reader's exact-id dedupe lets the runtime's row win if it did
          // land. Fire-and-forget: the turn must not wait on a table whose
          // whole value is being readable later. The instruction is the
          // boundary sanitizer's, carried on the result; the raw input is
          // never parsed again here.
          if (browserResult.legacyFallbackNeeded && browserResult.activityId) {
            fireAndForget(
              recordBrowserActivity({
                id: browserResult.activityId,
                tenantId: input.tenantId,
                threadId: input.threadId,
                tool: toolCall.name,
                instruction: {
                  text: browserResult.safeInstruction,
                  truncated: browserResult.instructionTruncated,
                  protectedDataOmitted: browserResult.instructionProtectedDataOmitted,
                },
                outcome: browserResult.trail.outcome,
                steps: browserResult.trail.steps,
              }),
              'liftoff browser activity',
            );
          }
          toolResults.push({
            toolCallId: toolCall.id,
            content: browserResult.content,
            // A visual read answers with a picture. The provider layer decides
            // the envelope, which differs by vendor; this just carries it.
            ...(browserResult.images && browserResult.images.length > 0
              ? { images: browserResult.images }
              : {}),
          });
          continue;
        }

        if (toolCall.name === BRING_IN_COLLEAGUE_TOOL) {
          const requested =
            typeof toolCall.input['target'] === 'string' ? toolCall.input['target'] : '';
          // Resolved AGAINST THE DATABASE, here, at the moment the delegation
          // fires. Whatever list_colleagues returned is already a snapshot: a
          // team can be deleted, paused or moved between the two, and a stale
          // id must never send someone's request into a thread nobody owns.
          const target = await resolveDelegationTarget(input.tenantId, requested);

          if (!target) {
            log.info(
              { threadId: input.threadId, tenantId: input.tenantId, requested },
              'Liftoff delegation target did not resolve; answering with the live roster',
            );
            const targets = await listDelegationTargets(input.tenantId);
            toolResults.push({
              toolCallId: toolCall.id,
              content: describeTargetsForModel(targets, {
                error:
                  `No colleague with id "${requested}" is available in this workspace right now. `
                  + 'It may have been deleted, paused, or never existed. '
                  + 'Tell the person plainly and offer one of the colleagues listed here.',
              }),
            });
            continue;
          }

          // Everything from here belongs to the colleague, so the turn ENDS
          // here: looping with a tool result would hand the model the floor
          // again and it would summarise what the person just read.
          //
          // Anything Liftoff wrote before calling the tool has already been
          // streamed to the person, so it is persisted as its own message
          // rather than dropped: text they watched arrive must still be there
          // on reload. The prompt asks for no preamble, so this is usually
          // nothing.
          const preamble = shownTurnText.trim();
          if (preamble) {
            await appendMessage({
              threadId: input.threadId,
              role: 'assistant',
              content: preamble,
              inputTokens: cumulativeInputTokens,
              outputTokens: cumulativeOutputTokens,
              turnId: recallTurnId,
            });
          }

          const task = toolCall.input['task'];
          const delegated = yield* runHandover(
            liftoffAsker(input),
            target,
            typeof task === 'string' ? task : '',
          );

          const replyText = delegated.text.trim();
          // Nothing is invented for a handover that failed or was stopped
          // before the colleague said anything: no reply exists, and a marker
          // in the content column would read as one.
          const savedMessage =
            delegated.failed || (!replyText && delegated.blocks.length === 0)
              ? null
              : await appendMessage({
                  threadId: input.threadId,
                  role: 'assistant',
                  content: replyText,
                  author: target.id,
                  authorLabel: target.label,
                  visualizationBlocks: delegated.blocks,
                  turnId: recallTurnId,
                  // The colleague's own spend, as its own surface counted it.
                  // The billing record is that surface's llm_usage_log row
                  // under its own purpose; this is transcript metadata, and
                  // nothing reconciles money from it.
                  inputTokens: delegated.inputTokens,
                  outputTokens: delegated.outputTokens,
                });

          logAudit(
            'liftoff.chat_turn',
            { tenantId: input.tenantId, userId: input.accountId },
            {
              threadId: input.threadId,
              iterations: iteration,
              attachmentCount: attachments.length,
              // Liftoff's deciding turn plus the delegated one, so the audit
              // line says what the whole turn cost rather than only its first
              // half.
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
            // Whatever it managed to say is already persisted above, so the
            // transcript keeps it. What is left to say is that it is waiting on
            // a person, which is not something Liftoff can do anything about
            // and not something it should paraphrase in its own voice.
            //
            // Written into the thread as its own row, exactly as team chat does
            // for the same fact: the terminal frame below reaches only the one
            // client whose turn tripped the gate, so without this the pause is
            // lost on reload and everyone else on the thread sees the
            // conversation stop with no explanation. `hitl_status` is what marks
            // it as a status line rather than as something the team said, and
            // keeps it out of the next turn's context.
            //
            // Best-effort, like its counterpart in agent-chat: a pause is not
            // worth failing an already-finished turn over.
            let statusMessage: LiftoffChatMessage | null = null;
            try {
              statusMessage = await appendMessage({
                threadId: input.threadId,
                role: 'assistant',
                content: delegated.paused,
                author: target.id,
                authorLabel: target.label,
                messageType: HITL_STATUS_MESSAGE_TYPE,
              });
            } catch (err) {
              log.warn(
                {
                  threadId: input.threadId,
                  tenantId: input.tenantId,
                  target: target.id,
                  error: (err as Error).message,
                },
                'Liftoff could not post the waiting-on-a-decision status row',
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

        // Anything else. Nothing else is registered on this surface, so this is
        // only reachable if a provider echoes a tool call regardless; saying so
        // is better than leaving the model waiting on a result that will never
        // come.
        log.warn(
          { threadId: input.threadId, toolName: toolCall.name },
          'Liftoff chat received a tool call it does not recognise',
        );
        toolResults.push({
          toolCallId: toolCall.id,
          content: JSON.stringify({
            error: `Tool "${toolCall.name}" is not available here.`,
          }),
        });
      }


      // Mid-run signals are claimed HERE, after a tool result, which is the
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
      // tool this assistant has — the workspace actions, list_colleagues, the
      // browser, the dataset tools themselves — rather than only the one it
      // was wired to. A result past the bound is parked as a dataset for this
      // conversation and the model gets its view; the tools it already holds
      // read the records back without any of them passing through the window.
      const boundedToolResults = await parkOversizedToolResults(
        input.tenantId,
        toolResults,
        { kind: 'liftoff_thread', id: input.threadId },
        (toolCallId) => {
          const name = turnToolCalls.find((c) => c.id === toolCallId)?.name ?? 'tool';
          return { label: `${name} result`, source: 'liftoff_tool', sourceRef: name };
        },
      );

      // Append the assistant's tool-use turn + the user turn carrying results.
      // The per-message tool fields are what make this round-trip through the
      // LLM provider correctly.
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
          'Chat turn passed its deadline during a round of tools; closing the reply',
        );
        terminatedEarly = 'DEADLINE';
        conversation = [...conversation, { role: 'user', content: closingNote }];
        closing = 'deadline';
      } else if (iteration >= MAX_ITERATIONS) {
        log.warn(
          { threadId: input.threadId, iteration },
          'Chat turn hit max iterations; closing the reply',
        );
        terminatedEarly = 'MAX_ITERATIONS';
        conversation = [...conversation, { role: 'user', content: closingNote }];
        closing = 'rounds';
      }
    }

    const finalText = accumulatedText.trim();

    // A stopped turn keeps what it had written (ADR-041). When it was stopped
    // before writing anything there is nothing to keep, and nothing is
    // invented: writing a marker into the message content would put words in
    // the assistant's mouth, and the transcript would show it saying
    // "(stopped)", which it never did, and which reads as an answer rather
    // than as the absence of one.
    if (userStopped && !finalText) {
      logAudit(
        'liftoff.chat_turn',
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

    // 5. Persist the assistant message.
    //
    // A FINISHED TURN MUST NEVER LEAVE THE THREAD EMPTY. `finalText` straight
    // through meant a turn that ran and ended without prose persisted an empty
    // row, which renders as a conversation that simply stops: indistinguishable
    // from a turn that never ran. The user-stopped case above is the one
    // legitimate silence and returns before reaching here.
    const savedMessage = await appendMessage({
      threadId: input.threadId,
      role: 'assistant',
      content: finalText || COMPLETED_WITHOUT_REPLY,
      inputTokens: cumulativeInputTokens,
      outputTokens: cumulativeOutputTokens,
      turnId: recallTurnId,
    });

    // Make this turn searchable. Best-effort ON PURPOSE and never awaited: this
    // process throttles CPU outside a request, so the call may not finish, and
    // the durable path is the embed sweep (scripts/embed-sweep-chat-turns).
    // Correctness never depends on either — an unembedded turn is still found by
    // the keyword arm.
    void embedPlatformTurn('liftoff', input.tenantId, recallTurnId).catch((err) => {
      log.warn(
        { threadId: input.threadId, turnId: recallTurnId, error: (err as Error).message },
        'liftoff: inline turn embed failed; the sweep will pick it up',
      );
    });

    // Tell them their answer arrived, if they are not sitting on the thread
    // watching it. Fire-and-forget after the row is committed: a notification
    // is never worth failing a turn that already succeeded.
    void notifyPlatformChatReply({
      tenantId: input.tenantId,
      surface: 'liftoff',
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

    // 6. Audit log, message length only, never full content (PII). The names
    // are the catalog's own tokens, not the person's words, so this carries
    // no more of the question than the tool list already contains.
    const catalogNamed = servedNamesIn(input.userMessage);
    logAudit(
      'liftoff.chat_turn',
      { tenantId: input.tenantId, userId: input.accountId },
      {
        threadId: input.threadId,
        iterations: iteration,
        attachmentCount: attachments.length,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        userMessageLength: input.userMessage.length,
        assistantMessageLength: finalText.length,
        terminatedEarly,
        ...(closingUnfinished !== null ? { closingUnfinished } : {}),
        ...(continuation ? { continuationOf: continuation.originMessageId, continuationOrdinal: continuation.ordinal } : {}),
        // The queryable marker for a turn the person ended (ADR-041). Written
        // alongside a success outcome, never as a failure.
        ...(userStopped ? { errorCode: 'user_stopped' } : {}),
        // WHICH ROUTE ANSWERED, and whether the other one was even considered.
        // `catalogNamed` is a keyword match of the question against the sites
        // and services already served here; it says the question MENTIONED
        // one, never that a capability would have answered it well.
        // `catalogSkipped` is therefore a question to look into, not a defect
        // count: the open web is often the better answer, and on the one
        // query that prompted this it was.
        capabilitySearched,
        ...(capabilityRan ? { capabilityRan } : {}),
        ...(webSearchRequests > 0 ? { webSearchRequests } : {}),
        ...(catalogNamed.length > 0 ? { catalogNamed } : {}),
        ...(catalogNamed.length > 0 && !capabilitySearched && webSearchRequests > 0
          ? { catalogSkipped: true }
          : {}),
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
    // mid-flight. maybeGenerateThreadTitle already catches all internal
    // errors, so awaiting can never throw here.
    if (priorTurns.length <= 4) {
      await maybeGenerateThreadTitle({
        threadId: input.threadId,
        tenantId: input.tenantId,
        userMessage: input.userMessage,
        assistantMessage: finalText,
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
      surface: 'liftoff',
      threadId: input.threadId,
      accountId: input.accountId,
      originMessageId,
      reason,
    });
    if (row) await enqueueContinuationTask(row.id, input.tenantId);
  } catch (err) {
    log.warn(
      { threadId: input.threadId, tenantId: input.tenantId, originMessageId, error: (err as Error).message },
      'liftoff: could not queue the continuation of this turn',
    );
  }
}

/**
 * Check if the thread needs a fresh rolling summary, and generate one if so.
 * Called fire-and-forget after each turn. Any errors are logged but do not
 * propagate: summarization failing must never affect the user-visible chat.
 */
async function maybeRefreshRollingSummary(
  threadId: string,
  tenantId: string,
): Promise<void> {
  // Load the full thread (up to the summarization cap) oldest-first.
  const historyResult = await listMessages(threadId, { limit: MAX_SUMMARIZATION_HISTORY });
  const allMessages: SummarizationMessage[] = [...historyResult.messages]
    .reverse()
    // Same reason as the turn history: a rolling summary that recorded "waiting
    // on an approval" as something the conversation was about would carry a
    // pause that has long since cleared forward as though it were subject
    // matter.
    .filter(m => m.messageType !== HITL_STATUS_MESSAGE_TYPE)
    // A note about what Liftoff was told is not part of the conversation being
    // summarised, and it is already a summary of one.
    .filter(m => m.messageType !== FORWARDED_CONTEXT_MESSAGE_TYPE)
    // The person's browser events are the record's, read from the Browser
    // section each turn, not subject matter.
    .filter(m => m.messageType !== BROWSER_HANDBACK_MESSAGE_TYPE)
    .filter(m => m.messageType !== BROWSER_POINT_MESSAGE_TYPE)
    .map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    }));

  const previousSummary = await getThreadRollingSummary(threadId, tenantId);

  // The purpose tag is what keeps this surface's summarization spend out of the
  // insights bucket in llm_usage_log.
  const input = {
    threadId,
    tenantId,
    allMessages,
    previousSummary,
    purpose: 'liftoff_summarization',
  };
  if (!shouldSummarize(input)) return;

  const newSummary = await generateRollingSummary(input);
  if (newSummary && newSummary !== previousSummary) {
    await updateThreadRollingSummary(threadId, tenantId, newSummary);
  }
}
