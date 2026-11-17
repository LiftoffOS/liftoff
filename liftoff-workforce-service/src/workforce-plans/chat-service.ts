// CAIO Workforce Planning Chat Service - tool-use loop orchestrator
//
// Runs a single /team-plan chat turn as an async generator of typed events.
// The stream-router wraps these events as SSE frames; the frontend consumes
// them to render a streaming CAIO response.
//
// Adapted from platform-backend src/workforce-plans/chat-service.ts with
// these key differences:
//   1. Auth via trusted headers (x-tenant-id, x-account-id, x-tenant-role).
//   2. CAIO chat loop calls callPBLlmComplete() → PB internal LLM endpoint → llmClient;
//   3. No tenantRuntimeClient — memory pre-fetch returns a stub.
//   4. No InternalAgentService — agent list pre-fetch returns a stub.
//   5. Tool definitions come from ./tools/index.js (same API contract).
//   6. Rolling summaries and thread titles run platform-backend's
//      implementations, not copies (conversation-summarization.ts, thread-title.ts).

import { BROWSER_GUIDANCE_SECTION } from '@liftoffos/browser-tools';
import { log } from '../infrastructure/logging.js';
import {
  FORWARDED_CONTEXT_MESSAGE_TYPE,
  forwardedContextStatus,
  withForwardedContext,
} from './forwarded-context.js';
import { guardOutgoingText } from './output-guard-client.js';
import {
  BROWSER_HANDBACK_MESSAGE_TYPE,
  BROWSER_POINT_MESSAGE_TYPE,
  COLLEAGUE_MESSAGE_TYPE,
  HITL_STATUS_MESSAGE_TYPE,
} from './message-types.js';
import { BROWSER_HANDBACK_TURN_TEXT, BROWSER_POINT_TURN_TEXT, describeAction, type RecordedAction } from '@liftoffos/browser-record';
import { fetchBrowserState, type BrowserStateContext } from './tools/browser.js';
import { fetchDatasetInventory } from './tools/capability.js';
import { enqueueContinuation, enqueueContinuationTask, MAX_CONTINUATIONS_PER_MESSAGE } from './chat-continuations.js';
import { loadConfig } from '../infrastructure/config.js';
import { streamHandover } from './handover-client.js';
import { PlatformAgentHandoverException } from '../platform-agent/types.js';
import { writeAuditLog } from './audit-log.js';
import { withTenantContext } from '../infrastructure/rls.js';
import { embedTeamPlanTurn } from './turn-embedding.js';
import type { LLMMessage } from '../llm/types.js';
import {
  appendMessage,
  createTurn,
  getThreadRollingSummary,
  lastAssistantReplyAt,
  linkWorkforcePlan,
  listMessages,
  updateThreadRollingSummary,
  updateThreadTitleInternal,
  type TeamPlanChatMessage,
  type TenantMemberRole,
} from './chat-repository.js';
import { buildBudgetedCAIOPrompt } from './context-budget.js';
import { buildToolTrail } from './tool-trail.js';
import {
  formatSummaryForPrompt,
  isUsableSummary,
  summarizeThread,
  type SummarizationMessage,
} from './conversation-summarization.js';
import {
  BRING_IN_COLLEAGUE_TOOL,
  dispatchToolCall,
  getToolDefinitionsForRole,
  resolveCAIOHandoverTarget,
  type CAIOHandoverTarget,
} from './tools/index.js';
import type { WorkforcePlanToolContext } from './tools/types.js';
import type { CallerOrigin } from './caller-context.js';
import { ensureRemoteWorkspaceActions } from './tools/remote-workspace-actions.js';
import { workforcePlansConnectorClient as connectorService } from './tenant-connectors.js';
import { listTenantAgents } from './tenant-agents.js';
import { workforcePlanService } from './service.js';
import { WorkforcePlanNotFoundError, type WorkforcePlan } from './types.js';
import { runPlatformAgent } from '../platform-agent/execution.js';
import { parkOrBoundToolResult } from '../platform-agent/park-result.js';
import { CAIO_AGENT_ID } from '../platform-agent/system-agent-ids.js';
import {
  formatPlanState,
  renderSystemPrompt,
} from '../platform-agent/system-prompt-render.js';
import { loadPlatformAgentConfig } from '../platform-agent/config.js';
import { randomUUID } from 'crypto';
import {
  StreamingVisualizationParser,
  parseVisualizationBlocks,
} from './visualization-parser.js';
import { TurnEventRecorder } from './turn-event-recorder.js';
import { claimTurn, isStopRequested, releaseTurn } from './active-turn-repository.js';
import { claimUserMessage, frameInterrupt } from './turn-signal-repository.js';
import { maybeGenerateThreadTitle } from './thread-title.js';
import type { VisualizationBlock } from './visualization-types.js';
// The attachment contract, published from platform-backend: one projection
// decides what is persisted, one wrapper decides what the model reads.
import {
  composeTurnText,
  partitionMediaForModel,
  toMessageAttachments,
  toMessageMedia,
  type ChatAttachment,
} from '@liftoffos/chat-attachments';
import { claimInboundMedia, loadTurnImages, sendableModalities } from './chat-media.js';
import { notifyTeamPlanReply } from './reply-notification.js';

export type { VisualizationBlock };

// ── Local utilities ─────────────────────────────────────────────────────

function fireAndForget(p: Promise<unknown>): void {
  p.catch(err => log.warn({ err }, 'fire-and-forget failed'));
}

// ── Event shape ─────────────────────────────────────────────────────────

export type CAIOChatErrorCode =
  | 'PROVIDER_ERROR'
  | 'MAX_ITERATIONS'
  | 'DEADLINE'
  /** A call's prompt filled the guarded share of the model's context
   *  window; the reply was closed with one more call. */
  | 'CONTEXT_FULL'
  /** A colleague was brought in and could not answer. Its own code, as on
   *  the other surfaces: "the provider failed" and "the colleague we handed
   *  this to could not finish" are different things to look at in a log. A
   *  colleague that PAUSED to wait on a person is not one of these; a pause
   *  has its own terminal frame. */
  | 'DELEGATION_ERROR'
  /** One response hit the per-turn output ceiling inside an unfinished tool
   *  call: the turn ends with what it had already said. Its own code because
   *  the provider did what it was asked — the ceiling is ours. */
  | 'OUTPUT_TRUNCATED'
  | 'INTERNAL';

export type CAIOChatServiceEvent =
  | { type: 'thinking' }
  | { type: 'tool_call'; tool: string }
  | { type: 'text_delta'; text: string }
  /** A rendered block. On a hand-over the block is the colleague's, in
   *  whatever shape its own parser delivers it. */
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
      message: TeamPlanChatMessage | null;
    }
  /** Terminal success. `message` is null when the turn was stopped before it
   *  said anything: there is no reply to persist and none is invented. */
  | { type: 'complete'; message: TeamPlanChatMessage | null }
  | { type: 'error'; code: CAIOChatErrorCode; message: string };

// ── The person's browser events ──────────────────────────────────────────────
//
// A hand-back or a point arrives from the client as a claim naming a hold.
// The claim is verified here against the runtime's record, through
// platform-backend's takeovers route, and the stream router calls this
// before it writes anything or flushes a header, so a claim that fails is a
// plain 409. What checks out rides the turn as `browserEvent`: the turn
// writes the status line in the person's name and, when they sent no words,
// reads the shared event text in their place.

export type BrowserEventKind = 'handback' | 'point';

/** A claimed browser event, verified: the hold the runtime recorded and,
 *  for a point, the control the person pointed at. */
export interface VerifiedBrowserEvent {
  kind: BrowserEventKind;
  holdId: string;
  action: RecordedAction | null;
}

export type BrowserEventVerification =
  | { ok: true; event: VerifiedBrowserEvent }
  /** The claim did not check out: the hold is not this thread's, not the
   *  claimed kind, not released, or older than the window. */
  | { ok: false; status: 409 }
  /** Platform-backend or the runtime could not answer. */
  | { ok: false; status: 503 };

/**
 * Verify the person's claimed hand-back or point against the runtime's
 * record, through platform-backend's takeovers route with the hold named:
 * the same check its own chat surfaces make before they write a row or run
 * a turn. A 409 from there is a 409 here.
 */
