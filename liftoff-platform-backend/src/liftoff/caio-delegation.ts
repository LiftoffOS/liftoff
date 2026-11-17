// The wire to the Chief AI Officer.
//
// Of the three colleagues Liftoff can bring into a thread, this is the only one
// that does not run in this process. The CAIO's turn exists as an HTTP stream in
// workforce-service (POST /team-plan/chat-stream), and that turn is bound to a
// thread in THAT service's database three ways over: its own thread lookup, the
// foreign key on its messages table, and the plan its mutating tools operate on.
// There is no transcript input and no way to hand it a Liftoff thread id, which
// is why a Liftoff conversation pairs with a team-plan thread and reuses it.
//
// This module owns the wire only: creating that thread, streaming a turn, and
// asking a running turn to stop. Which colleague to bring in belongs to
// delegation-targets.ts, and what to do with the events belongs to
// delegation-runtimes.ts.

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { log } from '../infrastructure/logging';
import type { ActorOrigin } from '../workspace-actions/actor';
import type { ChatAttachment } from '../chat-attachments';
import { buildOriginHeader } from '../workspace-actions/origin-header';
import type { VisualizationBlock } from '../insights/shared-types';
import type { Contributor } from '../chat-attachments';
import {
  buildWorkforceCallHeaders,
  workforceServiceBaseUrl,
  type WorkforceCaller,
} from '../workforce-plans/team-plan-thread-client';

/** The assistant message workforce-service persisted for the delegated turn.
 *  Only the fields Liftoff carries across are named; the rest of the row stays
 *  in workforce, which remains its system of record. */
export interface CAIOReplyMessage {
  content: string;
  visualizationBlocks: unknown[] | null;
  inputTokens: number;
  outputTokens: number;
  /** `colleague` when the Chief AI Officer handed its own turn to a colleague
   *  and this row is that colleague's reply; null when it answered itself. */
  messageType: string | null;
  /** Who wrote the row when it was a colleague, as the workforce service
   *  stored it. Empty when the Chief AI Officer answered itself. */
  contributors: Contributor[];
}

/**
 * The CAIO's SSE contract, one to one with what its chat-stream-router emits.
 *
 * `busy` is the local name for its `interrupt_delivered` frame: the message was
 * folded into a CAIO turn already running on the paired thread, so nothing will
 * be streamed back. It is terminal, and it is not an error in workforce's eyes,
 * but from inside a Liftoff turn it means nobody is going to answer the person.
 */
export type CAIOStreamEvent =
  | { type: 'thinking' }
  | { type: 'tool_call'; tool: string }
  | { type: 'text_delta'; text: string }
  | { type: 'content_block'; block: VisualizationBlock }
  /** The Chief AI Officer handed its turn to a colleague, on its own surface.
   *  Only reachable on a turn that is not itself a hand-over (a coding tool's
   *  or a Slack DM's): a Chief AI Officer brought in is offered no colleague. */
  | { type: 'delegation_started'; author: string; authorLabel: string }
  /** Terminal, not a failure: the colleague the Chief AI Officer brought in
   *  stopped to wait on a person. */
  | { type: 'delegation_paused'; author: string; authorLabel: string; reason: string }
  | { type: 'complete'; message: CAIOReplyMessage | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'busy' };

/** Raised when the paired thread could not be created. The message is written
 *  for the person, not for the log: it is what the chat surface shows. */
export class CAIODelegationError extends Error {}

/** What the person is told when workforce-service cannot be reached at all.
 *  One sentence, no internals. */
const UNREACHABLE_MESSAGE =
  'The Chief AI Officer could not be reached just now. Please try again in a moment.';

// ── Paired thread creation ──────────────────────────────────────────────

/**
 * Create the team-plan thread this Liftoff conversation will be paired with.
 *
 * No greeting is streamed. On its own surface a fresh thread opens with the CAIO
 * speaking first, but here the person has already said what they want, and a
 * greeting would be the same voice interrupting itself.
 */
