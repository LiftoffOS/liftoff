// The hand-over stream: a colleague the Chief AI Officer brought in, running
// on platform-backend, relayed here as it speaks.
//
// Liftoff and the Insights Manager run in platform-backend, on their own
// tables and their own locks; the rail that hands a turn to one of them lives
// there too (agent-chat/handover.ts). So when the Chief AI Officer's model
// calls `bring_in_colleague`, this service opens
// POST /api/internal/assistants/handover-stream and reads the colleague's
// events back as SSE, in the same frames the dashboard reads:
// `delegation_started`, `thinking`, `tool_call`, `text_delta`,
// `content_block`, then one terminal frame. The terminal `complete` and
// `delegation_paused` frames carry the text, the blocks and the token counts,
// because the reply is persisted HERE, on the Chief AI Officer's thread in
// this database; platform-backend persists only the colleague's own copy on
// the colleague's own thread.
//
// A STOP IS THE REQUEST CLOSING. The person's stop on the Chief AI Officer's
// surface is a row in this database that platform-backend cannot read, so the
// caller aborts the fetch through `signal` and platform-backend claims the
// close as the stop, delivering it through the colleague's own control plane.
// Nothing else about the stream is abandoned on purpose: the caller reads to
// the terminal frame in every other case.
//
// Mirrors platform-backend's liftoff/caio-delegation.ts, which reads THIS
// service's chat stream the same way, with the same parser for the same
// reason: SSE frames do not respect chunk boundaries.

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { log } from '../infrastructure/logging.js';
import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';
import { buildCallerHeaders, type CallerOrigin } from './caller-context.js';
import type { CAIOHandoverTarget } from './tools/bring-in-colleague.js';
import type { TenantMemberRole } from './chat-repository.js';

/** What platform-backend says while the colleague works, one to one with the
 *  frames its route writes. Every terminal frame is named as such. */
export type HandoverStreamEvent =
  | { type: 'delegation_started'; author: string; authorLabel: string }
  | { type: 'thinking' }
  | { type: 'tool_call'; tool: string }
  | { type: 'text_delta'; text: string }
  | { type: 'content_block'; block: unknown }
  /** Finished. `text` and `blocks` are the colleague's own persisted version
   *  of the reply, with any visualization fences already lifted out.
   *  `stopped` is true when the close was claimed as a stop. */
  | {
      type: 'complete';
      text: string;
      blocks: unknown[];
      inputTokens: number;
      outputTokens: number;
      delegateThreadId: string | null;
      stopped: boolean;
    }
  /** Terminal, not a failure: the colleague stopped to wait on a person.
   *  What it said before it stopped travels with the reason. */
  | {
      type: 'delegation_paused';
      author: string;
      authorLabel: string;
      delegateThreadId: string | null;
      reason: string;
      text: string;
      blocks: unknown[];
      inputTokens: number;
      outputTokens: number;
    }
  | { type: 'error'; code: string; message: string };

/** What the person is told when platform-backend cannot be reached at all.
 *  One sentence, no internals. */
const UNREACHABLE = (label: string): string =>
  `${label} could not be reached just now. Please try again in a moment.`;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toStreamEvent(frame: EventSourceMessage, target: CAIOHandoverTarget): HandoverStreamEvent | null {
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
    case 'delegation_started':
      return typeof data['author'] === 'string' && typeof data['authorLabel'] === 'string'
        ? { type: 'delegation_started', author: data['author'], authorLabel: data['authorLabel'] }
        : null;
    case 'thinking':
      return { type: 'thinking' };
    case 'tool_call':
      return typeof data['tool'] === 'string' ? { type: 'tool_call', tool: data['tool'] } : null;
    case 'text_delta':
      return typeof data['text'] === 'string' ? { type: 'text_delta', text: data['text'] } : null;
    case 'content_block':
      return data['block'] ? { type: 'content_block', block: data['block'] } : null;
    case 'complete':
      return {
        type: 'complete',
        text: typeof data['text'] === 'string' ? data['text'] : '',
        blocks: Array.isArray(data['blocks']) ? (data['blocks'] as unknown[]) : [],
        inputTokens: num(data['inputTokens']),
        outputTokens: num(data['outputTokens']),
        delegateThreadId: typeof data['delegateThreadId'] === 'string' ? data['delegateThreadId'] : null,
        stopped: data['stopped'] === true,
      };
    case 'delegation_paused':
      return {
        type: 'delegation_paused',
        author: typeof data['author'] === 'string' ? data['author'] : target.id,
        authorLabel: typeof data['authorLabel'] === 'string' ? data['authorLabel'] : target.label,
        delegateThreadId: typeof data['delegateThreadId'] === 'string' ? data['delegateThreadId'] : null,
        reason: typeof data['reason'] === 'string' && data['reason'].length > 0
          ? data['reason']
          : `${target.label} is waiting on a person before it can continue.`,
        text: typeof data['text'] === 'string' ? data['text'] : '',
        blocks: Array.isArray(data['blocks']) ? (data['blocks'] as unknown[]) : [],
        inputTokens: num(data['inputTokens']),
        outputTokens: num(data['outputTokens']),
      };
    case 'error':
      return {
        type: 'error',
        code: typeof data['code'] === 'string' ? data['code'] : 'DELEGATION_ERROR',
        message: typeof data['message'] === 'string' && data['message'].length > 0
          ? data['message']
          : UNREACHABLE(target.label),
      };
    default:
      return null;
  }
}