/** What every assistant with a browser pane is told about reading it, appended
 *  to the rendered prompt rather than seeded into the row.
 *
 *  It used to live in `internal_agents.system_prompt`, put there by migration
 *  512 and rewordable only by another migration. That is the wrong home for it
 *  twice over: the text describes the browser MECHANISM rather than anything
 *  about the Chief AI Officer, and a copy in a database row is a copy no
 *  compiler, test or package can keep in step with the other hosts — which is
 *  how this assistant ended up never being told to read a page at all.
 *
 *  A constant, so the prompt stays byte-identical between turns and is read
 *  back from the provider's cache rather than re-billed.
 */
const BROWSER_GUIDANCE_SUFFIX = `\n\n${BROWSER_GUIDANCE_SECTION}`;

export async function verifyBrowserEvent(
  ctx: BrowserStateContext,
  kind: BrowserEventKind,
  holdId: string,
): Promise<BrowserEventVerification> {
  const baseUrl = loadConfig().PLATFORM_BACKEND_URL.replace(/\/$/, '');
  const secret = loadConfig().WORKFORCE_SERVICE_TOKEN;
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/api/internal/assistant-browser/takeovers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Auth': secret },
      body: JSON.stringify({ tenantId: ctx.tenantId, threadId: ctx.threadId, holdId, kind }),
    });
  } catch (err) {
    log.error({ error: (err as Error).message, threadId: ctx.threadId }, 'browser event: fetch to platform-backend failed');
    return { ok: false, status: 503 };
  }
  if (resp.status === 409) return { ok: false, status: 409 };
  if (!resp.ok) {
    log.error({ status: resp.status, threadId: ctx.threadId }, 'browser event: unexpected status from platform-backend');
    return { ok: false, status: 503 };
  }
  const body = await resp.json() as { event?: { kind?: unknown; holdId?: unknown; action?: unknown } };
  const event = body.event;
  if (!event || (event.kind !== 'handback' && event.kind !== 'point') || event.holdId !== holdId) {
    return { ok: false, status: 503 };
  }
  const action = event.action && typeof event.action === 'object' ? event.action as RecordedAction : null;
  return { ok: true, event: { kind: event.kind, holdId, action } };
}

// ── Input shape ─────────────────────────────────────────────────────────

export interface RunCAIOChatTurnInput {
  /**
   * Null for the greeting the plan page opens with. A greeting nobody answered
   * is not a conversation, so it gets no thread and nothing is written down:
   * the first message the person actually sends is what creates one. Every
   * thread-scoped step below (history, rolling summary, linked plan, the
   * closing append, turn claiming) is skipped when this is null.
   */
  threadId: string | null;
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
  /** The user message for this turn. Empty or omitted triggers greeting mode
   *  where the CAIO speaks first with context gathered via its tools. */
  userMessage?: string;
  /** The brief a colleague wrote for the Chief AI Officer when it brought it
   *  into one of its conversations, already framed for the model. Read this
   *  turn, in front of the person's message, and NEVER persisted: it is one
   *  model's note to another and not for a person to read. Absent for a person
   *  typing on the CAIO page, who can see this thread.
   *
   *  It used to arrive fused onto `userMessage`, which is why every user row in
   *  a delegated thread read as a paragraph the person never wrote; then it was
   *  stored as its own row, which showed the person identifiers and directives
   *  meant for the model. */
  forwardedContext?: string | null;
  /** Who forwarded that background: Liftoff, the Insights Manager or an AI
   *  team. What the thread keeps of the hand-over is one status row naming
   *  them, attributed to them. Null or absent with a null brief. */
  forwardedBy?: { id: string; label: string } | null;
  /** True when a colleague handed this turn to the Chief AI Officer in front
   *  of the person: everything stays on offer except a colleague of its own,
   *  so a hand-over is one deep on every surface. */
  handover?: boolean;
  /** Files and connector references attached to this message. Uploads are read
   *  by the model this turn; only the metadata (see toMessageAttachments) is
   *  persisted with the message, never the upload's text. */
  attachments?: ChatAttachment[];
  /** Optional caller display name for the user-context preamble. */
  callerName?: string;
  /** Where the turn came from when it came through a coding tool; carried to
   *  every workspace action this turn performs. */
  origin?: CallerOrigin;
  /** When the reply must be on its way (epoch ms). The stream that carries it
   *  to the person has a fixed lifetime, and the turn has to close the reply
   *  inside it rather than finish after the person was told it failed. */
  replyDeadlineAt?: number;
  /** The person's browser event this turn carries, already verified by the
   *  stream router against the runtime's record through platform-backend:
   *  they handed the browser back, or pointed at something in it. The turn
   *  writes the status line naming it (the person's row), and with an empty
   *  `userMessage` the model reads the shared event text; no user row is
   *  written then, and the greeting is not what an empty message means. */
  browserEvent?: VerifiedBrowserEvent;
  /** Present when this turn continues work a bound closed (chat_continuations,
   *  migration 029). The turn then writes NO user row — the continuation
   *  note is the model's current message only, the way an injected mid-run
   *  message is a model-only entry — keeps the origin message's id for the
   *  audit row and the next continuation, and runs everything else
   *  unchanged, up to the cap. Not the greeting: an empty `userMessage`
   *  with a continuation is the note. */
  continuation?: { originMessageId: string; ordinal: number };
}

/** What a continuation turn reads as its current message. Model-only: it
 *  is never written as a row. */
const CONTINUATION_NOTE =
  'Continue the work in progress in this conversation. The datasets kept for it are listed. Write the reply when the '
  + 'work is done, or when you must stop again.';

// ── Constants ───────────────────────────────────────────────────────────

// MAX_ITERATIONS, the context-window guard and MAX_TURN_OUTPUT_TOKENS are
// owned by the platform-agent module — see src/platform-agent/execution.ts.
// The iteration count surfaced in the audit log is the loop's own, not a
// local clamp: a clamp here once reported a cap of ten after the loop's cap
// had moved to fifty, so the audit named a bound the loop no longer had.
/** What a turn says when it finished and said nothing. See the persist site
 *  below for why an empty row is no better than a missing one, and why this
 *  text is identical across all three deployables. */
const COMPLETED_WITHOUT_REPLY = 'Done.';
const MAX_HISTORY_MESSAGES = 20;
const MAX_SUMMARIZATION_HISTORY = 200;
// The spacing the platform-agent loop polls a stop on while a model call is
// out; a hand-over polls on the same spacing while the colleague streams.
const HANDOVER_STOP_POLL_INTERVAL_MS = 2_000;

// CAIO_AGENT_ID is imported from platform-agent/system-agent-ids.ts so the
// HRBP / CAIO UUIDs stay defined in exactly one place across the repo.

// ── Greeting context pre-fetch ─────────────────────────────────────────
//
// In greeting mode we pre-fetch workspace context server-side and inject it
// into the seed message. This eliminates the 2-5 second tool-calling round
// trip from the start of every new planning conversation.

/** The first sentence of every greeting, verbatim. The rest of the greeting
 *  is the model's, grounded in the workspace assessment; this sentence is not,
 *  because it is the product's own line and it must read the same way every
 *  time. Left to the model, it drifted to positioning the site no longer
 *  uses ("scale what your teams can do without adding headcount"). */
export const CAIO_GREETING_OPENING =
  'I am your Chief AI Officer, here to take the work you hand off and make sure an agent owns it.';

async function prefetchGreetingContext(tenantId: string): Promise<string> {
  // Connectors alone are not "the workspace". A tenant can have agents and no
  // connectors, or the reverse, and the greeting must not call either empty.
  const [connectorsSummary, workforceSummary] = await Promise.all([
    prefetchConnectors(tenantId),
    prefetchExistingWorkforce(tenantId),
  ]);

  return `## Workspace Assessment (pre-fetched)

${connectorsSummary}

${workforceSummary}

---

The user just opened a new planning conversation. Introduce yourself in two or three sentences. The first sentence is exactly this, word for word: "${CAIO_GREETING_OPENING}" The sentences after it are grounded in the workspace assessment above. Only call the workspace empty when the assessment above positively says both that nothing is connected and that no agents exist — a section that says it could not be read is not evidence of emptiness. If there are existing connectors or agents, reference them specifically and ask where they want to focus. End with a single open question.`;
}

