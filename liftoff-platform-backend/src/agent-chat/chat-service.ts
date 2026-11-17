// Agent Chat Service — SDK-backed interactive chat for agent conversations.
//
// Runs a single chat turn end-to-end as an async generator of typed events.
// The stream-router wraps these events as SSE frames (web) or posts them as
// Slack messages (via the Slack adapter). This service is channel-agnostic.
//
// A single turn:
//
//   1. Yield `thinking` so the UI can show a typing indicator
//   2. Load agent config from internal_agents (with not-found / paused guards)
//   3. Persist the user message
//   4. Delegate to the Tenant Runtime SDK engine via runChatTurnStream
//   5. Translate TR events to AgentChatEvents and yield them
//   6. On complete: persist assistant message, audit log, title generation,
//      rolling summary refresh

import crypto from 'crypto';
import { log, logAudit } from '../infrastructure/logging';
import { fireAndForget } from '../shared/fire-and-forget';
import { getPool, withTenantScope } from '../infrastructure/database';
import {
  TenantRuntimeClient,
  type ChatTurnStreamEvent as _ChatTurnStreamEvent,
} from '../connectors/tenant-runtime-client';
import * as chatRepo from './chat-repository';
import { embedTurn } from './turn-embedding-service';
import { TurnEventRecorder } from './turn-event-recorder';
import { describeApprovalRoute } from './approval-route-description';
import {
  waitingMessage,
  delegatedWaitingMessage,
  HITL_STATUS_MESSAGE_TYPE,
  DELEGATION_STATUS_MESSAGE_TYPE,
} from './hitl-status-message';
import {
  RUN_PROGRESS_MESSAGE_TYPE,
  RUN_FAILED_MESSAGE_TYPE,
  RUN_FAILED_SUMMARY_NOTE,
  RunProgressTracker,
  runEndedMessage,
  type RunEndedReason,
} from './run-progress';
import { isConversationRow } from './transcript-context';
import { browserDriverNameForThread } from '../browser-sessions/browser-state';
import {
  FORWARDED_CONTEXT_MESSAGE_TYPE,
  forwardedContextStatus,
  withForwardedContext,
} from '../liftoff/forwarded-context';
import { updateThreadTitleInternal } from './chat-repository';
import type { AgentChatMessage, Citation } from './chat-repository';
import type { Contributor } from '../chat-attachments';
import { resolveContributors } from './contributors';
import { COLLEAGUE_MESSAGE_TYPE } from './colleague-message-type';
import { maybeGenerateThreadTitle } from '../shared/thread-title-generation';
import {
  formatSummaryForPrompt,
  generateRollingSummary,
  shouldSummarize,
  type SummarizationMessage,
} from '../insights/conversation-summarization';
import type { ConversationSummary } from '../insights/types';
import { truncateToTokenBudget } from '../insights/context-budget';

/**
 * Token budget for the rolling summary sent to the runtime for a chat turn.
 *
 * Matches DEFAULT_INSIGHTS_BUDGET.sections.rollingSummary — the same artifact
 * gets the same allowance on both surfaces. Stated as its own constant because
 * this path has a hard requirement insights does not: the runtime's chat-turn
 * schema REJECTS an over-long summary, so an unbudgeted value fails the turn
 * instead of degrading it.
 */
const ROLLING_SUMMARY_PROMPT_TOKEN_BUDGET = 1000;
import { guardMessage } from '../common/injection-guard';
import { assistantMessageGap } from '../common/assistant-message-boundary';
import { GuardedOutput, guardWholeText } from '../common/guarded-stream';
import { designChangeJustRegistered } from './colleague-request';
import {
  applyLesson,
  classifyLesson,
  looksLikeTeaching,
  LEARNING_CONFIRMATION_MESSAGE_TYPE,
} from './chat-learning-service';
import { handlePossibleSuggestionReply, proposeRoutineFromChat } from './suggestion-flow';
import { pushOutOfTurnMessage, notifyReplyPersisted } from './out-of-turn-delivery';
import { screenChatMessage } from '../injection-detection/gating';
import { oversightService } from '../internal-agent-oversight/service';
import { MODEL_PRICING } from '../llm/pricing';
import {
  composeTurnText,
  partitionMediaForModel,
  toMessageAttachments,
  toMessageMedia,
  type ChatAttachment,
} from '../chat-attachments';
import { noteUnscreenedMediaExposure, sendableModalities } from '../llm/vision';
import { claimInboundMedia } from '../media/inbound';
import type { AutonomyLevel } from '../internal-agent-oversight/types';
import { checkAttachmentClaim, recordAttachmentClaimFinding } from './attachment-claims';

/** What an escalated turn adds to whatever the team managed to say.
 *
 *  The wording is owned here rather than sent over the wire: the runtime signals
 *  the handoff as a fact (`escalated` on the complete frame, beside `stopped`),
 *  and prose crossing a service boundary is prose two repositories have to keep
 *  in step. It matches the sentence the runtime persists to its own transcript,
 *  and the source contract test in the runtime keeps the frame carrying the flag
 *  rather than the words.
 *
 *  Product voice: no em dashes, no contractions, does not say "agent".
 */
const HANDED_TO_A_PERSON = 'Passed to a person for review.';

/** What a turn adds when the run behind it did not finish and nobody was handed
 *  anything.
 *
 *  The other half of HANDED_TO_A_PERSON. An escalation recorded operator-side
 *  reaches nobody in the workspace, so that sentence would be false — and
 *  saying nothing left the person with only the run's prose. A run whose steps
 *  did not produce their declared outputs composes that prose from the hole
 *  they left: a run that stops at step 3 of 21 can report "This week's report
 *  already ran. Nothing new was written since the last update."
 *
 *  Product voice: no em dashes, no contractions, does not say "agent". */
const RUN_DID_NOT_FINISH = 'This run did not finish, so what it reports may be incomplete.';

/** What a person is told when the CONNECTION to a run ends, which is not the
 *  run ending.
 *
 *  The runtime keeps working: a disconnect does not abort a turn (ADR-041) and
 *  the engine is cancelled only by the durable abort row. Saying the run
 *  stopped — and that "trying again is safe" — invited a second run on top of
 *  a first that was still going, and made every slow run look dead.
 *
 *  Product voice: no em dashes, no contractions, does not say "agent". */
const STREAM_ENDED_RUN_CONTINUES =
  'The live connection to this run ended. The run is still going and its result will appear here.';

// ── Event shape ─────────────────────────────────────────────────────────

export type AgentChatErrorCode =
  | 'PROVIDER_ERROR'
  | 'MAX_ITERATIONS'
  | 'TOKEN_BUDGET'
  | 'INTERNAL'
  | 'AGENT_PAUSED'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_BUSY'
  | 'BLOCKED'
  | 'EMPTY_MESSAGE';

/** Display name for one delegated team, from the runtime agent id a TR frame
 *  carries. The one-id case of resolveContributors, kept for the pause frame,
 *  which names a single team: a hand-over or a pause whose team cannot be
 *  named still happened and still needs surfacing; null lets the copy fall
 *  back to the nameless sentence rather than failing the turn. */
async function resolveDelegateName(
  tenantId: string,
  runtimeAgentId: string,
): Promise<string | null> {
  const [contributor] = await resolveContributors(tenantId, [runtimeAgentId]);
  return contributor?.label ?? null;
}