/**
 * Run one hand-over on platform-backend and yield what the colleague says as
 * it says it.
 *
 * A non-2xx answer is yielded as an `error` event rather than thrown, so the
 * caller has exactly one shape to handle. An abort through `signal` ends the
 * read quietly: it is the caller's own stop, already accounted for.
 */
export async function* streamHandover(args: {
  caller: { tenantId: string; accountId: string; role: TenantMemberRole; origin?: CallerOrigin };
  /** The person's name, for the colleague's surfaces that attribute the sender. */
  displayName: string;
  /** The Chief AI Officer's thread, which platform-backend pairs the
   *  colleague's own thread with. */
  threadId: string;
  target: CAIOHandoverTarget;
  /** The person's own words this turn, forwarded unchanged. */
  content: string;
  /** What the Chief AI Officer wrote for the colleague. */
  request: string;
  signal: AbortSignal;
}): AsyncIterable<HandoverStreamEvent> {
  const config = loadConfig();
  const baseUrl = config.PLATFORM_BACKEND_URL.replace(/\/$/, '');

  let response: Response;
  try {
    const headers = await getServiceAuthHeaders(baseUrl, config.WORKFORCE_SERVICE_TOKEN);
    response = await fetch(`${baseUrl}/api/internal/assistants/handover-stream`, {
      method: 'POST',
      headers: {
        ...headers,
        ...buildCallerHeaders(args.caller),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        tenantId: args.caller.tenantId,
        accountId: args.caller.accountId,
        role: args.caller.role,
        displayName: args.displayName,
        surface: 'caio',
        threadId: args.threadId,
        colleague: args.target.id,
        content: args.content,
        request: args.request,
      }),
      signal: args.signal,
    });
  } catch (err) {
    if (args.signal.aborted) return;
    log.error(
      { tenantId: args.caller.tenantId, threadId: args.threadId, target: args.target.id, error: (err as Error).message },
      'hand-over: failed to reach platform-backend',
    );
    yield { type: 'error', code: 'DELEGATION_ERROR', message: UNREACHABLE(args.target.label) };
    return;
  }

  if (!response.ok || !response.body) {
    log.error(
      { tenantId: args.caller.tenantId, threadId: args.threadId, target: args.target.id, status: response.status },
      'hand-over: platform-backend refused the stream',
    );
    yield { type: 'error', code: 'DELEGATION_ERROR', message: UNREACHABLE(args.target.label) };
    return;
  }

  const pending: HandoverStreamEvent[] = [];
  const parser = createParser({
    onEvent(frame: EventSourceMessage) {
      const event = toStreamEvent(frame, args.target);
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
    // The caller's own stop: the read ends and nothing is reported, because
    // the caller already knows and keeps what had streamed.
    if (args.signal.aborted) return;
    log.error(
      { tenantId: args.caller.tenantId, threadId: args.threadId, target: args.target.id, error: (err as Error).message },
      'hand-over: the stream broke mid-flight',
    );
    yield { type: 'error', code: 'DELEGATION_ERROR', message: `${args.target.label} stopped responding. Please try again.` };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