export async function createPairedTeamPlanThread(args: {
  caller: WorkforceCaller;
  /** Optional. Left unset in practice: workforce titles the thread from the
   *  first real turn, which reads better than a truncated raw message. */
  title?: string | null;
}): Promise<string> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) {
    log.error({}, 'CAIO delegation: WORKFORCE_SERVICE_URL not configured');
    throw new CAIODelegationError(UNREACHABLE_MESSAGE);
  }

  const headers = await buildWorkforceCallHeaders(targetBase, args.caller, {
    'content-type': 'application/json',
  });

  let response: globalThis.Response;
  try {
    response = await globalThis.fetch(`${targetBase}/team-plan/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args.title ? { title: args.title.slice(0, 500) } : {}),
    });
  } catch (err) {
    log.error(
      { err: (err as Error).message, tenantId: args.caller.tenantId },
      'CAIO delegation: failed to reach workforce-service to create the paired thread',
    );
    throw new CAIODelegationError(UNREACHABLE_MESSAGE);
  }

  if (!response.ok) {
    log.error(
      { status: response.status, tenantId: args.caller.tenantId },
      'CAIO delegation: paired thread creation rejected',
    );
    throw new CAIODelegationError(UNREACHABLE_MESSAGE);
  }

  const body = (await response.json().catch(() => null)) as
    | { thread?: { id?: string } }
    | null;
  const threadId = body?.thread?.id;
  if (!threadId) {
    log.error(
      { tenantId: args.caller.tenantId },
      'CAIO delegation: paired thread creation returned no thread id',
    );
    throw new CAIODelegationError(UNREACHABLE_MESSAGE);
  }
  return threadId;
}

// ── Streaming one delegated turn ────────────────────────────────────────

/** Turn one SSE frame into a typed event, or null for a frame this side does not
 *  model. Unknown frames are dropped rather than guessed at: workforce may add
 *  events, and a Liftoff turn must not fail because of one it has not been
 *  taught. */
/** A contributor as the workforce service wrote it: an id and a label. */
function isContributor(value: unknown): value is Contributor {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>)['id'] === 'string'
    && typeof (value as Record<string, unknown>)['label'] === 'string';
}

function toStreamEvent(frame: EventSourceMessage): CAIOStreamEvent | null {
  let data: Record<string, unknown> = {};
  if (frame.data) {
    try {
      data = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const eventType = frame.event || (data['type'] as string | undefined);

  switch (eventType) {
    case 'thinking':
      return { type: 'thinking' };
    case 'tool_call':
      return typeof data['tool'] === 'string' ? { type: 'tool_call', tool: data['tool'] } : null;
    case 'text_delta':
      return typeof data['text'] === 'string' ? { type: 'text_delta', text: data['text'] } : null;
    case 'content_block':
      return data['block']
        ? { type: 'content_block', block: data['block'] as VisualizationBlock }
        : null;
    case 'delegation_started':
      return typeof data['author'] === 'string' && typeof data['authorLabel'] === 'string'
        ? { type: 'delegation_started', author: data['author'], authorLabel: data['authorLabel'] }
        : null;
    case 'delegation_paused':
      return typeof data['author'] === 'string' && typeof data['authorLabel'] === 'string'
        ? {
            type: 'delegation_paused',
            author: data['author'],
            authorLabel: data['authorLabel'],
            reason: typeof data['reason'] === 'string' && data['reason'].length > 0
              ? data['reason']
              : `${data['authorLabel']} is waiting on a person before it can continue.`,
          }
        : null;
    case 'complete': {
      const message = data['message'] as Record<string, unknown> | null | undefined;
      if (!message || typeof message !== 'object') return { type: 'complete', message: null };
      return {
        type: 'complete',
        message: {
          content: typeof message['content'] === 'string' ? message['content'] : '',
          visualizationBlocks: Array.isArray(message['visualizationBlocks'])
            ? (message['visualizationBlocks'] as unknown[])
            : null,
          inputTokens: typeof message['inputTokens'] === 'number' ? message['inputTokens'] : 0,
          outputTokens: typeof message['outputTokens'] === 'number' ? message['outputTokens'] : 0,
          messageType: typeof message['messageType'] === 'string' ? message['messageType'] : null,
          contributors: Array.isArray(message['contributors'])
            ? (message['contributors'] as unknown[]).filter(isContributor)
            : [],
        },
      };
    }
    case 'interrupt_delivered':
      return { type: 'busy' };
    case 'error':
      return {
        type: 'error',
        code: typeof data['code'] === 'string' ? data['code'] : 'PROVIDER_ERROR',
        message:
          typeof data['message'] === 'string' && data['message'].length > 0
            ? data['message']
            : UNREACHABLE_MESSAGE,
      };
    default:
      return null;
  }
}

/**
 * Run one turn on the paired thread and yield what the CAIO says as it says it.
 *
 * A non-2xx answer is yielded as an `error` event rather than thrown, so the
 * caller has exactly one shape to handle. 409 gets its own sentence: it means a
 * CAIO turn is already running on the paired thread, which is a wait rather than
 * a failure, and "something went wrong" would be a lie that also invites an
 * immediate retry.
 */
export async function* streamCAIOTurn(args: {
  caller: WorkforceCaller;
  /** Where the Liftoff turn came from, when it came through a coding tool.
   *  Sent as x-origin so the CAIO's workspace actions carry it. */
  origin?: ActorOrigin | null;
  workforceThreadId: string;
  content: string;
  /** The background Liftoff wrote for this turn, already framed as the note
   *  workforce-service persists beside the message. Sent as its own field so
   *  that service can store the person's words as the person's turn and this as
   *  a row about the conversation. Null when there is nothing to forward, and
   *  omitted from the body entirely in that case so an older workforce-service
   *  sees exactly the request it saw before. */
  forwardedContext: string | null;
  /** What the person handed over with the message. workforce-service parses
   *  the same attachmentsSchema on its chat-stream route; omitted from the
   *  body when there are none. */
  attachments?: ChatAttachment[];
  /** Who forwarded the background above, as the contributor the note is
   *  stored with on the Chief AI Officer's thread: Liftoff or the Insights
   *  Manager. Omitted with the note. */
  forwardedBy?: { id: string; label: string } | null;
  /** True on every hand-over: the Chief AI Officer is a colleague brought in,
   *  so it is offered no colleague of its own. workforce-service withholds its
   *  bring-in tool on this flag; an older image strips the key and behaves as
   *  before. */
  handover?: boolean;
}): AsyncIterable<CAIOStreamEvent> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) {
    log.error({}, 'CAIO delegation: WORKFORCE_SERVICE_URL not configured');
    yield { type: 'error', code: 'DELEGATION_UNAVAILABLE', message: UNREACHABLE_MESSAGE };
    return;
  }

  const headers = await buildWorkforceCallHeaders(targetBase, args.caller, {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...buildOriginHeader(args.origin),
  });

  let response: globalThis.Response;
  try {
    response = await globalThis.fetch(`${targetBase}/team-plan/chat-stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId: args.workforceThreadId,
        content: args.content,
        ...(args.forwardedContext ? { forwardedContext: args.forwardedContext } : {}),
        ...(args.forwardedContext && args.forwardedBy ? { forwardedBy: args.forwardedBy } : {}),
        ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
        ...(args.handover ? { handover: true } : {}),
      }),
    });
  } catch (err) {
    log.error(
      { err: (err as Error).message, tenantId: args.caller.tenantId },
      'CAIO delegation: failed to reach workforce-service chat stream',
    );
    yield { type: 'error', code: 'DELEGATION_UNAVAILABLE', message: UNREACHABLE_MESSAGE };
    return;
  }

  if (!response.ok) {
    log.error(
      {
        status: response.status,
        tenantId: args.caller.tenantId,
        workforceThreadId: args.workforceThreadId,
      },
      'CAIO delegation: chat stream rejected',
    );
    yield response.status === 409
      ? { type: 'busy' }
      : { type: 'error', code: 'DELEGATION_UNAVAILABLE', message: UNREACHABLE_MESSAGE };
    return;
  }

  if (!response.body) {
    yield { type: 'error', code: 'DELEGATION_UNAVAILABLE', message: UNREACHABLE_MESSAGE };
    return;
  }

  // Same parser the tenant-runtime client uses, for the same reason: SSE frames
  // do not respect chunk boundaries, so splitting on "\n\n" per read drops the
  // frame that straddles two of them.
  const pending: CAIOStreamEvent[] = [];
  const parser = createParser({
    onEvent(frame: EventSourceMessage) {
      const event = toStreamEvent(frame);
      if (event) pending.push(event);
    },
    onComment() {
      // Heartbeat comments keep the connection warm and carry nothing.
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (pending.length > 0) yield pending.shift()!;
    }
    while (pending.length > 0) yield pending.shift()!;
  } catch (err) {
    log.error(
      { err: (err as Error).message, tenantId: args.caller.tenantId },
      'CAIO delegation: chat stream broke mid-flight',
    );
    yield { type: 'error', code: 'DELEGATION_UNAVAILABLE', message: UNREACHABLE_MESSAGE };
  } finally {
    // Best effort: a reader that has already errored rejects here, and that must
    // not become the failure the caller sees.
    await reader.cancel().catch(() => undefined);
  }
}

