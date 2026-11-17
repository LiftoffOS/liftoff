// The Browser section of a platform assistant's turn: where the browser is,
// who holds the wheel, and what happened since the assistant last spoke.
//
// Liftoff and the Insights Manager run their turns here, and the Chief AI
// Officer asks over POST /api/internal/assistant-browser/state; all three
// read the same block, rendered by the one renderer every host uses
// (@liftoffos/browser-record). The runtime is the source: the session
// (always looked up, because a session the pane opened a second ago has no
// record yet), the newest holds with their newest actions and the newest
// recorded calls, over the same streams the trail readers use; the driver's
// name is this service's, from browser_session_drivers, because only the
// control plane can put a name to an account. When the assistant last spoke
// is the host's own history, so the host passes it in.
//
// The page line is ordered by time: the newer of the newest hold action and
// the session's cached address wins, each by its own read time
// (`current_url_at` on the session, never `last_used_at`, which every touch
// restamps), and the title read beside the address goes with it.

import { timestampDate } from '@bufbuild/protobuf/wkt';
import { recordedUrl } from '@liftoffos/redact';
import {
  renderBrowserStateBlock,
  STATE_BLOCK_MAX_ACTIONS_PER_SEGMENT,
  STATE_BLOCK_MAX_ITEMS,
  type BrowserStateInput,
  type BrowserStateItem,
} from '@liftoffos/browser-record';
import type { BrowserSession } from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { getBrowserSessionsServiceClient } from '../connectors/tenant-runtime-service-client';
import { log } from '../infrastructure/logging';
import { redactSensitiveText } from '../common/redact';
import { getDriver } from './driver-repository';
import { activityStream, holdStream, takeoverRowOut, type HoldItem } from './takeover-activity';

/** Holds and rows read per turn, each; the renderer's own item cap is the
 *  same figure, so nothing is read that could not be shown. */
export const STATE_HOLDS = STATE_BLOCK_MAX_ITEMS;
export const STATE_ROWS = STATE_BLOCK_MAX_ITEMS;
export const STATE_ACTIONS_PER_HOLD = STATE_BLOCK_MAX_ACTIONS_PER_SEGMENT;

export interface AssistantBrowserStateArgs {
  tenantId: string;
  threadId: string;
  /** When the assistant last SPOKE on this thread (a speech row, never a
   *  status row), ISO 8601; null when it has not yet. The host's history
   *  knows; this module does not read it. */
  sinceLastReply: string | null;
}

/** The driver's display name: first and last name, else the address. */
function driverDisplayName(driver: { firstName: string | null; lastName: string | null; email: string }): string {
  return [driver.firstName, driver.lastName].filter(Boolean).join(' ').trim() || driver.email;
}

async function newestHolds(tenantId: string, threadId: string): Promise<HoldItem[]> {
  const stream = holdStream(tenantId, threadId, { newestActions: STATE_ACTIONS_PER_HOLD });
  const items: HoldItem[] = [];
  while (items.length < STATE_HOLDS) {
    const item = await stream.pop();
    if (!item) break;
    items.push(item);
  }
  return items;
}

async function newestRows(tenantId: string, threadId: string): Promise<BrowserStateItem[]> {
  const stream = activityStream(tenantId, threadId);
  const items: BrowserStateItem[] = [];
  while (items.length < STATE_ROWS) {
    const item = await stream.pop();
    if (!item) break;
    items.push({ at: item.createdAt.toISOString(), call: item.row });
  }
  return items;
}

/** The block, or an empty string when the thread has no session and no
 *  record. Never throws: a failed read is logged and the turn goes on
 *  without the section. */
