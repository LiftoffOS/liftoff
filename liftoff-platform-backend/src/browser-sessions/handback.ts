// The person's browser events as turns: a hand-back, and a point.
//
// When the person hands the browser back (the button, or a send while they
// were driving) or points at something in the live view, the client sends
// the surface's stream endpoint an event naming the hold the runtime
// recorded. The router verifies the claim against the runtime's record before
// anything is written: the hold must be this thread's, of the right kind,
// ended by a release (a hand-back) or made just now (a point), and recent.
// A claim that fails is 409 `handback_not_pending`, no row and no turn: a tab
// that woke after the window has nothing to say that the next turn's Browser
// section does not already carry.
//
// What the thread shows is one status line, written here once for the three
// chat surfaces of this service and the Chief AI Officer's (over the internal
// takeovers route): the person's name and what they did, in the record's own
// words for a point. The segment itself reaches the model through the Browser
// section, never through the row.

import { z } from 'zod';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { describeAction, type RecordedAction } from '@liftoffos/browser-record';
import { getBrowserSessionsServiceClient } from '../connectors/tenant-runtime-service-client';
import { takeoverActionOut, type TakeoverActionOut } from './takeover-activity';

/** How long after the hand-back a claim about it is honoured. */
export const BROWSER_EVENT_WINDOW_MS = 15 * 60_000;

/** The 409 code a claim that does not check out answers. */
export const BROWSER_EVENT_NOT_PENDING = 'handback_not_pending';

export type BrowserEventKind = 'handback';

/** The event as the client sends it: `{ browserHandback: { holdId } }`,
 *  beside or instead of `content`. */
export const browserEventBodySchema = z.object({ holdId: z.string().uuid() });

export interface BrowserEventBody {
  browserHandback?: { holdId: string };
}

/** The event a body names, or null. */
export function browserEventOf(body: BrowserEventBody): { kind: BrowserEventKind; holdId: string } | null {
  if (body.browserHandback) return { kind: 'handback', holdId: body.browserHandback.holdId };
  return null;
}

export interface VerifiedBrowserEvent {
  kind: BrowserEventKind;
  holdId: string;
}

/**
 * Verify a claimed event against the runtime's record. Null when the hold is
 * not this thread's, not the claimed kind, not released (a hand-back), or
 * older than the window.
 */
export async function verifyBrowserEvent(
  tenantId: string,
  threadId: string,
  kind: BrowserEventKind,
  holdId: string,
  now: Date = new Date(),
): Promise<VerifiedBrowserEvent | null> {
  const client = await getBrowserSessionsServiceClient(tenantId);
  const res = await client.listTakeoverActivity({
    tenantContext: { tenantId },
    threadId,
    limit: 1,
    beforeCursor: '',
    holdId,
    newestActions: 1,
  });
  const hold = res.holds.find((h) => h.id === holdId);
  if (!hold) return null;
  // A point hold is still REJECTED here, and the check has to stay after the
  // gesture is gone: the rows written while it existed are in the record, and
  // a hand-back claim against one of them was never valid and must not become
  // valid by the check being deleted with the feature.
  if (hold.kind === 'point') return null;
  if (hold.live || hold.endReason !== 'released' || !hold.endedAt) return null;
  if (now.getTime() - timestampDate(hold.endedAt).getTime() > BROWSER_EVENT_WINDOW_MS) return null;
  return { kind, holdId };
}

/** "<name> handed the browser back". */
export function handbackStatusLine(displayName: string): string {
  return `${displayName} handed the browser back`;
}

/** The status line for a verified event. */
export function browserEventStatusLine(displayName: string, _event: VerifiedBrowserEvent): string {
  return handbackStatusLine(displayName);
}

/** The agent-chat row's idempotency key: one row per hold, on replay too. */
export function browserEventExternalRef(event: VerifiedBrowserEvent): string {
  return `browser_handback:${event.holdId}`;
}