export type AgentChatEvent =
  /** Sent immediately when a turn starts, before any LLM call. */
  | { type: 'thinking' }
  /** Sent when the LLM requests a specific tool (one per call). In
   *  trace mode also carries the callId + args; default mode carries
   *  just the tool name (frontend wire stays unchanged). */
  | { type: 'tool_call'; tool: string; callId?: string; args?: unknown }
  // Where a long run has got to. Forwarded so a surface can show it live; the
  // turn wrapper uses it to narrate a run that emits nothing else.
  | { type: 'workflow_step'; stepId: string; index: number; total: number }
  // The run parked and will come back on its own. Yielded so the turn wrapper
  // can tell "still going, elsewhere" from "finished" — a distinction the
  // terminal `complete` below cannot carry.
  | { type: 'run_parked'; reason: 'continuation' | 'wake'; detail: string }
  /** Incremental text from the LLM response. */
  | { type: 'text_delta'; text: string }
  /** End of one assistant message, so the UI can place a paragraph break at a
   *  real boundary. Carries no text and is not accumulated into the turn's
   *  reply — the message content already arrived as deltas. */
  | { type: 'text_break' }
  /** A tool call was gated by HITL — the turn pauses until approval. */
  | {
      type: 'hitl_required';
      approvalId: string;
      reason: string;
      action?: string | null;
      why?: string | null;
      detail?: string | null;
      /** Who the approval was routed to, by name. Empty when it went to the
       *  workspace admins because the agent has no eligible assignee — the UI
       *  says "the workspace admins" rather than naming everyone. */
      routedTo?: string[];
      routedToAccountIds?: string[];
      /** True when nobody assigned could approve at this level. */
      routedToAdmins?: boolean;
      /** True when the agent has no assignees at all, so this is open to the
       *  workspace rather than escalated past somebody. */
      unassigned?: boolean;
      /** The gate's level. Level 1 needs an admin or owner; level 2 any member.
       *  The wording differs, so the client needs it. */
      hitlLevel?: number;
    }
  /** A team this team delegated work to stopped for a human approval. Not a
   *  failure, and not terminal for THIS turn: the parent model received the
   *  structured pause as its tool result and keeps narrating. The event exists
   *  so the client can refresh the transcript (a status row naming the waiting
   *  team was just persisted) and surface the way to the review queue, where
   *  the decision is waiting. `agentName` is resolved best-effort; null means
   *  the row still explains the stall, just without the name. */
  | { type: 'delegation_paused'; agentName: string | null; approvalId: string | null; reason: string }
  /** A team this team is handing work to, the moment the hand-over begins.
   *  Same payload as Liftoff's frame of the same name, so one client handler
   *  attributes a live reply on every surface: `author` is the teammate's
   *  internal_agents id, `authorLabel` the name the person sees. The client
   *  puts a chip on the live bubble and names the teammate on the activity
   *  line; the persisted copy arrives on the reply itself (`contributors`),
   *  resolved from the same ids by the same lookup. Only emitted when the
   *  teammate resolves: a chip with no name is worse than none. */
  | { type: 'delegation_started'; author: string; authorLabel: string }
  /** Values a tool returned that were delivered to the PERSON and deliberately
   *  kept out of the model's context — a signed download link, a one-time token.
   *  The runtime lifts declared fields off a result and leaves a placeholder in
   *  the model's copy, so this event is the only path they have to a reader. */
  | { type: 'host_delivered'; tool: string; fields: Array<{ path: string; value: unknown }> }
  /** The agent asked a clarifying question (ask_user) — the turn pauses until
   *  the user's next message answers it (routed via the clarification row). */
  | { type: 'awaiting_input'; question: string; sessionId: string }
  /** Terminal success — the final persisted assistant message. */
  /** Terminal success. `message` is null when the turn was stopped before it
   *  said anything: nothing was persisted, so there is nothing to hand over. */
  /** The connection ended while the run continued. NOT an error: nothing
   *  about the run is known from this, and the outcome arrives on the settle
   *  callback. Carried as its own type so a consumer cannot mistake it for a
   *  failure the way `error` was mistaken. */
  | { type: 'stream_lost'; detail: string }
  | { type: 'complete'; message: AgentChatMessage | null }
  /** Terminal failure — the turn could not complete.
   *
   *  `retryable` is the RUNTIME's verdict, relayed rather than re-derived: a
   *  provider at capacity or a dropped socket can succeed on a second delivery,
   *  a validation error or a paused agent cannot. A delivery worker that has not
   *  yet shown the user anything can use it to fail its own request and let the
   *  queue re-deliver, turning a visible apology into an invisible retry.
   *  Absent when the runtime did not say — treat that as "do not retry".
   *
   *  `failureClass` is the runtime's own taxonomy, carried because it is what
   *  says whether `message` is the RUNTIME's user-safe sentence or this
   *  service's generic fallback. The status row reads it to decide whether the
   *  "what to do next" clause can be taken from the message at all. Absent on
   *  every failure this service raises itself, and on an older runtime. */
  | { type: 'error'; code: AgentChatErrorCode; message: string; retryable?: boolean; failureClass?: string }
  /** The message did not start a turn: it was delivered as an interrupt to
   *  the run already active on this thread. No assistant reply follows. */
  | { type: 'interrupt_delivered' }
  /** The message answered a pending clarification; the paused run has been
   *  re-enqueued and will resume out-of-band. No assistant reply follows. */
  | { type: 'clarification_accepted' }
  /** A stop request was accepted (the active run is aborting, or nothing was
   *  running). No assistant reply follows. */
  | { type: 'stop_acknowledged' }
  // ── Trace-mode events ────────────────────────────────────────────
  // Emitted only when input.traceMode === true. The PB-side
  // agent-test-harness sets this on its internal call so it gets full
  // parity with the TR-direct runner: tool args + result, per-message
  // usage, and the agent's exposed tool catalog. Real chat never sets
  // traceMode, so it never receives these events.
  | { type: 'catalog'; exposedToolNames: string[] }
  | { type: 'tool_call_finished'; callId: string; result: unknown; error?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number };

// ── Input shape ─────────────────────────────────────────────────────────

export interface AgentChatTurnInput {
  tenantId: string;
  agentId: string;
  threadId: string;
  userId: string;
  /** Strict accounts.id of the human sender, or absent for unresolved
   *  Slack/Teams guests (plan v13 Change 2). NEVER the overloaded userId
   *  (which carries synthetic ids like `slack:<uid>` on guest turns).
   *  Drives per-turn attribution (agent_chat_turns.sender_account_id) and,
   *  via TR, recall-tool registration. */
  senderAccountId?: string;
  userDisplayName: string;
  /** Attribution-grade name for a sender with no account, when it differs
   *  from userDisplayName. Teams sets this because its greeting name falls
   *  back to a placeholder; Slack and MCP do not need it. */
  senderLabel?: string;
  /** The operator's account when a support delegation session is sending this
   *  turn. Set only by the two web entry points, because Slack, Teams and MCP
   *  are service paths that can never be delegated. Internal attribution only:
   *  the turn still renders as the customer's. */
  impersonatedBy?: string | null;
  userRole?: string;       // tenant member role (owner/admin/member/viewer)
  tenantName?: string;     // for system prompt identity line
  content: string;
  /** The brief Liftoff wrote when it brought this team into one of its
   *  conversations, already framed for the model (see
   *  liftoff/forwarded-context.ts). Read this turn, in front of the person's
   *  message, and never persisted. Absent on every other caller: a person
   *  typing here needs no forwarding, because they can see the thread. */
  forwardedContext?: string | null;
  /** Who forwarded that background. The thread keeps one status row naming
   *  them, attributed to them rather than to this team. Null or absent with
   *  a null brief. */
  forwardedBy?: Contributor | null;
  channelHint?: 'web' | 'slack' | 'teams';
  /** Turn identity supplied by the caller (C1).
   *
   *  The Slack/Teams workers mint this at ENQUEUE time and carry it on the
   *  Cloud Tasks payload, so a task retry addresses the same turn it did the
   *  first time. That is what lets a retry notice the turn already ran and
   *  re-deliver the stored reply instead of paying for the whole turn again.
   *  Web turns leave it unset and one is minted here. */
  turnId?: string;
  /** Invocation identity supplied by the caller. The runtime records the run
   *  under this id, so a caller that reads the run back afterwards — the test
   *  harness fetching its trace — has to be the one that names it; an id
   *  minted here and never surfaced is one the caller cannot cite. Real chat
   *  leaves it unset and one is minted here. */
  invocationId?: string;
  /** Opt-in trace mode used by the agent-test-harness PB endpoint to
   *  reach parity with the TR-direct runner. Forwarded to TR's chat
   *  turn stream; TR emits richer SSE events (catalog / args / result
   *  / usage) which runAgentChatTurn forwards to the consumer. Default
   *  false — real chat from the frontend never sets it. */
  traceMode?: boolean;
  /** Files and connector references attached to this message. Uploads are read
   *  by the model this turn; only metadata is persisted, and media goes to the
   *  message's own `media` column rather than to `attachments`. */
  attachments?: ChatAttachment[];
  /** The person's browser event this turn carries, verified by the stream
   *  router against the runtime's record: they handed the browser back, or
   *  pointed at something in it. With an empty `content` the turn is the
   *  event alone: no user row is written, the router's status line is what
   *  the thread shows, and the runtime supplies the model-facing text. */
  browserEvent?: { kind: 'handback'; holdId: string };
}

// ── Constants ───────────────────────────────────────────────────────────

const MAX_HISTORY_MESSAGES = 20;
// When generating the rolling summary we load more history so we can see
// everything that's accumulated since the last summary. 200 is well above
// any realistic thread length; short threads just see the whole thing.
const MAX_SUMMARIZATION_HISTORY = 200;

// ── Session persistence ─────────────────────────────────────────────────

/**
 * Upsert the SDK session ID for a (thread, agent) pair.
 * Called after each successful SDK chat turn so the next turn can resume
 * the session with full conversational context.
 */
async function upsertChatSession(threadId: string, agentId: string, sessionId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_chat_sessions (thread_id, agent_id, session_id, expires_at, updated_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', NOW())
     ON CONFLICT (thread_id, agent_id) DO UPDATE
     SET session_id = $3, expires_at = NOW() + INTERVAL '7 days', updated_at = NOW()`,
    [threadId, agentId, sessionId],
  );
}

/**
 * Look up the current SDK session ID for a (thread, agent) pair.
 * Returns undefined if no session exists or it has expired.
 */
async function getSessionId(threadId: string, agentId: string): Promise<string | undefined> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT session_id FROM agent_chat_sessions
     WHERE thread_id = $1 AND agent_id = $2 AND expires_at > NOW()`,
    [threadId, agentId],
  );
  return result.rows[0]?.session_id;
}

/**
 * Delete a stale session row so the next turn starts fresh.
 * Called when Tenant Runtime rejects a resumeSessionId as unknown.
 */
async function deleteStaleSession(threadId: string, agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    'DELETE FROM agent_chat_sessions WHERE thread_id = $1 AND agent_id = $2',
    [threadId, agentId],
  );
}

// ── Agent config row shape ──────────────────────────────────────────────

interface AgentConfigRow {
  id: string;
  role: string;
  messaging_nickname: string | null;
  system_prompt: string | null;
  user_instructions: string | null;
  additional_context: string | null;
  status: string;
  autonomy_override: AutonomyLevel | null;
  model_config: { modelId?: string; provider?: string } | null;
}

// ── Main entry point ────────────────────────────────────────────────────

// Not every display name an adapter produces is an identity. The Teams
// resolver falls back to the literal 'there' (it doubles as the greeting in
// "Hi there") when the roster lookup fails, and MCP leaves it empty when no
// account backs the token. Persisting either would put a nonsense avatar on a
// message, which is worse than the blank it replaces.
const NON_IDENTIFYING_LABELS = new Set(['there', 'user', 'unknown']);