async function prefetchExistingWorkforce(tenantId: string): Promise<string> {
  const result = await listTenantAgents(tenantId);

  // Same rule as the connector section: a failed lookup is not an empty
  // workforce, and must never be narrated as one.
  if (!result.ok) {
    return '### Existing Agents\nThe existing agents could not be read just now, so this assessment does not know what is already running. Do NOT tell the user they are starting from scratch or that this is a blank-slate org. Ask what they already have running instead.';
  }

  if (result.agents.length === 0) {
    return '### Existing Agents\nNone provisioned yet — this really is a blank slate on the AI-team side.';
  }

  const lines = [`### Existing Agents (${result.agents.length})`];
  for (const agent of result.agents) {
    lines.push(`- ${agent.role ?? agent.id} (${agent.status ?? 'draft'})`);
  }
  return lines.join('\n');
}

async function prefetchConnectors(tenantId: string): Promise<string> {
  try {
    const result = await connectorService.listByTenant(tenantId);

    // A failed lookup is not an empty workspace. Saying so is how the greeting
    // came to tell people with a dozen connected apps that they were starting
    // from scratch, for as long as the call has been 401ing.
    if (!result.ok) {
      return '### Connected Apps\nThe connector list could not be read just now, so this assessment does not know which apps are set up. Do NOT tell the user their workspace is empty or that nothing is connected. Ask them what they are working with instead.';
    }

    const connected = result.connectors.filter(c => c.status === 'active');

    if (connected.length === 0) {
      return '### Connected Apps\nNone connected yet. The user will need to connect apps on the Connections page before agents can use them.';
    }

    const lines = [`### Connected Apps (${connected.length} connected)`];
    for (const conn of connected) {
      const displayName = conn.displayName || conn.type;
      lines.push(`- ${displayName} (${conn.type})`);
    }
    return lines.join('\n');
  } catch {
    return '### Connected Apps\n(Unable to fetch connector data)';
  }
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Run a turn, tee its events into the turn-event log on the way past so anybody
 * else on the thread can follow along, and register it as the thread's live turn
 * so it can be stopped.
 *
 * A separate wrapper rather than calls sprinkled through the turn itself: the
 * recorder is an observability nicety and must never be able to change what the
 * sender sees. It swallows its own errors, writes nothing when nobody else is on
 * the thread, and both `finish()` and the claim release run in a finally, so a
 * turn that throws still marks itself done rather than leaving followers polling
 * and the next turn unstoppable.
 */
export async function* runCAIOChatTurn(
  input: RunCAIOChatTurnInput,
): AsyncIterable<CAIOChatServiceEvent> {
  const turnId = randomUUID();

  // Both of these are thread-scoped: the recorder tees events so others on the
  // thread can follow along, and the claim is what makes a turn stoppable and
  // stops a second one starting. A threadless greeting has nobody to follow it
  // and no transcript to race for, so it runs without either rather than
  // claiming a turn on a thread that does not exist.
  const threadId = input.threadId;
  if (!threadId) {
    yield* runCAIOChatTurnCore(input, turnId);
    return;
  }

  const recorder = new TurnEventRecorder(
    input.tenantId,
    threadId,
    turnId,
    input.accountId,
  );
  await claimTurn(input.tenantId, threadId, turnId, input.accountId);
  try {
    for await (const event of runCAIOChatTurnCore(input, turnId)) {
      await recorder.record(event as unknown as { type: string; text?: string });
      yield event;
    }
  } finally {
    await recorder.finish();
    await releaseTurn(input.tenantId, threadId, turnId);
  }
}

async function* runCAIOChatTurnCore(
  input: RunCAIOChatTurnInput,
  turnId: string,
): AsyncIterable<CAIOChatServiceEvent> {
  yield { type: 'thinking' };

  // A browser event without words is a turn of its own, never the greeting;
  // so is a continuation.
  const continuation = input.continuation ?? null;
  const eventOnly = continuation === null && input.browserEvent !== undefined && (!input.userMessage || input.userMessage.trim().length === 0);
  const greetingMode = continuation === null && !eventOnly && (!input.userMessage || input.userMessage.trim().length === 0);
  const attachments = input.attachments ?? [];

  // In greeting mode, pre-fetch the workspace context server-side and inject
  // it into the seed message. The LLM is given no user-defined tools so it
  // writes the greeting immediately without tool-calling round trips.
  const sentMedia = toMessageMedia(attachments);
  let turnImages: Array<{ mimeType: string; dataBase64: string; alt?: string }> = [];
  let effectiveUserMessage: string;
  if (continuation) {
    effectiveUserMessage = CONTINUATION_NOTE;
  } else if (greetingMode) {
    effectiveUserMessage = await prefetchGreetingContext(input.tenantId);
  } else if (eventOnly) {
    // The shared text every host gives the model for a hand-back or a point;
    // the Browser section beneath the prompt carries what the person did.
    effectiveUserMessage = input.browserEvent!.kind === 'point' ? BROWSER_POINT_TURN_TEXT : BROWSER_HANDBACK_TURN_TEXT;
  } else {
    // Attachment bodies go in front of everything else in the current message:
    // the budget truncates this section from its start, so a turn that overflows
    // loses document body rather than the question being asked about it.
    // What the model may look at, resolved against the model this turn will
    // actually run on. Everything else is named in the prompt in words —
    // never dropped, because a dropped picture lets the model answer about one
    // it never received and nothing in the answer says so.
    const partitioned = sentMedia.length > 0
      ? partitionMediaForModel(sentMedia, await sendableModalities('caio_workforce_planning'))
      : { readable: [], described: [] };
    turnImages = partitioned.readable.length > 0
      ? await loadTurnImages(input.tenantId, partitioned.readable)
      : [];
    // Anything whose bytes could not be read joins the described half, so the
    // two always add up to what the person attached.
    const described = partitioned.readable.length > turnImages.length
      ? [...partitioned.described, ...partitioned.readable.slice(turnImages.length)]
      : partitioned.described;

    effectiveUserMessage = composeTurnText(
      withForwardedContext(input.userMessage!, input.forwardedContext ?? null),
      attachments,
      { describedMedia: described },
    );
  }

  try {
    // 0. The person's browser event, as one status line in their name: what
    //    they did, in the record's own words for a point. Written before
    //    their message (a send while driving) so the thread reads in the
    //    order it happened. The model never reads this row; the segment
    //    reaches it through the Browser section.
    if (input.browserEvent && input.threadId) {
      const who = input.callerName ?? 'The person';
      const line = input.browserEvent.kind === 'point' && input.browserEvent.action
        ? `${who} ${describeAction(input.browserEvent.action)}`
        : `${who} handed the browser back`;
      await appendMessage({
        threadId: input.threadId,
        tenantId: input.tenantId,
        role: 'assistant',
        content: line,
        messageType: input.browserEvent.kind === 'point' ? BROWSER_POINT_MESSAGE_TYPE : BROWSER_HANDBACK_MESSAGE_TYPE,
      });
    }

    // 1. Persist the user message FIRST (unless we're in greeting mode —
    //    the synthetic seed is internal-only and never shown to the user —
    //    or the turn is a browser event without words, whose row is the
    //    status line above). What is stored is what they typed plus
    //    attachment METADATA, so a reloaded thread shows the chips again;
    //    attachment bodies are a one-turn model input, not transcript.
    // The person's message this work belongs to: the row written here, or
    // the origin a continuation carries. Null for a greeting or an event
    // turn, which then cannot continue. A continuation writes no row: its
    // message is the origin message, already there.
    let originMessageId: string | null = continuation?.originMessageId ?? null;

    // The turn a conversation search is keyed to (migration 031). `turnId` is
    // already minted for every turn, so unlike the other assistants there is
    // nothing to fall back to — but it is opened only when there is a THREAD to
    // hang it off: a threadless greeting has no conversation to search later.
    // Opened before the person's row, so the message's turn_id has a row to
    // point at, and unconditionally for a thread (an event turn and a
    // continuation write no user row of their own, and the reply still belongs
    // to a turn). Idempotent, so a retry is free.
    if (input.threadId) {
      await createTurn(input.tenantId, input.threadId, turnId, input.accountId);
    }

    if (!greetingMode && !eventOnly && !continuation) {
      const userRow = await appendMessage({
        threadId: input.threadId!,
        tenantId: input.tenantId,
        role: 'user',
        senderAccountId: input.accountId,
        content: input.userMessage!,
        attachments: toMessageAttachments(attachments),
        turnId,
        // Media goes to the message's own column, never into `attachments`:
        // that one means what the person handed over as text, and the renderer
        // already draws `media` for any role.
        ...(sentMedia.length > 0 ? { media: sentMedia } : {}),
      });
      originMessageId = userRow?.id ?? null;

      // A message carries these now, so the control plane's retention sweep
      // must leave them alone. Fire-and-forget by design — see chat-media.ts.
      if (sentMedia.length > 0) {
        fireAndForget(
          claimInboundMedia(input.tenantId, input.threadId!, sentMedia.map(m => m.mediaId)),
        );
      }

      // A colleague brought the Chief AI Officer in: one status row about the
      // conversation rather than a turn in it, naming who did. Written straight
      // after the person's message so the thread reads in the order it
      // happened, and typed so the UI renders it as a status line and the
      // history below skips it. The brief itself is read this turn, in front
      // of the message, and never stored: it is the colleague's note to the
      // model, not something a person should open.
      //
      // Best effort. It is provenance, not the question itself, so failing to
      // write it must not cost the person a turn.
      if (input.forwardedContext) {
        try {
          await appendMessage({
            threadId: input.threadId!,
            tenantId: input.tenantId,
            role: 'assistant',
            // A brief with no named forwarder came from a platform-backend
            // that predates the forwarder, which only Liftoff could send.
            content: forwardedContextStatus(input.forwardedBy?.label ?? 'Liftoff'),
            messageType: FORWARDED_CONTEXT_MESSAGE_TYPE,
            // The row is the colleague's, not the Chief AI Officer's: the
            // chip on it names whoever brought it in.
            contributors: input.forwardedBy ? [input.forwardedBy] : undefined,
          });
        } catch (err) {
          log.warn(
            { threadId: input.threadId, error: (err as Error).message },
            'CAIO: could not record the context a colleague forwarded',
          );
        }
      }
    }

    // 2. Load prior turns, rolling summary, and the linked plan (if any)
    //    in parallel. A threadless greeting has none of the three by
    //    definition: it is the first thing said, to nobody, on nothing.
    const [historyResult, summary, linkedPlan, sinceLastReply] = input.threadId
      ? await Promise.all([
          listMessages(input.threadId, input.tenantId, { limit: MAX_HISTORY_MESSAGES }),
          getThreadRollingSummary(input.threadId, input.tenantId),
          loadLinkedPlan(input.threadId, input.tenantId),
          lastAssistantReplyAt(input.threadId, input.tenantId),
        ])
      : [{ messages: [] }, null, null, null] as const;
    // The Browser section, on every thread-scoped turn: platform-backend
    // renders where the browser is, who holds the wheel and what the person
    // did since this assistant last spoke. Empty when there is nothing to say.
    // The datasets kept for the conversation, the same way: one internal
    // call, the block platform-backend's own assistants read, so a turn that
    // follows a fetch knows what it holds rather than fetching again.
    const [browserContext, datasetContext] = input.threadId
      ? await Promise.all([
          fetchBrowserState({ tenantId: input.tenantId, threadId: input.threadId }, sinceLastReply),
          fetchDatasetInventory({ tenantId: input.tenantId, threadId: input.threadId }),
        ])
      : ['', ''];

    // listMessages returns newest-first; reverse to oldest-first.
    // Notes about the conversation are dropped BEFORE the slice below, which
    // assumes the last row is the user turn this call just persisted. A
    // forwarded-context row is written straight after that turn, so leaving it
    // in would make the slice discard the note and keep the user's message in
    // `priorTurns` — putting the same sentence in front of the model twice,
    // once as history and once as the current message.
    //
    // Status rows are dropped on the same terms Liftoff and team chat drop
    // them: written BY this service ABOUT the conversation (a colleague
    // waiting on an approval), not said by anyone in it.
    //
    // The person's browser events are dropped on the same terms: the segment
    // reaches the model through the Browser section, and the row is the
    // person's, not this assistant's.
    const historyOldestFirst = [...historyResult.messages]
      .reverse()
      .filter(m => m.messageType !== FORWARDED_CONTEXT_MESSAGE_TYPE)
      .filter(m => m.messageType !== HITL_STATUS_MESSAGE_TYPE)
      .filter(m => m.messageType !== BROWSER_HANDBACK_MESSAGE_TYPE)
      .filter(m => m.messageType !== BROWSER_POINT_MESSAGE_TYPE);
    // In normal mode we just persisted the user turn - it IS the last
    // message, so drop it from priorTurns. In greeting mode nothing was
    // persisted, and an event turn without words persisted only its status
    // line (filtered above), so every history row is a prior turn.
    // A continuation persisted nothing either: every row is a prior turn,
    // the newest being the closing reply the last turn wrote.
    const priorTurns = greetingMode || eventOnly || continuation
      ? historyOldestFirst
      : historyOldestFirst.slice(0, -1);

    // 3. Build the budgeted-prompt's user-facing preamble (caller context +
    //    rolling summary). The platform-agent module owns the SYSTEM prompt
    //    (loaded from internal_agents.system_prompt seed and rendered with
    //    {{TODAY}} / {{PLAN_STATE}} / {{TOOLS}} substitution). What
    //    buildBudgetedCAIOPrompt still gives us: per-section token caps on
    //    the conversation history we hand to the LLM as priorMessages.
    // The workspace actions are registered from platform-backend's manifest;
    // when none are registered and the last attempt is older than a minute,
    // fetch once more so this turn does not run without them because the
    // backend was unreachable at startup.
    await ensureRemoteWorkspaceActions();
    const availableTools = getToolDefinitionsForRole(input.role, { handover: input.handover === true });

    // A toolless CAIO is worse than a broken one. The seed prompt names its
    // tools in prose, so a model handed no `tools` array writes the call out
    // as text ("[Tool Call: memory_save] Parameters: {...}"), tells the user
    // it saved something, and writes nothing. Fail the turn instead: every
    // role in the access matrix is entitled to at least the read-only tools,
    // so an empty list here can only mean the registry is broken.
    if (!greetingMode && availableTools.length === 0) {
      log.error(
        { threadId: input.threadId, tenantId: input.tenantId, role: input.role },
        'CAIO: no tools available for role - refusing to run a toolless turn',
      );
      yield {
        type: 'error',
        code: 'INTERNAL',
        message: 'Something went wrong processing your message. Please try again.',
      };
      return;
    }

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

    // isUsableSummary rejects the flat `{summary, messageCount}` placeholders the
    // old stub wrote; those threads simply get a real summary on the next refresh.
    const rollingSummaryText = isUsableSummary(summary)
      ? formatSummaryForPrompt(summary)
      : null;

    // Render the actual seed-derived system prompt up-front so the budget
    // calculator can charge it against the context window. runPlatformAgent
    // will render it again (with the same renderer + same RenderContext)
    // when it makes the LLM call — the duplication is cheap and keeps the
    // budgeting authoritative.
    const caioConfig = await loadPlatformAgentConfig(CAIO_AGENT_ID);
    // Rendered WITHOUT the plan state. The system prompt is the provider's cache
    // prefix and it is re-sent on every round of the tool-use loop, so it has to
    // be byte-identical between turns to be read back rather than re-billed. The
    // plan is the one thing here that changes mid-conversation — every
    // workforce_plan__draft call rewrites it — so a copy inside the prompt
    // invalidated the whole prefix on exactly the turns that did the most work,
    // and a miss costs 1.25x rather than nothing.
    //
    // It goes on the turn instead, through the `planStateText` slot the budgeted
    // prompt already had for it. `{{PLAN_STATE}}` in the seeded template still
    // substitutes, to the empty string, so no placeholder leaks into the prompt.
    const renderedSystemPrompt = renderSystemPrompt(caioConfig.systemPromptTemplate, {
      tools: availableTools.map(t => ({ name: t.name, description: t.description })),
    }) + BROWSER_GUIDANCE_SUFFIX;

    const budgeted = buildBudgetedCAIOPrompt({
      systemPrompt: renderedSystemPrompt,
      userContext,
      ...(browserContext ? { browserContext } : {}),
      ...(datasetContext ? { datasetContext } : {}),
      // The live plan, on the turn rather than in the prompt. Budgeted and
      // truncated like every other volatile section, and it lands in the
      // `[Context]` message the preamble already builds.
      planStateText: linkedPlan ? formatPlanState(linkedPlan) : null,
      rollingSummary: rollingSummaryText,
      recentTurns: recentTurnsAsLLM,
      currentMessage: effectiveUserMessage,
    });

    // Build priorMessages for runPlatformAgent. budgeted.messages is the
    // budget-fit list of LLMMessages (preamble user-context block + recent
    // turns + the final user turn). The final entry IS the current message;
    // drop it so runPlatformAgent's `objective` carries it as the kickoff.
    const budgetedMessages = budgeted.messages.filter(
      (m): m is LLMMessage & { role: 'user' | 'assistant' } =>
        m.role === 'user' || m.role === 'assistant',
    );
    const priorMessagesForRun = budgetedMessages
      .slice(0, -1)
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : String(m.content),
      }));

    // 4. Hand off to the platform-agent execution module.
    const toolContext: WorkforcePlanToolContext = {
      tenantId: input.tenantId,
      accountId: input.accountId,
      role: input.role,
      threadId: input.threadId ?? undefined,
      // Only when there is a thread: a threadless greeting opens no turn row.
      ...(input.threadId ? { turnId } : {}),
      workforcePlanId: linkedPlan?.id,
      ...(input.origin ? { origin: input.origin } : {}),
    };

    const parser = new StreamingVisualizationParser();
    let accumulatedText = '';
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let iteration = 0;
    // Why the loop ended, for the audit row. 'STOPPED' is not an error — the
    // person asked — but it is worth telling apart from a turn that simply
    // finished, which is what an operator reading /activity needs to know.
    let terminatedEarly: CAIOChatErrorCode | 'STOPPED' | null = null;
    // What the turn did, kept with the reply it produced (migration 025).
    let toolTrail: ReturnType<typeof buildToolTrail> = [];
    // Whether a further continuation may follow this turn: a message to
    // continue from, and the cap for it not reached. Decides which closing
    // note the loop puts to the model, and whether its verdict is read.
    const canContinue = originMessageId !== null && (continuation?.ordinal ?? 0) < MAX_CONTINUATIONS_PER_MESSAGE;
    // The closing reply's verdict, as the loop reported it: true when the
    // model said work is still to do (or wrote no verdict), false for [done],
    // undefined for a turn no bound closed.
    let closingUnfinished: boolean | undefined;

    // In greeting mode, the LLM gets an empty tool list so it just writes
    // its intro without round-tripping tools.
    const toolsForRun = greetingMode ? [] : availableTools;

    // Set when the model calls bring_in_colleague with a colleague that
    // resolves: the loop ends on the platform-agent's `handed_over`
    // terminator and the hand-over below takes the rest of the turn.
    let pendingHandover: { target: CAIOHandoverTarget; request: string } | null = null;

    // Wrap dispatchToolCall to (a) emit tool_call events to the SSE stream
    // (b) handle the plan-link side effect on workforce_plan__draft success,
    // and (c) return runPlatformAgent's expected {ok, data} shape.
    const wrappedDispatch = async (
      name: string,
      toolInput: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ): Promise<{ ok: boolean; data: unknown }> => {
      const wfCtx = ctx as unknown as WorkforcePlanToolContext;

      // NOT dispatched: the colleague takes the rest of the reply. Resolved
      // here, at the moment the model asks; an unknown name comes back as an
      // ordinary tool result so the model can recover in the same turn.
      if (name === BRING_IN_COLLEAGUE_TOOL) {
        const target = resolveCAIOHandoverTarget(toolInput['colleague']);
        if (!target) {
          log.info(
            { threadId: input.threadId, tenantId: input.tenantId, requested: toolInput['colleague'] },
            'CAIO: hand-over target did not resolve; answering with the two colleagues',
          );
          return {
            ok: false,
            data: {
              error:
                `No colleague named "${String(toolInput['colleague'] ?? '')}" can be brought in from here. `
                + "Use 'insights' for the Insights Manager or 'liftoff' for Liftoff.",
            },
          };
        }
        const request = toolInput['request'];
        pendingHandover = { target, request: typeof request === 'string' ? request : '' };
        throw new PlatformAgentHandoverException();
      }

      try {
        const result = await dispatchToolCall(name, toolInput, wfCtx);

        // Plan-link side effect (matches the pre-migration behaviour): after
        // workforce_plan__draft creates a plan, link it to the thread and
        // mutate the live toolContext so subsequent tool calls in THIS turn
        // see the new planId.
        if (
          result.ok &&
          name === 'workforce_plan__draft' &&
          typeof result.data.planId === 'string' &&
          !toolContext.workforcePlanId
        ) {
          const newPlanId = result.data.planId;
          toolContext.workforcePlanId = newPlanId;
          try {
            // Non-null here: reaching a tool call means tools were offered,
            // and the only threadless turn is the greeting, which runs with
            // an empty tool list.
            await linkWorkforcePlan(input.threadId!, input.tenantId, newPlanId);
          } catch (err) {
            log.error(
              {
                threadId: input.threadId,
                planId: newPlanId,
                error: (err as Error).message,
              },
              'CAIO: failed to link workforce plan to thread - continuing turn',
            );
          }
        }

        return { ok: result.ok, data: result.data };
      } catch (err) {
        log.error(
          {
            threadId: input.threadId,
            toolName: name,
            error: (err as Error).message,
          },
          'CAIO: tool dispatch threw unexpectedly',
        );
        return { ok: false, data: { error: `Tool execution failed: ${(err as Error).message}` } };
      }
    };

    // Drive runPlatformAgent and translate its events into the chat-service
    // event shape. The platform-agent module is responsible for the
    // 10-iteration cap, token-budget guard, and audit-log emissions.
    const platformEvents = runPlatformAgent({
      agentId: CAIO_AGENT_ID,
      tenantId: input.tenantId,
      threadId: input.threadId ?? undefined,
      objective: effectiveUserMessage,
      ...(turnImages.length > 0 ? { objectiveImages: turnImages } : {}),
      priorMessages: priorMessagesForRun,
      tools: toolsForRun,
      toolContext: toolContext as unknown as Record<string, unknown>,
      dispatchToolCall: wrappedDispatch,
      auditAction: 'caio.chat_turn',
      // A CAIO turn only exists because a person sent a message, so it is
      // attributed to that person. The loop used to hardcode the bare literal
      // 'agent', which attributed every turn to nobody.
      triggeredBy: `human:${input.accountId}`,
      // Cost-attribution rule: CAIO LLM calls keep purpose='caio_workforce_planning'
      // so /insights Workforce-planning bucket math stays unchanged after the
      // CAIO becomes a real registry-row agent.
      usagePurpose: 'caio_workforce_planning',
      // The text is a reply a person is waiting to read, so the loop closes
      // it — one last tool-less call — when its rounds or its time run out.
      // The closing note asks for the [continue]/[done] verdict only while a
      // continuation could follow; at the cap it asks the reply to say the
      // person can ask it to go on.
      reply: { ...(input.replyDeadlineAt !== undefined ? { deadlineAt: input.replyDeadlineAt } : {}), askVerdict: canContinue },
      // A tool result larger than one message is parked as a dataset for THIS
      // conversation and the model gets its view; the three dataset tools it
      // already holds read the records back without any of them passing
      // through the window. Supplied here and not by the HRBP fan-out, which
      // has no dataset tools and would be handed an id it cannot read.
      // The threadless greeting runs with an empty tool list, so it has no
      // result to park.
      ...(input.threadId
        ? { parkToolResult: (toolName: string, data: unknown, serialized: string) =>
            parkOrBoundToolResult({ tenantId: input.tenantId, threadId: input.threadId! }, toolName, data, serialized) }
        : {}),
      // Between iterations and before each tool call, the loop asks whether
      // somebody has pressed stop, and whether somebody typed while it was
      // working. Both are thread-scoped, and both are optional on the loop.
      // The threadless greeting claimed no turn, so there is no row for
      // either to read and nothing that could steer it: it is two or three
      // sentences written before anyone has said a word.
      ...(input.threadId
        ? {
            shouldStop: () => isStopRequested(input.tenantId, input.threadId!, turnId),
            // The message is framed here, at the CAIO seam, so the loop never
            // has to know who is speaking: the agent is told the sender and
            // that this continues the current task rather than replacing it.
            claimUserMessage: async () => {
              const pending = await claimUserMessage(input.tenantId, turnId);
              return pending ? frameInterrupt(pending) : null;
            },
          }
        : {}),
    });

    for await (const event of platformEvents) {
      if (event.type === 'text_delta') {
        // Every word the person reads passes the output guard first
        // (output-guard-client.ts): the loop yields whole text blocks, so
        // each is read whole, before the parser and before it is
        // accumulated for the row. What is persisted is what streamed.
        const shown = await guardOutgoingText(event.text, {
          tenantId: input.tenantId,
          threadId: input.threadId ?? null,
          toolNames: toolsForRun.map((t) => t.name),
        });
        accumulatedText += shown;
        for (const parsed of parser.feed(shown)) {
          if (parsed.type === 'text') {
            yield { type: 'text_delta', text: parsed.content };
          } else {
            for (const vizBlock of parsed.blocks) {
              yield { type: 'content_block', block: vizBlock };
            }
          }
        }
      } else if (event.type === 'tool_call') {
        yield { type: 'tool_call', tool: event.tool };
      } else if (event.type === 'error') {
        log.error(
          { threadId: input.threadId, tenantId: input.tenantId, code: event.code, message: event.message },
          'CAIO: runPlatformAgent emitted error',
        );
        // A bound closed this turn and the call that was to write its reply
        // failed: the work is unfinished, and goes on as a continuation.
        if (event.closingCallFailed && input.threadId && canContinue && originMessageId) {
          await queueContinuation(input, input.threadId, originMessageId, 'CLOSING_CALL_FAILED');
        }
        yield { type: 'error', code: 'PROVIDER_ERROR', message: event.message };
        return;
      } else if (event.type === 'complete') {
        iteration = event.summary.toolCalls.length + 1;
        toolTrail = buildToolTrail(event.summary.toolCalls);
        cumulativeInputTokens = event.summary.inputTokens;
        cumulativeOutputTokens = event.summary.outputTokens;
        closingUnfinished = event.summary.unfinished;
        if (event.summary.terminator === 'max_iterations') terminatedEarly = 'MAX_ITERATIONS';
        else if (event.summary.terminator === 'deadline') terminatedEarly = 'DEADLINE';
        else if (event.summary.terminator === 'context_full') terminatedEarly = 'CONTEXT_FULL';
        else if (event.summary.terminator === 'output_truncated') terminatedEarly = 'OUTPUT_TRUNCATED';
        else if (event.summary.terminator === 'error') terminatedEarly = 'PROVIDER_ERROR';
        else if (event.summary.terminator === 'stopped') terminatedEarly = 'STOPPED';
      }
      // 'tool_result' events are internal bookkeeping; not surfaced to SSE.
    }

    // Flush the streaming parser so any trailing buffered text comes out.
    for (const parsed of parser.flush()) {
      if (parsed.type === 'text') {
        yield { type: 'text_delta', text: parsed.content };
      } else {
        for (const block of parsed.blocks) {
          yield { type: 'content_block', block };
        }
      }
    }

    // 5. One-shot parse the full accumulated text for visualization blocks.
    const { cleanedText, blocks } = parseVisualizationBlocks(accumulatedText);

    // The model handed the rest of the turn to a colleague. Everything from
    // here is the colleague's: what the Chief AI Officer said before the call
    // is its own row, the colleague's reply is persisted on this thread in
    // the colleague's name, and the turn ends there. The model is not called
    // again, because it would summarise what the person just read.
    if (pendingHandover) {
      yield* runHandoverSegment({
        input,
        turnId,
        handover: pendingHandover,
        preamble: { cleanedText, blocks: blocks as unknown[], toolTrail },
        priorTurnCount: priorTurns.length,
        cumulativeInputTokens,
        cumulativeOutputTokens,
        iteration,
        hasLinkedPlan: !!toolContext.workforcePlanId,
      });
      return;
    }

    // A turn stopped before it said anything leaves nothing behind. The
    // alternative - writing a marker into the message content - puts words in
    // the agent's mouth: the transcript would show the Chief AI Officer saying
    // "(stopped)", which it never did, and which reads as an answer rather
    // than as the absence of one. The person pressed stop; the honest record
    // is their message with no reply under it.
    if (terminatedEarly === 'STOPPED' && !cleanedText.trim()) {
      void writeAuditLog(
        'workforce_plans.chat_turn',
        { tenantId: input.tenantId, userId: input.accountId },
        {
          threadId: input.threadId,
          greetingMode,
          iterations: iteration,
          inputTokens: cumulativeInputTokens,
          outputTokens: cumulativeOutputTokens,
          userMessageLength: input.userMessage?.length ?? 0,
          assistantMessageLength: 0,
          terminatedEarly,
          hasLinkedPlan: !!toolContext.workforcePlanId,
        },
      );
      // Terminal all the same, so the composer stops streaming and the thread
      // refetches. The frame simply carries no message, because there is none.
      yield { type: 'complete', message: null };
      return;
    }

    // The greeting is said, not filed. With no thread there is nowhere to
    // write it and nothing that should outlive the visit: somebody who opens
    // the page and leaves without replying leaves no trace, and somebody who
    // does reply starts a conversation whose first line is their own. The
    // `complete` frame carries no message for the same reason the stopped
    // turn above carries none — there is no stored row to hand back.
    // A FINISHED TURN MUST NEVER LEAVE THE THREAD EMPTY.
    //
    // `cleanedText` straight through meant a turn that ran and ended without
    // prose persisted an empty row, which renders as a conversation that simply
    // stops. In a thread, "no reply" and "never ran" are indistinguishable, so
    // an empty bubble is no better than a missing one. The stopped turn above is
    // the one legitimate silence and returns before reaching here.
    //
    // A turn that answered entirely with a visualization HAS said something, so
    // the fallback is gated on there being neither text nor blocks, and
    // `cleanedText` is passed through untouched whenever there is.
    //
    // Text kept identical to platform-backend's
    // `src/shared/completed-without-reply.ts` and the tenant runtime's
    // `interactive-chat/chat-turn-handler.ts`: a person moving between the
    // Chief AI Officer, a platform assistant and an agent must not be shown
    // three spellings of the same ending. Duplicated rather than imported only
    // because these are three deployables.
    const saidSomething = cleanedText.trim().length > 0 || blocks.length > 0;
    const savedMessage = input.threadId
      ? await appendMessage({
          threadId: input.threadId,
          tenantId: input.tenantId,
          role: 'assistant',
          content: saidSomething ? cleanedText : COMPLETED_WITHOUT_REPLY,
          turnId,
          visualizationBlocks: blocks.length > 0 ? (blocks as unknown[]) : null,
          inputTokens: cumulativeInputTokens,
          outputTokens: cumulativeOutputTokens,
          toolTrail,
        })
      : null;

    // Make this turn searchable. Best-effort ON PURPOSE and never awaited: this
    // service runs with request-based CPU, so work started after the response has
    // streamed may not finish, and the durable path is the embed sweep
    // (scripts/embed-sweep-team-plan-turns). Correctness never depends on either —
    // an unembedded turn is still found by the keyword arm. Gated so the embed
    // spend cannot start before it is switched on.
    if (savedMessage && input.threadId && process.env.CAIO_RECALL_EMBED_ENABLED === 'true') {
      void embedTeamPlanTurn(input.tenantId, turnId).catch((err) => {
        log.warn(
          { threadId: input.threadId, turnId, error: (err as Error).message },
          'caio: inline turn embed failed; the sweep will pick it up',
        );
      });
    }

    // Tell them their answer arrived, if they are not sitting on the thread
    // watching it. Fire-and-forget after the row is committed: a notification
    // is never worth failing a turn that already succeeded. A greeting is not
    // an answer to anything and never notifies.
    if (savedMessage && input.threadId && !greetingMode) {
      void notifyTeamPlanReply({
        tenantId: input.tenantId,
        accountId: input.accountId,
        threadId: input.threadId,
        text: savedMessage.content,
        via: input.origin?.via ?? null,
      });
    }

    // The continuation: a bound closed this turn AND the closing reply said
    // the work is not finished (or carried no verdict). Queued after the
    // closing reply is persisted, while this turn is still claimed; the task
    // handler checks the thread is free and re-reads the row. A turn that
    // ended on its own, a closing reply that said [done], and a turn at the
    // cap start nothing.
    const boundClosed = terminatedEarly === 'MAX_ITERATIONS' || terminatedEarly === 'DEADLINE' || terminatedEarly === 'CONTEXT_FULL';
    if (boundClosed && savedMessage && input.threadId && canContinue && originMessageId && closingUnfinished !== false) {
      await queueContinuation(input, input.threadId, originMessageId, terminatedEarly as string);
    }

    // 6. Audit log.
    void writeAuditLog(
      'workforce_plans.chat_turn',
      { tenantId: input.tenantId, userId: input.accountId },
      {
        threadId: input.threadId,
        greetingMode,
        iterations: iteration,
        blockCount: blocks.length,
        inputTokens: cumulativeInputTokens,
        outputTokens: cumulativeOutputTokens,
        userMessageLength: input.userMessage?.length ?? 0,
        assistantMessageLength: cleanedText.length,
        terminatedEarly,
        ...(closingUnfinished !== undefined ? { closingUnfinished } : {}),
        ...(continuation ? { continuationOf: continuation.originMessageId, continuationOrdinal: continuation.ordinal } : {}),
        hasLinkedPlan: !!toolContext.workforcePlanId,
      },
    );

    // 7. Fire-and-forget rolling summary refresh. Nothing to summarise when
    //    there is no thread — the greeting is the only thing that was said.
    if (input.threadId) {
      fireAndForget(
        maybeRefreshRollingSummary(input.threadId, input.tenantId),
      );
    }

    // 8. AI title generation on the first few real turns. AWAITED (not
    //    fire-and-forget) because the container may scale to zero once the
    //    HTTP request completes, killing detached promises mid-flight.
    if (!greetingMode && priorTurns.length <= 5) {
      await maybeGenerateThreadTitle({
        // Non-null outside greeting mode: a turn with a user message always
        // has a thread, which the router enforces.
        threadId: input.threadId!,
        tenantId: input.tenantId,
        userMessage: input.userMessage!,
        assistantMessage: cleanedText,
        purpose: 'caio_workforce_planning_title_generation',
        updateTitle: updateThreadTitleInternal,
      });
    }

    yield { type: 'complete', message: savedMessage };
  } catch (err) {
    log.error(
      {
        threadId: input.threadId,
        tenantId: input.tenantId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      'CAIO chat turn failed with uncaught error',
    );
    yield {
      type: 'error',
      code: 'INTERNAL',
      message: 'Something went wrong processing your message. Please try again.',
    };
  }
}

