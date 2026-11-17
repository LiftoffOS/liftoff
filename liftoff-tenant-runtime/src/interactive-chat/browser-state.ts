// The Browser section of a team's chat turn: where the browser is, who holds
// the wheel, and what happened since the assistant last spoke.
//
// The record is the source; the live page is read on demand. This reads
// rows only: the session row (always looked up, because a session the pane
// opened a second ago has no record yet), the newest holds with their newest
// actions, the newest activity rows, and the time of the assistant's last
// reply in the runtime's own history, and hands them to the one renderer
// every host uses (@liftoffos/browser-record). The page line is ordered by
// explicit timestamps: the newer of the newest hold action and the cached
// URL's own `current_url_at` wins, never `last_used_at`, which every touch
// restamps.

import { renderBrowserStateBlock, type BrowserStateInput, type BrowserStateItem } from '@liftoffos/browser-record';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import * as repo from '../browser-sessions/repository';
import { listTakeoverHolds } from '../browser-sessions/takeover-capture/repository';
import { listBrowserActivity } from '../browser-sessions/activity-repository';
import { activityRowToRecord, holdState, holdToRecord } from '../browser-sessions/activity-wire';
import { interventionsForHolds, pendingIntervention } from '../browser-sessions/interventions';

/** Holds and rows read per turn, each; the renderer's own item cap is the
 *  same figure, so nothing is read that could not be shown. */
export const STATE_HOLDS = 8;
export const STATE_ROWS = 8;
export const STATE_ACTIONS_PER_HOLD = 20;

export interface BrowserStateArgs {
  tenantId: string;
  threadId: string;
  /** The driver's display name, from the control plane's driver record,
   *  stamped on the request as `browserDriverName`. */
  driverName?: string;
}

/** When the assistant last SPOKE on this thread: the runtime's own history
 *  holds only speech rows (status rows live on the control plane), so its
 *  newest assistant row is the reply. Null when it has not replied. */
async function lastReplyAt(tenantId: string, threadId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ at: Date | null }>(
    `SELECT MAX(created_at) AS at FROM messages WHERE tenant_id = $1 AND thread_id = $2 AND role = 'assistant'`,
    [tenantId, threadId],
  );
  const at = rows[0]?.at;
  return at ? new Date(at).toISOString() : null;
}

/** The block, or an empty string when the thread has no session and no
 *  record. Never throws: a failed read is logged and the turn goes on
 *  without the section. */
export async function buildBrowserStateBlock(args: BrowserStateArgs): Promise<string> {
  const { tenantId, threadId } = args;
  try {
    const [session, holds, rows, sinceLastReply] = await Promise.all([
      repo.getActiveForThread(tenantId, threadId),
      listTakeoverHolds(tenantId, threadId, { limit: STATE_HOLDS, newestActions: STATE_ACTIONS_PER_HOLD }),
      listBrowserActivity(tenantId, threadId, { limit: STATE_ROWS }),
      lastReplyAt(tenantId, threadId),
    ]);
    if (!session && holds.holds.length === 0 && rows.rows.length === 0) return '';

    const items: BrowserStateItem[] = [
      ...holds.holds.map((h) => ({ at: h.startedAt.toISOString(), segment: holdToRecord(h) })),
      ...rows.rows.map((r) => ({ at: r.createdAt.toISOString(), call: activityRowToRecord(r) })),
    ];

    // The page line: the newer of the newest hold action and the cached URL.
    let url = session?.currentUrl ?? '';
    let title = session?.currentTitle ?? '';
    let urlAt = session?.currentUrlAt?.getTime() ?? 0;
    for (const hold of holds.holds) {
      for (const a of hold.actions) {
        if (a.url && a.at.getTime() > urlAt) {
          url = a.url;
          title = '';
          urlAt = a.at.getTime();
        }
      }
    }

    // The request for the person: pending on the session, or answered by
    // the newest hold that answered one.
    let intervention: BrowserStateInput['intervention'] = null;
    if (session) {
      const pending = await pendingIntervention(tenantId, session.id).catch(() => null);
      if (pending) intervention = { reason: pending.reason, requestedAt: pending.requestedAt.toISOString(), answered: false };
    }
    if (!intervention && holds.holds.length > 0) {
      const answered = await interventionsForHolds(tenantId, holds.holds.map((h) => h.id)).catch(() => new Map());
      const newest = holds.holds.find((h) => answered.has(h.id));
      if (newest) {
        const req = answered.get(newest.id)!;
        intervention = { reason: req.reason, requestedAt: newest.startedAt.toISOString(), answered: true };
      }
    }

    const live = holds.holds.some((h) => holdState(h).live);
    const wheel: 'assistant' | 'person' | 'nobody' =
      session?.takeoverState === 'taken_over' || live ? 'person' : session ? 'assistant' : 'nobody';

    return renderBrowserStateBlock({
      session: session
        ? {
          open: true,
          url,
          // The cached URL is the safe projection already; a hold action's
          // url is too. Whether a component was replaced is not stored on
          // the row, so the block does not claim to know.
          urlProtectedDataOmitted: false,
          title,
          wheel,
          driverName: args.driverName ?? '',
        }
        : { open: false, url, urlProtectedDataOmitted: false, title, wheel: 'nobody', driverName: '' },
      recent: items,
      sinceLastReply,
      intervention,
    });
  } catch (err) {
    logger.warn({ tenantId, threadId, err: (err as Error).message }, 'browser state block could not be built (non-fatal)');
    return '';
  }
}
