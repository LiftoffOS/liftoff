// A tool result larger than one message, for the Chief AI Officer.
//
// Every tool the CAIO calls came back through one line —
// `JSON.stringify(result.data)` in the loop below — and went into the model's
// context whole, at whatever size it happened to be. Three of the five agent
// surfaces were in that state; this is one of them. A 200,000-character result
// there is not a slow turn, it is a turn that cannot finish: the window fills,
// the reply is closed, and the person gets nothing for work already paid for.
//
// The rule and the store live in platform-backend, where the datasets are and
// where the other two in-process assistants already call it. This posts the
// oversized result there and hands back what the model reads instead — the
// dataset's view, which the CAIO's own dataset_query / dataset_extract /
// dataset_list tools then read the records through.
//
// FAILURE IS BOUNDED, NOT TRANSPARENT. A timeout, a 413, any non-2xx, a thrown
// request: none of them may end with the oversized payload going into the
// window, because that is the exact outcome this exists to prevent. What comes
// back then is a bounded copy, and the model is told it is one.

import { pbPostJson } from '../infrastructure/platform-backend.js';
import { log } from '../infrastructure/logging.js';

/**
 * The size past which a successful result is parked rather than read.
 *
 * The same figure platform-backend's own seam and the tenant runtime's
 * per-result bound use, and it is one number across the estate on purpose: a
 * result that is "too big to read" on one surface is too big on all of them,
 * and two thresholds would mean a result parked for an agent and inlined for
 * the assistant that asked the same question. Calibrated in the runtime
 * against 30 days of real tool results (n=6043: p50=350, p95=3268, p99=33275,
 * max=77530) — at 50,000 it touches only the sub-1% pathological tail.
 */
export const TOOL_RESULT_PARK_CHARS = 50_000;

/** How long the loop waits for a park before falling back. Generous enough for
 *  a multi-megabyte body over a service hop, short enough that a person
 *  waiting on a reply is not left watching the request rather than the answer. */
const PARK_TIMEOUT_MS = 30_000;

/** Room kept for the note and the cut marker, which are part of what is handed
 *  over and therefore come OUT of the budget: a "bounded" result longer than
 *  the one it replaced is not a bound. */
const NOTE =
  '\n\n[This result was larger than one message and could not be kept for querying, so it is shortened here. '
  + 'Ask for a narrower result rather than assuming this is all of it.]';

/** A bounded copy of an oversized result. The failure path, never the happy
 *  one: handing back the original when parking failed is the outcome parking
 *  was added to prevent, and a protection that falls back to the unprotected
 *  behaviour protects nothing. */
export function boundedInline(text: string, max: number = TOOL_RESULT_PARK_CHARS): string {
  if (text.length <= max) return text;
  const budget = Math.max(1_000, max - NOTE.length - 64);
  const kept = text.slice(0, budget);
  return `${kept}\n…[cut: ${text.length - kept.length} more characters]${NOTE}`;
}

export interface ParkContext {
  tenantId: string;
  /** The conversation the datasets belong to, and what dataset_list lists. */
  threadId: string;
}

/**
 * What the model reads in place of one tool result.
 *
 * Under the bound: the serialized result, unchanged — no request is made, so
 * the ordinary turn costs nothing it did not cost before. Over it: the dataset
 * view, or a bounded copy when the park could not happen.
 *
 * Never throws.
 */
export async function parkOrBoundToolResult(
  ctx: ParkContext,
  toolName: string,
  data: unknown,
  serialized: string,
): Promise<string> {
  if (typeof serialized !== 'string' || serialized.length <= TOOL_RESULT_PARK_CHARS) return serialized;
  try {
    const res = await pbPostJson('/api/internal/datasets/park', {
      tenantId: ctx.tenantId,
      scopeKind: 'caio_thread',
      scopeId: ctx.threadId,
      label: `${toolName} result`,
      source: 'caio_tool',
      sourceRef: toolName,
      text: serialized,
      payload: data,
    }, { timeoutMs: PARK_TIMEOUT_MS });
    if (res.ok) {
      const text = (res.json as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) return text;
      log.warn({ tenantId: ctx.tenantId, threadId: ctx.threadId, toolName }, 'CAIO: the park route answered without a text; bounding instead');
    } else {
      // 413 is its own fact and worth naming: the payload was past the route's
      // stated maximum, which is a different problem from the service being
      // unreachable and is fixed in a different place.
      log.warn(
        { tenantId: ctx.tenantId, threadId: ctx.threadId, toolName, status: res.status, detail: res.detail },
        res.status === 413
          ? 'CAIO: a tool result was past the park route\'s maximum payload; bounding instead'
          : 'CAIO: the park route refused an oversized tool result; bounding instead',
      );
    }
  } catch (err) {
    log.warn(
      { tenantId: ctx.tenantId, threadId: ctx.threadId, toolName, error: (err as Error).message },
      'CAIO: the park route could not be reached for an oversized tool result; bounding instead',
    );
  }
  return boundedInline(serialized);
}