function usableSenderLabel(displayName: string | undefined): string | null {
  const trimmed = displayName?.trim();
  if (!trimmed) return null;
  return NON_IDENTIFYING_LABELS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** Exported for tests only. */
export const __testables = { usableSenderLabel };

/**
 * Run a turn, and record its execution events so people other than the sender
 * can watch it happen.
 *
 * The recording is a tee here rather than at any caller because this generator
 * is the single producer of a turn's events — every channel and the
 * multi-agent router both funnel through it — and it is the only place that
 * knows the turnId. It never affects the turn: the recorder swallows its own
 * failures, and a turn with no audience records nothing at all.
 */
export async function* runAgentChatTurn(
  input: AgentChatTurnInput,
): AsyncIterable<AgentChatEvent> {
  let recorder: TurnEventRecorder | null = null;
  // Whether an exchange exists to narrate. The core calls back with a turn id
  // only AFTER the turn row and the person's message are inserted, so this is
  // the precise question — not a list of the codes that happen to return early
  // today. A branch that refuses before the insert (empty message, unknown
  // team) leaves nothing on screen to attach a status row to, and writing one
  // would put an orphan in a thread whose question was never recorded.
  let turnExists = false;
  // What this run has done so far, and the row it is being told through. One
  // row per run, rewritten: the live tool_call frames reach an open browser and
  // are never written down, so a turn that outlives the tab leaves a thread
  // holding a question and nothing else.
  const progress = new RunProgressTracker();
  try {
    for await (const event of runAgentChatTurnCore(input, (turnId) => {
      turnExists = true;
      recorder = new TurnEventRecorder(
        input.tenantId,
        input.threadId,
        turnId,
        input.senderAccountId ?? null,
      );
    })) {
      await (recorder as TurnEventRecorder | null)?.record(
        event as unknown as { type: string; text?: string },
      );
      // A run that ends without an answer says so IN THE THREAD.
      //
      // Written here rather than at each of the eight `type: 'error'` yields in
      // the core, because a rule enforced at eight sites is a rule that will be
      // missed at the ninth. Everything the core can produce passes through this
      // loop, so a branch added tomorrow is covered by existing.
      //
      // The error EVENT already reaches a browser that is still listening. That
      // is not enough and never was: these turns run for minutes, the person has
      // usually navigated away, and on reload the thread holds their question
      // and nothing else — indistinguishable from a message never delivered,
      // so a person can wait on an already-dead turn. The row is what
      // survives the connection.
      if (event.type === 'error' && turnExists) {
        await persistRunEnded(input, event, progress);
      }

      // The connection ended and the run did not. Written like any other
      // narration and deliberately NOT through `persistRunEnded`: that settles
      // the tracker as this run's last word, and this run has not had its last
      // word — the outcome arrives on the settle callback and gets to write it.
      if (event.type === 'stream_lost' && turnExists) {
        await persistProgressLine(input, event.detail);
      }

      // Narrate the work while it is happening. The tracker decides whether
      // there is anything worth saying and how often -- a turn that answers in
      // seconds never writes a row at all.
      if (turnExists) {
        if (event.type === 'tool_call') progress.noteToolCall(event.tool, event.callId);
        else if (event.type === 'workflow_step') progress.noteStep(event.index, event.total);
        else if (event.type === 'delegation_started') progress.noteDelegation();
        else if (event.type === 'run_parked') {
          // Parked is not finished. The run is still going, somewhere else, and
          // the notice saying so is written by the runtime's settle callback --
          // so this must not also write "this run took twelve minutes", which
          // reads as an ending and, keeping the row it was rewritten into,
          // sorted ABOVE the notice that the work was still running.
          progress.settle();
        } else if (event.type === 'complete') {
          // The answer is right below it now, so this line stops being a status
          // and becomes the record of why the answer took as long as it did.
          // finishedLine settles the tracker either way, which is what stops a
          // run that finished the moment it started working from having its
          // first progress line written AFTER its own reply.
          const finished = progress.finishedLine();
          if (finished && progress.hasWritten()) {
            await persistProgressLine(input, finished);
          }
        }
        const line = progress.takeLine();
        if (line) await persistProgressLine(input, line);
      }
      yield event;
    }
  } finally {
    await (recorder as TurnEventRecorder | null)?.finish();
  }
}

/** Map the error CODE the core already resolved onto the reason a person is
 *  told. Derived from the code rather than from the message text, so rewording
 *  a sentence can never silently change which advice the reader gets. */
function reasonForCode(code: AgentChatErrorCode | undefined): RunEndedReason {
  switch (code) {
    case 'AGENT_BUSY': return 'busy';
    case 'PROVIDER_ERROR': return 'provider_error';
    case 'INTERNAL': return 'internal';
    default: return 'internal';
  }
}

/** Persist the run-ended row. Best-effort and silent on failure: a thread that
 *  could not be told why a turn stopped is the situation we already have, and
 *  making the error path itself able to throw would be worse than the gap. */
async function persistRunEnded(
  input: AgentChatTurnInput,
  event: {
    type: 'error';
    code?: AgentChatErrorCode;
    message?: string;
    failureClass?: string;
    retryable?: boolean;
  },
  progress: RunProgressTracker,
): Promise<void> {
  const timedOut = typeof event.message === 'string'
    && /time limit|wall-clock|timed out/i.test(event.message);
  // Nothing further is narrated: this row is the run's last word.
  progress.settle();
  // Appended like every other line, carrying what the run got done: a failure
  // that lists the work it completed is a different thing to read from one that
  // says nothing happened.
  //
  // The "what to do next" clause is the runtime's OWN sentence whenever the
  // runtime classified the failure — `failureClass` is precisely the flag that
  // says `event.message` is that sentence rather than this service's generic
  // fallback, so no raw engine string can reach a person. And a retry is
  // called safe only when the runtime said it was.
  await persistProgressLine(
    input,
    runEndedMessage(
      timedOut ? 'timeout' : reasonForCode(event.code),
      { activity: progress.activitySummary(), ...(progress.position() ?? {}) },
      {
        ...(event.failureClass && event.message ? { nextStep: event.message } : {}),
        ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
      },
    ),
    RUN_FAILED_MESSAGE_TYPE,
  );
}

/** Append one line of narration.
 *
 *  APPEND, not rewrite. One row rewritten in place showed only the run's latest
 *  state: every earlier update vanished as the next replaced it, and because a
 *  rewritten row keeps its original created_at, the final text sorted to where
 *  the FIRST update had been -- so a run that parked after twelve minutes read
 *  as "this run took 12 minutes" ABOVE the notice saying it was still going.
 *
 *  The throttle is what keeps this from becoming a log: nothing for the first
 *  45 seconds, then at most one line per 20 seconds, and never a line that says
 *  what the last one said.
 *
 *  Best-effort and silent on failure: a thread that could not be told what its
 *  run is doing is the situation we already have, and making narration able to
 *  throw would be worse than the gap it closes. */
async function persistProgressLine(
  input: AgentChatTurnInput,
  line: string,
  /** Which narration this is. The terminal row is typed `run_failed` so the
   *  next turn can find it and tell the model the run stopped; everything else
   *  is `run_progress`. Both are narration and neither is speech. */
  messageType: string = RUN_PROGRESS_MESSAGE_TYPE,
): Promise<void> {
  try {
    await chatRepo.appendMessage(
      input.tenantId,
      input.threadId,
      'assistant',
      line,
      input.agentId,
      undefined,
      undefined,
      undefined,
      messageType,
    );
  } catch (err) {
    log.warn(
      { tenantId: input.tenantId, threadId: input.threadId, error: (err as Error).message },
      'run-progress: could not persist the status row (turn unaffected)',
    );
  }
}

async function* runAgentChatTurnCore(
  input: AgentChatTurnInput,
  onTurnId: (turnId: string) => void,
): AsyncIterable<AgentChatEvent> {
  yield { type: 'thinking' };

  // 0. Nothing to answer. This is the shared entry for web / Slack / Teams /
  //    mcp-server / delegation / multi-agent, and the runtime client rejects an
  //    empty userMessage by THROWING before it ever calls fetch — which lands in
  //    the pre-stream catch and tells the person "we could not reach the agent",
  //    naming a network failure that did not happen. Refuse it here instead,
  //    ahead of the turn+message insert so an empty message never becomes a row
  //    that replays as history, and ahead of the injection and jailbreak screens
  //    so it costs no classifier calls. Deliberately not retryable: sending the
  //    same empty message again fails identically.
  // A browser event is a turn without words: the runtime writes the text the
  // model reads, and nothing here screens or stores an empty message.
  const eventOnly = input.browserEvent !== undefined && !input.content.trim();
  if (!input.content.trim() && !eventOnly) {
    yield {
      type: 'error',
      code: 'EMPTY_MESSAGE',
      message: 'There was no message to respond to.',
    };
    return;
  }

  try {
    // 1. Load agent config.
    const agentResult = await withTenantScope(input.tenantId, (client) => client.query(
      `SELECT id, role, messaging_nickname, system_prompt, user_instructions,
              additional_context, status, autonomy_override, model_config
       FROM internal_agents
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [input.agentId, input.tenantId],
    ));

    if (agentResult.rows.length === 0) {
      yield {
        type: 'error',
        code: 'AGENT_NOT_FOUND',
        message: 'That agent was not found, or has been deleted.',
      };
      return;
    }

    const agent = agentResult.rows[0] as AgentConfigRow;

    // R5 Fix 12: generate turnId on PB for audit correlation across PB↔TR.
    // Moved ABOVE user-message persistence (plan v13 Change 2): the same id
    // keys the agent_chat_turns row, so it must exist before the atomic
    // turn+message insert below.
    const turnId = input.turnId ?? crypto.randomUUID();
    onTurnId(turnId);

    const attachments = input.attachments ?? [];
    const sentMedia = toMessageMedia(attachments);
    const persistedAttachments = toMessageAttachments(attachments);

    // 2. Persist the turn record + user message FIRST (one transaction) so a
    //    crashed turn still leaves a visible, attributed record of what the
    //    user asked. Sender attribution is the strict senderAccountId only —
    //    null for unresolved guests, never the overloaded userId.
    if (eventOnly) {
      await chatRepo.createTurnWithoutUserMessage(
        input.tenantId,
        input.threadId,
        input.agentId,
        turnId,
        input.senderAccountId ?? null,
        usableSenderLabel(input.senderLabel ?? input.userDisplayName),
        input.impersonatedBy ?? null,
      );
    } else {
      await chatRepo.createTurnWithUserMessage(
        input.tenantId,
        input.threadId,
        input.agentId,
        turnId,
        input.senderAccountId ?? null,
        input.content,
        // Guests have no account; their channel display name is the only
        // attribution available, and every adapter already passes it.
        usableSenderLabel(input.senderLabel ?? input.userDisplayName),
        sentMedia.length > 0 ? sentMedia : null,
        persistedAttachments.length > 0 ? persistedAttachments : null,
        input.impersonatedBy ?? null,
      );
    }

    // A message carries these now, so the abandoned-upload sweep must leave
    // them alone. Best effort: a failed claim costs the picture a day from now,
    // failing the turn over it would cost it immediately.
    if (sentMedia.length > 0) {
      await claimInboundMedia(
        input.tenantId,
        sentMedia.map(m => m.mediaId),
        input.threadId,
        'agent_chat',
      ).catch(err => {
        log.warn(
          { error: (err as Error).message, threadId: input.threadId },
          'agent-chat: could not claim inbound media',
        );
      });
    }

    // A colleague brought this team in: one status row about the conversation
    // rather than a turn in it, naming who did. Written straight after the
    // person's message so it reads in the order it happened, and typed so the
    // UI renders it as a status line and the model's history skips it. The
    // brief itself is read this turn, in front of the message, and never
    // stored: it is the colleague's note to the model, not something a person
    // should open.
    //
    // Best effort. This is provenance, not the question itself, so failing to
    // write it must not cost the person their turn.
    if (input.forwardedContext) {
      try {
        await chatRepo.appendMessage(
          input.tenantId,
          input.threadId,
          'assistant',
          forwardedContextStatus(input.forwardedBy?.label ?? 'Liftoff'),
          input.agentId,
          undefined,
          0,
          0,
          FORWARDED_CONTEXT_MESSAGE_TYPE,
          undefined,
          undefined,
          null,
          null,
          null,
          // The row is the colleague's, not this team's: the chip on it
          // names whoever brought the team in.
          input.forwardedBy ? [input.forwardedBy] : undefined,
        );
      } catch (err) {
        log.warn(
          { tenantId: input.tenantId, threadId: input.threadId, error: (err as Error).message },
          'agent-chat: could not record the context a colleague forwarded',
        );
      }
    }

    // 2.5 Deterministic injection pre-filter — HARD-BLOCK, runs BEFORE the LLM
    //     guard and the model call. runAgentChatTurn is the shared entry for web
    //     / Slack / Teams / multi-agent, so this covers every direct channel.
    //     Per-tenant gated, shadow-first: only an `enforce`-mode Block rejects;
    //     Review/Allow (and all of shadow) fall through to the LLM guard below.
    const injectionScreen = eventOnly
      ? { block: false }
      : await screenChatMessage(input.content, {
        tenantId: input.tenantId,
        agentId: input.agentId,
        userId: input.userId,
        threadId: input.threadId,
      });
    if (injectionScreen.block) {
      yield {
        type: 'error',
        code: 'BLOCKED',
        message: "I'm not able to help with that.",
      };
      return;
    }

    // 3. Screen the message for jailbreak / prompt injection before delegating
    //    to the agent. Fails open so a classifier outage never blocks users.
    const guardResult = eventOnly
      ? { safe: true }
      : await guardMessage(input.content, {
        tenantId: input.tenantId,
        agentId: input.agentId,
        threadId: input.threadId,
      });
    if (!guardResult.safe) {
      yield {
        type: 'error',
        code: 'BLOCKED',
        message: "I'm not able to help with that.",
      };
      return;
    }

    // 4. Load prior turns to determine title-generation window.
    const tenantRuntimeClient = new TenantRuntimeClient();

    const historyResult = await chatRepo.listMessages(input.threadId, input.tenantId, {
      limit: MAX_HISTORY_MESSAGES,
    });
    // Status rows are written by us, not said by the agent. Feeding them back
    // would have the model read "Waiting on Ada Lovelace to approve" as its own
    // prior turn and answer accordingly.
    const historyUnfiltered = [...historyResult.messages].reverse();
    const historyOldestFirst = historyUnfiltered.filter(isConversationRow);
    const priorTurns = historyOldestFirst.slice(0, -1);

    // Did the exchange IMMEDIATELY BEFORE this message end in a run that
    // stopped without an answer?
    //
    // Read from the UNFILTERED history on purpose: `run_failed` is narration,
    // so `isConversationRow` excludes it from everything built from the
    // conversation — which is right, and is also why the model could see its
    // own "the sweep is starting now" and not the error that followed one
    // second later. On the next turn it produced a detailed, confident,
    // entirely fictional progress report and refused the retry.
    //
    // Scoped to that one exchange rather than "the most recent failure": the
    // most recent failure stays the most recent one forever, so a run that
    // succeeded three turns later would still be introduced as a failure. The
    // note describes the LAST EXCHANGE, not the last failure.
    const precedingExchangeFailed = (() => {
      const personRows: number[] = [];
      historyUnfiltered.forEach((m, i) => { if (m.role === 'user') personRows.push(i); });
      if (personRows.length === 0) return false;
      // The last person row is the message being answered now; the one before
      // it opens the exchange that just ended.
      const current = personRows[personRows.length - 1];
      const previous = personRows.length > 1 ? personRows[personRows.length - 2] : -1;
      return historyUnfiltered
        .slice(previous + 1, current)
        .some((m) => m.messageType === RUN_FAILED_MESSAGE_TYPE);
    })();

    // 4b. Is this message the answer to a routine the team member offered?
    //
    // Handled entirely here when it is: accepting appends the routine to the
    // team member's guidance and redistills, which is a platform operation, not
    // something to ask the model to do. The turn then completes without ever
    // reaching the runtime — the same shape the hybrid engine already uses for
    // clarification answers.
    //
    // Anything ambiguous falls through to a normal turn, so a misread costs
    // nothing.
    const suggestionOutcome = eventOnly
      ? { handled: false as const, reply: null }
      : await handlePossibleSuggestionReply({
        tenantId: input.tenantId,
        agentId: input.agentId,
        threadId: input.threadId,
        content: input.content,
      });
    if (suggestionOutcome.handled && suggestionOutcome.reply) {
      const acceptedMsg = await chatRepo.getAssistantMessageByTurnId(input.tenantId, turnId);
      if (acceptedMsg) {
        yield { type: 'complete', message: acceptedMsg };
      } else {
        yield { type: 'text_delta', text: suggestionOutcome.reply };
        const persisted = await chatRepo.appendMessage(
          input.tenantId,
          input.threadId,
          'assistant',
          suggestionOutcome.reply,
          input.agentId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          turnId,
        );
        yield { type: 'complete', message: persisted };
      }
      return;
    }

    // 5. Resolve effective autonomy: per-agent override → workspace default.
    const oversightSettings = await oversightService.getOrCreateOversightSettings(input.tenantId);
    const effectiveAutonomy: AutonomyLevel = agent.autonomy_override ?? oversightSettings.autonomy;

    // Resolve model pricing from PB's canonical table and pass to TR so TR
    // never needs its own pricing data. Fallback default tracks the large-tier
    // model; keep TR's DEFAULT_MODEL bumped to match (Opus 5 == Opus 4.8
    // pricing, so a lag here is cost-neutral).
    const resolvedModelId = agent.model_config?.modelId ?? 'claude-opus-5';
    const agentPricing = MODEL_PRICING[resolvedModelId];

    // The vision decision is made HERE, not in the runtime, for the same reason
    // pricing is: this is the process that knows which model the agent runs on,
    // and it is the only one with the capability registry. What the model can
    // see travels as refs; what it cannot is named in the prompt in words.
    // Short-circuited when there is no media, so a turn without a picture never
    // touches the capability registry.
    // Team chat runs in the tenant runtime, so the ENGINE half of the gate is
    // that runtime's adapter rather than a provider in this process. Only
    // Gemini's adapter can express a video; every other engine either carries
    // an image block or takes a text prompt. `chatProviderKind` is the same
    // value the runtime resolves the adapter from.
    const { readable: readableMedia, described: describedMedia } = sentMedia.length > 0
      ? partitionMediaForModel(
          sentMedia,
          await sendableModalities(
            resolvedModelId,
            // Defaulted alongside resolvedModelId and to the same family:
            // `provider` is admin-authored and usually absent, and the engine a
            // team chat falls back to is the Claude Agent SDK. Leaving it
            // undefined would make the intersection empty and silently stop
            // sending IMAGES, which is a working feature.
            agent.model_config?.provider ?? 'anthropic',
          ),
        )
      : { readable: [], described: [] };
    // Same exposure record the other two surfaces write. It fires on the REFS
    // here rather than on fetched bytes, because on this path the runtime does
    // the fetching — the fact being recorded is that unscreened pictures were
    // put in front of a model, and that is decided here.
    noteUnscreenedMediaExposure({
      tenantId: input.tenantId,
      surface: 'agent_chat',
      threadId: input.threadId,
      imageCount: readableMedia.length,
    });

    // 6. SDK path: delegate to Tenant Runtime SDK engine
    let eventsEmitted = false;
    let accumulatedText = '';
    let sessionResumed = false;

    const invocationId = input.invocationId ?? crypto.randomUUID();
    let currentSessionId = await getSessionId(input.threadId, input.agentId);
    if (currentSessionId) sessionResumed = true;

    // R5 TE-R5-011: if the incoming chat turn is an explicit HITL resume
    // (approvalId present on input), propagate the resume contract to TR.
    const isResume = Boolean((input as { approvalId?: string }).approvalId);
    const approvalId = (input as { approvalId?: string }).approvalId;

    // TR sessions can expire before our 7-day DB TTL. If TR rejects a
    // resumeSessionId as unknown, delete the stale row and retry once
    // without it so the user gets a normal response rather than an error.
    let retried = false;
    // Every word the person reads passes the output guard first: a paragraph
    // streams once it has been scrubbed and read (common/guarded-stream.ts),
    // and what is persisted is what streamed. A team's tools are the
    // runtime's to know, so the names it calls are collected as it calls
    // them, and the scrub removes those from everything read after.
    const outputGuardContext = { tenantId: input.tenantId, speaker: input.agentId, threadId: input.threadId };
    const calledToolNames: string[] = [];
    try {
      while (true) {
        let staleSession = false;
        let earlyExit = false;
        const shown: string[] = [];
        const guardedOutput = new GuardedOutput(outputGuardContext, {
          toolNames: calledToolNames,
          onText: (text) => shown.push(text),
        });
        /** Hand what the guard has released to the person, in order. */
        const drainShown = function* (): Generator<AgentChatEvent> {
          while (shown.length > 0) {
            const text = shown.shift()!;
            accumulatedText += text;
            yield { type: 'text_delta', text };
          }
        };
        /** The end of a message, or anything that reads the accumulator: the
         *  paragraph in flight is read now and reaches the person first. */
        const settleShown = async function* (): AsyncGenerator<AgentChatEvent> {
          await guardedOutput.flush();
          yield* drainShown();
        };

        // Rolling summary of the turns older than the recent window. It has
        // been regenerated after every qualifying turn since the feature
        // landed and read by nothing but its own summarizer — the thread got
        // a summary that never reached the model, and the LLM call to build
        // it was billed as platform overhead regardless. Reading it here is
        // what makes that spend buy something.
        //
        // Best-effort on purpose: a summary read that fails must not fail the
        // turn, and short threads legitimately have none.
        let conversationSummary: string | undefined;
        try {
          const summary = (await chatRepo.getThreadRollingSummary(
            input.threadId,
            input.tenantId,
          )) as ConversationSummary | null;
          if (summary) {
            // Budgeted here, not left to the generator's output cap. The
            // runtime rejects an over-long summary at its request schema, so an
            // unbounded value would turn a long thread into a failed turn
            // rather than a slightly shorter summary. Relying on
            // SUMMARY_MAX_TOKENS staying small would make that a constant in a
            // third module silently deciding whether chat works.
            //
            // Same budget the insights surface applies to the same artifact,
            // and the same truncate-from-the-front helper: the tail of a
            // rolling summary is its most recent state.
            conversationSummary = truncateToTokenBudget(
              formatSummaryForPrompt(summary),
              ROLLING_SUMMARY_PROMPT_TOKEN_BUDGET,
            );
          }
        } catch (err) {
          log.warn(
            { err, threadId: input.threadId },
            'agent-chat: rolling summary read failed; continuing without it',
          );
        }

        // The one fact the model cannot otherwise learn: the run it announced
        // last turn stopped without producing anything.
        //
        // Carried HERE because `conversationSummary` is the control plane's
        // model-context seam — the request field the runtime turns into model
        // context. Putting it in the history instead would make it words the
        // team appears to have said, in summaries, absorption, embeddings,
        // recall and the reply clock; it is a fact about the conversation, not
        // a turn in it.
        //
        // Appended after the budget, then re-budgeted: `truncateToTokenBudget`
        // trims from the FRONT, because the tail of a rolling summary is its
        // most recent state — so the note survives on a thread whose summary
        // is already at the cap.
        if (precedingExchangeFailed) {
          conversationSummary = truncateToTokenBudget(
            conversationSummary
              ? `${conversationSummary}\n\n${RUN_FAILED_SUMMARY_NOTE}`
              : RUN_FAILED_SUMMARY_NOTE,
            ROLLING_SUMMARY_PROMPT_TOKEN_BUDGET,
          );
        }

        // The Browser section the runtime renders names the driver by the
        // name this service holds for them. Read only when a session is
        // taken over; one call, and a failure costs the name alone.
        const browserDriverName = await browserDriverNameForThread(input.tenantId, input.threadId);

        for await (const event of tenantRuntimeClient.runChatTurnStream(input.tenantId, {
          agentId: input.agentId,
          threadId: input.threadId,
          invocationId,
          // The model reads the forwarded background in front of the message;
          // the thread stores the two apart. Composed here rather than by the
          // caller so the persisted user row is the person's words even if this
          // join ever changes.
          // Attachment bodies and the notices about unshowable media go in
          // front of what the person typed, on the same rule every other
          // surface follows: a budget truncates the current message from its
          // start, so an overflow costs document body rather than the question.
          userMessage: composeTurnText(
            withForwardedContext(input.content, input.forwardedContext ?? null),
            attachments,
            { describedMedia: describedMedia },
          ),
          // Refs only, never bytes. The runtime fetches each object through the
          // control plane's service-auth content route; putting base64 on this
          // request would put a 20 MB body on a path sized for a chat turn.
          ...(readableMedia.length > 0 ? { media: readableMedia } : {}),
          channelHint: input.channelHint ?? 'web',
          userId: input.userId,
          userDisplayName: input.userDisplayName,
          userRole: input.userRole || 'member',
          tenantName: input.tenantName,
          resumeSessionId: currentSessionId,
          turnId,
          ...(input.senderAccountId ? { senderAccountId: input.senderAccountId } : {}),
          ...(input.impersonatedBy ? { impersonatedBy: input.impersonatedBy } : {}),
          autonomy: effectiveAutonomy,
          ...(agentPricing ? {
            modelPriceInputPerMillion: agentPricing.input,
            modelPriceOutputPerMillion: agentPricing.output,
          } : {}),
          ...(isResume && approvalId ? { resume: true as const, approvalId } : {}),
          ...(input.traceMode === true ? { traceMode: true } : {}),
          ...(conversationSummary ? { conversationSummary } : {}),
          // The person's browser event, verified by the router: the runtime
          // reads the hold and, when the person sent no words, writes the
          // turn's text itself.
          ...(input.browserEvent?.kind === 'handback' ? { browserHandback: { holdId: input.browserEvent.holdId } } : {}),
          ...(browserDriverName ? { browserDriverName } : {}),
        })) {
          switch (event.type) {
            case 'thinking':
              // Already yielded thinking at the top of the function
              break;
            case 'text_delta':
              eventsEmitted = true;
              guardedOutput.feed(event.text);
              yield* drainShown();
              break;
            case 'text_break':
              yield* settleShown();
              // The end of one assistant message inside a multi-message turn.
              // It carries no text of its own, which is exactly why it has to
              // be written INTO the reply and not only streamed.
              //
              // This used to be structure only, on the reasoning that the
              // boundary is a rendering concern for the live stream. It is
              // not: `accumulatedText` is what gets persisted, and the stored
              // row is what a reload, a /share link, and every other
              // participant on the thread read. Dropping the break made the
              // paragraphs correct for exactly as long as nobody refreshed,
              // and stored replies came out with two messages run together
              // ("...across the repos.Now let me search for merged PRs...").
              //
              // The runtime emits one of these after EVERY assistant message,
              // the last one included, so the break is only written when there
              // is text in front of it and the trailing one is trimmed off at
              // persistence. The separator is sized to what the text already
              // ends with, so a model that closed with its own newline does
              // not open a gap of four.
              // How big the gap is, is decided in one place for all three
              // assistants (common/assistant-message-boundary.ts). The next
              // message has not arrived yet, so it is sized from what the text
              // already ends with.
              accumulatedText += assistantMessageGap(accumulatedText);
              yield { type: 'text_break' };
              break;
            case 'workflow_step':
              eventsEmitted = true;
              yield {
                type: 'workflow_step', stepId: event.stepId, index: event.index, total: event.total,
              };
              break;
            case 'tool_call':
              eventsEmitted = true;
              if (!calledToolNames.includes(event.tool)) calledToolNames.push(event.tool);
              // Forward the richer trace fields when present; default
              // (frontend) calls only ever see the tool name. The
              // AgentChatEvent union accepts the optional fields.
              yield {
                type: 'tool_call',
                tool: event.tool,
                ...(event.callId !== undefined ? { callId: event.callId } : {}),
                ...(event.args !== undefined ? { args: event.args } : {}),
              };
              break;
            // ── Trace-mode-only relays. Only fire when the caller
            //    passed traceMode: true; TR's chat-turn-handler emits
            //    these only in that mode. Forwarded verbatim to the
            //    consumer of runAgentChatTurn (the harness endpoint).
            case 'catalog':
              yield { type: 'catalog', exposedToolNames: event.exposedToolNames };
              break;
            case 'tool_call_finished':
              yield {
                type: 'tool_call_finished',
                callId: event.callId,
                result: event.result,
                ...(event.error ? { error: event.error } : {}),
              };
              break;
            case 'usage':
              yield {
                type: 'usage',
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                ...(event.cachedTokens !== undefined ? { cachedTokens: event.cachedTokens } : {}),
              };
              break;
            case 'hitl_required': {
              eventsEmitted = true;
              // Say who was asked. Without this the chat tells whoever
              // triggered the gate that it is "waiting on your review", which
              // is wrong whenever the request routed to somebody else — and
              // leaves everyone else in a shared thread staring at a stall
              // with no explanation.
              // The gate's level decides who may approve it, and the upstream
              // chat event does not carry it — so read it off the approval we
              // already have the id for. One call per gate, and gates are rare.
              // Falls back to 2 rather than failing: the wrong wording is
              // survivable, a broken turn is not.
              let hitlLevel: 1 | 2 = 2;
              try {
                const approval = await tenantRuntimeClient.getApproval(
                  input.tenantId, event.approvalId,
                );
                if (approval?.hitlLevel === 1) hitlLevel = 1;
              } catch {
                // Keep the default.
              }
              const routed = await describeApprovalRoute(
                input.tenantId, input.agentId, hitlLevel,
              );
              // Keep what the team SAID before the gate stopped it.
              //
              // The insert that persists a reply used to exist only on the
              // `complete` branch, so a turn that wrote two paragraphs and then
              // asked for an approval threw both away: the person watched the
              // text arrive, reloaded, and found their question answered by a
              // status line and nothing else. The resume does not bring it back
              // either, since the continuation the settle callback posts is only
              // what the team says AFTER the decision.
              //
              // Written FIRST, so the transcript reads in the order it happened:
              // what was said, then the stall. Keyed by turnId like the
              // completed reply, which is what makes it idempotent against the
              // runtime's settle-turn backstop writing the same partial.
              yield* settleShown();
              const pregateText = accumulatedText.trim();
              if (pregateText) {
                try {
                  await chatRepo.appendMessage(
                    input.tenantId,
                    input.threadId,
                    'assistant',
                    pregateText,
                    input.agentId,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    turnId,
                    undefined,
                    undefined,
                    // A reply that stopped for a gate is attributed like one
                    // that finished: the runtime says who it handed work to
                    // on this frame too, from the same durable record.
                    await resolveContributors(input.tenantId, event.delegatedTo ?? []),
                  );
                } catch (err) {
                  // 23505 is the settle callback having already stored it, which
                  // is a success. Anything else is logged and dropped: a partial
                  // that could not be kept must not fail a turn that is only
                  // pausing.
                  if ((err as { code?: string }).code !== '23505') {
                    log.warn('could not persist the reply written before the gate', {
                      tenantId: input.tenantId, threadId: input.threadId,
                      error: (err as Error).message,
                    });
                  }
                }
              }
              // Post the stall into the thread itself. The SSE event below only
              // reaches this one client, so without a persisted message everyone
              // else sees the conversation stop with no explanation, and even
              // this reader loses it on reload. Best-effort: a gate that stopped
              // the turn is not worth failing the turn over.
              try {
                await chatRepo.appendMessage(
                  input.tenantId,
                  input.threadId,
                  'assistant',
                  waitingMessage(routed),
                  input.agentId,
                  null, 0, 0,
                  HITL_STATUS_MESSAGE_TYPE,
                );
              } catch (err) {
                log.warn('could not post hitl waiting message', {
                  tenantId: input.tenantId, threadId: input.threadId,
                  error: (err as Error).message,
                });
              }
              yield {
                type: 'hitl_required', approvalId: event.approvalId, reason: event.reason,
                action: event.action ?? null, why: event.why ?? null, detail: event.detail ?? null,
                routedTo: routed.names,
                routedToAccountIds: routed.accountIds,
                routedToAdmins: routed.toAdmins,
                unassigned: routed.unassigned,
                hitlLevel,
              };
              // Terminal. TR writes exactly ONE frame for a pause and then
              // closes the stream, so anything after this is the loop running
              // out of events — which the exit below reports as a provider
              // error. See the `awaiting_input` case for the full account.
              return;
            }
            case 'run_parked': {
              eventsEmitted = true;
              // The run outgrew this turn. It is not finished and it has not
              // failed: it is continuing on its own and will deliver into this
              // thread when it lands.
              //
              // Written keyed by the TURN so the runtime's settle callback and
              // this path cannot both leave a notice. Whichever arrives second
              // hits the one-assistant-row-per-turn index and is discarded,
              // which is the same race the reply path already resolves this
              // way. The row is the durable half: the runtime settles it too,
              // because by the time a run outgrows a ten-minute turn the tab
              // is usually gone.
              try {
                await chatRepo.appendMessage(
                  input.tenantId,
                  input.threadId,
                  'assistant',
                  event.detail,
                  input.agentId,
                  undefined,
                  undefined,
                  undefined,
                  RUN_PROGRESS_MESSAGE_TYPE,
                  undefined,
                  undefined,
                  turnId,
                );
              } catch (err) {
                if ((err as { code?: string }).code !== '23505') {
                  log.warn(
                    { tenantId: input.tenantId, threadId: input.threadId, error: (err as Error).message },
                    'run-parked notice could not be persisted (the run continues regardless)',
                  );
                }
              }
              // Yielded before the terminal frame so the wrapper can see that
              // this run PARKED rather than finished. Without it the wrapper
              // reads the `complete` below as an ending and writes "this run
              // took twelve minutes" over a run that is still working.
              yield { type: 'run_parked', reason: event.reason, detail: event.detail };
              // Terminal for this turn. The client stops streaming and refetches;
              // the answer arrives later as its own row.
              yield { type: 'complete', message: null };
              return;
            }
            case 'host_delivered': {
              // Relayed, not persisted. These values were lifted off a tool
              // result so the model would never hold them; writing them into
              // the transcript would put them back in the context the lift
              // removed them from, on the next turn that reads history.
              //
              // The consequence is deliberate and worth naming: they reach this
              // client, on this turn, once. A reload does not bring them back —
              // which is the correct trade for a signed link or a one-time
              // token, and the reason the surface renders them beside the tool
              // call rather than as a message.
              //
              // `eventsEmitted` is NOT set: this is not the agent doing
              // something, and a turn whose only output was a delivered field
              // should still read as a turn that said nothing.
              yield { type: 'host_delivered', tool: event.tool, fields: event.fields };
              break;
            }
            case 'delegation_started': {
              eventsEmitted = true;
              // Attribution on hand-over: name the team receiving the work
              // while it works, and put its chip on the live reply. The
              // parent narrates the outcome itself, so the reply is its own;
              // what persists is the list of who it handed work to, resolved
              // on the complete frame from the same ids by the same lookup.
              const [contributor] = await resolveContributors(input.tenantId, [event.agentId]);
              if (!contributor) {
                log.warn('delegation_started names a team that does not resolve; frame skipped', {
                  tenantId: input.tenantId, threadId: input.threadId, runtimeAgentId: event.agentId,
                });
                break;
              }
              yield {
                type: 'delegation_started',
                author: contributor.id,
                authorLabel: contributor.label,
              };
              break;
            }
            case 'delegation_paused': {
              eventsEmitted = true;
              const delegateName = await resolveDelegateName(input.tenantId, event.agentId);
              // Post the stall into the thread itself, like the agent's own
              // gate does above: the SSE event reaches only this client, and
              // even this reader loses it on reload. Third person, no reader
              // addressed — the row is read by everyone in the thread.
              //
              // DELEGATION_STATUS, not HITL_STATUS: this row carries an
              // affordance (the way to the review queue) that the team's own
              // gate rows must not, and the client keys that on the type
              // rather than on the sentence's wording.
              try {
                await chatRepo.appendMessage(
                  input.tenantId,
                  input.threadId,
                  'assistant',
                  delegatedWaitingMessage(delegateName),
                  input.agentId,
                  null, 0, 0,
                  DELEGATION_STATUS_MESSAGE_TYPE,
                );
              } catch (err) {
                log.warn('could not post delegation-paused status message', {
                  tenantId: input.tenantId, threadId: input.threadId,
                  error: (err as Error).message,
                });
              }
              yield {
                type: 'delegation_paused',
                agentName: delegateName,
                approvalId: event.approvalId,
                reason: event.reason,
              };
              break;
            }
            case 'awaiting_input': {
              eventsEmitted = true;
              // Stopping to ask the person a question is a SUCCESSFUL end to a
              // turn, and TR writes it as one terminal frame and closes the
              // stream. Falling through to the loop's exit read that clean close
              // as "stream ended without complete event" and put a provider
              // error on screen over a turn where nothing had failed — while the
              // question itself, persisted only on the `complete` branch below,
              // was dropped. The person was told to try again, and the thing
              // they were being asked did not survive the refetch that the error
              // triggered. Both halves of that are fixed here.
              //
              // Keep what the team said before it stopped, keyed by turnId so
              // the runtime's settle-turn backstop writing the same partial is a
              // no-op rather than a duplicate — the same shape, and the same
              // reason, as the hitl gate above.
              yield* settleShown();
              const prePauseText = accumulatedText.trim();
              // Who the turn handed work to before it stopped to ask. On the
              // partial when there is one; on the question itself when the
              // team asked before saying anything else, so a turn that brought
              // a teammate in and then asked is never attributed to nobody.
              const pauseContributors = await resolveContributors(input.tenantId, event.delegatedTo ?? []);
              if (prePauseText) {
                try {
                  await chatRepo.appendMessage(
                    input.tenantId,
                    input.threadId,
                    'assistant',
                    prePauseText,
                    input.agentId,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    turnId,
                    undefined,
                    undefined,
                    pauseContributors,
                  );
                } catch (err) {
                  // 23505 is the settle callback having already stored it, which
                  // is a success. Anything else is logged and dropped: a partial
                  // that could not be kept must not fail a turn that is only
                  // pausing.
                  if ((err as { code?: string }).code !== '23505') {
                    log.warn('could not persist the reply written before the question', {
                      tenantId: input.tenantId, threadId: input.threadId,
                      error: (err as Error).message,
                    });
                  }
                }
              }
              // The question as ordinary agent speech, not a status row: it is
              // what the team actually said, every later turn should see it in
              // history, and everyone else in a shared thread needs to know what
              // the conversation is waiting on. Deliberately NOT keyed by
              // turnId — that key belongs to the partial above, and losing the
              // race for it would silently drop the question, which is the whole
              // defect this branch exists to close.
              try {
                await chatRepo.appendMessage(
                  input.tenantId,
                  input.threadId,
                  'assistant',
                  event.question,
                  input.agentId,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  prePauseText ? [] : pauseContributors,
                );
              } catch (err) {
                log.warn('could not persist the question the team paused on', {
                  tenantId: input.tenantId, threadId: input.threadId,
                  error: (err as Error).message,
                });
              }
              // NOT upsertChatSession: `sessionId` here is the clarification
              // session the answer routes back to, not the SDK session the next
              // turn resumes from. Writing it into agent_chat_sessions would
              // hand the next turn an id the engine has never seen.
              yield { type: 'awaiting_input', question: event.question, sessionId: event.sessionId };
              return;
            }
            case 'interrupt_delivered': {
              // The user message was folded into the thread's in-flight run as
              // a signal. Nothing to persist: the user message was stored
              // before the TR call and this turn produces no assistant reply.
              yield { type: 'interrupt_delivered' };
              return;
            }
            case 'clarification_accepted': {
              yield { type: 'clarification_accepted' };
              return;
            }
            case 'stop_acknowledged': {
              yield { type: 'stop_acknowledged' };
              return;
            }
            case 'complete': {
              // Store session (strip sessionId from client-facing events).
              await upsertChatSession(input.threadId, input.agentId, event.sessionId);

              // Extract and strip citations block from accumulated text.
              let citations: Citation[] | undefined;
              // Trimmed because the runtime closes the last assistant message
              // with a text_break like every other one, so the accumulator
              // ends on the separator that boundary wrote. The pre-gate and
              // pre-pause writes below already trim for the same reason.
              yield* settleShown();
              // A turn that streamed nothing is read whole, the way the
              // streamed one was read paragraph by paragraph.
              const finalText = (
                accumulatedText
                || await guardWholeText(event.outputText, outputGuardContext, { toolNames: calledToolNames })
              ).trim();
              let cleanedText = finalText;
              const citationBlocks = [...finalText.matchAll(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/g)];
              if (citationBlocks.length > 0) {
                citations = citationBlocks.flatMap((m) => {
                  try {
                    return JSON.parse(m[1].trim()) as Citation[];
                  } catch {
                    return [];
                  }
                });
                if (citations.length === 0) citations = undefined;
                cleanedText = finalText
                  .replace(/<CITATIONS>[\s\S]*?<\/CITATIONS>/g, '')
                  .trim();
              }

              // Stopped before it said anything: there is no reply, and none
              // is invented. Writing a marker here would put words in the
              // agent's mouth - the transcript would show it saying
              // "(stopped)", which reads as an answer rather than as the
              // absence of one. The turn is still terminal, so the composer
              // stops streaming and the thread refetches; the frame simply
              // carries no message.
              if (event.stopped && !cleanedText.trim()) {
                log.info(
                  { tenantId: input.tenantId, agentId: input.agentId, threadId: input.threadId },
                  'chat turn stopped before any output - nothing persisted',
                );
                yield { type: 'complete', message: null };
                return;
              }

              // A run that ENDED by handing the work to a person says so, and
              // until now it did not.
              //
              // The runtime appends its own handoff sentence to the reply it
              // persists and sends that as `outputText`. This function reads
              // `outputText` only when the turn streamed nothing at all
              // (`accumulatedText || event.outputText` above), so on every turn
              // that spoke while it worked — which is most of them — the
              // sentence was dropped and the thread showed a composed, confident
              // reply with no sign the run had escalated.
              //
              // Dev thread ed29c17a: four consecutive escalated turns, the
              // sentence present in all four of the runtime's own rows and
              // absent from all four the person read. They retried three times
              // into what looked like a stubborn refusal.
              //
              // Appended here rather than by preferring `outputText`, because
              // the accumulator is the better body: it carries the text_break
              // separators this function writes between messages, which
              // `outputText` does not.
              // The hand-off, when a person actually received one; otherwise
              // the statement that the run did not finish. Both are APPENDED,
              // never substituted for the body: the reply is the thing most
              // likely to be wrong on a run that ended this way, so replacing
              // it would hide the prose while leaving the person no better
              // informed, and omitting the line is what let a confident false
              // answer stand alone.
              const terminalNote = event.escalated
                ? HANDED_TO_A_PERSON
                : event.didNotFinish
                  ? RUN_DID_NOT_FINISH
                  : null;
              cleanedText = terminalNote
                ? (cleanedText ? `${cleanedText}\n\n${terminalNote}` : terminalNote)
                : cleanedText;

              // A reply that says a file is attached is held against the cards
              // this turn actually appended, here, on the text about to be
              // persisted — so the line survives the
              // `accumulatedText || outputText` choice above and reaches every
              // surface that reads the row. The finding is logged below, once
              // the row has landed.
              const attachmentClaim = await checkAttachmentClaim({
                tenantId: input.tenantId,
                threadId: input.threadId,
                turnId,
                text: cleanedText,
              });
              cleanedText = attachmentClaim.text;

              // Who the turn handed work to, from the runtime's durable record
              // of the delegations that actually ran — the same record every
              // other writer of this turn's speech reads, so a closed tab, a
              // pause and a finished reply all say the same thing. A live
              // delegation_started frame for a call a human gate then refused
              // is deliberately NOT here: that teammate never ran.
              const contributors = await resolveContributors(input.tenantId, event.delegatedTo ?? []);

              // Persist message with token counts. The tenant-runtime settle
              // callback can race this insert (both are keyed by turnId under
              // the acm_assistant_turn_uniq index); when it wins, read its row
              // instead of failing the stream after the reply was persisted.
              let savedMsg: AgentChatMessage;
              try {
                savedMsg = await chatRepo.appendMessage(
                  input.tenantId,
                  input.threadId,
                  'assistant',
                  cleanedText,
                  input.agentId,
                  undefined,
                  event.inputTokens,
                  event.outputTokens,
                  undefined,
                  undefined,
                  citations,
                  turnId,
                  undefined,
                  undefined,
                  contributors,
                );
                recordAttachmentClaimFinding(attachmentClaim.finding, {
                  tenantId: input.tenantId,
                  threadId: input.threadId,
                  turnId,
                  invocationId,
                });
                // The reply is committed. Tell the person if they are not
                // looking at it. Fire and forget: a notification must never
                // delay the stream that is still writing to them, and this
                // swallows its own failures.
                void notifyReplyPersisted({
                  tenantId: input.tenantId,
                  threadId: input.threadId,
                  agentId: input.agentId,
                  text: cleanedText,
                });
              } catch (persistErr) {
                if ((persistErr as { code?: string }).code !== '23505') throw persistErr;
                const existing = await chatRepo.getAssistantMessageByTurnId(input.tenantId, turnId);
                if (!existing) throw persistErr;
                savedMsg = existing;
              }

              // v2 semantic recall: BEST-EFFORT inline embed (see
              // turn-embedding-service.ts header — the recurring sweeper is
              // the durable path). fireAndForget logs rejections; guests
              // are skipped inside embedTurn too.
              if (process.env.RECALL_EMBED_WRITE_ENABLED === 'true' && input.senderAccountId) {
                fireAndForget(
                  embedTurn(input.tenantId, turnId).then(() => undefined),
                  'turn-embedding',
                );
              }

              // Audit log
              logAudit(
                'agent_chat.chat_turn',
                { tenantId: input.tenantId, userId: input.userId },
                {
                  threadId: input.threadId,
                  agentId: input.agentId,
                  executionMode: 'sdk',
                  sdkFallback: false,
                  sessionResumed,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  userMessageLength: input.content.length,
                  assistantMessageLength: cleanedText.length,
                  isPaused: agent.status === 'paused',
                },
              );

              // Fire-and-forget: maybe refresh the rolling summary.
              fireAndForget(
                maybeRefreshRollingSummary(input.threadId, input.tenantId, input.agentId),
                'agent-chat maybeRefreshRollingSummary',
              );

              // AI title generation on the first few turns. AWAITED (not
              // fire-and-forget) because Cloud Run may scale the container
              // to zero once the Slack webhook worker finishes, killing
              // any detached promises mid-flight — that's why Slack-
              // originated threads were coming out untitled. Safe to await
              // because maybeGenerateThreadTitle catches all errors
              // internally. Pass agentId so the cost lands in the agent's
              // interactions bucket.
              if (priorTurns.length <= 4) {
                await maybeGenerateThreadTitle({
                  threadId: input.threadId,
                  tenantId: input.tenantId,
                  agentId: input.agentId,
                  userMessage: input.content,
                  assistantMessage: cleanedText,
                  updateTitle: updateThreadTitleInternal,
                });
              }

              // P1.2: did this exchange teach something durable?
              //
              // AWAITED, for the same reason the title generation above is:
              // Cloud Run can scale the container to zero the moment the
              // Slack/Teams worker request finishes, killing detached
              // promises. A learning that only sometimes persists is worse
              // than one that never does.
              //
              // The regex gate is free and rejects almost every turn, so the
              // ordinary path pays nothing at all.
              // A change to what the team IS was handed to the Chief AI
              // Officer during this turn (propose_change); the same sentence
              // must not also be filed as a technique or a preference.
              if (
                input.content
                && looksLikeTeaching(input.content)
                && !(await designChangeJustRegistered(input.tenantId, input.agentId, input.threadId))
              ) {
                try {
                  const classification = await classifyLesson({
                    tenantId: input.tenantId,
                    agentId: input.agentId,
                    userMessage: input.content,
                    assistantMessage: cleanedText,
                  });
                  if (classification.kind !== 'none') {
                    const outcome = await applyLesson({
                      tenantId: input.tenantId,
                      agentId: input.agentId,
                      classification,
                    });
                    if (outcome.confirmation) {
                      // A separate assistant row rather than an edit of the
                      // reply: the reply is already persisted and already on
                      // the wire, and rewriting it would break the turn-keyed
                      // uniqueness the settle path depends on.
                      await chatRepo.appendMessage(
                        input.tenantId,
                        input.threadId,
                        'assistant',
                        outcome.confirmation,
                        input.agentId,
                        undefined,
                        undefined,
                        undefined,
                        LEARNING_CONFIRMATION_MESSAGE_TYPE,
                      );
                      // The transcript row is delivery for web, but Slack and
                      // Teams stream one turn reply and stop listening — so
                      // without this push the person is told nothing about what
                      // was just learned from them.
                      await pushOutOfTurnMessage({
                        tenantId: input.tenantId,
                        threadId: input.threadId,
                        agentId: input.agentId,
                        text: outcome.confirmation,
                      });
                    }
                    if (outcome.kind === 'routine' && outcome.routineProse) {
                      await proposeRoutineFromChat({
                        tenantId: input.tenantId,
                        agentId: input.agentId,
                        threadId: input.threadId,
                        routineProse: outcome.routineProse,
                      });
                    }
                  }
                } catch (learnErr) {
                  log.warn(
                    { tenantId: input.tenantId, agentId: input.agentId, error: (learnErr as Error).message },
                    'chat-learning: post-turn learning failed (turn unaffected)',
                  );
                }
              }

              yield { type: 'complete', message: savedMsg };
              return;
            }
            case 'error': {
              if (!retried && currentSessionId && event.message?.includes('No conversation found with session ID')) {
                staleSession = true;
              } else {
                eventsEmitted = true;
                // What the team said before it failed reaches the person
                // before the error does.
                yield* settleShown();
                // Log the raw TR error for operators, but show the user a
                // generic copy — vendor SDK internals (cli.js paths,
                // pathToClaudeCodeExecutable hints, ENOENT stacks, etc.)
                // are never meaningful to a chat user and leak the
                // implementation. Same posture as the "stream ended without
                // complete event" branch below.
                log.error(
                  {
                    tenantId: input.tenantId,
                    agentId: input.agentId,
                    threadId: input.threadId,
                    code: event.code,
                    error: event.message,
                  },
                  'TR chat-turn yielded error event',
                );
                // A turn refused because the team is mid-run is not a failure of
                // this turn, and the generic copy actively misleads: nothing went
                // wrong and retrying immediately fails the same way. Name the
                // real condition so the person knows what to do with it.
                const isBusy = event.message?.includes('agent_already_running') === true;
                yield isBusy
                  ? {
                    type: 'error',
                    code: 'AGENT_BUSY' as AgentChatErrorCode,
                    message: 'This team is still working on an earlier request. Your message was not lost. Send it again once the current run finishes.',
                  }
                  : {
                    type: 'error',
                    code: 'PROVIDER_ERROR' as AgentChatErrorCode,
                    // When the runtime classified the failure it also wrote the
                    // sentence for it, and that sentence distinguishes cases this
                    // one cannot: "busy, try shortly" (rate limit) reads nothing
                    // like "rephrase that" (validation) or "break it into smaller
                    // steps" (timeout). Collapsing all of them into one generic
                    // line told the person nothing they could act on.
                    //
                    // The fallback stays for the rollout window, where an older
                    // runtime revision yields no failureClass and `event.message`
                    // is still a raw engine string that must not be shown.
                    message: event.failureClass
                      ? event.message
                      : 'Something went wrong on our end while running this turn. Please try again.',
                    // Relayed verbatim from the runtime, which owns the
                    // taxonomy. BOTH values, not just a true: an explicit
                    // `false` is the runtime saying a retry cannot work, and
                    // dropping it left the status row inviting one. A
                    // validation failure was told "Trying again is safe" and
                    // the person retried 25 seconds later.
                    ...(typeof event.retryable === 'boolean' ? { retryable: event.retryable } : {}),
                    ...(event.failureClass ? { failureClass: event.failureClass } : {}),
                  };
                earlyExit = true;
              }
              break;
            }
          }
          if (staleSession || earlyExit) break;
        }
        yield* settleShown();

        if (earlyExit) return;

        if (staleSession) {
          log.info(
            { tenantId: input.tenantId, agentId: input.agentId, sessionId: currentSessionId },
            'TR rejected stale session ID — retrying without session',
          );
          await deleteStaleSession(input.threadId, input.agentId);
          currentSessionId = undefined;
          sessionResumed = false;
          retried = true;
          accumulatedText = '';
          eventsEmitted = false;
          continue;
        }

        // A STREAM ENDING IS NOT A RUN ENDING.
        //
        // The runtime does not stop when this connection does — ADR-041 is
        // explicit that a client disconnect leaves the turn running, and the
        // engine is cancelled only by the durable abort row. So a stream that
        // ends without a terminal frame says nothing about the run, and
        // reporting it as a failure is badly misleading.
        //
        // A person can be told "This run stopped on an error before it could
        // answer. It reached step N of M" while the run goes on working for
        // minutes more, or a run can get the same sentence, then park,
        // continue, and write its result into the document it was asked to
        // write. In both cases the work is fine and only the account of it is
        // wrong — and "Trying again is safe" invites a second run on top of a
        // first that is still going.
        //
        // So: say what is true (the connection ended, the run continues, the
        // result lands here), and do NOT settle the tracker as a failure. The
        // run's real fate arrives on the settle callback, and that is what
        // gets to write the outcome.
        log.warn(
          { tenantId: input.tenantId, agentId: input.agentId, eventsEmitted },
          'chat turn stream ended without a terminal frame; the run continues and will settle',
        );
        yield { type: 'stream_lost', detail: STREAM_ENDED_RUN_CONTINUES };
        return;
      }
    } catch (err) {
      if (!eventsEmitted) {
        // Connection failed before any streaming — yield error
        log.error(
          { tenantId: input.tenantId, agentId: input.agentId, error: (err as Error).message },
          'SDK chat turn failed pre-stream',
        );
        yield {
          type: 'error',
          code: 'PROVIDER_ERROR',
          message: 'We could not reach the agent right now. Please try again in a moment.',
        };
        return;
      } else {
        // Mid-stream failure — log and surface error
        log.error(
          {
            tenantId: input.tenantId,
            agentId: input.agentId,
            threadId: input.threadId,
            error: (err as Error).message,
            stack: (err as Error).stack,
          },
          'SDK chat turn failed mid-stream',
        );
        // Same rule as the no-terminal-frame case above: the read failed, the
        // RUN did not. Anything already streamed is persisted, and the outcome
        // arrives on the settle callback.
        yield { type: 'stream_lost', detail: STREAM_ENDED_RUN_CONTINUES };
        return;
      }
    }
  } catch (err) {
    log.error(
      {
        threadId: input.threadId,
        tenantId: input.tenantId,
        agentId: input.agentId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      'Agent chat turn failed with uncaught error',
    );
    yield {
      type: 'error',
      code: 'INTERNAL',
      message:
        'Something went wrong processing your message. Please try again.',
    };
  }
}

// ── Async wrapper ─────────────────────────────────────────────────────────

/**
 * Non-streaming wrapper that runs the full turn and returns the final
 * assistant message. Useful for Slack adapter and test harnesses where
 * streaming isn't needed.
 */
export async function runAgentChatTurnAsync(
  input: AgentChatTurnInput,
): Promise<AgentChatMessage | null> {
  let result: AgentChatMessage | null = null;
  for await (const event of runAgentChatTurn(input)) {
    if (event.type === 'complete') result = event.message;
  }
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if the thread needs a fresh rolling summary, and generate one if so.
 * Called fire-and-forget after each turn. Any errors are logged but do not
 * propagate — summarization failing must never affect the user-visible chat.
 */
async function maybeRefreshRollingSummary(
  threadId: string,
  tenantId: string,
  agentId: string,
): Promise<void> {
  // Load the full thread (up to the summarization cap) oldest-first.
  const historyResult = await chatRepo.listMessages(threadId, tenantId, {
    limit: MAX_SUMMARIZATION_HISTORY,
  });
  const allMessages: SummarizationMessage[] = [...historyResult.messages]
    .reverse()
    // Same reason as the turn history: a rolling summary that records "waiting
    // on Ada" as something the conversation was about would carry a transient
    // pause forward as though it were subject matter.
    .filter(isConversationRow)
    // A row whose payload is not words has nothing for a summary to record.
    // `file_output` and `media` rows both carry empty content; summarizing them
    // spends tokens on blank turns and invites a provider to reject a message
    // with no content block in it.
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      // A colleague's reply in this chat is stored verbatim and attributed
      // through `contributors`; a summary that read it as the team's own turn
      // would have the team remember offering what a colleague offered. The
      // speaker is put back here, at the one sink that has no chip to look
      // at, rather than kept in the stored text.
      content: m.messageType === COLLEAGUE_MESSAGE_TYPE && m.contributors.length > 0
        ? `${m.contributors.map((c) => c.label).join(', ')}: ${m.content}`
        : m.content,
      createdAt: m.createdAt,
    }));

  const previousSummary = (await chatRepo.getThreadRollingSummary(
    threadId,
    tenantId,
  )) as ConversationSummary | null;

  const summarizationInput = {
    threadId,
    tenantId,
    allMessages,
    previousSummary,
    // Route cost to the per-agent "interactions" bucket on /insights instead
    // of leaking into platformLLMOperations alongside insights summarization.
    purpose: 'agent_chat_summarization',
    agentId,
  };
  if (!shouldSummarize(summarizationInput)) return;

  const newSummary = await generateRollingSummary(summarizationInput);
  if (newSummary && newSummary !== previousSummary) {
    await chatRepo.updateThreadRollingSummary(threadId, tenantId, newSummary);
  }
}