/**
 * A row as the model should read it: a colleague's reply in the colleague's
 * name.
 *
 * A colleague's reply in this chat is stored verbatim and attributed through
 * `contributors`, which the page draws as a chip. The two sinks that have no
 * chip to look at are the model's own history and the rolling summary, and
 * in both a colleague row read as the Chief AI Officer's own turn has it
 * remember answering what a colleague answered. The speaker is put back
 * here, for both sinks, exactly as the Insights Manager and team chat do.
 */
function inSpeakersVoice(m: Pick<TeamPlanChatMessage, 'messageType' | 'contributors' | 'content'>): string {
  return m.messageType === COLLEAGUE_MESSAGE_TYPE && m.contributors.length > 0
    ? `${m.contributors.map((c) => c.label).join(', ')}: ${m.content}`
    : m.content;
}

// ── Handing the turn to a colleague ─────────────────────────────────────

/**
 * Watch for a stop while the colleague streams. The stop is a row in this
 * database, read on the same spacing the model call polls it; claiming it
 * aborts the hand-over request, which platform-backend reads as the person's
 * stop and delivers through the colleague's own control plane.
 */
function startHandoverStopWatcher(
  tenantId: string,
  threadId: string,
  turnId: string,
  abortController: AbortController,
  onStopped: () => void,
): { stop: () => void } {
  let finished = false;
  const timer = setInterval(() => {
    void isStopRequested(tenantId, threadId, turnId)
      .then((stop) => {
        if (!stop || finished) return;
        finished = true;
        clearInterval(timer);
        onStopped();
        abortController.abort(new Error('user_stop'));
      })
      .catch(() => undefined);
  }, HANDOVER_STOP_POLL_INTERVAL_MS);
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
 * The rest of a turn the Chief AI Officer handed to a colleague: persist what
 * it said before the call, say who is speaking, relay the colleague from
 * platform-backend, persist the reply in the colleague's name, end.
 *
 * The same shape as Liftoff's and the Insights Manager's hand-over, with the
 * one difference that the colleague runs in another service: the segment is
 * an SSE stream (handover-client.ts) and a stop is the request closing.
 */
async function* runHandoverSegment(args: {
  input: RunCAIOChatTurnInput;
  turnId: string;
  handover: { target: CAIOHandoverTarget; request: string };
  /** What the Chief AI Officer said before handing over, already parsed. */
  preamble: { cleanedText: string; blocks: unknown[]; toolTrail: ReturnType<typeof buildToolTrail> };
  priorTurnCount: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  iteration: number;
  hasLinkedPlan: boolean;
}): AsyncIterable<CAIOChatServiceEvent> {
  const { input, turnId, preamble } = args;
  const { target, request } = args.handover;
  // Non-null: a hand-over is a tool call, and the only threadless turn is the
  // greeting, which runs with no tools.
  const threadId = input.threadId!;

  // Anything the Chief AI Officer wrote before calling the tool has already
  // been streamed to the person (a figure it was asked for alongside the
  // hand-over), so it is persisted as its own message rather than dropped:
  // text they watched arrive must still be there on reload.
  if (preamble.cleanedText.trim() || preamble.blocks.length > 0) {
    await appendMessage({
      threadId,
      tenantId: input.tenantId,
      role: 'assistant',
      content: preamble.cleanedText,
      turnId,
      visualizationBlocks: preamble.blocks.length > 0 ? preamble.blocks : null,
      inputTokens: args.cumulativeInputTokens,
      outputTokens: args.cumulativeOutputTokens,
      toolTrail: preamble.toolTrail,
    });
  }

  // Who is speaking, said FIRST: before the stream is opened and before
  // anything the colleague itself emits, so the reply is attributed for the
  // whole of it rather than once it is over.
  yield { type: 'delegation_started', author: target.id, authorLabel: target.label };

  const abortController = new AbortController();
  let stopped = false;
  const watcher = startHandoverStopWatcher(input.tenantId, threadId, turnId, abortController, () => {
    stopped = true;
  });

  let text = '';
  let blocks: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = false;
  let paused: string | null = null;
  let delegateThreadId: string | null = null;
  let sawTerminal = false;
  try {
    for await (const event of streamHandover({
      caller: {
        tenantId: input.tenantId,
        accountId: input.accountId,
        role: input.role,
        ...(input.origin ? { origin: input.origin } : {}),
      },
      displayName: input.callerName ?? '',
      threadId,
      target,
      content: input.userMessage!,
      request,
      signal: abortController.signal,
    })) {
      switch (event.type) {
        case 'delegation_started':
          // Already said above, before the round trip; the stream's own copy
          // names the same colleague.
          break;
        case 'thinking':
          yield { type: 'thinking' };
          break;
        case 'tool_call':
          yield { type: 'tool_call', tool: event.tool };
          break;
        case 'text_delta':
          text += event.text;
          yield { type: 'text_delta', text: event.text };
          break;
        case 'content_block':
          blocks.push(event.block);
          yield { type: 'content_block', block: event.block };
          break;
        case 'complete':
          sawTerminal = true;
          // Prefer what the colleague persisted: the same reply with any
          // visualization fences already lifted out.
          if (event.text) text = event.text;
          if (event.blocks.length > 0) blocks = event.blocks;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          delegateThreadId = event.delegateThreadId;
          if (event.stopped) stopped = true;
          break;
        case 'delegation_paused':
          sawTerminal = true;
          if (event.text) text = event.text;
          if (event.blocks.length > 0) blocks = event.blocks;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          delegateThreadId = event.delegateThreadId;
          paused = event.reason;
          break;
        case 'error':
          sawTerminal = true;
          failed = true;
          log.error(
            { threadId, tenantId: input.tenantId, target: target.id, code: event.code },
            'CAIO: a colleague reported an error on a delegated turn',
          );
          yield { type: 'error', code: 'DELEGATION_ERROR', message: event.message };
          break;
      }
      if (sawTerminal) break;
    }
  } finally {
    watcher.stop();
  }

  // The person pressed Stop: the read ended on the abort with no terminal
  // frame, and what had streamed is kept, exactly as Liftoff keeps a
  // half-written answer. Any other stream that ends without saying how is a
  // connection that went away mid-reply.
  if (!sawTerminal && !stopped) {
    log.error(
      { threadId, tenantId: input.tenantId, target: target.id },
      'CAIO: a colleague stream ended without a terminal event',
    );
    failed = true;
    yield {
      type: 'error',
      code: 'DELEGATION_ERROR',
      message: `${target.label} stopped responding. Please try again.`,
    };
  }

  const replyText = text.trim();
  // Nothing is invented for a hand-over that failed or was stopped before the
  // colleague said anything: no reply exists, and a marker in the content
  // column would read as one.
  const savedMessage =
    failed || (!replyText && blocks.length === 0)
      ? null
      : await appendMessage({
          threadId,
          tenantId: input.tenantId,
          role: 'assistant',
          content: replyText,
          // The colleague's words, verbatim, attributed through the same two
          // fields every surface reads: the type says a colleague spoke, the
          // contributors say which. The reply clock treats it as a reply.
          messageType: COLLEAGUE_MESSAGE_TYPE,
          turnId,
          contributors: [{ id: target.id, label: target.label }],
          visualizationBlocks: blocks.length > 0 ? blocks : null,
          // The colleague's own spend, as its own surface counted it.
          // Transcript metadata; nothing reconciles money from it.
          inputTokens,
          outputTokens,
        });

  void writeAuditLog(
    'workforce_plans.chat_turn',
    { tenantId: input.tenantId, userId: input.accountId },
    {
      threadId,
      greetingMode: false,
      iterations: args.iteration,
      blockCount: blocks.length,
      // The deciding turn plus the delegated one, so the audit line says what
      // the whole turn cost rather than only its first half.
      inputTokens: args.cumulativeInputTokens + inputTokens,
      outputTokens: args.cumulativeOutputTokens + outputTokens,
      userMessageLength: input.userMessage!.length,
      assistantMessageLength: replyText.length,
      terminatedEarly: stopped ? 'STOPPED' : null,
      hasLinkedPlan: args.hasLinkedPlan,
      delegatedTo: target.id,
      ...(paused ? { errorCode: 'delegate_paused' } : {}),
      ...(failed ? { errorCode: 'delegation_failed' } : {}),
    },
  );

  // A failure already yielded its own error frame, which is terminal.
  if (failed) return;

  if (savedMessage) {
    // The colleague's reply is the answer to their message on this thread, so
    // it is announced as this surface's reply.
    void notifyTeamPlanReply({
      tenantId: input.tenantId,
      accountId: input.accountId,
      threadId,
      text: savedMessage.content,
      via: input.origin?.via ?? null,
    });
    fireAndForget(maybeRefreshRollingSummary(threadId, input.tenantId));
    // Awaited for the same reason as the ordinary path: the container may
    // scale to zero once the request completes.
    if (args.priorTurnCount <= 5) {
      await maybeGenerateThreadTitle({
        threadId,
        tenantId: input.tenantId,
        userMessage: input.userMessage!,
        assistantMessage: replyText,
        purpose: 'caio_workforce_planning_title_generation',
        updateTitle: updateThreadTitleInternal,
      });
    }
  }

  if (paused) {
    // Whatever it managed to say is already persisted above. What is left to
    // say is that it is waiting on a person, written into the thread as its
    // own status row exactly as Liftoff and team chat do for the same fact:
    // the terminal frame below reaches only the one client whose turn
    // tripped the gate, so without this the pause is lost on reload.
    // Best-effort: a pause is not worth failing an already-finished turn over.
    let statusMessage: TeamPlanChatMessage | null = null;
    try {
      statusMessage = await appendMessage({
        threadId,
        tenantId: input.tenantId,
        role: 'assistant',
        content: paused,
        messageType: HITL_STATUS_MESSAGE_TYPE,
        contributors: [{ id: target.id, label: target.label }],
      });
    } catch (err) {
      log.warn(
        { threadId, tenantId: input.tenantId, target: target.id, error: (err as Error).message },
        'CAIO: could not post the waiting-on-a-decision status row',
      );
    }
    yield {
      type: 'delegation_paused',
      author: target.id,
      authorLabel: target.label,
      delegateThreadId,
      reason: paused,
      message: statusMessage,
    };
    return;
  }

  yield { type: 'complete', message: savedMessage };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Look up the workforce plan linked to the given thread, if any. Returns
 * null when the thread has no linked plan or the plan has been deleted.
 */
async function loadLinkedPlan(
  threadId: string,
  tenantId: string,
): Promise<WorkforcePlan | null> {
  let workforcePlanId: string | null = null;
  try {
    workforcePlanId = await withTenantContext(tenantId, async (client) => {
      const threadResult = await client.query(
        `SELECT workforce_plan_id FROM team_plan_threads
         WHERE id = $1 AND deleted_at IS NULL`,
        [threadId],
      );
      return (threadResult.rows[0]?.workforce_plan_id as string | null) ?? null;
    });
  } catch (err) {
    log.warn(
      { threadId, tenantId, error: (err as Error).message },
      'CAIO: failed to load linked plan id from thread',
    );
    return null;
  }

  if (!workforcePlanId) return null;

  try {
    return await workforcePlanService.getPlan(workforcePlanId, tenantId);
  } catch (err) {
    if (err instanceof WorkforcePlanNotFoundError) return null;
    log.warn(
      {
        threadId,
        tenantId,
        planId: workforcePlanId,
        error: (err as Error).message,
      },
      'CAIO: failed to load linked workforce plan - continuing without plan state',
    );
    return null;
  }
}

/**
 * Refresh the rolling summary if the thread is long enough to warrant it.
 * Fire-and-forget — never throws.
 */
export async function maybeRefreshRollingSummary(
  threadId: string,
  tenantId: string,
): Promise<void> {
  const historyResult = await listMessages(threadId, tenantId, {
    limit: MAX_SUMMARIZATION_HISTORY,
  });
  const allMessages: SummarizationMessage[] = [...historyResult.messages]
    .reverse()
    // Notes about the conversation are not part of the conversation being
    // summarised: the forwarded background is already a summary of one, and a
    // status row records a pause that has long since cleared.
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

  const previous = await getThreadRollingSummary(threadId, tenantId);

  // Whether this thread is long enough to need a summary is platform-backend's
  // call, not ours — that keeps the threshold and interval in the same place as
  // the summarizer itself, which is why this sends everything and lets the
  // response say whether anything happened.
  const result = await summarizeThread({
    tenantId,
    threadId,
    messages: allMessages,
    previousSummary: isUsableSummary(previous) ? previous : null,
  });

  if (!result.summarized || !result.summary) return;

  await updateThreadRollingSummary(threadId, tenantId, result.summary);
}

/**
 * Queue the next continuation of the work a bound closed: the row (ordinal
 * after the last for this message, or none at the cap) and its Cloud Task.
 * Best effort: a continuation that could not be queued is logged, and what
 * the person already has stands.
 */
async function queueContinuation(
  input: RunCAIOChatTurnInput,
  threadId: string,
  originMessageId: string,
  reason: string,
): Promise<void> {
  try {
    const row = await enqueueContinuation({
      tenantId: input.tenantId,
      threadId,
      accountId: input.accountId,
      originMessageId,
      reason,
    });
    if (row) await enqueueContinuationTask(row.id, input.tenantId);
  } catch (err) {
    log.warn(
      { threadId, tenantId: input.tenantId, originMessageId, error: (err as Error).message },
      'CAIO: could not queue the continuation of this turn',
    );
  }
}