// ── Stopping a delegated turn ───────────────────────────────────────────

/**
 * Ask the CAIO turn running on the paired thread to stop.
 *
 * This is not optional politeness. Dropping the HTTP stream does NOT end the
 * CAIO's turn: workforce treats a lost socket as "the person walked away, finish
 * the work and persist it", exactly as Liftoff does. So a Stop on the Liftoff
 * side that only abandoned the read would leave a turn running that nobody is
 * watching, holding the paired thread, and the next request would be folded into
 * a turn the person cannot see. The stop has to be written where the CAIO's own
 * loop reads it.
 *
 * Best effort: a failure is logged and swallowed, because the Liftoff turn is
 * already ending and there is nothing useful to tell the person.
 */
export async function requestCAIOTurnStop(args: {
  caller: WorkforceCaller;
  workforceThreadId: string;
}): Promise<void> {
  const targetBase = workforceServiceBaseUrl();
  if (!targetBase) return;

  try {
    const headers = await buildWorkforceCallHeaders(targetBase, args.caller, {
      'content-type': 'application/json',
    });
    const response = await globalThis.fetch(
      `${targetBase}/team-plan/threads/${encodeURIComponent(args.workforceThreadId)}/stop`,
      { method: 'POST', headers, body: '{}' },
    );
    log.info(
      {
        tenantId: args.caller.tenantId,
        workforceThreadId: args.workforceThreadId,
        status: response.status,
      },
      'CAIO delegation: stop requested on the paired thread',
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, workforceThreadId: args.workforceThreadId },
      'CAIO delegation: could not deliver the stop to the paired thread',
    );
  }
}