export async function buildAssistantBrowserState(args: AssistantBrowserStateArgs): Promise<string> {
  const { tenantId, threadId } = args;
  try {
    const client = await getBrowserSessionsServiceClient(tenantId);
    const [active, holds, rows] = await Promise.all([
      client.getActiveSessionForThread({ tenantContext: { tenantId }, threadId }),
      newestHolds(tenantId, threadId),
      newestRows(tenantId, threadId),
    ]);
    const session: BrowserSession | null = active.session ?? null;
    if (!session && holds.length === 0 && rows.length === 0) return '';

    const items: BrowserStateItem[] = [
      ...holds.map((h) => ({ at: h.startedAt.toISOString(), segment: takeoverRowOut(h) })),
      ...rows,
    ];

    // The page line: the newer of the newest hold action and the cached
    // address, both as safe projections, redacted once more on the way out.
    // A hold action newer than the cached address stands for the page, and
    // the title read beside the older address no longer describes it.
    let url = session?.currentUrl ? recordedUrl(session.currentUrl).text : '';
    let title = session?.currentTitle ?? '';
    let urlAt = session?.currentUrlAt ? timestampDate(session.currentUrlAt).getTime() : 0;
    for (const item of holds) {
      for (const a of item.hold.actions) {
        const at = a.at ? timestampDate(a.at).getTime() : 0;
        if (a.url && at > urlAt) {
          url = a.url;
          title = '';
          urlAt = at;
        }
      }
    }
    url = redactSensitiveText(url);
    title = redactSensitiveText(title);

    // The request for the person: pending on the session, or answered by
    // the newest hold that answered one.
    let intervention: BrowserStateInput['intervention'] = null;
    if (session?.intervention?.requestedAt) {
      intervention = {
        reason: redactSensitiveText(session.intervention.reason),
        requestedAt: timestampDate(session.intervention.requestedAt).toISOString(),
        answered: false,
      };
    }
    if (!intervention) {
      const answered = holds.find((h) => h.hold.interventionReason);
      if (answered) {
        intervention = {
          reason: redactSensitiveText(answered.hold.interventionReason),
          requestedAt: answered.startedAt.toISOString(),
          answered: true,
        };
      }
    }

    const live = holds.some((h) => h.hold.live);
    const personHolds = session?.takeoverState === 'taken_over' || live;
    let driverName = '';
    if (session && personHolds) {
      const driver = await getDriver(tenantId, session.id).catch(() => null);
      if (driver) driverName = driverDisplayName(driver);
    }
    const wheel: 'assistant' | 'person' | 'nobody' = personHolds ? 'person' : session ? 'assistant' : 'nobody';

    return renderBrowserStateBlock({
      session: session
        ? {
          open: true,
          url,
          // The cached address and a hold action's url are safe projections
          // already; whether a component was replaced is not on the wire, so
          // the block does not claim to know.
          urlProtectedDataOmitted: false,
          title,
          wheel,
          driverName,
        }
        : { open: false, url, urlProtectedDataOmitted: false, title, wheel: 'nobody', driverName: '' },
      recent: items,
      sinceLastReply: args.sinceLastReply,
      intervention,
    });
  } catch (err) {
    log.warn({ tenantId, threadId, err: (err as Error).message }, 'browser state block could not be built (non-fatal)');
    return '';
  }
}

/**
 * The display name of the person holding the wheel on the thread's browser,
 * for a team's chat turn: the runtime renders the Browser section itself and
 * has no name to put to the driver's account, so the control plane stamps it
 * on the request as `browserDriverName`. Empty when no session is open, when
 * nobody holds the wheel, or when the read fails: a missing name costs the
 * block its "<name> holds the wheel" and nothing else.
 */
export async function browserDriverNameForThread(tenantId: string, threadId: string): Promise<string> {
  try {
    const client = await getBrowserSessionsServiceClient(tenantId);
    const { session } = await client.getActiveSessionForThread({ tenantContext: { tenantId }, threadId });
    if (!session || session.takeoverState !== 'taken_over') return '';
    const driver = await getDriver(tenantId, session.id);
    return driver ? driverDisplayName(driver) : '';
  } catch (err) {
    log.warn({ tenantId, threadId, err: (err as Error).message }, 'browser driver name could not be read (non-fatal)');
    return '';
  }
}
